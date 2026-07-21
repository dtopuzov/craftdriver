/**
 * Project scoping for the daemon and for CLI-owned artifacts.
 *
 * The socket and PID were user-global while requests carried only a session
 * name, so a daemon started in project A answered project B: same browser,
 * same cookies, same refs. Artifacts compounded it — they resolved from the
 * daemon's own working directory, so `state save` in project B wrote into
 * project A's tree.
 *
 * What is pinned here: two projects never share a socket, the same project
 * always resolves to one socket regardless of the subdirectory a command runs
 * from, and artifacts follow the project rather than the process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot, daemonDir } from '../../src/cli/defaults';
import { artifactRoot } from '../../src/cli/artifactPaths';

let projectA: string;
let projectB: string;
let nested: string;
let cwd: string;

beforeAll(() => {
  cwd = process.cwd();
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cd-scope-')));
  projectA = path.join(base, 'alpha');
  projectB = path.join(base, 'beta');
  nested = path.join(projectA, 'packages', 'inner');
  mkdirSync(nested, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(path.join(projectA, 'package.json'), '{"name":"alpha"}');
  writeFileSync(path.join(projectB, 'package.json'), '{"name":"beta"}');
});

afterAll(() => {
  process.chdir(cwd);
});

describe('project scoping', () => {
  it('finds the nearest ancestor holding a package.json', () => {
    process.chdir(nested);
    expect(projectRoot()).toBe(projectA);
  });

  it('gives two projects different daemon sockets', () => {
    expect(daemonDir(projectA)).not.toBe(daemonDir(projectB));
  });

  it('gives one project the same socket from any subdirectory', () => {
    // Otherwise `craftdriver click` from packages/inner would silently start
    // a second browser instead of reusing the session the agent set up.
    process.chdir(nested);
    const fromNested = daemonDir(projectRoot());
    process.chdir(projectA);
    const fromRoot = daemonDir(projectRoot());
    expect(fromNested).toBe(fromRoot);
  });

  it('anchors artifacts to the project, not the working directory', () => {
    process.chdir(nested);
    expect(artifactRoot('state', 'CRAFTDRIVER_STATE_DIR', {})).toBe(
      path.join(projectA, '.craftdriver', 'state'),
    );
    expect(artifactRoot('traces', 'CRAFTDRIVER_TRACE_DIR', {})).toBe(
      path.join(projectA, '.craftdriver', 'traces'),
    );
  });

  it('writes one project\'s artifacts outside the other project', () => {
    process.chdir(projectA);
    const a = artifactRoot('state', 'CRAFTDRIVER_STATE_DIR', {});
    process.chdir(projectB);
    const b = artifactRoot('state', 'CRAFTDRIVER_STATE_DIR', {});

    expect(a).not.toBe(b);
    expect(b.startsWith(projectA)).toBe(false);
  });

  it('still honours an explicit artifact directory override', () => {
    process.chdir(projectA);
    expect(
      artifactRoot('state', 'CRAFTDRIVER_STATE_DIR', { CRAFTDRIVER_STATE_DIR: projectB }),
    ).toBe(projectB);
  });
});
