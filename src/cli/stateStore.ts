/**
 * Safe on-disk storage for authentication/session state.
 *
 * A saved state file holds live session cookies — it is a credential, not a
 * fixture. Three properties follow from that, and each is enforced here rather
 * than at the call site:
 *
 * - **Files live under one owned root.** Callers name a file, not a path, so a
 *   command can never be talked into writing over `~/.ssh/config` or reading
 *   an arbitrary file back into a browser. The root is `CRAFTDRIVER_STATE_DIR`
 *   when set, else `.craftdriver/state` under the working directory.
 * - **Symlinks cannot escape it.** Containment is checked against the resolved
 *   real path of the deepest existing ancestor, so a symlink planted inside
 *   the root does not widen it.
 * - **Nothing is half-written and nothing is world-readable.** Writes land on
 *   a temp file created `0600` and are renamed into place, so a reader sees
 *   either the old file or the new one, never a truncated JSON document.
 *
 * Callers must also never print what these files contain — see
 * `summarizeState`, which is deliberately the only reporting path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import type { SessionState } from '../lib/bidi/types.js';
import {
  artifactRoot,
  resolveArtifactPath,
  validateArtifactName,
  prepareTempPath,
  commitFile,
  discardTempFile,
  MAX_ARTIFACT_NAME,
} from './artifactPaths.js';

/** Owned root for state files, overridable for tests and CI sandboxes. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return artifactRoot('state', 'CRAFTDRIVER_STATE_DIR', env);
}

/** Longest accepted state name. Kept exported for the error-message tests. */
export const MAX_STATE_NAME = MAX_ARTIFACT_NAME;

/**
 * Normalize and validate an untrusted state name.
 *
 * The rule is shared with every other CLI-owned artifact — see
 * `artifactPaths.ts` — so a name that is safe as a path component is safe for
 * all of them, and there is only one place to get it wrong.
 */
export function validateStateName(raw: unknown): string {
  return validateArtifactName(raw, 'state', stateRoot());
}

/**
 * Full path for a state name, guaranteed to sit inside the owned root.
 */
export async function resolveStatePath(name: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return resolveArtifactPath({
    root: stateRoot(env),
    name,
    suffix: '.json',
    kind: 'state',
  });
}

/** @see prepareTempPath */
export const prepareTempStatePath = prepareTempPath;
/** @see commitFile */
export const commitStateFile = commitFile;
/** @see discardTempFile */
export const discardTempStateFile = discardTempFile;

/**
 * Read and structurally validate a state file.
 *
 * The file is JSON that will be fed back into a browser, so a malformed or
 * hand-edited one should fail here with a clear message rather than deep
 * inside cookie restoration.
 */
export async function readStateFile(target: string, name: string): Promise<SessionState> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf-8');
  } catch {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `state: no saved state named ${JSON.stringify(name)}`,
      {
        detail: { root: path.dirname(target) },
        hint: 'save one first with `craftdriver state save <name>`, or `state list` to see what exists',
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `state: ${JSON.stringify(name)} is not valid JSON`,
      { hint: 'the file is corrupt or was edited by hand; save it again' },
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `state: ${JSON.stringify(name)} is not a state object`,
      { hint: 'expected an object with optional "cookies", "localStorage" and "sessionStorage"' },
    );
  }

  const state = parsed as SessionState;
  if (state.cookies !== undefined && !Array.isArray(state.cookies)) {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `state: ${JSON.stringify(name)} has a non-array "cookies"`,
    );
  }
  return state;
}

/** Origins whose storage a state file carries. */
export function stateOrigins(state: SessionState): string[] {
  const origins = new Set<string>();
  for (const key of Object.keys(state.localStorage ?? {})) origins.add(key);
  for (const key of Object.keys(state.sessionStorage ?? {})) origins.add(key);
  return [...origins];
}

export interface StateSummary {
  cookies: number;
  origins: string[];
  storageKeys: number;
}

/**
 * Reportable shape of a state file: counts and origins, never values.
 *
 * Cookie names and storage keys are omitted too. They are not secrets in the
 * way values are, but they are unnecessary to the caller and land in agent
 * transcripts and CI logs, so the useful-to-leaky trade is not worth it.
 */
export function summarizeState(state: SessionState): StateSummary {
  let storageKeys = 0;
  for (const bucket of [state.localStorage, state.sessionStorage]) {
    for (const entries of Object.values(bucket ?? {})) {
      storageKeys += Object.keys(entries ?? {}).length;
    }
  }
  return {
    cookies: state.cookies?.length ?? 0,
    origins: stateOrigins(state),
    storageKeys,
  };
}

/** Saved state names under the root, without the `.json` suffix. */
export async function listStateNames(env?: NodeJS.ProcessEnv): Promise<string[]> {
  const root = stateRoot(env);
  try {
    const entries = await fs.readdir(root);
    return entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}
