/**
 * Named session registry for the daemon.
 *
 * The daemon used to own exactly one `AgentSession`, which made the browser,
 * the selected page, the snapshot baseline and the ref registry global to the
 * process. Two concurrent workflows on one daemon stepped on each other with
 * no way to opt out short of running a second daemon.
 *
 * A session is now addressed by name (`--session <name>`, default
 * `default`). Each owns its own browser and its own `SnapshotTracker`, so
 * refs, baselines, page selection and dialog state never cross. Creation is
 * lazy — naming a session costs nothing until a command needs a browser —
 * and bounded, because every live session is a real browser process.
 */
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import type { AgentSessionRunner } from './agentSession.js';

/** Session used by callers that pass no `--session`. */
export const DEFAULT_SESSION = 'default';

/**
 * Maximum live sessions per daemon.
 *
 * Each one is a browser process, so this is a memory bound, not a bookkeeping
 * one. Creation past the cap fails loudly rather than evicting: silently
 * quitting someone else's browser would strand every ref they hold.
 */
export const MAX_SESSIONS = 8;

/** Upper bound on a session name, in characters. */
export const MAX_SESSION_NAME = 32;

// Deliberately narrower than "a valid filename": the auth/storage-state work
// turns a session name into a path component under an owned artifact
// directory, and a name that cannot contain `.`, `/`, `\` or a leading `-`
// cannot traverse, hide, or be mistaken for a flag. Validate once, here, so
// that slice inherits a safe name instead of re-deriving the rule.
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Normalize and validate an untrusted session name.
 *
 * Called on the CLI side before any socket or filesystem effect, and again on
 * the daemon side because a socket peer is not the CLI.
 */
export function validateSessionName(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_SESSION;
  if (typeof raw !== 'string') {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `session name must be a string, got ${typeof raw}`,
      { hint: `use letters, digits, "-" and "_" (max ${MAX_SESSION_NAME} chars)` },
    );
  }
  if (raw.length === 0 || raw.length > MAX_SESSION_NAME || !SESSION_NAME.test(raw)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `invalid session name ${JSON.stringify(raw)}`,
      {
        detail: { maxLength: MAX_SESSION_NAME },
        hint: `must start with a letter or digit and use only letters, digits, "-" and "_" (max ${MAX_SESSION_NAME} chars)`,
      },
    );
  }
  return raw;
}

export interface SessionInfo {
  name: string;
  /** ISO timestamp of first use, so a stuck session is identifiable. */
  createdAt: string;
}

export interface SessionRegistry {
  /** The session for `name`, creating it on first use. */
  get(name: string): AgentSessionRunner;
  /** Live sessions, in creation order. Creates nothing. */
  list(): SessionInfo[];
  /** Close one session. Resolves false if there was nothing to close. */
  close(name: string): Promise<boolean>;
  /** Close every session; used on daemon shutdown. */
  closeAll(): Promise<void>;
}

export interface SessionRegistryOptions {
  create: (name: string) => AgentSessionRunner;
  /** Override the cap; tests use it, the daemon does not. */
  limit?: number;
}

export function createSessionRegistry(opts: SessionRegistryOptions): SessionRegistry {
  const limit = opts.limit ?? MAX_SESSIONS;
  const sessions = new Map<string, { session: AgentSessionRunner; createdAt: string }>();

  return {
    get(name: string): AgentSessionRunner {
      const existing = sessions.get(name);
      if (existing) return existing.session;
      if (sessions.size >= limit) {
        throw new CraftdriverError(
          ErrorCode.STATE_INVALID,
          `session limit reached: ${limit} sessions are already open`,
          {
            detail: { limit, open: [...sessions.keys()] },
            hint: 'close one with `craftdriver session close <name>`, or reuse an open session',
          },
        );
      }
      const session = opts.create(name);
      sessions.set(name, { session, createdAt: new Date().toISOString() });
      return session;
    },

    list(): SessionInfo[] {
      return [...sessions.entries()].map(([name, entry]) => ({
        name,
        createdAt: entry.createdAt,
      }));
    },

    async close(name: string): Promise<boolean> {
      const entry = sessions.get(name);
      if (!entry) return false;
      // Drop the slot first: a close that rejects must still free the name,
      // or a session whose browser died becomes an unreleasable slot.
      sessions.delete(name);
      try {
        await entry.session.close();
      } catch {
        /* the browser is going away regardless */
      }
      return true;
    },

    async closeAll(): Promise<void> {
      const names = [...sessions.keys()];
      await Promise.all(names.map((name) => this.close(name)));
    },
  };
}
