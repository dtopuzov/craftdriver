/**
 * Bounded console and network history for a session.
 *
 * An agent's loop is act, then ask. That shape drives every decision here:
 *
 * - **Capture starts with the browser, not with the question.** Listeners are
 *   wired when the session's browser is first handed out, so an event that
 *   fires during the very first navigation is still answerable afterwards.
 * - **Every entry has a monotonic `seq`.** "What happened since my last
 *   command" is the actual question, and answering it by re-reading the whole
 *   buffer and diffing is both wasteful and wrong once eviction starts.
 * - **Waiting scans before it subscribes.** By the time an agent asks, the
 *   event it cares about has usually already arrived. A subscribe-only wait
 *   therefore times out on the common case rather than the rare one — see
 *   `tests/cli/journal-wait-race.test.ts`, which pins that behavior on the
 *   library's own `waitForConsole`.
 * - **Eviction is counted, never silent.** A caller that lost entries is told
 *   how many, because "no errors in the log" and "the errors fell off the end
 *   of the log" must not look alike.
 *
 * Bounds are on both entries and bytes: a page in a render loop hits the entry
 * cap, and a page logging serialized blobs hits the byte cap. Neither should
 * be able to grow a long-lived daemon without limit.
 */
import type { Browser } from '../lib/browser.js';

/** Entries retained per session before the oldest are evicted. */
export const MAX_JOURNAL_ENTRIES = 500;

/** Total retained text per session. Sized to stay well under a daemon's RSS. */
export const MAX_JOURNAL_BYTES = 512 * 1024;

/** Longest single retained text. Longer ones are truncated with a marker. */
export const MAX_ENTRY_TEXT = 2_000;

/**
 * `error` covers both uncaught exceptions and `console.error` output.
 *
 * They are recorded as distinct entries — an exception is kind `error`, a
 * `console.error` is kind `console` at level `error` — but a caller asking for
 * "errors" means both. Splitting them at the filter made
 * `logs --kind error` return nothing on a page that had loudly logged an
 * error, which is exactly the silent-empty answer this module exists to avoid.
 */
export type JournalKind = 'console' | 'error' | 'request' | 'response';

interface BaseEntry {
  /** Monotonic across the session; never reused, survives eviction. */
  seq: number;
  kind: JournalKind;
  /** ISO 8601, from the browser's own event timestamp where available. */
  time: string;
}

export interface ConsoleEntry extends BaseEntry {
  kind: 'console' | 'error';
  level: string;
  /** Console method (`log`, `warn`, …) or `exception` for a thrown error. */
  method: string;
  text: string;
  /** Top stack frame only — enough to locate, too little to be a dump. */
  origin?: string;
}

export interface NetworkEntry extends BaseEntry {
  kind: 'request' | 'response';
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  /** Browsing context id when the event carries one. */
  context?: string;
}

export type JournalEntry = ConsoleEntry | NetworkEntry;

export interface JournalQuery {
  /** Return entries with `seq` strictly greater than this. */
  since?: number;
  kinds?: JournalKind[];
  /**
   * Console level filter (`error`, `warn`, …). Implies console entries: a
   * network row has no level, and returning one alongside the warnings an
   * agent asked for is noise, not a match.
   */
  level?: string;
  /** Substring match against text or URL. */
  contains?: string;
  limit?: number;
}

export interface JournalPage {
  entries: JournalEntry[];
  /** Highest `seq` issued so far — pass back as `since` next time. */
  cursor: number;
  /** Entries evicted over the session's lifetime. */
  dropped: number;
  /**
   * Entries evicted that the caller had not yet read, i.e. those at or below
   * the requested `since` boundary that no longer exist. Non-zero means this
   * page has a hole in it.
   */
  droppedBeforeCursor: number;
  /** True when `limit` cut the result short. */
  truncated: boolean;
}

/**
 * The error tripwire carried by an observation.
 *
 * An action can make the application throw while changing nothing an a11y
 * snapshot can see, and the observation then reported `(no a11y changes)` —
 * which reads as "all clear". The alternative was for an agent to spend a
 * `logs` call after every single action, doubling the round trips batching
 * exists to remove. This is the cheap middle: not the log contents, just
 * enough to decide whether reading them is worth a call, and the cursor that
 * reads exactly the window counted.
 */
export interface LogTripwire {
  /**
   * Errors since the previous observation — uncaught exceptions and
   * `console.error` alike, matching what `logs --kind error` returns.
   */
  errors: number;
  /** Pass as `--since` (CLI) or `since` (MCP) to read that same window. */
  logCursor: number;
  /**
   * *Error* entries evicted inside the window, which makes `errors` a lower
   * bound. Absent — not zero — in the ordinary case where nothing was lost.
   *
   * Deliberately not "entries evicted": a busy page evicts network rows
   * constantly, and reporting those made every observation on a chatty page
   * claim its error count was unreliable when no error had been lost at all.
   * Counting the errors specifically is what lets `expect no-errors` treat a
   * hole as undecidable rather than as noise.
   */
  logsDropped?: number;
  /**
   * Present, and false, when `logsDropped` is an upper bound rather than a
   * figure — the window reaches back past the evicted errors the journal still
   * has sequence numbers for.
   *
   * It takes more than {@link MAX_JOURNAL_ENTRIES} evicted errors to get here,
   * so it is rare; it is carried anyway because a number an agent quotes into
   * a report should not be more precise than the thing that produced it.
   */
  logsDroppedExact?: false;
  /**
   * Present, and false, when the ordering barrier could not be taken — the
   * driver would not answer, so events the action caused may not have been
   * delivered yet.
   *
   * `errors: 0` is an affirmative answer everywhere else on this surface, and
   * an unsettled zero is not one. Reported rather than omitted so a *non*-zero
   * count, which is still true, is not thrown away with it.
   */
  logsSettled?: false;
}

/**
 * One line for the surfaces that render text rather than JSON.
 *
 * Emitted even when the count is zero: the hole this closes is an observation
 * that *implied* all-clear by saying nothing, so silence is exactly the answer
 * to avoid.
 */
export function formatLogTripwire(logs: LogTripwire): string {
  const count =
    logs.logsDroppedExact === false ? `up to ${logs.logsDropped}` : `${logs.logsDropped}`;
  const dropped =
    logs.logsDropped !== undefined
      ? `; ${count} evicted before they could be read, so this is a lower bound`
      : '';
  const unsettled =
    logs.logsSettled === false
      ? '; the driver would not confirm delivery, so a late error may be missing'
      : '';
  return `errors: ${logs.errors} (logCursor ${logs.logCursor}${dropped}${unsettled})`;
}

/**
 * Is this entry one a caller asking for "errors" means?
 *
 * The union `logs --kind error` matches: a thrown exception is kind `error`,
 * and a `console.error` is kind `console` at level `error`. One definition,
 * because the filter and the eviction accounting disagreeing about what an
 * error is would make the tripwire quietly wrong rather than visibly broken.
 */
function isErrorEntry(entry: JournalEntry): boolean {
  return entry.kind === 'error' || ('level' in entry && entry.level === 'error');
}

function truncate(text: string): string {
  if (text.length <= MAX_ENTRY_TEXT) return text;
  return `${text.slice(0, MAX_ENTRY_TEXT)}… (${text.length - MAX_ENTRY_TEXT} more chars)`;
}

/** Approximate retained size of an entry. Exact byte accounting is not worth
 * a serialization pass per event; this tracks the fields that actually grow. */
function entrySize(entry: JournalEntry): number {
  return entryText(entry).length + 128;
}

/**
 * The growing field of an entry, for filtering and size accounting.
 *
 * Narrowed on the property rather than on `kind`: both members carry a union
 * of `kind` values, which is not a discriminant TypeScript can narrow through.
 */
function entryText(entry: JournalEntry): string {
  return 'text' in entry ? entry.text : entry.url;
}

/**
 * Does `entry` satisfy `q`?
 *
 * One implementation for both `query` and `waitFor`: they had the same
 * predicate written twice, and a filter that behaves differently depending on
 * whether you polled or waited would be a genuinely confusing bug.
 */
function matchesQuery(entry: JournalEntry, q: JournalQuery): boolean {
  if (entry.seq <= (q.since ?? 0)) return false;

  if (q.kinds && q.kinds.length > 0) {
    const wantsError = q.kinds.includes('error');
    // `console.error` is kind `console`; a caller asking for errors wants it.
    if (!q.kinds.includes(entry.kind) && !(wantsError && isErrorEntry(entry))) return false;
  }

  if (q.level && (!('level' in entry) || entry.level !== q.level)) return false;

  if (q.contains && !entryText(entry).toLowerCase().includes(q.contains.toLowerCase())) {
    return false;
  }
  return true;
}

type Waiter = {
  match: (entry: JournalEntry) => boolean;
  /** Called with null when the session shuts down before a match arrives. */
  resolve: (entry: JournalEntry | null) => void;
};

export class SessionJournal {
  private entries: JournalEntry[] = [];
  private bytes = 0;
  private nextSeq = 1;
  private droppedTotal = 0;
  /** Highest `seq` that has been evicted, so a reader can detect a hole. */
  private highestDroppedSeq = 0;
  /**
   * `seq` of every evicted *error*, newest last.
   *
   * A single total would not do: a caller asks about a window (`since`), and
   * how many errors were lost inside one cannot be recovered from a lifetime
   * count. The list is capped like the buffer itself, so it answers exactly
   * for any window that starts at or after {@link forgottenErrorMaxSeq} —
   * every window a caller can realistically hold a cursor for.
   */
  private droppedErrorSeqs: number[] = [];
  /**
   * Evicted errors old enough to have fallen off that list, and the highest
   * `seq` among them.
   *
   * Past this point the window count is an upper bound rather than a figure:
   * these errors are known to have been lost, but not whether each one was
   * inside a window that starts before `forgottenErrorMaxSeq`. It takes more
   * than {@link MAX_JOURNAL_ENTRIES} evicted errors to get here, and the
   * answer stays safe in the direction that matters — an error lost inside the
   * window is never reported as zero.
   */
  private forgottenErrors = 0;
  private forgottenErrorMaxSeq = 0;
  private waiters = new Set<Waiter>();
  private detachers: Array<() => void> = [];
  private attached = false;
  /**
   * The browser currently wired up.
   *
   * Identity matters, not just "have we attached once". `quit` closes the
   * browser and the next command launches a new one; treating attach as a
   * no-op because it had already run left the journal wired to a dead browser,
   * silently capturing nothing while still answering queries with an empty
   * list — which reads as "the page was quiet".
   */
  private attachedTo: Browser | null = null;

  /** Whether capture is live. False when the browser has no BiDi session. */
  get isCapturing(): boolean {
    return this.attached;
  }

  /**
   * Wire listeners onto a launched browser.
   *
   * Console and network history are BiDi-only. Rather than throwing — which
   * would make an unrelated command fail on a Classic session — this records
   * that capture is off, and the query commands report it.
   */
  attach(browser: Browser): void {
    // Same browser: already wired, and re-wiring would double-record.
    if (this.attached && this.attachedTo === browser) return;
    // Different browser: drop the old listeners before wiring the new one.
    if (this.attachedTo !== null) this.releaseListeners();

    try {
      const logs = browser.logs;
      this.detachers.push(
        logs.onLog((message) => {
          const isError = message.type === 'javascript';
          const frame = message.stackTrace?.[0];
          this.record({
            seq: 0,
            kind: isError ? 'error' : 'console',
            time: message.timestamp.toISOString(),
            level: message.level,
            method: message.type === 'console' ? message.method : 'exception',
            text: truncate(message.text ?? ''),
            ...(frame ? { origin: `${frame.url}:${frame.lineNumber}` } : {}),
          });
        }),
      );
    } catch {
      // No BiDi: `browser.logs` throws. Leave capture off rather than
      // failing the command that happened to launch the browser.
      return;
    }

    try {
      const network = browser.network;
      // Deliberately no bodies, cookies, or headers of any kind: they are
      // bulky, rarely what an agent is asking about, and an Authorization
      // header is pure liability in a log.
      //
      // URLs are recorded whole, query string included, so a token passed as
      // a query parameter does appear here. That is deliberate: the URL is
      // the one part an agent actually needs to identify a request, and it is
      // returned only when the caller asks for logs. The journal itself keeps
      // it in memory and never persists or transmits it independently, but a
      // CLI/MCP caller can put that URL into an agent transcript. That is the
      // real boundary; headers, cookies and bodies are never captured.
      this.detachers.push(
        network.on('request', (req) => {
          this.record({
            seq: 0,
            kind: 'request',
            time: new Date().toISOString(),
            url: truncate(req.url),
            method: req.method,
            ...(req.context ? { context: req.context } : {}),
          });
        }),
      );
      this.detachers.push(
        network.on('response', (res) => {
          this.record({
            seq: 0,
            kind: 'response',
            time: new Date().toISOString(),
            url: truncate(res.url),
            // The response event carries no browsing context, so a response
            // is attributed browser-wide rather than to a page. Requests do
            // carry one; the asymmetry is the protocol's, not a lapse here.
            method: res.request.method,
            ...(res.status !== undefined ? { status: res.status } : {}),
            ...(res.mimeType ? { mimeType: res.mimeType } : {}),
          });
        }),
      );
    } catch {
      // Console capture may still be live; network simply stays off.
    }

    this.attached = true;
    this.attachedTo = browser;
  }

  /** Unsubscribe from the current browser without ending the journal. */
  private releaseListeners(): void {
    for (const off of this.detachers.splice(0)) {
      try {
        off();
      } catch {
        /* the browser is going away regardless */
      }
    }
    this.attached = false;
    this.attachedTo = null;
  }

  private record(entry: JournalEntry): void {
    entry.seq = this.nextSeq++;
    this.entries.push(entry);
    this.bytes += entrySize(entry);
    this.evict();

    // Notify after eviction so a waiter can never be handed an entry that is
    // already gone from the buffer.
    for (const waiter of [...this.waiters]) {
      if (waiter.match(entry)) {
        this.waiters.delete(waiter);
        waiter.resolve(entry);
      }
    }
  }

  private evict(): void {
    while (
      this.entries.length > MAX_JOURNAL_ENTRIES ||
      (this.bytes > MAX_JOURNAL_BYTES && this.entries.length > 1)
    ) {
      const gone = this.entries.shift();
      if (!gone) break;
      this.bytes -= entrySize(gone);
      this.droppedTotal++;
      this.highestDroppedSeq = gone.seq;
      if (isErrorEntry(gone)) {
        this.droppedErrorSeqs.push(gone.seq);
        if (this.droppedErrorSeqs.length > MAX_JOURNAL_ENTRIES) {
          this.forgottenErrorMaxSeq = this.droppedErrorSeqs.shift() ?? 0;
          this.forgottenErrors++;
        }
      }
    }
  }

  /**
   * Errors evicted with `seq` greater than `since`.
   *
   * `exact` is false only once more errors have been evicted than the list
   * retains *and* the window reaches back into the part it no longer holds;
   * the count is then an upper bound. Never an under-count either way, which
   * is the direction an assertion depends on.
   */
  private droppedErrorsSince(since: number): { dropped: number; exact: boolean } {
    const listed = this.droppedErrorSeqs.filter((seq) => seq > since).length;
    if (since >= this.forgottenErrorMaxSeq) return { dropped: listed, exact: true };
    return { dropped: listed + this.forgottenErrors, exact: false };
  }

  /** Highest `seq` issued so far — the value a reader passes back as `since`. */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  /**
   * Count errors after `since`, without materialising them.
   *
   * Counting rather than querying is the point: this runs after every observed
   * action, and the caller has explicitly not asked for the entries. `dropped`
   * is reported for the same reason eviction is reported everywhere else here
   * — "no errors" and "the errors fell off the end of the buffer" must not
   * look alike.
   */
  countErrorsSince(since = 0): { errors: number; dropped: number; droppedExact: boolean } {
    const q: JournalQuery = { since, kinds: ['error'] };
    let errors = 0;
    for (const entry of this.entries) {
      if (matchesQuery(entry, q)) errors++;
    }
    // `dropped` counts evicted *errors*, not evicted entries. A page making a
    // request per frame evicts constantly while logging nothing, and reporting
    // that as a hole in the error count cried wolf on every busy page — which
    // is worse than silence, because it is the signal `expect no-errors` has
    // to be able to act on.
    const { dropped, exact } = this.droppedErrorsSince(since);
    return { errors, dropped, droppedExact: exact };
  }

  query(q: JournalQuery = {}): JournalPage {
    const since = q.since ?? 0;
    const matched = this.entries.filter((entry) => matchesQuery(entry, q));

    const limit = q.limit ?? MAX_JOURNAL_ENTRIES;
    // Keep the newest when cutting: an agent asking "what just happened"
    // wants the tail, not the head.
    const truncated = matched.length > limit;
    const entries = truncated ? matched.slice(-limit) : matched;

    return {
      entries,
      cursor: this.nextSeq - 1,
      dropped: this.droppedTotal,
      droppedBeforeCursor: this.highestDroppedSeq > since ? this.highestDroppedSeq - since : 0,
      truncated,
    };
  }

  /**
   * Resolve with the first entry matching `q`, scanning what is already
   * buffered before subscribing.
   *
   * The scan-first order is the whole point: the event an agent asks about
   * has usually already arrived. Returns null on timeout rather than
   * throwing, so the caller decides whether absence is an error.
   */
  waitFor(q: JournalQuery, timeoutMs: number): Promise<JournalEntry | null> {
    const existing = this.query({ ...q, limit: 1 });
    if (existing.entries.length > 0) return Promise.resolve(existing.entries[0]);

    const match = (entry: JournalEntry): boolean => matchesQuery(entry, q);

    return new Promise((resolve) => {
      const waiter: Waiter = { match, resolve: (entry) => { clearTimeout(timer); resolve(entry); } };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      // Do not hold the process open for a wait nobody is blocked on.
      timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  /**
   * Drop retained entries.
   *
   * The sequence counter deliberately survives, for the same reason snapshot
   * refs do: a cursor an agent still holds must not start matching new
   * entries after a clear.
   */
  clear(): void {
    this.entries = [];
    this.bytes = 0;
    // The eviction bookkeeping goes too. A caller that discarded the history
    // on purpose is not owed "some of what you threw away was an error" for
    // the rest of the session — and without this, one eviction would leave
    // `expect no-errors` permanently undecidable, with no way back.
    this.droppedErrorSeqs = [];
    this.forgottenErrors = 0;
    this.forgottenErrorMaxSeq = 0;
  }

  /** Stop capturing and release listeners and pending waiters. */
  detach(): void {
    this.releaseListeners();
    // Release anyone blocked: a shutdown must not leave a caller waiting out
    // the full timeout for an event that can no longer arrive.
    for (const waiter of this.waiters) waiter.resolve(null);
    this.waiters.clear();
  }
}
