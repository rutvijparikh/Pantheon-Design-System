/**
 * Loads the built extension into real Chromium.
 *
 * This is the check the unit tests cannot make: that the manifest is accepted,
 * that the MV3 service worker starts and the bundled Anthropic SDK survives the
 * worker environment (no `window`, no DOM), and that the two extension pages
 * render and wire themselves up without throwing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { contrastRatio, flatten, parseColor } from '../src/lib/color.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

if (!existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('Run `npm run build` before the extension tests.');
}

function findChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers && existsSync(browsers)) {
    const found = readdirSync(browsers)
      .filter((entry) => entry.startsWith('chromium-'))
      .sort()
      .reverse()
      .map((entry) => path.join(browsers, entry, 'chrome-linux', 'chrome'))
      .find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return undefined;
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'pantheon-profile-'));
const executablePath = findChromium();

/** Errors the page or worker logged, collected across the whole session. */
const problems = [];

const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--headless=new',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-sandbox',
  ],
});

context.on('weberror', (error) => problems.push(`weberror: ${error.error().message}`));
context.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

/** The worker registers a moment after the browser comes up. */
async function serviceWorker() {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: 15000 });
}

const extensionId = new URL((await serviceWorker()).url()).host;

/**
 * Evaluate in the service worker, re-acquiring it first.
 *
 * Chrome stops an idle MV3 worker and starts a fresh one on the next event,
 * which leaves any handle we captured earlier pointing at a dead or
 * half-initialised context — evaluating against one of those fails in confusing
 * ways (a missing `chrome.storage`, for instance). So take the current worker
 * every time, and retry once across a restart.
 */
async function inWorker(fn, argument) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const worker = await serviceWorker();
      return await worker.evaluate(fn, argument);
    } catch (error) {
      if (attempt >= 3) throw error;
      // Poke the worker so Chrome spins a new one up, then try again.
      await context.newPage().then(async (page) => {
        await page.goto(`chrome-extension://${extensionId}/options.html`);
        await page.close();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

test.after(async () => {
  await context.close();
  await rm(profile, { recursive: true, force: true });
});

test('the extension loads and its service worker starts', async () => {
  const worker = await serviceWorker();
  assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/);
  assert.equal(extensionId.length, 32, `extension id is ${extensionId}`);
});

test('the worker is a real MV3 worker with what the SDK needs', async () => {
  // A module-level throw would have stopped the worker from reaching "activated"
  // at all, so the environment probe below doubles as proof the bundle — the
  // Anthropic SDK included — evaluated cleanly here.
  const environment = await inWorker(async () => {
    // Transcripts live in session storage precisely because this worker can be
    // unloaded between turns, so confirm that surface is actually usable here.
    await chrome.storage.session.set({ 'probe:session': { ok: true } });
    const round = await chrome.storage.session.get('probe:session');
    await chrome.storage.session.remove('probe:session');

    return {
      hasChrome: typeof chrome !== 'undefined',
      hasFetch: typeof fetch === 'function',
      hasAbort: typeof AbortController === 'function',
      noWindow: typeof window === 'undefined',
      noDocument: typeof document === 'undefined',
      scope: self.constructor.name,
      sessionStorage: round['probe:session']?.ok === true,
    };
  });

  assert.equal(environment.hasChrome, true, 'chrome APIs are present');
  assert.equal(environment.hasFetch, true, 'fetch is available for API calls');
  assert.equal(environment.hasAbort, true, 'AbortController backs the Stop button');
  assert.equal(environment.noWindow, true, 'this really is a worker, not a page');
  assert.equal(environment.noDocument, true);
  assert.equal(environment.scope, 'ServiceWorkerGlobalScope');
  assert.equal(environment.sessionStorage, true, 'session storage round-trips');
});

test('the worker bundle carries the Anthropic SDK and the browser-access flag', async () => {
  // The SDK refuses browser-like environments unless `dangerouslyAllowBrowser`
  // is set, and that same flag is what sends the header the API requires for a
  // request with a `chrome-extension://` origin. Both must survive minification.
  const source = await inWorker(() =>
    fetch(chrome.runtime.getURL('service-worker.js')).then((response) => response.text()),
  );
  assert.match(source, /anthropic-dangerous-direct-browser-access/);
  assert.match(source, /api\.anthropic\.com/);
  assert.match(source, /server-side-fallback-2026-07-01/, 'refusal fallbacks are wired');
  assert.match(source, /claude-opus-5/, 'the default model survived the build');
});

test('the worker registers its listeners', async () => {
  // MV3 is free to unload and restart the worker, and a restart re-evaluates
  // the module asynchronously — so poll for the wiring rather than sampling it
  // once and catching a restart mid-flight.
  const read = () =>
    inWorker(() => ({
      onConnect: chrome.runtime.onConnect.hasListeners(),
      onMessage: chrome.runtime.onMessage.hasListeners(),
      onRemoved: chrome.tabs.onRemoved.hasListeners(),
      storageChanged: chrome.storage.onChanged.hasListeners(),
    }));

  let wired = await read();
  for (let attempt = 0; attempt < 20 && !Object.values(wired).every(Boolean); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    wired = await read();
  }

  assert.deepEqual(wired, {
    onConnect: true,
    onMessage: true,
    onRemoved: true,
    storageChanged: true,
  });
});

test('the worker ships the token file and can index it', async () => {
  const tokens = await inWorker(async () => {
    const response = await fetch(chrome.runtime.getURL('tokens/pantheon.tokens.json'));
    const tree = await response.json();
    return { ok: response.ok, groups: Object.keys(tree).filter((key) => !key.startsWith('$')) };
  });
  assert.equal(tokens.ok, true);
  assert.deepEqual(tokens.groups.sort(), ['borderRadius', 'colors', 'spacing']);
});

test('the options page renders and saves a setting', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await assert.doesNotReject(page.waitForSelector('#api-key', { timeout: 5000 }));
  assert.equal(await page.locator('#model option').count(), 3, 'the model list populated');
  assert.equal(await page.locator('#model').inputValue(), 'claude-opus-5', 'defaults to Opus 5');
  assert.equal(await page.locator('#effort').inputValue(), 'high');
  assert.ok(await page.locator('#source-bundled').isChecked(), 'bundled tokens by default');

  // Changing the model persists, and the effort control follows model support.
  await page.selectOption('#model', 'claude-haiku-4-5');
  await page.waitForFunction(() => document.getElementById('effort').disabled);
  const stored = await page.evaluate(() => chrome.storage.local.get('model'));
  assert.equal(stored.model, 'claude-haiku-4-5', 'the change was saved');

  await page.selectOption('#model', 'claude-opus-5');
  await page.waitForFunction(() => !document.getElementById('effort').disabled);

  // The key field starts masked and the reveal button toggles it.
  assert.equal(await page.locator('#api-key').getAttribute('type'), 'password');
  await page.click('#reveal');
  assert.equal(await page.locator('#api-key').getAttribute('type'), 'text');

  await page.close();
});

test('the options page validates a pasted token file as you type', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.fill('#token-json', '{ "not json" ');
  await page.waitForSelector('#token-result.bad');
  assert.match(await page.locator('#token-result').textContent(), /Not valid JSON/);

  await page.fill('#token-json', '{"brand":{"ink":{"$value":"#101010","$type":"color"}}}');
  await page.waitForSelector('#token-result.ok');
  assert.match(await page.locator('#token-result').textContent(), /1 tokens — 1 colours/);

  await page.fill('#token-json', '{"brand":{}}');
  await page.waitForSelector('#token-result.bad');
  assert.match(await page.locator('#token-result').textContent(), /no tokens found/);

  await page.close();
});

test('the side panel renders, connects and reports its token source', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await assert.doesNotReject(page.waitForSelector('#scan', { timeout: 5000 }));
  assert.equal(await page.locator('h1').textContent(), 'Pantheon Copilot');
  assert.ok(await page.locator('#empty').isVisible(), 'the empty state shows first');
  assert.ok(await page.locator('#report').isHidden(), 'no report before a scan');

  // The worker answers the panel's opening handshake over the port.
  await page.waitForFunction(
    () => document.getElementById('source').textContent.includes('tokens'),
    { timeout: 10000 },
  );
  assert.match(
    await page.locator('#source').textContent(),
    /^18 tokens · bundled Pantheon tokens$/,
  );

  // With no API key stored, the panel says so rather than failing silently.
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner-text').textContent(), /API key/);

  await page.close();
});

test('Copy CSS round-trips through the worker and back to the panel', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.waitForSelector('#export');

  // Clicking asks the worker for the token set as CSS; the worker answers over
  // the port and the panel puts it on the clipboard. Either outcome — copied,
  // or a clipboard the headless browser would not hand over — proves the round
  // trip completed.
  await page.click('#export');
  await page.waitForSelector('#status:not([hidden])', { timeout: 10000 });
  const status = await page.locator('#status').textContent();
  assert.match(status, /Copied bundled Pantheon tokens|Could not reach the clipboard/, status);

  await page.close();
});

test('the composer sends on Enter and keeps Shift+Enter for newlines', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.waitForSelector('#question');

  await page.fill('#question', 'first line');
  await page.press('#question', 'Shift+Enter');
  await page.type('#question', 'second line');
  assert.equal(
    await page.locator('#question').inputValue(),
    'first line\nsecond line',
    'Shift+Enter inserts a newline instead of sending',
  );

  // Enter submits, which clears the field and asks the worker — with no audit
  // in this session the worker answers with an error banner, which is correct.
  await page.press('#question', 'Enter');
  await page.waitForFunction(() => document.getElementById('question').value === '');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 10000 });
  assert.match(
    await page.locator('#banner-text').textContent(),
    /API key|Scan a page or pick an element first/,
  );

  await page.close();
});

test('the primary button stays legible while hovered', async () => {
  // Regression: a generic `button:hover` rule outranks `button.primary` on
  // specificity, which painted white label text on a near-white ground — the
  // button vanished under the cursor.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.waitForSelector('#scan');

  const read = () =>
    page.locator('#scan').evaluate((button) => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor };
    });

  const resting = await read();
  await page.hover('#scan');
  const hovered = await read();

  for (const [state, paint] of [
    ['resting', resting],
    ['hovered', hovered],
  ]) {
    const ratio = contrastRatio(
      flatten(parseColor(paint.color)),
      flatten(parseColor(paint.background)),
    );
    assert.ok(
      ratio >= 4.5,
      `the ${state} primary button needs readable contrast, got ${ratio.toFixed(2)}:1 ` +
        `(${paint.color} on ${paint.background})`,
    );
  }

  await page.close();
});

test('nothing logged an error while the extension ran', () => {
  const unexpected = problems.filter(
    (problem) =>
      // Chrome's own noise in headless: favicon and devtools probes.
      !/favicon|net::ERR_FILE_NOT_FOUND|Failed to load resource/.test(problem),
  );
  assert.deepEqual(unexpected, [], `clean console, got:\n${unexpected.join('\n')}`);
});
