/**
 * CLI surface mapping: `argv` in, `(cmd, args)` out.
 *
 * Why this exists separately from the browser tests: those call
 * `session.run({ cmd, args })` directly, which skips the parsing layer
 * entirely. A typo in an argument name here — `deltaY` vs `delta-y`,
 * `text` vs `key` — would leave every browser test green while the actual
 * command line silently did nothing. These run in milliseconds and cover
 * the whole surface, so the expensive end-to-end tests don't have to.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseArgv } from '../../src/cli/parseArgs';

function parse(line: string) {
  const parsed = parseArgv(line.split(' ').filter(Boolean));
  if (!parsed) throw new Error(`parseArgv returned null for: ${line}`);
  return parsed;
}

describe('CLI command mapping', () => {
  it.each([
    ['go http://x.test', 'go', { url: 'http://x.test' }],
    ['click #a', 'click', { selector: '#a' }],
    ['dblclick #a', 'dblclick', { selector: '#a' }],
    ['hover #a', 'hover', { selector: '#a' }],
    ['clear #a', 'clear', { selector: '#a' }],
    ['check #a', 'check', { selector: '#a' }],
    ['uncheck #a', 'uncheck', { selector: '#a' }],
    ['focus #a', 'focus', { selector: '#a' }],
    ['scroll #a', 'scroll', { selector: '#a' }],
    ['exists #a', 'exists', { selector: '#a' }],
    ['value #a', 'value', { selector: '#a' }],
    ['locators #a', 'locators', { selector: '#a' }],
    ['find #a', 'find', { selector: '#a' }],
    ['attr #a href', 'attr', { selector: '#a', name: 'href' }],
    ['is checked #a', 'is', { what: 'checked', selector: '#a' }],
    ['select #a pro', 'select', { selector: '#a', value: 'pro' }],
    ['fill #a hello', 'fill', { selector: '#a', value: 'hello' }],
  ])('%s', (line, cmd, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe(cmd);
    expect(parsed.args).toMatchObject(args);
  });

  it('type takes text and no selector', () => {
    const parsed = parse('type hello world');
    expect(parsed.cmd).toBe('type');
    expect(parsed.args).toMatchObject({ text: 'hello world' });
    expect(parsed.args.selector).toBeUndefined();
  });

  it('fill joins a multi-word value', () => {
    expect(parse('fill #a hello big world').args).toMatchObject({
      selector: '#a',
      value: 'hello big world',
    });
  });

  it.each([
    ['key press Enter', { action: 'press', key: 'Enter' }],
    ['key down Shift', { action: 'down', key: 'Shift' }],
    ['key up Shift', { action: 'up', key: 'Shift' }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('key');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    // Numbers, like --delta-x/--delta-y. These used to arrive as strings only
    // because they fell through to the catch-all that absorbed unknown flags.
    ['mouse move --x 10 --y 20', { action: 'move', x: 10, y: 20 }],
    ['mouse click #a', { action: 'click', selector: '#a' }],
    ['mouse down --button right', { action: 'down', button: 'right' }],
    ['mouse up', { action: 'up' }],
    ['mouse wheel --delta-y 200', { action: 'wheel', deltaY: 200 }],
    ['mouse wheel --delta-x 50', { action: 'wheel', deltaX: 50 }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('mouse');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['dialog inspect', { action: 'inspect' }],
    ['dialog dismiss', { action: 'dismiss' }],
    ['dialog accept my answer', { action: 'accept', text: 'my answer' }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('dialog');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['snapshot', 'snapshot'],
    ['pages', 'pages'],
    ['back', 'back'],
    ['forward', 'forward'],
    ['reload', 'reload'],
    ['status', 'status'],
    ['quit', 'quit'],
  ])('%s takes no arguments', (line, cmd) => {
    expect(parse(line).cmd).toBe(cmd);
  });

  it('eval joins the whole expression', () => {
    expect(parse('eval return 1 + 2').args).toMatchObject({ js: 'return 1 + 2' });
  });

  it('press takes a key and an optional selector', () => {
    expect(parse('press Enter').args).toMatchObject({ key: 'Enter' });
    expect(parse('press Enter #form').args).toMatchObject({ key: 'Enter', selector: '#form' });
  });

  it('find carries pagination flags', () => {
    expect(parse('find li --all --limit 5 --offset 10').args).toMatchObject({
      selector: 'li',
      all: true,
      limit: 5,
      offset: 10,
    });
  });

  it('accepts the documented aliases', () => {
    expect(parse('goto http://x.test').cmd).toBe('go');
    expect(parse('navigate http://x.test').cmd).toBe('go');
    expect(parse('doubleclick #a').cmd).toBe('dblclick');
    expect(parse('attribute #a href').cmd).toBe('attr');
    expect(parse('shot').cmd).toBe('screenshot');
  });

  it.each([
    ['page list', { action: 'list' }],
    ['page open', { action: 'open' }],
    ['page open http://x.test', { action: 'open', url: 'http://x.test' }],
    ['page select 1', { action: 'select', target: '1' }],
    ['page close 2', { action: 'close', target: '2' }],
    ['page select abc123', { action: 'select', target: 'abc123' }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('page');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['state list', { action: 'list' }],
    ['state save alice', { action: 'save', name: 'alice' }],
    ['state load alice', { action: 'load', name: 'alice' }],
    ['state save alice --session-storage', { action: 'save', name: 'alice', sessionStorage: true }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('state');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['logs', { action: 'list' }],
    ['logs list', { action: 'list' }],
    ['logs clear', { action: 'clear' }],
    ['logs wait --contains ready', { action: 'wait', contains: 'ready' }],
    ['logs --kind error --level warn', { action: 'list', kind: 'error', level: 'warn' }],
    ['logs --since 12 --limit 5', { action: 'list', since: 12, limit: 5 }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('logs');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['trace status', { action: 'status' }],
    ['trace start', { action: 'start' }],
    ['trace start checkout', { action: 'start', name: 'checkout' }],
    ['trace start c --no-screenshots', { action: 'start', name: 'c', noScreenshots: true }],
    ['trace stop --zip', { action: 'stop', zip: true }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('trace');
    expect(parsed.args).toMatchObject(args);
  });

  it.each([
    ['mock list', { action: 'list' }],
    ['mock clear', { action: 'clear' }],
    ['mock block **/ads*', { action: 'block', pattern: '**/ads*' }],
    ['mock remove abc', { action: 'remove', id: 'abc' }],
    ['mock add **/api* --status 500', { action: 'add', pattern: '**/api*', status: 500 }],
  ])('%s', (line, args) => {
    const parsed = parse(line);
    expect(parsed.cmd).toBe('mock');
    expect(parsed.args).toMatchObject(args);
  });

  it('trace and mock default to their read-only action', () => {
    expect(parse('trace').args).toMatchObject({ action: 'status' });
    expect(parse('mock').args).toMatchObject({ action: 'list' });
  });

  it('accepts log as an alias for logs', () => {
    expect(parse('log list').cmd).toBe('logs');
  });

  it('state defaults to listing', () => {
    expect(parse('state').args).toMatchObject({ action: 'list' });
  });

  it('keeps --session-storage out of the global --session flag', () => {
    // `--session` is a global routing flag and `--session-storage` is a
    // per-command option; a prefix match here would silently route the
    // command to a session literally named "-storage".
    const parsed = parse('state save alice --session-storage');
    expect(parsed.flags.session).toBeUndefined();
    expect(parsed.args.sessionStorage).toBe(true);
  });

  it('routes `key type` to the type command rather than an unusable key call', () => {
    // The dispatcher has no `key type` action; emitting one produced a
    // confusing "missing required argument key" error.
    const parsed = parse('key type hello world');
    expect(parsed.cmd).toBe('type');
    expect(parsed.args).toMatchObject({ text: 'hello world' });
  });

  it('resolves --files in the caller process, like the positional form', () => {
    const files = parse('upload #f --files ./a.png,./b.png').args.files as string[];
    expect(files).toEqual([resolve('./a.png'), resolve('./b.png')]);
  });

  it('page defaults to listing', () => {
    expect(parse('page').args).toMatchObject({ action: 'list' });
  });

  it('wait distinguishes a selector from a load state', () => {
    expect(parse('wait #a').args).toMatchObject({ target: '#a', kind: 'selector' });
    expect(parse('wait load').args).toMatchObject({ target: 'load', kind: 'load' });
  });

  it('screenshot takes an output path via -o', () => {
    expect(parse('screenshot -o out.png').args).toMatchObject({ path: resolve('out.png') });
  });

  describe('named sessions', () => {
    it('reads --session as a global flag, not a command argument', () => {
      // It addresses a session rather than parameterising a command: the
      // daemon routes on it and the dispatcher must never receive it.
      const parsed = parse('click #a --session checkout');
      expect(parsed.cmd).toBe('click');
      expect(parsed.flags.session).toBe('checkout');
      expect(parsed.args).toEqual({ selector: '#a' });
    });

    it('leaves the session unset when the flag is absent', () => {
      expect(parse('click #a').flags.session).toBeUndefined();
    });

    it('accepts --session anywhere on the line', () => {
      expect(parse('--session admin go http://x.test').flags.session).toBe('admin');
      expect(parse('go --session admin http://x.test').cmd).toBe('go');
    });

    it('maps the session subcommands', () => {
      expect(parse('session list').cmd).toBe('session:list');
      expect(parse('session').cmd).toBe('session:list');
      expect(parse('session close checkout')).toMatchObject({
        cmd: 'session:close',
        args: { target: 'checkout' },
      });
    });

    it('takes the close target from --session when not positional', () => {
      const parsed = parse('session close --session checkout');
      expect(parsed.cmd).toBe('session:close');
      expect(parsed.args.target).toBeUndefined();
      expect(parsed.flags.session).toBe('checkout');
    });
  });

  describe('unknown flags', () => {
    it('rejects a misspelled --session instead of running against the default', () => {
      // The failure this prevents: `--sesion admin` used to be absorbed into
      // an options bag, the typo vanished, and the command ran against the
      // default session — a different browser, with a different login.
      const parsed = parse('click #pay --sesion admin');
      expect(parsed.cmd).toBe('__unknown_flag__');
      expect(parsed.args.flag).toBe('--sesion');
      expect(parsed.args.suggestion).toBe('--session');
    });

    it('rejects an unknown flag that takes no value', () => {
      expect(parse('click #a --turbo').cmd).toBe('__unknown_flag__');
    });

    it('rejects missing flag values instead of consuming another flag', () => {
      expect(parse('click #pay --session')).toMatchObject({
        cmd: '__usage_error__',
        args: { message: '--session requires a value' },
      });
      expect(parse('find #a --limit --all')).toMatchObject({
        cmd: '__usage_error__',
        args: { message: '--limit requires a value' },
      });
    });

    it('rejects malformed numeric values instead of silently using defaults', () => {
      expect(parse('click #pay --timeout banana')).toMatchObject({
        cmd: '__usage_error__',
      });
      expect(parse('find #a --offset -1')).toMatchObject({
        cmd: '__usage_error__',
      });
    });

    it('rejects extra positionals and known flags that the command ignores', () => {
      expect(parse('click #pay -s admin')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('click #pay --all')).toMatchObject({
        cmd: '__usage_error__',
        args: { message: '--all is not valid for click' },
      });
    });

    it('rejects invalid nested actions and action-specific options', () => {
      expect(parse('page list extra')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('page close')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('trace start --zip')).toMatchObject({
        cmd: '__usage_error__',
        args: { message: '--zip is not valid for trace start' },
      });
      expect(parse('mock block **/ads* --status 404')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('state list --session-storage')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('daemon explode')).toMatchObject({ cmd: '__usage_error__' });
    });

    it('requires an upload file before a daemon can be started', () => {
      expect(parse('upload #avatar')).toMatchObject({
        cmd: '__usage_error__',
        args: { message: 'upload: missing required argument "file"' },
      });
      expect(parse('upload #avatar --files ,')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('upload #avatar --files ./avatar.png').cmd).toBe('upload');
    });

    it('validates enumerated arguments in the caller', () => {
      expect(parse('is sideways #save')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('wait #save --state almost')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('wait load --state visible')).toMatchObject({ cmd: '__usage_error__' });
      expect(parse('init claude')).toMatchObject({ cmd: '__usage_error__' });
    });

    it('leaves single-dash tokens alone so text can start with a dash', () => {
      // `type -bob` types the literal text "-bob"; treating it as a flag
      // broke appending to a field mid-form.
      expect(parse('type -bob').cmd).toBe('type');
      expect(parse('type -bob').args.text).toBe('-bob');
    });

    it('treats everything after -- as data', () => {
      expect(parse('type -- --draft').args.text).toBe('--draft');
    });

    it('omits a suggestion when nothing is close', () => {
      const parsed = parse('click #a --quantumfoo');
      expect(parsed.cmd).toBe('__unknown_flag__');
      expect(parsed.args.suggestion).toBeUndefined();
    });

    it('still accepts every documented flag', () => {
      // Guards the drift the suggestion list can introduce: a flag the
      // parser handles but the list forgets is still valid input.
      for (const line of [
        'find #a --limit 5 --offset 2 --all',
        'screenshot -o out.png --full-page',
        'click #a --timeout 100 --json --session admin',
        'logs --kind console --level error --contains boom --since 3',
        'trace start run --no-screenshots',
        'trace stop --zip',
        'mock add /api --status 200 --body {} --content-type application/json',
        'state save auth --session-storage',
        'mouse wheel --delta-x 10 --delta-y 20',
      ]) {
        expect(parse(line).cmd, line).not.toBe('__unknown_flag__');
        expect(parse(line).cmd, line).not.toBe('__usage_error__');
      }
    });

    it('does not mistake a negative number for a flag', () => {
      expect(parse('mouse wheel --delta-y -100').args.deltaY).toBe(-100);
    });
  });

  describe('upload', () => {
    it('collects positional files as a list', () => {
      const parsed = parse('upload #f a.txt b.txt');
      expect(parsed.cmd).toBe('upload');
      expect(parsed.args.selector).toBe('#f');
      expect(parsed.args.files).toEqual([resolve('a.txt'), resolve('b.txt')]);
    });

    it('resolves paths in the caller process, not the daemon', () => {
      // The daemon is long-lived with its own cwd. A relative path sent
      // over the socket would resolve against wherever it was started,
      // so paths must already be absolute on the wire.
      const files = parse('upload #f ./rel.txt').args.files as string[];
      expect(files[0]).toBe(resolve('./rel.txt'));
      expect(files[0].startsWith('/')).toBe(true);
    });
  });
});
