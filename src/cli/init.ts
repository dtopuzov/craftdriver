import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Agents whose project-skill directory this installer knows how to fill. */
export const AGENT_TARGETS = ['claude', 'codex', 'copilot', 'all'] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];
export const SKILL_READERS = ['Claude Code', 'Copilot', 'Codex'] as const;
export type SkillReader = (typeof SKILL_READERS)[number];

/**
 * Where each agent looks for a committed project skill, as of July 2026.
 *
 * - Claude Code reads `.claude/skills/` only.
 * - Codex reads `.agents/skills/` only.
 * - GitHub Copilot reads `.github/skills/`, `.claude/skills/`, and
 *   `.agents/skills/` on surfaces that support agent skills.
 *
 * So two directories cover all three for the default install. A Copilot-only
 * install uses Copilot's own `.github/skills/` location instead of creating a
 * directory named for another host.
 */
const SKILL_ROOTS = {
  claude: ['.claude', 'skills'],
  agents: ['.agents', 'skills'],
  github: ['.github', 'skills'],
} as const;

type SkillRoot = keyof typeof SKILL_ROOTS;

/** Agents that discover a skill installed under each root. */
const ROOT_READERS: Record<SkillRoot, readonly SkillReader[]> = {
  claude: ['Claude Code', 'Copilot'],
  agents: ['Codex', 'Copilot'],
  github: ['Copilot'],
};

const TARGET_ROOTS: Record<AgentTarget, readonly SkillRoot[]> = {
  claude: ['claude'],
  copilot: ['github'],
  codex: ['agents'],
  all: ['claude', 'agents'],
};

/** Project-scoped MCP configuration, per host. Printed, never written. */
export interface McpSnippet {
  /** Host label for the printed heading. Names one surface, not a family. */
  host: string;
  /** Project-relative file the user pastes it into. */
  file: string;
  snippet: string;
  /** Caveat printed under the snippet, when the host has sibling surfaces. */
  note?: string;
}

type McpTarget = Exclude<SkillRoot, 'github'> | 'copilot';

const MCP_SNIPPETS: Record<McpTarget, McpSnippet> = {
  claude: {
    host: 'Claude Code',
    file: '.mcp.json',
    snippet: `{
  "mcpServers": {
    "craftdriver": {
      "command": "npx",
      "args": ["--no-install", "craftdriver", "mcp"]
    }
  }
}`,
  },
  // VS Code only. Copilot CLI reads `~/.copilot/mcp-config.json` and
  // `.github/mcp.json`; the cloud agent is configured in repository settings.
  // Rather than ship three half-checked snippets, name the surface this one is
  // for and point at the others.
  copilot: {
    host: 'Copilot in VS Code',
    file: '.vscode/mcp.json',
    snippet: `{
  "servers": {
    "craftdriver": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "craftdriver", "mcp"]
    }
  }
}`,
    note: 'Copilot CLI and the cloud agent use different files — see docs/mcp.md.',
  },
  agents: {
    host: 'Codex',
    file: '.codex/config.toml',
    snippet: `[mcp_servers.craftdriver]
command = "npx"
args = ["--no-install", "craftdriver", "mcp"]`,
  },
};

const TARGET_MCP: Record<AgentTarget, readonly McpTarget[]> = {
  claude: ['claude'],
  copilot: ['copilot'],
  codex: ['agents'],
  all: ['claude', 'copilot', 'agents'],
};

const MANIFEST_NAME = '.craftdriver-manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;

interface SkillManifest {
  schemaVersion: number;
  craftdriverVersion: string;
  files: Record<string, string>;
}

interface SourceFile {
  relativePath: string;
  absolutePath: string;
  hash: string;
}

export interface SkillInstall {
  /** Absolute path of the installed skill directory. */
  destination: string;
  /** Same path relative to the project root, for readable output. */
  relativePath: string;
  /** Agents that discover a skill at this path. */
  readers: readonly SkillReader[];
  status: 'installed' | 'updated' | 'unchanged' | 'would-install' | 'would-update';
}

export interface InitResult {
  projectRoot: string;
  agent: AgentTarget;
  installs: SkillInstall[];
  files: string[];
  dryRun: boolean;
  mcp?: McpSnippet[];
}

export interface InitOptions {
  /** Which agent to install for. Defaults to `all` — the two-directory set. */
  agent?: AgentTarget;
  cwd: string;
  force?: boolean;
  dryRun?: boolean;
  mcp?: boolean;
}

/** Install the package-shipped project skill without inspecting user config. */
export function runInit(options: InitOptions): InitResult {
  if (options.force) {
    throw new Error('--force is not supported because CraftDriver never overwrites user content');
  }
  const agent = options.agent ?? 'all';
  if (!(AGENT_TARGETS as readonly string[]).includes(agent)) {
    throw new Error(`unknown agent ${JSON.stringify(agent)}; expected ${AGENT_TARGETS.join(', ')}`);
  }

  const projectRoot = findProjectRoot(options.cwd);
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const packageJson = readJsonFile(join(packageRoot, 'package.json'), 'CraftDriver package.json');
  const version = readVersion(packageJson);
  const sourceRoot = join(packageRoot, 'skills', 'craftdriver');
  const sourceFiles = collectSourceFiles(sourceRoot);
  if (!sourceFiles.some((file) => file.relativePath === 'SKILL.md')) {
    throw new Error(`CraftDriver skill source is missing SKILL.md at ${sourceRoot}`);
  }

  const manifest = createManifest(version, sourceFiles);
  const dryRun = options.dryRun === true;
  const roots = rootsForInstall(agent, projectRoot);

  // Inspect every destination before writing any of them, so a conflict in the
  // second directory refuses the whole command instead of leaving one agent
  // configured and the other not.
  const planned = roots.map((root) => {
    const segments = SKILL_ROOTS[root];
    assertSafeDestinationAncestors(projectRoot, segments);
    const destination = join(projectRoot, ...segments, 'craftdriver');
    return {
      root,
      destination,
      relativePath: [...segments, 'craftdriver'].join('/'),
      readers: ROOT_READERS[root],
      state: inspectDestination(destination, manifest),
    };
  });

  const installs = planned.map((entry): SkillInstall => {
    const common = {
      destination: entry.destination,
      relativePath: entry.relativePath,
      readers: entry.readers,
    };
    if (entry.state === 'unchanged') return { ...common, status: 'unchanged' };
    if (dryRun) {
      return { ...common, status: entry.state === 'missing' ? 'would-install' : 'would-update' };
    }
    installAtomically(entry.destination, sourceFiles, manifest, entry.state === 'owned');
    return { ...common, status: entry.state === 'missing' ? 'installed' : 'updated' };
  });

  return {
    projectRoot,
    agent,
    installs,
    files: sourceFiles.map((file) => file.relativePath),
    dryRun,
    ...(options.mcp ? { mcp: TARGET_MCP[agent].map((host) => MCP_SNIPPETS[host]) } : {}),
  };
}

/**
 * The default covering set is two directories, but a previous Copilot-only
 * install may have created a third copy in `.github/skills`, which Copilot CLI
 * checks first. Reconcile any known destination that already exists so a stale
 * duplicate cannot shadow the copies this run updates. Explicit single-agent
 * targets remain narrow and touch only their documented destination.
 */
function rootsForInstall(agent: AgentTarget, projectRoot: string): SkillRoot[] {
  const roots = [...TARGET_ROOTS[agent]];
  if (agent !== 'all') return roots;

  for (const root of Object.keys(SKILL_ROOTS) as SkillRoot[]) {
    if (roots.includes(root)) continue;
    const destination = join(projectRoot, ...SKILL_ROOTS[root], 'craftdriver');
    if (existsSync(destination)) roots.push(root);
  }
  return roots;
}

function findProjectRoot(cwd: string): string {
  let current: string;
  try {
    current = realpathSync(resolve(cwd));
  } catch {
    throw new Error(`cannot resolve current directory: ${cwd}`);
  }

  while (true) {
    const marker = join(current, 'package.json');
    if (existsSync(marker)) {
      const stat = lstatSync(marker);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`project marker must be a regular file: ${marker}`);
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('no project root found; run `craftdriver init` below a package.json');
    }
    current = parent;
  }
}

function readJsonFile(path: string, label: string): unknown {
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid JSON in ${label} at ${path}`);
  }
}

function readVersion(value: unknown): string {
  if (!isPlainObject(value) || typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error('CraftDriver package.json has no valid version');
  }
  return value.version;
}

function collectSourceFiles(sourceRoot: string): SourceFile[] {
  let rootStat;
  try {
    rootStat = lstatSync(sourceRoot);
  } catch {
    throw new Error(`CraftDriver skill source is missing: ${sourceRoot}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`CraftDriver skill source must be a regular directory: ${sourceRoot}`);
  }

  const files: SourceFile[] = [];
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`CraftDriver skill source contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) visit(absolutePath, relativePath);
      else if (stat.isFile()) {
        files.push({ relativePath, absolutePath, hash: sha256(readFileSync(absolutePath)) });
      } else {
        throw new Error(`CraftDriver skill source is not a regular file: ${relativePath}`);
      }
    }
  };
  visit(sourceRoot);
  return files.sort((a, b) => compareText(a.relativePath, b.relativePath));
}

function createManifest(version: string, sourceFiles: SourceFile[]): SkillManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    craftdriverVersion: version,
    files: Object.fromEntries(sourceFiles.map((file) => [file.relativePath, file.hash])),
  };
}

function assertSafeDestinationAncestors(
  projectRoot: string,
  segments: readonly string[],
): void {
  let current = projectRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symbolic link in skill destination: ${relative(projectRoot, current)}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`skill destination parent is not a directory: ${relative(projectRoot, current)}`);
    }
  }
}

function inspectDestination(
  destination: string,
  sourceManifest: SkillManifest,
): 'missing' | 'unchanged' | 'owned' {
  if (!existsSync(destination)) return 'missing';
  const destinationStat = lstatSync(destination);
  if (destinationStat.isSymbolicLink()) {
    throw new Error(`refusing symbolic link at skill destination: ${destination}`);
  }
  if (!destinationStat.isDirectory()) {
    throw new Error(`skill destination is not a directory: ${destination}`);
  }

  const manifestPath = join(destination, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`refusing unowned skill destination without ${MANIFEST_NAME}: ${destination}`);
  }

  const installedManifest = parseManifest(readJsonFile(manifestPath, 'skill ownership manifest'));
  const installedPaths = collectInstalledPaths(destination);
  const actualFiles = installedPaths.files;
  const owned = new Set([...Object.keys(installedManifest.files), MANIFEST_NAME]);
  const ownedDirectories = ownedDirectoryPaths(Object.keys(installedManifest.files));
  const conflicts: string[] = [];

  for (const path of actualFiles) if (!owned.has(path)) conflicts.push(path);
  for (const path of installedPaths.directories) {
    if (!ownedDirectories.has(path)) conflicts.push(path);
  }
  for (const [path, expectedHash] of Object.entries(installedManifest.files)) {
    if (!actualFiles.has(path)) {
      conflicts.push(path);
      continue;
    }
    const absolutePath = safeOwnedPath(destination, path);
    if (sha256(readFileSync(absolutePath)) !== expectedHash) conflicts.push(path);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `refusing to overwrite user-edited or unowned skill files: ${[...new Set(conflicts)].sort().join(', ')}`,
    );
  }

  const sameVersion = installedManifest.craftdriverVersion === sourceManifest.craftdriverVersion;
  const sameFiles = recordsEqual(installedManifest.files, sourceManifest.files);
  return sameVersion && sameFiles ? 'unchanged' : 'owned';
}

function parseManifest(value: unknown): SkillManifest {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    typeof value.craftdriverVersion !== 'string' ||
    !isPlainObject(value.files)
  ) {
    throw new Error(`invalid ${MANIFEST_NAME}`);
  }

  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(value.files)) {
    if (!isSafeRelativePath(path) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`invalid ${MANIFEST_NAME} entry: ${path}`);
    }
    files[path] = hash;
  }
  if (Object.keys(files).length === 0) throw new Error(`invalid ${MANIFEST_NAME}: no files`);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    craftdriverVersion: value.craftdriverVersion,
    files,
  };
}

function collectInstalledPaths(destination: string): {
  files: Set<string>;
  directories: Set<string>;
} {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing symbolic link in installed skill: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        directories.add(relativePath);
        visit(absolutePath, relativePath);
      }
      else if (stat.isFile()) files.add(relativePath);
      else throw new Error(`installed skill path is not a regular file: ${relativePath}`);
    }
  };
  visit(destination);
  return { files, directories };
}

function ownedDirectoryPaths(files: string[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i++) {
      directories.add(segments.slice(0, i).join('/'));
    }
  }
  return directories;
}

function safeOwnedPath(root: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error(`invalid owned path: ${relativePath}`);
  const absolutePath = resolve(root, ...relativePath.split('/'));
  const fromRoot = relative(root, absolutePath);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || resolve(root) === absolutePath) {
    throw new Error(`owned path escapes skill destination: ${relativePath}`);
  }
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`owned path is not a regular file: ${relativePath}`);
  }
  return absolutePath;
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    path !== MANIFEST_NAME
  );
}

function installAtomically(
  destination: string,
  sourceFiles: SourceFile[],
  manifest: SkillManifest,
  replacing: boolean,
): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const stage = join(parent, `.craftdriver-stage-${suffix}`);
  const backup = join(parent, `.craftdriver-backup-${suffix}`);
  let destinationMoved = false;

  try {
    mkdirSync(stage, { mode: 0o700 });
    for (const file of sourceFiles) {
      const target = join(stage, ...file.relativePath.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file.absolutePath, target);
    }
    writeFileSync(join(stage, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (inspectDestination(stage, manifest) !== 'unchanged') {
      throw new Error('staged CraftDriver skill failed validation');
    }

    if (replacing) {
      renameSync(destination, backup);
      destinationMoved = true;
    }
    renameSync(stage, destination);
    if (destinationMoved) {
      rmSync(backup, { recursive: true, force: false });
      destinationMoved = false;
    }
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (destinationMoved && !existsSync(destination) && existsSync(backup)) {
      renameSync(backup, destination);
      destinationMoved = false;
    }
    throw error;
  }
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aEntries = Object.entries(a).sort(([left], [right]) => compareText(left, right));
  const bEntries = Object.entries(b).sort(([left], [right]) => compareText(left, right));
  return JSON.stringify(aEntries) === JSON.stringify(bEntries);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
