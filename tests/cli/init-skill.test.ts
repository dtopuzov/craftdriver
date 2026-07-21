import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/init.js';
import { main } from '../../src/cli/index.js';
import { parseArgv } from '../../src/cli/parseArgs.js';

const LEGACY_TARGETS = {
  agents: 'AGENTS.md',
  copilot: '.github/copilot-instructions.md',
  claude: 'CLAUDE.md',
  cursor: '.cursor/rules/craftdriver.mdc',
  gemini: 'GEMINI.md',
} as const;

const MCP_SNIPPET = `[mcp_servers.craftdriver]
command = "npx"
args = ["--no-install", "craftdriver", "mcp"]`;

interface ExpectedInitResult {
  projectRoot: string;
  destination: string;
  status: 'installed' | 'updated' | 'unchanged' | 'would-install' | 'would-update';
  files: string[];
  dryRun: boolean;
  mcpSnippet?: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'craftdriver-init-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function init(
  cwd: string,
  options: { dryRun?: boolean; mcp?: boolean; force?: boolean } = {},
): ExpectedInitResult {
  return runInit({ flavor: 'codex' as never, cwd, ...options }) as unknown as ExpectedInitResult;
}

describe('safe project-local skill installer', () => {
  it.each(Object.entries(LEGACY_TARGETS))(
    'legacy init %s creates no instruction file',
    (flavor, target) => {
      const root = project();
      let error: unknown;
      try {
        runInit({ flavor: flavor as keyof typeof LEGACY_TARGETS, cwd: root });
      } catch (caught) {
        error = caught;
      }

      expect(existsSync(join(root, target))).toBe(false);
      expect(String((error as Error | undefined)?.message)).toContain('craftdriver init codex');
    },
  );

  it('legacy init all leaves every existing instruction file byte-identical', () => {
    const root = project();
    const before = Buffer.from('user-owned\0instructions\n');
    for (const target of Object.values(LEGACY_TARGETS)) writeFileBytes(root, target, before);

    let error: unknown;
    try {
      runInit({ flavor: 'all', cwd: root, force: true });
    } catch (caught) {
      error = caught;
    }

    for (const target of Object.values(LEGACY_TARGETS)) {
      expect(readFileSync(join(root, target))).toEqual(before);
    }
    expect(String((error as Error | undefined)?.message)).toContain('craftdriver init codex');
  });

  it('installs the package skill at the nearest project root', () => {
    const root = project();
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    const result = init(nested);
    const canonicalRoot = realpathSync(root);
    const destination = join(canonicalRoot, '.agents', 'skills', 'craftdriver');

    expect(result).toMatchObject({
      projectRoot: canonicalRoot,
      destination,
      status: 'installed',
      dryRun: false,
    });
    expect(result.files).toEqual([...result.files].sort());
    expect(result.files).toContain('SKILL.md');
    expect(result.files).toContain('agents/openai.yaml');
    expect(result.files).toContain('workflow.md');
    expect(existsSync(join(destination, 'SKILL.md'))).toBe(true);
    const installedSkill = readFileSync(join(destination, 'SKILL.md'), 'utf8');
    const installedWorkflow = readFileSync(join(destination, 'workflow.md'), 'utf8');
    // The installed skill must describe how refs actually behave: they fail
    // STALE_REF rather than drifting, and durable locators come from
    // `locators`, not from guesswork.
    expect(installedSkill).toContain('STALE_REF');
    expect(installedSkill).toContain('craftdriver locators');
    expect(installedSkill).not.toContain('refs can be reassigned');
    expect(installedSkill).toMatch(/^---\nname: craftdriver\ndescription: .+\n---\n/);
    expect(installedSkill).not.toContain('No hallucination');
    expect(installedWorkflow).toContain('Never copy `ref=eN` into test code');
    // The installed workflow must also teach the evidence loop, not just the
    // exploration one: guidance that stops at the DOM sends an agent to guess
    // at failures the console and network journal explain outright.
    expect(installedWorkflow).toContain('craftdriver logs --kind');
    expect(installedWorkflow).toContain('Never heal a test at runtime');
    expect(
      readFileSync(join(destination, 'agents', 'openai.yaml'), 'utf8'),
    ).toContain('default_prompt: "Use $craftdriver');

    const manifest = JSON.parse(
      readFileSync(join(destination, '.craftdriver-manifest.json'), 'utf8'),
    ) as { schemaVersion: number; craftdriverVersion: string; files: Record<string, string> };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.craftdriverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(manifest.files)).toEqual(result.files);
    expect(Object.values(manifest.files)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    );
  });

  it('is an unchanged no-op on an identical repeated install', () => {
    const root = project();
    init(root);
    const destination = join(root, '.agents', 'skills', 'craftdriver');
    const before = readTree(destination);

    const result = init(root);

    expect(result.status).toBe('unchanged');
    expect(readTree(destination)).toEqual(before);
  });

  it('dry-run reports the install and writes no files or temporary directories', () => {
    const root = project();

    const result = init(root, { dryRun: true });

    expect(result.status).toBe('would-install');
    expect(result.dryRun).toBe(true);
    expect(existsSync(join(root, '.agents'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['package.json']);
  });

  it('dry-run reports an owned update without changing any byte', () => {
    const root = project();
    init(root);
    const destination = join(root, '.agents', 'skills', 'craftdriver');
    const manifestPath = join(destination, '.craftdriver-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      craftdriverVersion: string;
    };
    manifest.craftdriverVersion = '0.0.0';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const before = readTree(destination);

    const result = init(root, { dryRun: true });

    expect(result.status).toBe('would-update');
    expect(readTree(destination)).toEqual(before);
  });

  it('updates an older untouched owned installation', () => {
    const root = project();
    init(root);
    const manifestPath = join(
      root,
      '.agents',
      'skills',
      'craftdriver',
      '.craftdriver-manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      craftdriverVersion: string;
    };
    manifest.craftdriverVersion = '0.0.0';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    expect(init(root).status).toBe('updated');
  });

  it('refuses a user-edited owned file without changing it', () => {
    const root = project();
    init(root);
    const skillPath = join(root, '.agents', 'skills', 'craftdriver', 'SKILL.md');
    writeFileSync(skillPath, 'my custom skill\n');

    expect(() => init(root)).toThrow(/SKILL\.md/);
    expect(readFileSync(skillPath, 'utf8')).toBe('my custom skill\n');
  });

  it('refuses an unowned destination and an extra file', () => {
    const unownedRoot = project();
    write(unownedRoot, '.agents/skills/craftdriver/SKILL.md', 'mine\n');
    expect(() => init(unownedRoot)).toThrow(/unowned|manifest/i);
    expect(readFileSync(join(unownedRoot, '.agents/skills/craftdriver/SKILL.md'), 'utf8')).toBe(
      'mine\n',
    );

    const extraRoot = project();
    init(extraRoot);
    write(extraRoot, '.agents/skills/craftdriver/notes.md', 'keep me\n');
    expect(() => init(extraRoot)).toThrow(/notes\.md/);
    expect(readFileSync(join(extraRoot, '.agents/skills/craftdriver/notes.md'), 'utf8')).toBe(
      'keep me\n',
    );

    const emptyDirectoryRoot = project();
    init(emptyDirectoryRoot);
    mkdirSync(join(emptyDirectoryRoot, '.agents/skills/craftdriver/private-notes'));
    expect(() => init(emptyDirectoryRoot)).toThrow(/private-notes/);
  });

  it('refuses an invalid ownership manifest and a symlinked owned file', () => {
    const invalidRoot = project();
    init(invalidRoot);
    const invalidDestination = join(invalidRoot, '.agents', 'skills', 'craftdriver');
    writeFileSync(join(invalidDestination, '.craftdriver-manifest.json'), '{}\n');
    const invalidBefore = readTree(invalidDestination);
    expect(() => init(invalidRoot)).toThrow(/invalid \.craftdriver-manifest\.json/i);
    expect(readTree(invalidDestination)).toEqual(invalidBefore);

    const symlinkRoot = project();
    const outside = project();
    init(symlinkRoot);
    const cliPath = join(symlinkRoot, '.agents', 'skills', 'craftdriver', 'cli.md');
    rmSync(cliPath);
    symlinkSync(join(outside, 'package.json'), cliPath);
    expect(() => init(symlinkRoot)).toThrow(/symbolic link.*cli\.md/i);
    expect(readFileSync(join(outside, 'package.json'), 'utf8')).toContain('fixture');
  });

  it('refuses a symlinked skill destination', () => {
    const root = project();
    const outside = project();
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    symlinkSync(outside, join(root, '.agents', 'skills', 'craftdriver'), 'dir');

    expect(() => init(root)).toThrow(/symbolic link/i);
    expect(lstatSync(join(root, '.agents', 'skills', 'craftdriver')).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlinked destination parent', () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, '.agents'), 'dir');

    expect(() => init(root)).toThrow(/symbolic link.*\.agents/i);
    expect(existsSync(join(outside, 'skills', 'craftdriver'))).toBe(false);
  });

  it('rejects force instead of overwriting and never touches Codex config', () => {
    const root = project();
    const config = '[user]\nsetting = true\n';
    write(root, '.codex/config.toml', config);

    expect(() => init(root, { force: true })).toThrow(/force/i);
    const result = init(root, { mcp: true });

    expect(result.mcpSnippet).toBe(MCP_SNIPPET);
    expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toBe(config);
  });

  it('parses the supported init command and flags', () => {
    expect(parseArgv(['init', 'codex', '--dry-run', '--mcp'])).toMatchObject({
      cmd: 'init',
      args: { flavor: 'codex', 'dry-run': true, mcp: true },
    });
  });

  it('reports migration and manual MCP instructions through the CLI', async () => {
    const root = project();
    const previousCwd = process.cwd();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      process.chdir(root);
      expect(await main(['init', 'agents'])).toBe(2);
      expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
      expect(stderr.join('')).toContain('craftdriver init codex');

      expect(await main(['init', 'codex', '--dry-run', '--mcp'])).toBe(0);
      expect(stdout.join('')).toContain('[dry-run] would install');
      expect(stdout.join('')).toContain(MCP_SNIPPET);
      expect(existsSync(join(root, '.agents'))).toBe(false);
      expect(existsSync(join(root, '.codex'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('fails clearly when no project root can be found', () => {
    const root = mkdtempSync(join(tmpdir(), 'craftdriver-no-project-'));
    tempRoots.push(root);
    expect(() => init(root)).toThrow(/no project root found/i);
    expect(readdirSync(root)).toEqual([]);
  });
});

function writeFileBytes(root: string, relativePath: string, content: Buffer): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else result[relativePath] = readFileSync(absolutePath).toString('base64');
    }
  };
  visit(root);
  return result;
}
