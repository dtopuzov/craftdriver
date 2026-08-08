/**
 * Turn a newline-delimited command script into parsed commands.
 *
 * Shared by `--ephemeral` and `craftdriver run` so the two cannot drift into
 * two script languages. Both go through the same `tokenize` → `parseArgv`
 * path the interactive CLI uses, which is the whole design shortcut: a batch
 * introduces no selector syntax, no argument spelling and no error codes that
 * an agent has not already met on the command line.
 *
 * The whole script is parsed before any of it runs. A typo on line 7 used to
 * be found only after lines 1-6 had navigated and filled, leaving a
 * half-driven browser behind for a fault that was knowable up front — and
 * every syntax problem is reported, not just the first, so one pass fixes the
 * script.
 */
import { parseArgv, type GlobalFlags, type ParsedCommand } from './parseArgs.js';
import { batchRejection } from './batch.js';

export interface CompiledScript {
  steps: ParsedCommand[];
  /** Formatted, ready to write to stderr. Non-empty means: run nothing. */
  errors: string[];
}

export interface CompileOptions {
  /**
   * `batch` adds the two rules a live-session batch needs: no command that
   * addresses the daemon or ends the browser, and one observation rather
   * than one per step.
   */
  mode: 'ephemeral' | 'batch';
}

/** Render parser pseudo-commands consistently in one-shot and script modes. */
export function formatParseFailure(parsed: ParsedCommand, line?: string): string | null {
  const context = line ? ` in: ${line}` : '';
  if (parsed.cmd === '__unknown__') {
    return `error: unknown command "${parsed.args.cmd as string}"${context}\nrun: craftdriver --help\n`;
  }
  if (parsed.cmd === '__unknown_flag__') {
    const flag = parsed.args.flag as string;
    const suggestion = parsed.args.suggestion as string | undefined;
    return (
      `error: unknown flag "${flag}"${context}\n` +
      (suggestion ? `did you mean: ${suggestion}\n` : '') +
      'run: craftdriver --help\n'
    );
  }
  if (parsed.cmd === '__usage_error__') {
    const usage = parsed.args.usage as string | undefined;
    return (
      `error: ${parsed.args.message as string}${context}\n` +
      (usage ? `usage: ${usage}\n` : '') +
      'run: craftdriver --help\n'
    );
  }
  return null;
}

/**
 * Flags that choose the browser or the session, not the step.
 *
 * They apply to the script's one target — an ephemeral browser, or the named
 * daemon session — so accepting them per line would promise something the
 * line cannot deliver.
 */
export function outerOnlyFlag(flags: GlobalFlags): string | null {
  if (flags.session !== undefined) return '--session';
  if (flags.ephemeral) return '--ephemeral';
  if (flags.continueOnError) return '--continue-on-error';
  if (flags.headless === true) return '--headless';
  if (flags.headless === false) return '--headed';
  if (flags.launch.browserName !== undefined) return '--browser';
  return null;
}

export function compileScript(source: string, options: CompileOptions): CompiledScript {
  const steps: ParsedCommand[] = [];
  const errors: string[] = [];
  // Kept alongside the steps so the "observe only the last one" rule can be
  // applied after the script is known, and still quote the offending line.
  const lines: string[] = [];

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sub = parseArgv(tokenize(line));
    if (!sub) continue;
    // A malformed line must not pass silently. Skipping every `__…`
    // pseudo-command meant `click #pay --forse` did nothing at all and the
    // script still exited 0 — the same silent-typo failure strict flag
    // parsing exists to prevent, just moved onto this path.
    const parseFailure = formatParseFailure(sub, line);
    if (parseFailure) {
      errors.push(parseFailure);
      continue;
    }
    const outerFlag = outerOnlyFlag(sub.flags);
    if (outerFlag) {
      const kind = options.mode === 'batch' ? 'a batch script' : 'an ephemeral script';
      const outer = options.mode === 'batch' ? 'run' : '--ephemeral';
      errors.push(
        `error: ${outerFlag} cannot be set inside ${kind} in: ${line}\n` +
          `hint: pass it on the outer \`craftdriver ${outer}\` command\n`
      );
      continue;
    }
    if (sub.cmd.startsWith('__')) continue;
    if (options.mode === 'batch') {
      const reason = batchRejection(sub.cmd);
      if (reason) {
        errors.push(
          `error: "${sub.cmd}" cannot run inside a batch in: ${line}\n` +
            `hint: ${reason}\n`
        );
        continue;
      }
    }
    steps.push(sub);
    lines.push(line);
  }

  if (options.mode === 'batch') {
    // One observation per batch is where the token saving comes from, and
    // `--observe=delta` on the last step already accumulates the changes the
    // unobserved steps made. An earlier step asking for one is a
    // misunderstanding worth naming rather than quietly honouring N times.
    steps.slice(0, -1).forEach((step, index) => {
      if (step.args.observe === undefined) return;
      errors.push(
        `error: --observe is only valid on the last step in: ${lines[index]}\n` +
          `hint: a batch returns one observation; --observe=delta on the last step ` +
          `accumulates what the earlier steps changed\n`
      );
    });
  }

  return { steps, errors };
}

/** Minimal shell-like tokeniser: supports single and double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
