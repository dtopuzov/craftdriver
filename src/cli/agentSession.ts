import { Browser, INTERNAL_RUN_WITH_NAVIGATION_FENCE, type LaunchOptions } from '../lib/browser.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import {
  createBrowserHandle,
  dispatch,
  isMutating,
  resetBrowserOwnedState,
  type BrowserHandle,
  type DispatchContext,
} from './dispatcher.js';
import {
  takeSnapshot,
  peekDialog,
  renderFull,
  SnapshotTracker,
  type SnapshotShape,
} from './snapshot.js';
import { SessionJournal, type LogTripwire } from './journal.js';
import { AGENT_DEFAULT_VIEWPORT, type AgentViewport } from './defaults.js';
import { truncateUtf8, utf8Bytes } from './bounds.js';
import {
  boundBatchSteps,
  type BatchOutcome,
  type BatchRequest,
  type BatchStepResult,
} from './batch.js';
import { toWireError } from './wireError.js';

export interface AgentCommand {
  cmd: string;
  args?: Record<string, unknown>;
  /**
   * Ask this invocation to capture its post-action state even when the
   * transport normally suppresses automatic snapshots (the persistent CLI).
   */
  observe?: 'page' | 'delta';
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
  /**
   * Whether the action made the application log an error, and where to read
   * it. Absent when this session cannot capture logs at all (a Classic
   * session has no journal), which is deliberately different from `errors: 0`.
   */
  logs?: LogTripwire;
  snapshot?: SnapshotShape | null;
  /** Cheap-to-render state from the same atomic post-action snapshot. */
  page?: {
    url: string;
    title: string;
    documentId: string;
    revision: number;
    /** Relationship to the preceding observed document. */
    documentChange: 'unknown' | 'same' | 'changed';
  };
}

export type AgentDispatcher = (
  ctx: DispatchContext,
  cmd: string,
  args?: Record<string, unknown>
) => Promise<AgentResult>;

function isObservedSubmit(command: AgentCommand, autoSnapshot: boolean): boolean {
  if (!autoSnapshot && !command.observe) return false;
  if (command.cmd === 'fill') {
    return command.args?.submit === true || command.args?.submit === 'true';
  }
  if (command.cmd !== 'press') return false;
  const key = command.args?.key;
  return typeof key === 'string' && /^(enter|return)$/i.test(key);
}

const MAX_RECOVERY_SNAPSHOT_BYTES = 12 * 1024;

function commandRef(command: AgentCommand): string | null {
  const raw = command.args?.selector;
  if (typeof raw !== 'string') return null;
  return /^\s*ref\s*=\s*(e\d+)\s*$/i.exec(raw)?.[1] ?? /^\s*(e\d+)\s*$/.exec(raw)?.[1] ?? null;
}

function boundRecoverySnapshot(snapshot: string): string {
  if (utf8Bytes(snapshot) <= MAX_RECOVERY_SNAPSHOT_BYTES) return snapshot;
  const marker = '\n… (recovery snapshot truncated)';
  return truncateUtf8(snapshot, MAX_RECOVERY_SNAPSHOT_BYTES - utf8Bytes(marker)) + marker;
}

/**
 * Attach fresh context to a failed action on a previously issued ref.
 *
 * The action is never retried: the new snapshot may contain a replacement,
 * but only the agent can decide whether that replacement is the right target.
 */
async function withRefRecovery(
  ctx: DispatchContext,
  command: AgentCommand,
  error: unknown
): Promise<unknown> {
  if (!(error instanceof CraftdriverError)) return error;
  if (
    !CraftdriverError.is(error, ErrorCode.STALE_REF) &&
    !CraftdriverError.is(error, ErrorCode.NO_MATCH)
  )
    return error;
  const ref = commandRef(command);
  if (!ref || !ctx.tracker.hasIssuedRef(ref)) return error;
  const browser = ctx.handle.peek();
  if (!browser || (await peekDialog(browser)) !== null) return error;
  const snap = await takeSnapshot(browser, ctx.tracker.minRef);
  const recorded = ctx.tracker.record(snap);
  if (!recorded) return error;
  return new CraftdriverError(error.code, error.message, {
    ...(error.detail ? { detail: error.detail } : {}),
    hint: 'use recoverySnapshot to choose a current ref; the failed action was not retried',
    cause: error,
    recoverySnapshot: boundRecoverySnapshot(renderFull(recorded)),
  });
}

export interface AgentSessionRunner {
  run(command: AgentCommand): Promise<AgentResult>;
  runDetailed(command: AgentCommand): Promise<AgentDetailedResult>;
  /** Run several known commands in one queue slot. See {@link BatchRequest}. */
  runBatch(request: BatchRequest): Promise<BatchOutcome>;
  close(): Promise<void>;
}

interface AgentSessionOptions {
  launchOptions: LaunchOptions;
  /** Desktop-sized by default so responsive pages expose primary controls. */
  viewport?: AgentViewport;
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
  /**
   * Journal cursor as of the previous observation.
   *
   * The tripwire answers "did *this* action log an error", so it counts from
   * here rather than from the start of the session — a total would keep
   * reporting the same error long after it was read and dealt with.
   */
  private lastLogCursor = 0;

  constructor(options: AgentSessionOptions) {
    const baseLaunch = options.launch ?? (() => Browser.launch(options.launchOptions));
    const viewport = options.viewport ?? AGENT_DEFAULT_VIEWPORT;
    const journal = new SessionJournal();
    // Attach inside the launch step, not after the first command: the handle
    // must never hand out a browser whose console and network events are
    // already going unrecorded. Events during the first navigation are the
    // ones an agent most often asks about.
    const launch = async (): Promise<Browser> => {
      const browser = await baseLaunch();
      try {
        await browser.setViewportSize(viewport);
        journal.attach(browser);
        return browser;
      } catch (error) {
        await browser.quit().catch(() => {});
        throw error;
      }
    };
    this.journal = journal;
    this.ctx = {
      handle: options.handle ?? createBrowserHandle(launch),
      launchOptions: options.launchOptions,
      artifactName: options.artifactName,
      tracker: new SnapshotTracker(),
      journal,
      viewport: { ...viewport },
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
      return Promise.reject(
        new CraftdriverError(
          ErrorCode.STATE_INVALID,
          'AgentSession is closing or closed; it cannot accept new commands'
        )
      );
    }

    const result = this.tail.then(async (): Promise<AgentDetailedResult> => {
      const value = await this.dispatchOne(command);
      // An explicit `--observe` always observes; auto-snapshot still skips
      // reads, which is what keeps a browsing loop from paying for a snapshot
      // after every `text` or `exists`. The two were folded together while no
      // non-mutating command accepted the flag — `expect` does, because a
      // batch may only carry its one observation on the last step, and the
      // step worth ending on is the one that asserts the outcome.
      if (!command.observe && (!this.autoSnapshot || !isMutating(command.cmd))) return { value };
      const observation = await this.captureObservation();
      return observation ? { value, ...observation } : { value };
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Run several known commands in one queue slot.
   *
   * The queue slot is the point. Five commands sent one at a time are five
   * slots, and anything else addressing this session can land between them —
   * so the page an agent reasons about is not necessarily the page its next
   * step acts on. A batch is indivisible: nothing interleaves, and the single
   * observation at the end describes the whole flow.
   *
   * What a batch deliberately does not do: heal, retry or substitute a
   * selector. A failed step stops the rest (unless the caller opted out) and
   * carries whatever recovery snapshot the error already had. Choosing a
   * replacement target is the agent's decision, not the batch's.
   */
  runBatch(request: BatchRequest): Promise<BatchOutcome> {
    if (this.state !== 'open') {
      return Promise.reject(
        new CraftdriverError(
          ErrorCode.STATE_INVALID,
          'AgentSession is closing or closed; it cannot accept new commands'
        )
      );
    }

    const result = this.tail.then(async (): Promise<BatchOutcome> => {
      const { steps, observe } = request;
      const results: BatchStepResult[] = [];
      let failedStep: number | undefined;
      let sawMutation = false;
      // A ref failure already took a snapshot to build its recovery context,
      // which advanced the baseline. Observing again would render an empty
      // delta and cost a second snapshot for it.
      let recovered = false;

      for (const [index, step] of steps.entries()) {
        const command: AgentCommand = {
          cmd: step.cmd,
          args: step.args,
          // Only the last step can be observed, so only it needs the
          // navigation fence that keeps a submit-and-navigate from racing
          // the snapshot that follows it.
          ...(observe && index === steps.length - 1 ? { observe } : {}),
        };
        const started = performance.now();
        try {
          const value = await this.dispatchOne(command);
          results.push({
            index,
            cmd: step.cmd,
            ok: true,
            durationMs: Math.round(performance.now() - started),
            result: value,
          });
          if (isMutating(step.cmd)) sawMutation = true;
        } catch (error) {
          const wire = toWireError(error);
          results.push({
            index,
            cmd: step.cmd,
            ok: false,
            durationMs: Math.round(performance.now() - started),
            error: wire,
          });
          failedStep ??= index;
          recovered ||= wire.recoverySnapshot !== undefined;
          // Stop here. The remaining steps were written for a page state this
          // batch never reached, and running them anyway produces output that
          // reads like an application answer rather than a step that failed.
          if (!request.continueOnError) break;
        }
      }

      const skipped = steps.length - results.length;
      const observation =
        observe && sawMutation && !recovered ? await this.captureObservation() : null;
      // The tripwire is a journal read, not a snapshot, so it still answers
      // "did any step in this batch make the application throw" on the paths
      // that skipped the snapshot — a recovery snapshot, a read-only batch.
      const logs = observation?.logs ?? (observe ? this.takeLogTripwire().logs : undefined);
      return {
        ok: skipped === 0 && results.every((step) => step.ok),
        steps: boundBatchSteps(results),
        ran: results.length,
        skipped,
        ...(failedStep !== undefined ? { failedStep } : {}),
        // `page` is the richer answer and `delta` the cheaper one, but a
        // dialog or a failed snapshot only ever produces the note in `delta`
        // — so a `page` request falls back to it rather than reporting
        // nothing at all about why there is no page.
        ...(observe === 'page' && observation?.page
          ? { page: observation.page }
          : observation?.delta
            ? { delta: observation.delta }
            : {}),
        ...(logs ? { logs } : {}),
      };
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * The error tripwire for everything since the previous observation, moving
   * the baseline forward as it reports.
   *
   * Called exactly once per observation — it is a read *and* an advance, so
   * calling it twice would report the second window as empty.
   */
  private takeLogTripwire(): { logs?: LogTripwire } {
    // No capture at all (a Classic session has no journal events) is not the
    // same answer as "no errors", so say nothing rather than say zero.
    if (!this.journal.isCapturing) return {};
    const since = this.lastLogCursor;
    const { errors, dropped } = this.journal.countErrorsSince(since);
    this.lastLogCursor = this.journal.cursor;
    return {
      logs: { errors, logCursor: since, ...(dropped > 0 ? { logsDropped: dropped } : {}) },
    };
  }

  /** Dispatch one command, with the navigation fence and ref recovery. */
  private async dispatchOne(command: AgentCommand): Promise<AgentResult> {
    const args = command.args ?? {};
    try {
      return isObservedSubmit(command, this.autoSnapshot)
        ? await (
            await this.ctx.handle.get()
          )[INTERNAL_RUN_WITH_NAVIGATION_FENCE](() => this.dispatcher(this.ctx, command.cmd, args))
        : await this.dispatcher(this.ctx, command.cmd, args);
    } catch (error) {
      throw await withRefRecovery(this.ctx, command, error);
    }
  }

  /**
   * The one post-action snapshot, taken inside the caller's queue slot.
   *
   * Null means there was no browser to look at. Every other outcome — a
   * blocking dialog, a snapshot that could not be taken — is reported, because
   * "nothing changed" and "nothing could be seen" are different answers.
   */
  private async captureObservation(): Promise<Omit<AgentDetailedResult, 'value'> | null> {
    // Only if a browser is actually up: a fake dispatcher (or a command
    // that never needed a browser) must not cause a launch here.
    const browser = this.ctx.handle.peek();
    if (!browser) return null;

    // A modal dialog blocks script execution, so snapshotting behind one
    // stalls for the full WebDriver script timeout (measured: 60s) and
    // then fails anyway. Probing costs ~2ms and tells the agent the one
    // thing it actually needs to know here.
    const dialog = await peekDialog(browser);
    if (dialog !== null) {
      return {
        delta: `dialog open: ${dialog}\n(snapshot skipped — accept or dismiss it first)`,
        ...this.takeLogTripwire(),
      };
    }

    const before = this.ctx.tracker.current;
    const snap = await takeSnapshot(browser, this.ctx.tracker.minRef);
    // Counted after the snapshot, not before it: the round trip is a few tens
    // of milliseconds during which an error the action caused can still
    // arrive over BiDi. Reading the journal itself costs no round trip.
    if (!snap) {
      return {
        delta: 'post-action snapshot unavailable',
        snapshot: null,
        ...this.takeLogTripwire(),
      };
    }

    // Ordinary failures throw above. A failed action on a previously issued
    // ref is the one exception: its attached recovery snapshot advances the
    // baseline so the new refs in that error are immediately usable.
    const delta = this.ctx.tracker.advance(snap);
    const snapshot = this.ctx.tracker.current;
    return {
      ...(delta ? { delta } : {}),
      ...this.takeLogTripwire(),
      snapshot,
      ...(snapshot
        ? {
            page: {
              url: snapshot.url,
              title: snapshot.title,
              documentId: snapshot.documentId,
              revision: snapshot.revision,
              documentChange:
                before === null
                  ? 'unknown'
                  : before.documentId === snapshot.documentId
                    ? 'same'
                    : 'changed',
            },
          }
        : {}),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.state = 'closing';
    this.closePromise = this.tail
      .then(() => this.ctx.handle.close())
      .then(
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
        }
      );
    return this.closePromise;
  }
}
