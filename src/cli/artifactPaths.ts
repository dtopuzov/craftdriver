/**
 * Shared path safety for CLI-owned artifact directories.
 *
 * Saved login state and traces both write files a name chooses, under a root
 * craftdriver owns. The rules are identical and security-relevant — a name is
 * never a path, and a symlink must not widen the root — so they live here once
 * rather than being reimplemented per artifact kind. The one place this
 * codebase already copied helpers between modules (`locatorCandidates` from
 * `snapshot`) is recorded as a mistake because the copies then diverged.
 *
 * Callers supply the root and the kind label; the rules do not vary.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { projectRoot } from './defaults.js';

/**
 * Accepted artifact names.
 *
 * Deliberately narrower than "a valid filename": with no `.`, `/` or `\` a
 * name cannot traverse or hide, and a required leading alphanumeric means it
 * can never be read as a flag.
 */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MAX_ARTIFACT_NAME = 64;

export function validateArtifactName(raw: unknown, kind: string, root: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `${kind}: a name is required`, {
      hint: `pass a bare name, e.g. \`${kind} save alice\``,
    });
  }
  // Reported apart from the charset rule: a caller passing a path is making a
  // different mistake than one passing "my file", and the fix differs.
  if (raw.includes('/') || raw.includes('\\') || raw.includes('.')) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `${kind}: ${JSON.stringify(raw)} is a name, not a path`,
      {
        detail: { root },
        hint: `pass a bare name like \`alice\`; files are kept under the ${kind} root`,
      },
    );
  }
  if (raw.length > MAX_ARTIFACT_NAME || !ARTIFACT_NAME.test(raw)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `${kind}: invalid name ${JSON.stringify(raw)}`,
      {
        detail: { maxLength: MAX_ARTIFACT_NAME },
        hint: `must start with a letter or digit and use only letters, digits, "-" and "_" (max ${MAX_ARTIFACT_NAME} chars)`,
      },
    );
  }
  return raw;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve the real path of the deepest ancestor of `target` that exists.
 *
 * Checking `realpath(target)` alone is not enough: the target usually does not
 * exist yet when writing, and a symlinked *directory* in the middle of the
 * path is exactly the escape this guards against.
 */
async function realpathOfExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Full path for `<name><suffix>` inside `root`, proven to stay there.
 *
 * Creates the root (mode 0700) as a side effect so readers and writers agree
 * on where it is even on a first run.
 */
export async function resolveArtifactPath(opts: {
  root: string;
  name: string;
  /** `.json` for state; empty for a trace directory. */
  suffix?: string;
  /** Used in error messages: `state`, `trace`. */
  kind: string;
}): Promise<string> {
  const { root, kind } = opts;
  const validated = validateArtifactName(opts.name, kind, root);
  const target = path.join(root, `${validated}${opts.suffix ?? ''}`);

  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  const realRoot = await fs.realpath(root);
  const realAncestor = await realpathOfExistingAncestor(target);
  // Either the root itself (target not created yet) or the target, which must
  // resolve to something inside the root.
  if (realAncestor !== realRoot && !isInside(realRoot, realAncestor)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `${kind}: ${JSON.stringify(opts.name)} resolves outside the ${kind} root`,
      {
        detail: { root: realRoot },
        hint: `a symlink in the ${kind} directory points elsewhere; remove it`,
      },
    );
  }
  return target;
}

/**
 * Prepare a temp path next to `target`, pre-created with owner-only
 * permissions.
 *
 * Opened `wx` (`O_EXCL`), which is what makes the mode guarantee real: plain
 * `w` follows an existing symlink and ignores the mode argument, so a
 * leftover or planted entry would silently redirect the write and leave the
 * mode unset. The random suffix keeps concurrent writers from colliding.
 */
export async function prepareTempPath(target: string): Promise<string> {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  await handle.close();
  return tmp;
}

/** Move a fully written temp file into place. */
export async function commitFile(tmp: string, target: string): Promise<void> {
  try {
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Best-effort cleanup for a failed write. */
export async function discardTempFile(tmp: string): Promise<void> {
  await fs.rm(tmp, { force: true }).catch(() => {});
}

/**
 * Root for a CLI-owned artifact kind, overridable by env.
 *
 * Anchored to the project root rather than `process.cwd()`. The daemon is a
 * long-lived process with its own working directory, so resolving from `cwd`
 * meant saved state and traces landed wherever the daemon happened to be
 * started — and, before the socket was project-scoped, in a different project
 * entirely. Anchoring also makes a run from a subdirectory address the same
 * artifacts as one from the repository root.
 */
export function artifactRoot(kind: 'state' | 'traces' | 'screenshots', envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[envVar];
  return override && override.length > 0
    ? path.resolve(override)
    : path.resolve(projectRoot(), '.craftdriver', kind);
}
