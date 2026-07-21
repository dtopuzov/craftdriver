/**
 * Secure writer for credential-bearing state files.
 *
 * A saved `SessionState` holds live session cookies, so it is written the way a
 * credential file should be: the parent directory is created, an existing
 * symlink at the destination is refused, the content is written to a
 * same-directory temporary file with owner-only permissions, and that temp file
 * is atomically renamed into place. A crash therefore never leaves a
 * half-written file, and the bytes never pass through a symlink that could
 * redirect them elsewhere.
 *
 * POSIX permissions are best-effort — Windows ignores the mode, so callers must
 * not assume `0600` there. This module is intentionally free of any CLI
 * dependency so the public library owns its own persistence discipline.
 */
import fs from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { CraftdriverError, ErrorCode } from './errors.js';

/**
 * Atomically write `contents` to `destPath` with owner-only permissions.
 *
 * @throws {CraftdriverError} `INVALID_ARGUMENT` if the destination already
 *   exists as a symlink.
 */
export async function writeSecureFile(destPath: string, contents: string): Promise<void> {
  const abs = resolve(destPath);
  const dir = dirname(abs);

  await fs.mkdir(dir, { recursive: true });

  // Refuse an existing symlink at the destination: writing "through" it could
  // land the credentials outside `dir`. (The atomic rename below already
  // replaces a link rather than following it, so this is a clear error rather
  // than the load-bearing defense.)
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `refusing to write state through a symlink: ${abs}`
      );
    }
  } catch (err) {
    if (err instanceof CraftdriverError) throw err;
    // ENOENT is the normal case (destination does not exist yet); anything else
    // (e.g. EACCES on the path) surfaces when we try to write below.
  }

  const tmp = join(dir, `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    // `wx` fails if the temp name somehow exists; `mode` requests owner-only at
    // creation. chmod after is belt-and-suspenders for platforms/umasks that do
    // not honor the create mode.
    await fs.writeFile(tmp, contents, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await fs.chmod(tmp, 0o600).catch(() => {
      /* Windows / unsupported fs — mode is best-effort */
    });
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {
      /* nothing to clean up */
    });
    throw err;
  }
}
