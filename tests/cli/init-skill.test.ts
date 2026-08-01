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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit, type AgentTarget, type InitResult } from '../../src/cli/init.js';
import { main } from '../../src/cli/index.js';
import { parseArgv } from '../../src/cli/parseArgs.js';

/**
 * Repository instruction files the installer must never create or touch.
 *
 * `init` used to write these. It doesn't any more, and the promise is load
 * bearing: a tool that rewrites AGENTS.md or CLAUDE.md behind your back is one
 * you cannot run twice. Installing into a CraftDriver-owned skill directory is
 * a different thing entirely, which is why that is all it does.
 */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/craftdriver.mdc',
  'GEMINI.md',
  '.codex/config.toml',
  '.mcp.json',
  '.github/mcp.json',
  '.vscode/mcp.json',
] as const;

const CLAUDE_SKILL = '.claude/skills/craftdriver';
const AGENTS_SKILL = '.agents/skills/craftdriver';
const COPILOT_SKILL = '.github/skills/craftdriver';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
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
  options: { agent?: AgentTarget; dryRun?: boolean; mcp?: boolean; force?: boolean } = {},
): InitResult {
  return runInit({ cwd, ...options });
}

/** Installed paths, project-relative, in install order. */
function paths(result: InitResult): string[] {
  return result.installs.map((entry) => entry.relativePath);
}

describe('safe project-local skill installer', () => {
  // -------------------------------------------------------------------------
  // Which directories each agent actually reads
  // -------------------------------------------------------------------------

  it('installs both skill directories by default, and says which agent reads each', () => {
    const root = project();

    const result = init(root);

    // Claude Code reads `.claude/skills/` only; Codex reads `.agents/skills/`
    // only; Copilot reads both. Two directories therefore cover all three in
    // the default install without adding a third copy.
    expect(paths(result)).toEqual([CLAUDE_SKILL, AGENTS_SKILL]);
    expect(result.agent).toBe('all');
    expect(result.installs.map((entry) => entry.status)).toEqual(['installed', 'installed']);
    expect(result.installs[0].readers).toEqual(['Claude Code', 'Copilot']);
    expect(result.installs[1].readers).toEqual(['Codex', 'Copilot']);
    for (const relativePath of [CLAUDE_SKILL, AGENTS_SKILL]) {
      expect(existsSync(join(root, relativePath, 'SKILL.md'))).toBe(true);
    }
    expect(existsSync(join(root, '.github', 'skills'))).toBe(false);
  });

  it.each([
    ['claude', [CLAUDE_SKILL]],
    ['copilot', [COPILOT_SKILL]],
    ['codex', [AGENTS_SKILL]],
    ['all', [CLAUDE_SKILL, AGENTS_SKILL]],
  ] as const)('--agent %s installs exactly %j', (agent, expected) => {
    const root = project();

    const result = init(root, { agent });

    expect(paths(result)).toEqual([...expected]);
    const installed = [CLAUDE_SKILL, AGENTS_SKILL, COPILOT_SKILL].filter((p) =>
      existsSync(join(root, p)),
    );
    expect(installed).toEqual([...expected]);
  });

  it('rejects an unknown agent', () => {
    expect(() => init(project(), { agent: 'gemini' as AgentTarget })).toThrow(/unknown agent/i);
  });

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  it('installs the package skill at the nearest project root', () => {
    const root = project();
    const nested = join(root, 'packages', 'app', 'src');
    mkdirSync(nested, { recursive: true });

    const result = init(nested, { agent: 'claude' });
    const canonicalRoot = realpathSync(root);
    const destination = join(canonicalRoot, '.claude', 'skills', 'craftdriver');

    expect(result.projectRoot).toBe(canonicalRoot);
    expect(result.installs[0]).toMatchObject({ destination, status: 'installed' });
    expect(result.dryRun).toBe(false);
    expect(result.files).toEqual([...result.files].sort());
    expect(result.files).toContain('SKILL.md');
    expect(result.files).toContain('agents/openai.yaml');
    expect(result.files).not.toContain('browser.md');
    expect(result.files).toContain('workflow.md');

    const installedSkill = readFileSync(join(destination, 'SKILL.md'), 'utf8');
    const installedWorkflow = readFileSync(join(destination, 'workflow.md'), 'utf8');
    // The installed skill must describe how refs actually behave: they fail
    // STALE_REF rather than drifting, and durable locators come from
    // `locators`, not from guesswork.
    expect(installedSkill).toContain('STALE_REF');
    expect(installedSkill).toContain('craftdriver locators');
    expect(installedSkill).toContain('--observe=delta');
    expect(installedSkill).toContain('do not follow it with another snapshot');
    expect(installedSkill).not.toContain('refs can be reassigned');
    expect(installedSkill).not.toContain('[browser.md]');
    expect(installedSkill).toContain('[cli.md](cli.md)');
    expect(installedSkill).not.toContain('[cheatsheet.md]');
    // `name` and `description` frontmatter is what every host indexes the
    // skill by — Claude Code, Codex, and Copilot all read the same two fields.
    expect(installedSkill).toMatch(/^---\nname: craftdriver\ndescription: .+\n---\n/);
    expect(installedSkill).not.toContain('No hallucination');
    expect(installedWorkflow).toContain('Never copy `ref=eN` into test code');
    // The installed workflow must also teach the evidence loop, not just the
    // exploration one: guidance that stops at the DOM sends an agent to guess
    // at failures the console and network journal explain outright.
    expect(installedWorkflow).toContain('craftdriver logs --kind');
    expect(installedWorkflow).toContain('Never heal a test at runtime');
    expect(installedWorkflow).toContain('[CLI reference](cli.md)');
    expect(installedWorkflow).toContain('[TypeScript API\ncheatsheet](cheatsheet.md)');
    expect(installedWorkflow).toContain('[worked patterns](patterns.md)');
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

  it('installs byte-identical content into both directories', () => {
    const root = project();

    init(root);

    expect(readTree(join(root, CLAUDE_SKILL))).toEqual(readTree(join(root, AGENTS_SKILL)));
  });

  // -------------------------------------------------------------------------
  // Never touching user content
  // -------------------------------------------------------------------------

  it('creates and modifies no repository instruction or MCP configuration file', () => {
    const root = project();
    const before = Buffer.from('user-owned\0instructions\n');
    for (const target of INSTRUCTION_FILES) writeFileBytes(root, target, before);

    init(root, { mcp: true });

    for (const target of INSTRUCTION_FILES) {
      expect(readFileSync(join(root, target))).toEqual(before);
    }
  });

  it('creates no instruction file that did not already exist', () => {
    const root = project();

    init(root, { mcp: true });

    for (const target of INSTRUCTION_FILES) {
      expect(existsSync(join(root, target))).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Repeat installs
  // -------------------------------------------------------------------------

  it('is an unchanged no-op on an identical repeated install', () => {
    const root = project();
    init(root);
    const before = [CLAUDE_SKILL, AGENTS_SKILL].map((p) => readTree(join(root, p)));

    const result = init(root);

    expect(result.installs.map((entry) => entry.status)).toEqual(['unchanged', 'unchanged']);
    expect([CLAUDE_SKILL, AGENTS_SKILL].map((p) => readTree(join(root, p)))).toEqual(before);
  });

  it('reports per-directory status when only one is already installed', () => {
    const root = project();
    init(root, { agent: 'claude' });

    const result = init(root);

    expect(result.installs.map((entry) => [entry.relativePath, entry.status])).toEqual([
      [CLAUDE_SKILL, 'unchanged'],
      [AGENTS_SKILL, 'installed'],
    ]);
  });

  it('reconciles an existing Copilot-native copy during a default install', () => {
    const root = project();
    init(root);
    init(root, { agent: 'copilot' });

    // Copilot CLI resolves duplicate skill names in .github, .agents, .claude
    // order. A copy created by --agent copilot must therefore remain part of
    // later default runs instead of silently shadowing their updated copies.
    const dryRun = init(root, { dryRun: true });
    expect(paths(dryRun)).toEqual([CLAUDE_SKILL, AGENTS_SKILL, COPILOT_SKILL]);
    expect(dryRun.installs.map((entry) => entry.status)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);

    downgrade(root, COPILOT_SKILL);
    const reconciled = init(root);
    expect(reconciled.installs.map((entry) => [entry.relativePath, entry.status])).toEqual([
      [CLAUDE_SKILL, 'unchanged'],
      [AGENTS_SKILL, 'unchanged'],
      [COPILOT_SKILL, 'updated'],
    ]);
  });

  it('updates an older untouched owned installation', () => {
    const root = project();
    init(root);
    downgrade(root, CLAUDE_SKILL);
    downgrade(root, AGENTS_SKILL);

    expect(init(root).installs.map((entry) => entry.status)).toEqual(['updated', 'updated']);
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  it('dry-run reports the install and writes no files or temporary directories', () => {
    const root = project();

    const result = init(root, { dryRun: true });

    expect(result.installs.map((entry) => entry.status)).toEqual([
      'would-install',
      'would-install',
    ]);
    expect(result.dryRun).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['package.json']);
  });

  it('dry-run reports an owned update without changing any byte', () => {
    const root = project();
    init(root);
    downgrade(root, CLAUDE_SKILL);
    downgrade(root, AGENTS_SKILL);
    const before = [CLAUDE_SKILL, AGENTS_SKILL].map((p) => readTree(join(root, p)));

    const result = init(root, { dryRun: true });

    expect(result.installs.map((entry) => entry.status)).toEqual(['would-update', 'would-update']);
    expect([CLAUDE_SKILL, AGENTS_SKILL].map((p) => readTree(join(root, p)))).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('refuses a user-edited owned file without changing it', () => {
    const root = project();
    init(root);
    const skillPath = join(root, CLAUDE_SKILL, 'SKILL.md');
    writeFileSync(skillPath, 'my custom skill\n');

    expect(() => init(root)).toThrow(/SKILL\.md/);
    expect(readFileSync(skillPath, 'utf8')).toBe('my custom skill\n');
  });

  it('a conflict in either directory refuses the whole command', () => {
    // The install is all-or-nothing on purpose: a partial run would leave one
    // agent with the skill and another without, which is worse to diagnose
    // than a refusal naming the file in the way.
    const root = project();
    write(root, `${AGENTS_SKILL}/SKILL.md`, 'mine\n');

    expect(() => init(root)).toThrow(/unowned|manifest/i);
    expect(existsSync(join(root, CLAUDE_SKILL))).toBe(false);
    expect(readFileSync(join(root, AGENTS_SKILL, 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses a Copilot-native shadow before writing the default destinations', () => {
    const root = project();
    write(root, `${COPILOT_SKILL}/SKILL.md`, 'mine\n');

    expect(() => init(root)).toThrow(/unowned|manifest/i);
    expect(existsSync(join(root, CLAUDE_SKILL))).toBe(false);
    expect(existsSync(join(root, AGENTS_SKILL))).toBe(false);
    expect(readFileSync(join(root, COPILOT_SKILL, 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('refuses an unowned destination and an extra file', () => {
    const unownedRoot = project();
    write(unownedRoot, `${CLAUDE_SKILL}/SKILL.md`, 'mine\n');
    expect(() => init(unownedRoot, { agent: 'claude' })).toThrow(/unowned|manifest/i);
    expect(readFileSync(join(unownedRoot, CLAUDE_SKILL, 'SKILL.md'), 'utf8')).toBe('mine\n');

    const extraRoot = project();
    init(extraRoot, { agent: 'claude' });
    write(extraRoot, `${CLAUDE_SKILL}/notes.md`, 'keep me\n');
    expect(() => init(extraRoot, { agent: 'claude' })).toThrow(/notes\.md/);
    expect(readFileSync(join(extraRoot, CLAUDE_SKILL, 'notes.md'), 'utf8')).toBe('keep me\n');

    const emptyDirectoryRoot = project();
    init(emptyDirectoryRoot, { agent: 'claude' });
    mkdirSync(join(emptyDirectoryRoot, CLAUDE_SKILL, 'private-notes'));
    expect(() => init(emptyDirectoryRoot, { agent: 'claude' })).toThrow(/private-notes/);
  });

  it('refuses an invalid ownership manifest and a symlinked owned file', () => {
    const invalidRoot = project();
    init(invalidRoot, { agent: 'claude' });
    const invalidDestination = join(invalidRoot, CLAUDE_SKILL);
    writeFileSync(join(invalidDestination, '.craftdriver-manifest.json'), '{}\n');
    const invalidBefore = readTree(invalidDestination);
    expect(() => init(invalidRoot, { agent: 'claude' })).toThrow(
      /invalid \.craftdriver-manifest\.json/i,
    );
    expect(readTree(invalidDestination)).toEqual(invalidBefore);

    const symlinkRoot = project();
    const outside = project();
    init(symlinkRoot, { agent: 'claude' });
    const cliPath = join(symlinkRoot, CLAUDE_SKILL, 'cli.md');
    rmSync(cliPath);
    symlinkSync(join(outside, 'package.json'), cliPath);
    expect(() => init(symlinkRoot, { agent: 'claude' })).toThrow(/symbolic link.*cli\.md/i);
    expect(readFileSync(join(outside, 'package.json'), 'utf8')).toContain('fixture');
  });

  it.each([
    ['claude', '.claude'],
    ['codex', '.agents'],
    ['copilot', '.github'],
  ] as const)('refuses a symlinked skill destination for --agent %s', (agent, root_) => {
    const root = project();
    const outside = project();
    mkdirSync(join(root, root_, 'skills'), { recursive: true });
    symlinkSync(outside, join(root, root_, 'skills', 'craftdriver'), 'dir');

    expect(() => init(root, { agent })).toThrow(/symbolic link/i);
    expect(lstatSync(join(root, root_, 'skills', 'craftdriver')).isSymbolicLink()).toBe(true);
  });

  it.each([
    ['claude', '.claude'],
    ['codex', '.agents'],
    ['copilot', '.github'],
  ] as const)('refuses a symlinked destination parent for --agent %s', (agent, root_) => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, root_), 'dir');

    expect(() => init(root, { agent })).toThrow(/symbolic link/i);
    expect(existsSync(join(outside, 'skills', 'craftdriver'))).toBe(false);
  });

  it('rejects force instead of overwriting', () => {
    expect(() => init(project(), { force: true })).toThrow(/force/i);
  });

  it('fails clearly when no project root can be found', () => {
    const root = mkdtempSync(join(tmpdir(), 'craftdriver-no-project-'));
    tempRoots.push(root);
    expect(() => init(root)).toThrow(/no project root found/i);
    expect(readdirSync(root)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // MCP snippets — printed, never written
  // -------------------------------------------------------------------------

  it('returns the project-scoped MCP snippet each host actually reads', () => {
    const root = project();

    expect(init(root, { agent: 'claude', mcp: true, dryRun: true }).mcp).toEqual([
      { host: 'Claude Code', file: '.mcp.json', snippet: expect.stringContaining('"mcpServers"') },
    ]);
    // VS Code's schema differs from Claude Code's: `servers`, and `type` is
    // required. Printing the wrong one is a config that silently does nothing.
    //
    // "Copilot" is also several products: this snippet is VS Code's, and the
    // label plus the note have to say so rather than implying Copilot CLI and
    // the cloud agent are covered.
    expect(init(root, { agent: 'copilot', mcp: true, dryRun: true }).mcp).toEqual([
      {
        host: 'Copilot in VS Code',
        file: '.vscode/mcp.json',
        snippet: expect.stringContaining('"type": "stdio"'),
        note: expect.stringContaining('Copilot CLI'),
      },
    ]);
    expect(init(root, { agent: 'codex', mcp: true, dryRun: true }).mcp).toEqual([
      {
        host: 'Codex',
        file: '.codex/config.toml',
        snippet: expect.stringContaining('[mcp_servers.craftdriver]'),
      },
    ]);
    expect(init(root, { agent: 'all', mcp: true, dryRun: true }).mcp).toHaveLength(3);
    expect(init(root, { dryRun: true }).mcp).toBeUndefined();

    for (const entry of init(root, { mcp: true, dryRun: true }).mcp ?? []) {
      expect(entry.snippet).toContain('craftdriver');
      expect(entry.snippet).toContain('--no-install');
    }
  });

  // -------------------------------------------------------------------------
  // CLI surface
  // -------------------------------------------------------------------------

  it('parses the init command and its flags', () => {
    expect(parseArgv(['init'])).toMatchObject({ cmd: 'init', args: {} });
    expect(parseArgv(['init', '--agent', 'claude', '--dry-run', '--mcp'])).toMatchObject({
      cmd: 'init',
      args: { agent: 'claude', 'dry-run': true, mcp: true },
    });
    // `init codex` is the pre-1.10 spelling and still works.
    expect(parseArgv(['init', 'codex'])).toMatchObject({
      cmd: 'init',
      args: { agent: 'codex', deprecatedFlavor: true },
    });
    // Two ways of naming the target in one command line is rejected, even when
    // they agree — silently letting one win means the losing spelling is what
    // the caller believed they had asked for.
    expect(parseArgv(['init', 'codex', '--agent', 'claude'])).toMatchObject({
      cmd: '__usage_error__',
    });
    expect(parseArgv(['init', 'codex', '--agent', 'codex'])).toMatchObject({
      cmd: '__usage_error__',
    });
    expect(parseArgv(['init', 'gemini'])).toMatchObject({ cmd: '__usage_error__' });
    expect(parseArgv(['init', '--agent', 'gemini'])).toMatchObject({ cmd: '__usage_error__' });
  });

  it('reports what was installed, how to verify it, and the MCP snippets', async () => {
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

      expect(await main(['init', '--dry-run', '--mcp'])).toBe(0);
      const out = stdout.join('');
      expect(out).toContain('[dry-run] would install .claude/skills/craftdriver');
      expect(out).toContain('[dry-run] would install .agents/skills/craftdriver');
      // "Did it load?" is where skill onboarding actually fails, so the
      // command answers it for every agent it just installed for.
      expect(out).toContain('/craftdriver');
      expect(out).toContain('/skills');
      expect(out).toContain('$craftdriver');
      // Project trust gates Codex's `.codex/` config layer, not `.agents/skills`.
      // The verify block must not send people chasing a setting that is not the
      // reason their skill is missing.
      expect(out).not.toMatch(/trust/i);
      expect(out).toContain('"mcpServers"');
      expect(out).toContain('[mcp_servers.craftdriver]');
      expect(out).toContain('Copilot CLI');
      expect(existsSync(join(root, '.claude'))).toBe(false);
      expect(existsSync(join(root, '.agents'))).toBe(false);
      expect(existsSync(join(root, '.codex'))).toBe(false);

      // The deprecated spelling still installs, and says what to use instead.
      stdout.length = 0;
      expect(await main(['init', 'codex'])).toBe(0);
      expect(stderr.join('')).toContain('deprecated');
      expect(stdout.join('')).toContain('installed .agents/skills/craftdriver');
      expect(existsSync(join(root, CLAUDE_SKILL))).toBe(false);

      expect(await main(['init', '--agent', 'gemini'])).toBe(2);
    } finally {
      process.chdir(previousCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

/** Rewrite an installed manifest's version so the next install is an update. */
function downgrade(root: string, relativePath: string): void {
  const manifestPath = join(root, relativePath, '.craftdriver-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    craftdriverVersion: string;
  };
  manifest.craftdriverVersion = '0.0.0';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

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
