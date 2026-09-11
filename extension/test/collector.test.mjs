/**
 * Browser tests for the page-side collector.
 *
 * These run the *built* `dist/inspector.js` inside real Chromium against a
 * fixture page with known planted drift. Only `chrome.runtime` is stubbed — the
 * messaging shim the collector talks through — so the DOM walking, computed
 * style reads, background resolution and selector generation are all the real
 * thing. The resulting scan is then pushed through the real audit engine, which
 * makes this an end-to-end check of collect → audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { buildIndex } from '../src/lib/tokens.js';
import { auditElement, auditPage } from '../src/lib/audit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bundle = path.join(root, 'dist', 'inspector.js');
const fixture = readFileSync(path.join(here, 'fixture.html'));

if (!existsSync(bundle)) {
  throw new Error('Run `npm run build` before the browser tests — they exercise dist/.');
}

const index = buildIndex(
  JSON.parse(readFileSync(path.join(root, '..', 'sample-tokens.json'), 'utf8')),
);

/**
 * The collector reads `location.href`, so the fixture is served over http
 * rather than loaded from a file:// URL.
 */
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

/**
 * Find a Chromium to drive. Playwright's own download is preferred, but CI
 * images often ship one at a fixed path whose build number will not match the
 * pinned Playwright version — `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, or a
 * `PLAYWRIGHT_BROWSERS_PATH` install, wins over re-downloading.
 */
function findChromium() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;

  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers && existsSync(browsers)) {
    const candidates = readdirSync(browsers)
      .filter((entry) => entry.startsWith('chromium-'))
      .sort()
      .reverse()
      .map((entry) => path.join(browsers, entry, 'chrome-linux', 'chrome'));
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return undefined;
}

const executablePath = findChromium();
const browser = await chromium.launch(executablePath ? { executablePath } : {});

/** A page with the collector loaded and the extension messaging shim stubbed. */
async function openFixture() {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.addInitScript(() => {
    window.__sent = [];
    window.chrome = {
      runtime: {
        onMessage: {
          addListener: (listener) => {
            window.__listener = listener;
          },
        },
        sendMessage: (message) => window.__sent.push(message),
      },
    };
  });
  await page.goto(origin, { waitUntil: 'load' });
  await page.addScriptTag({ path: bundle });
  await page.waitForFunction(() => typeof window.__listener === 'function');
  return page;
}

const collect = (page) =>
  page.evaluate(
    () => new Promise((resolve) => window.__listener({ type: 'collect-page' }, null, resolve)),
  );

test.after(async () => {
  await browser.close();
  server.close();
});

// ------------------------------------------------------------------ collector

test('collects the values the fixture page actually uses', async () => {
  const page = await openFixture();
  const scan = await collect(page);

  assert.equal(scan.url, origin);
  assert.equal(scan.title, 'Drift fixture');
  assert.ok(scan.elementsScanned > 8, `scanned ${scan.elementsScanned} elements`);
  assert.equal(scan.truncated, false);

  const colors = scan.colors.map((usage) => usage.value);
  assert.ok(colors.includes('rgb(10, 106, 251)'), 'the drifted CTA blue');
  assert.ok(colors.includes('rgb(139, 92, 246)'), 'the off-palette badge purple');
  assert.ok(colors.includes('rgb(17, 24, 39)'), 'the on-token body text colour');

  const spacing = scan.spacing.map((usage) => usage.value);
  assert.ok(spacing.includes(14), 'the 14px card padding');
  assert.ok(spacing.includes(37), 'the 37px hero margin');
  assert.ok(spacing.includes(16), 'the on-token 16px values');

  const radii = scan.radii.map((usage) => usage.value);
  assert.ok(radii.includes(6), 'the 6px card radius');
  assert.ok(radii.includes(8), 'the on-token 8px button radius');

  await page.close();
});

test('counts repeated values once, with a count and example selectors', async () => {
  const page = await openFixture();
  const scan = await collect(page);

  // The fixture has two .card elements and two .cta buttons.
  const cardPadding = scan.spacing.find((usage) => usage.value === 14);
  assert.equal(cardPadding.count, 8, 'four sides on two cards');
  assert.ok(cardPadding.properties.includes('padding-top'));

  const ctaBackground = scan.colors.find((usage) => usage.value === 'rgb(10, 106, 251)');
  assert.equal(ctaBackground.count, 2, 'two CTA buttons');
  assert.ok(
    ctaBackground.examples.some((selector) => selector.includes('button')),
    `examples name the element: ${ctaBackground.examples.join(', ')}`,
  );

  await page.close();
});

test('resolves the effective background through transparent ancestors', async () => {
  const page = await openFixture();
  const scan = await collect(page);

  // .badge sits inside .card, which paints #F9FAFB; the badge itself has no
  // background, so its contrast pair must report the card's colour.
  const badgePair = scan.contrast.find((pair) => pair.foreground === 'rgb(139, 92, 246)');
  assert.ok(badgePair, 'the badge produced a contrast pair');
  assert.equal(badgePair.background, 'rgb(249, 250, 251)', 'inherited the card background');

  // .hint is a direct child of body, which paints white.
  const hintPair = scan.contrast.find((pair) => pair.foreground === 'rgb(156, 163, 175)');
  assert.equal(hintPair.background, 'rgb(255, 255, 255)');

  await page.close();
});

test('ignores the script and style elements it walks past', async () => {
  const page = await openFixture();
  const scan = await collect(page);
  const allExamples = [...scan.colors, ...scan.spacing].flatMap((usage) => usage.examples);
  for (const selector of allExamples) {
    assert.ok(!/\b(script|style|head|meta|title)\b/.test(selector), selector);
  }
  await page.close();
});

test('leaves the browser\'s own default margins out of the scan', async () => {
  const page = await openFixture();
  const scan = await collect(page);

  // The fixture sets no margin on h1/h2/p, but Chrome's stylesheet gives each an
  // em-based one. Reporting those as token violations would bury the values the
  // page actually chose — and on a real page there are hundreds of them.
  const marginUsages = scan.spacing.filter((usage) =>
    usage.properties.some((property) => property.startsWith('margin')),
  );
  const values = marginUsages.map((usage) => usage.value);

  // Nothing whose only margin comes from the UA stylesheet may appear.
  const selectors = marginUsages.flatMap((usage) => usage.examples);
  for (const selector of selectors) {
    assert.ok(
      !/(^|[\s>])(h1|h2|p)(:|$|[\s>])/.test(selector),
      `${selector} has only a browser-default margin and must not be reported`,
    );
  }

  // The em-derived defaults land on fractional pixels; none should survive.
  for (const value of values) {
    assert.equal(value, Math.round(value), `${value}px looks like an em-derived UA default`);
  }

  // What the fixture did set must still come through: the 37px hero margin, and
  // the 16px card margin — which is also a `<p>` default, so a filter keyed on
  // the value rather than the element would wrongly drop it.
  assert.ok(values.includes(37), `the authored 37px margin survives: ${values.join(', ')}`);
  assert.ok(values.includes(16), `the authored 16px card margin survives: ${values.join(', ')}`);

  const cardMargin = marginUsages.find((usage) => usage.value === 16);
  assert.ok(
    cardMargin.examples.some((selector) => selector.includes('card')),
    `the 16px margin is attributed to .card, not a paragraph: ${cardMargin.examples.join(', ')}`,
  );

  await page.close();
});

// --------------------------------------------------------- collector → audit

test('the audit finds exactly the drift the fixture planted', async () => {
  const page = await openFixture();
  const result = auditPage(await collect(page), index);

  const has = (predicate, description) =>
    assert.ok(result.findings.some(predicate), `expected a finding: ${description}`);

  has(
    (f) => f.category === 'color' && f.actual === '#0A6AFB' && f.severity === 'warning',
    'the CTA blue as drift from colors.primary',
  );
  has(
    (f) => f.category === 'color' && f.actual === '#8B5CF6' && f.severity === 'error',
    'the badge purple as off-palette',
  );
  has(
    (f) => f.category === 'spacing' && f.actual === '37px' && f.severity === 'error',
    'the 37px hero margin as off-ramp',
  );
  has(
    (f) => f.category === 'spacing' && f.actual === '14px' && f.severity === 'warning',
    'the 14px card padding as a near miss',
  );
  has(
    (f) => f.category === 'radius' && f.actual === '6px' && f.severity === 'warning',
    'the 6px radius as a near miss',
  );
  has(
    (f) => f.category === 'contrast' && f.severity === 'error' && f.message.includes('#9CA3AF'),
    'the low-contrast hint text',
  );

  // Values the fixture put on tokens must not be reported.
  for (const clean of ['#111827', '#FFFFFF', '#F9FAFB']) {
    assert.ok(
      !result.findings.some((f) => f.category === 'color' && f.actual === clean),
      `${clean} is on-token and should not be flagged`,
    );
  }
  for (const clean of ['16px', '32px', '8px']) {
    assert.ok(
      !result.findings.some((f) => f.category === 'spacing' && f.actual === clean),
      `${clean} is on-token and should not be flagged`,
    );
  }

  assert.ok(
    result.coverage.overall > 0 && result.coverage.overall < 100,
    `a partly drifted page scores between 0 and 100, got ${result.coverage.overall}`,
  );

  await page.close();
});

// --------------------------------------------------------------------- picker

test('the picker highlights what the pointer is over and reports the click', async () => {
  const page = await openFixture();
  await page.addStyleTag({ path: path.join(root, 'dist', 'inspector.css') });
  await page.evaluate(
    () => new Promise((resolve) => window.__listener({ type: 'pick-element' }, null, resolve)),
  );

  const target = await page.locator('button.cta').first().boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);

  await page.waitForFunction(() => {
    const overlay = document.getElementById('pantheon-copilot-overlay');
    return overlay && overlay.style.display === 'block';
  });
  const label = await page.locator('#pantheon-copilot-label').textContent();
  assert.match(label, /^button · \d+×\d+$/, `label reads "${label}"`);

  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await page.waitForFunction(() => window.__sent.length > 0);

  const [message] = await page.evaluate(() => window.__sent);
  assert.equal(message.type, 'element-picked');
  assert.equal(message.sample.tag, 'BUTTON');
  assert.match(message.sample.selector, /button\.cta/);
  assert.equal(message.sample.colors['background-color'], 'rgb(10, 106, 251)');
  assert.equal(message.sample.radii['border-top-left-radius'], '8px');
  assert.equal(message.sample.contrast.background, 'rgb(10, 106, 251)');

  // The overlay must clean itself up after the click.
  assert.equal(await page.locator('#pantheon-copilot-overlay').count(), 0);

  const element = auditElement(message.sample, index);
  assert.ok(
    element.findings.some((f) => f.actual === '#0A6AFB'),
    'auditing the picked button reports the drifted blue',
  );

  await page.close();
});

test('Escape cancels the picker without reporting an element', async () => {
  const page = await openFixture();
  await page.evaluate(
    () => new Promise((resolve) => window.__listener({ type: 'pick-element' }, null, resolve)),
  );
  await page.mouse.move(200, 200);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__sent.length > 0);

  const [message] = await page.evaluate(() => window.__sent);
  assert.equal(message.type, 'pick-aborted');
  assert.equal(await page.locator('#pantheon-copilot-overlay').count(), 0);

  await page.close();
});

test('the collector is inert when injected twice', async () => {
  const page = await openFixture();
  const first = await collect(page);
  await page.addScriptTag({ path: bundle });
  const second = await collect(page);
  assert.equal(second.elementsScanned, first.elementsScanned, 'no double registration');
  await page.close();
});
