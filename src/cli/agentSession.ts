import { Browser, type LaunchOptions } from '../lib/browser.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import {
  createBrowserHandle,
  dispatch,
  isMutating,
  resetBrowserOwnedState,
  type BrowserHandle,
  type DispatchContext,
} from './dispatcher.js';
import { takeSnapshot, peekDialog, SnapshotTracker, type SnapshotShape } from './snapshot.js';
import { SessionJournal } from './journal.js';

export interface AgentCommand {
  cmd: string;
  args?: Record<string, unknown>;
}

export type AgentResult = unknown;

/**
 * A command's result plus the one post-action snapshot it earned.
 *
 * Transports that show the agent what changed (MCP, the CLI's pretty
 * mode) read `delta`; everything else uses {@link AgentSession.run} and
 * ignores it.
 */
export interface AgentDetailedResult {
  value: AgentResult;
  /** Rendered diff (or full snapshot on a document change). */
  delta?: string;
  snapshot?: SnapshotShape | null;
}

export type AgentDispatcher = (
  ctx: DispatchContext,
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<AgentResult>;

export interface AgentSessionRunner {
  run(command: AgentCommand): Promise<AgentResult>;
  runDetailed(command: AgentCommand): Promise<AgentDetailedResult>;
  close(): Promise<void>;
}

interface AgentSessionOptions {
  launchOptions: LaunchOptions;
  /** Safe name for session-owned artifacts such as the implicit screenshot. */
  artifactName?: string;
  launch?: () => Promise<Browser>;
  dispatcher?: AgentDispatcher;
  /** Internal lifecycle seam used by transport/session tests. */
  handle?: BrowserHandle;
  /** Set false to suppress automatic post-action snapshots. */
  autoSnapshot?: boolean;
}

/** A lazy browser session whose accepted commands execute in FIFO order. */
export class AgentSession implements AgentSessionRunner {
  private readonly ctx: DispatchContext;
  private readonly journal: SessionJournal;
  private readonly dispatcher: AgentDispatcher;
  private readonly autoSnapshot: boolean;
  private tail: Promise<void> = Promise.resolve();
  private state: 'open' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | null = null;

  constructor(options: AgentSessionOptions) {
    const baseLaunch = options.launch ?? (() => Browser.launch(options.launchOptions));
    const journal = new SessionJournal();
    // Attach inside the launch step, not after the first command: the handle
    // must never hand out a browser whose console and network events are
    // already going unrecorded. Events during the first navigation are the
    // ones an agent most often asks about.
    const launch = async (): Promise<Browser> => {
      const browser = await baseLaunch();
      journal.attach(browser);
      return browser;
    };
    this.journal = journal;
    this.ctx = {
      handle: options.handle ?? createBrowserHandle(launch),
      launchOptions: options.launchOptions,
      artifactName: options.artifactName,
      tracker: new SnapshotTracker(),
      journal,
    };
    this.dispatcher = options.dispatcher ?? dispatch;
    this.autoSnapshot = options.autoSnapshot !== false;
  }

  run(command: AgentCommand): Promise<AgentResult> {
    return this.runDetailed(command).then((detailed) => detailed.value);
  }

  /**
   * Execute a command and, for a successful mutation, capture the one
   * post-action snapshot in the *same* queue slot.
   *
   * Action and snapshot are deliberately one operation: if they were two,
   * a concurrent command could land between them and the agent would be
   * shown a diff attributed to the wrong action.
   */
  runDetailed(command: AgentCommand): Promise<AgentDetailedResult> {
    if (this.state !== 'open') {
      return Promise.reject(new CraftdriverError(
        ErrorCode.STATE_INVALID,
        'AgentSession is closing or closed; it cannot accept new commands',
      ));
    }

    const result = this.tail.then(async (): Promise<AgentDetailedResult> => {
      const value = await this.dispatcher(this.ctx, command.cmd, command.args ?? {});
      if (!this.autoSnapshot || !isMutating(command.cmd)) return { value };
      // Only if a browser is actually up: a fake dispatcher (or a command
      // that never needed a browser) must not cause a launch here.
      const browser = this.ctx.handle.peek();
      if (!browser) return { value };

      // A modal dialog blocks script execution, so snapshotting behind one
      // stalls for the full WebDriver script timeout (measured: 60s) and
      // then fails anyway. Probing costs ~2ms and tells the agent the one
      // thing it actually needs to know here.
      const dialog = await peekDialog(browser);
      if (dialog !== null) {
        return {
          value,
          delta: `dialog open: ${dialog}\n(snapshot skipped — accept or dismiss it first)`,
        };
      }

      const snap = await takeSnapshot(browser, this.ctx.tracker.minRef);
      // A failed command threw above, so the baseline only ever advances
      // on success.
      const delta = this.ctx.tracker.advance(snap);
      return { value, ...(delta ? { delta } : {}), snapshot: snap };
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.state = 'closing';
    this.closePromise = this.tail.then(() => this.ctx.handle.close()).then(
      () => {
        this.state = 'closed';
        // Same teardown `quit` performs: releases journal listeners and any
        // caller blocked in a wait, which would otherwise sit out its full
        // timeout against a dead browser, and drops trace and mock metadata
        // that described the browser just closed.
        resetBrowserOwnedState(this.ctx);
      },
      (error: unknown) => {
        this.closePromise = null;
        throw error;
      },
    );
    return this.closePromise;
  }
}
