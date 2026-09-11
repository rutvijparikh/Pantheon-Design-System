/**
 * Capture screenshots of the real UI for the README.
 *
 * Not a test — a developer tool. It loads the built extension, runs a genuine
 * scan of the fixture page and screenshots what the panel actually renders, so
 * the images in the docs are real output rather than mockups.
 *
 *   node test/screenshot.mjs [outputDir]
 *
 * Two shims make this possible headlessly, and nothing else is faked:
 *   1. The manifest gets `<all_urls>` host access, because the optional-permission
 *      grant needs a native dialog a headless browser cannot accept.
 *   2. The panel's "which tab am I looking at" query is pointed at the fixture
 *      tab, because the panel is opened as an ordinary tab here rather than in
 *      Chrome's side panel.
 * The collector, the audit and every render path are the shipped ones.
 */
import http from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'docs', 'screenshots'));

if (!existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('Run `npm run build` first.');
}

function findChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers && existsSync(browsers)) {
    return readdirSync(browsers)
      .filter((entry) => entry.startsWith('chromium-'))
      .sort()
      .reverse()
      .map((entry) => path.join(browsers, entry, 'chrome-linux', 'chrome'))
      .find((candidate) => existsSync(candidate));
  }
  return undefined;
}

// A copy of the build with blanket host access, so no permission dialog appears.
const staged = mkdtempSync(path.join(os.tmpdir(), 'pantheon-ext-'));
await cp(dist, staged, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(staged, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://api.anthropic.com/*', '<all_urls>'];
await writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2));

const fixture = await readFile(path.join(here, 'fixture.html'));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(path.join(os.tmpdir(), 'pantheon-shots-'));
const executablePath = findChromium();
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--headless=new',
    `--disable-extensions-except=${staged}`,
    `--load-extension=${staged}`,
    '--no-sandbox',
  ],
});

const worker =
  context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
const extensionId = new URL(worker.url()).host;

await mkdir(outDir, { recursive: true });

// The page the panel will audit.
const target = await context.newPage();
await target.setViewportSize({ width: 900, height: 560 });
await target.goto(origin, { waitUntil: 'load' });
const targetTabId = await worker.evaluate(
  async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0].id,
  origin,
);

/** The side panel, in the geometry Chrome actually gives it. */
async function openPanel() {
  const panel = await context.newPage();
  // A persistent context ignores per-page viewport options, so size it here to
  // the geometry Chrome actually gives the side panel.
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.addInitScript((tabId) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (query) =>
      query?.active ? Promise.resolve([{ id: tabId }]) : real(query);
  }, targetTabId);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForSelector('#scan');
  await panel.waitForFunction(() =>
    document.getElementById('source').textContent.includes('tokens'),
  );
  return panel;
}

const shot = async (page, name) => {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(path.relative(root, file));
};

// 1. The empty state.
const empty = await openPanel();
await empty.waitForSelector('#banner:not([hidden])');
await shot(empty, 'panel-empty');
await empty.close();

// 2. A real audit of the fixture page.
const panel = await openPanel();
await panel.click('#scan');
await panel.waitForSelector('#report:not([hidden])', { timeout: 20000 });
await panel.locator('#findings').evaluate((details) => {
  details.open = true;
});
// The Claude turn needs a key we do not have here; the banner that replaces it
// is the honest state for a fresh install.
await panel.waitForSelector('#banner:not([hidden])', { timeout: 20000 });
await panel.waitForTimeout(300);
await shot(panel, 'panel-audit');
await panel.close();

// 3. The options page.
const options = await context.newPage();
await options.setViewportSize({ width: 860, height: 1180 });
await options.goto(`chrome-extension://${extensionId}/options.html`);
await options.waitForSelector('#api-key');
await options.fill('#token-json', '');
await options.waitForTimeout(200);
await shot(options, 'options');
await options.close();

// 4. The picker overlay on the page being inspected.
const picker = await openPanel();
await picker.click('#pick');
await picker.waitForTimeout(500);
await target.bringToFront();
const box = await target.locator('button.cta').first().boundingBox();
await target.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await target.waitForFunction(() => {
  const overlay = document.getElementById('pantheon-copilot-overlay');
  return overlay && overlay.style.display === 'block';
});
await target.screenshot({ path: path.join(outDir, 'picker.png') });
console.log(path.relative(root, path.join(outDir, 'picker.png')));
await picker.close();

await context.close();
server.close();
await rm(profile, { recursive: true, force: true });
await rm(staged, { recursive: true, force: true });
