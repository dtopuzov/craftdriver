/**
 * The vendored chromium-bidi mapper drives a real Chrome.
 *
 * This is the gate every mapper update runs (`npm run mapper:update`): it
 * launches Chrome directly, runs the bundled mapper in-process (no parser, so
 * no zod) behind craftdriver's BiDiConnection, and checks the behaviour
 * craftdriver relies on. Pages are data: URLs so no examples server is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChrome, type LaunchedChrome } from '../src/lib/chromeLauncher';
import { findChromeBinary } from '../src/lib/driverManager';
import { BiDiConnection } from '../src/lib/bidi/connection';
import { startInProcessMapper } from '../src/lib/bidi/inProcessMapper';
import { IS_CHROMIUM } from './utils';

const PROMPTS_IGNORED = {
  unhandledPromptBehavior: {
    alert: 'ignore',
    confirm: 'ignore',
    prompt: 'ignore',
    beforeUnload: 'ignore',
  },
};

const page = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

describe.runIf(IS_CHROMIUM)('bundled chromium-bidi mapper', () => {
  let chrome: LaunchedChrome;
  let bidi: BiDiConnection;
  let context: string;

  beforeAll(async () => {
    chrome = await launchChrome({ binary: findChromeBinary()!, headless: true });
    bidi = new BiDiConnection();
    bidi.connectTransport(
      await startInProcessMapper(chrome.wsUrl, { capabilities: PROMPTS_IGNORED })
    );
    const tree = await bidi.send<{ contexts: Array<{ context: string; url: string }> }>(
      'browsingContext.getTree',
      { maxDepth: 0 }
    );
    expect(tree.contexts).toHaveLength(1);
    context = tree.contexts[0].context;
  });

  afterAll(async () => {
    await bidi?.close();
    await chrome?.close();
  });

  it('navigates, evaluates and locates nodes', async () => {
    const nav = await bidi.send<{ url: string }>('browsingContext.navigate', {
      context,
      url: page('<title>mapper</title><button id="b">go</button>'),
      wait: 'complete',
    });
    expect(nav.url).toContain('data:text/html');

    const evaluated = await bidi.send<{ result: { type: string; value: unknown } }>(
      'script.evaluate',
      { expression: 'document.title', target: { context }, awaitPromise: false }
    );
    expect(evaluated.result).toEqual({ type: 'string', value: 'mapper' });

    const located = await bidi.send<{ nodes: Array<{ sharedId: string }> }>(
      'browsingContext.locateNodes',
      { context, locator: { type: 'css', value: '#b' } }
    );
    expect(located.nodes).toHaveLength(1);
    // Classic element ids and BiDi sharedIds share this format; craftdriver
    // passes one as the other across the protocol boundary.
    expect(located.nodes[0].sharedId).toMatch(/^f\.[0-9A-F]+\.d\.[0-9A-F]+\.e\.\d+$/);
  });

  it('delivers subscribed events', async () => {
    await bidi.subscribe(['browsingContext.load']);
    const loaded = bidi.once<{ url: string }>('browsingContext.load', undefined, 10_000);
    await bidi.send('browsingContext.navigate', { context, url: page('<p>loaded</p>') });
    expect((await loaded).url).toContain('data:text/html');
    await bidi.unsubscribe(['browsingContext.load']);
  });

  it('leaves dialogs open for the client when prompts are ignored', async () => {
    await bidi.subscribe(['browsingContext.userPromptOpened']);
    const opened = bidi.once<{ type: string; message: string }>(
      'browsingContext.userPromptOpened',
      undefined,
      10_000
    );
    await bidi.send('script.evaluate', {
      expression: 'setTimeout(() => alert("hi"), 0)',
      target: { context },
      awaitPromise: false,
    });
    expect(await opened).toMatchObject({ type: 'alert', message: 'hi' });

    // Still open: closing it succeeds exactly once.
    await bidi.send('browsingContext.handleUserPrompt', { context, accept: true });
    await expect(
      bidi.send('browsingContext.handleUserPrompt', { context, accept: true })
    ).rejects.toThrow(/no such alert/);
    await bidi.unsubscribe(['browsingContext.userPromptOpened']);
  });

  // Without the validating parser, bad input still gets W3C error codes from
  // the mapper's own processors.
  it.each([
    ['browsingContext.navigate', { url: 42 }, 'invalid argument'],
    ['browsingContext.doesNotExist', {}, 'unknown command'],
    ['browsingContext.navigate', { context: 'nope', url: 'data:,' }, 'no such frame'],
  ])('%s with bad input fails with %s', async (method, params, code) => {
    await expect(bidi.send(method, { context, ...params })).rejects.toThrow(`[${code}]`);
  });
});
