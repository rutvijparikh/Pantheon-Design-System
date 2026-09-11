/**
 * Unit tests for the pure logic: colour maths, the token index, the audit
 * verdicts and the markdown renderer. No browser and no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contrastRatio, deltaE, flatten, parseColor, toHex } from '../src/lib/color.js';
import { buildIndex, nearestDimension, toCssVariables, toPixels } from '../src/lib/tokens.js';
import { auditContrastPair, auditElement, auditPage, classifyColor } from '../src/lib/audit.js';
import { buildOpeningMessage, buildSystem, describeAudit } from '../src/lib/prompt.js';
import { renderMarkdown } from '../src/lib/markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenTree = JSON.parse(readFileSync(path.join(here, '..', '..', 'sample-tokens.json'), 'utf8'));
const index = buildIndex(tokenTree);

// ------------------------------------------------------------------- colour

test('parses every colour form Chrome and token files produce', () => {
  const expected = { r: 0, g: 102, b: 255, a: 1 };
  for (const input of ['#0066FF', '#0066ff', 'rgb(0, 102, 255)', 'rgb(0 102 255)', 'color(srgb 0 0.4 1)']) {
    assert.deepEqual(parseColor(input), expected, input);
  }
  assert.deepEqual(parseColor('#06F'), expected, 'three-digit hex');
  assert.deepEqual(parseColor('rgba(0, 102, 255, 0.5)'), { ...expected, a: 0.5 });
  assert.equal(parseColor('transparent').a, 0);
});

test('returns null for colours it cannot resolve rather than guessing', () => {
  for (const input of ['currentColor', 'inherit', 'var(--x)', '#12345', '', 'nonsense']) {
    assert.equal(parseColor(input), null, input);
  }
});

test('deltaE is zero for identical colours and grows with visible difference', () => {
  const primary = parseColor('#0066FF');
  assert.equal(deltaE(primary, parseColor('rgb(0, 102, 255)')), 0);
  assert.ok(deltaE(primary, parseColor('#0A6AFB')) < 3, 'a near-identical blue stays under the near band');
  assert.ok(deltaE(primary, parseColor('#EF4444')) > 30, 'red is far from blue');
});

test('contrast ratio matches the WCAG reference values', () => {
  assert.equal(contrastRatio(parseColor('#FFFFFF'), parseColor('#000000')).toFixed(2), '21.00');
  assert.equal(contrastRatio(parseColor('#FFFFFF'), parseColor('#FFFFFF')).toFixed(2), '1.00');
});

test('flatten composites alpha over a backdrop', () => {
  const half = flatten(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#FFFFFF'));
  assert.equal(toHex(half), '#808080');
});

// -------------------------------------------------------------------- tokens

test('flattens the nested token tree into dotted paths', () => {
  const paths = index.tokens.map((token) => token.path);
  assert.ok(paths.includes('colors.background.subtle'), 'nested group flattens');
  assert.ok(paths.includes('spacing.md'));
  assert.equal(index.tokens.length, 18);
  assert.equal(index.colors.length, 9);
  assert.equal(index.dimensions.length, 9);
});

test('ignores $-prefixed group metadata', () => {
  const paths = index.tokens.map((token) => token.path);
  assert.ok(!paths.some((entry) => entry.includes('$description')));
});

test('resolves dimensions to pixels from numbers and strings', () => {
  assert.equal(toPixels(16), 16);
  assert.equal(toPixels('16px'), 16);
  assert.equal(toPixels('1rem'), 16);
  assert.equal(toPixels('bogus'), null);
});

test('nearest dimension stays inside the requested ramp', () => {
  // 9999 is borderRadius.full and would otherwise win nothing; 30px must match
  // the spacing ramp, not a radius.
  assert.equal(nearestDimension(30, index, 'spacing').token.path, 'spacing.xl');
  assert.equal(nearestDimension(30, index, 'borderRadius').token.path, 'borderRadius.lg');
});

test('renders the token set as CSS custom properties', () => {
  const css = toCssVariables(tokenTree);
  assert.match(css, /--pantheon-colors-primary: #0066FF;/);
  assert.match(css, /--pantheon-spacing-md: 16px;/);
  assert.match(css, /--pantheon-border-radius-full: 9999px;/);
});

// --------------------------------------------------------------------- audit

test('classifies an exact token value as on-token across notations', () => {
  for (const input of ['#0066FF', 'rgb(0, 102, 255)', 'color(srgb 0 0.4 1)']) {
    const verdict = classifyColor(input, index);
    assert.equal(verdict.status, 'on-token', input);
    assert.equal(verdict.token.path, 'colors.primary');
  }
});

test('classifies a slightly drifted colour as a near miss, not a violation', () => {
  const verdict = classifyColor('#0A6AFB', index);
  assert.equal(verdict.status, 'near');
  assert.equal(verdict.token.path, 'colors.primary');
});

test('classifies a colour outside the palette as off-token', () => {
  const verdict = classifyColor('#8B5CF6', index);
  assert.equal(verdict.status, 'off-token');
  assert.ok(verdict.deltaE > 3);
});

test('withholds a suggestion when nothing in the palette is close', () => {
  const verdict = classifyColor('#00FF88', index);
  assert.equal(verdict.status, 'off-token');
  assert.equal(verdict.token, null, 'no misleading nearest-token suggestion');
});

test('skips fully transparent colours instead of auditing them', () => {
  assert.equal(classifyColor('rgba(0, 0, 0, 0)', index), null);
});

test('fails contrast below AA and holds large text to the lower bar', () => {
  const small = auditContrastPair({
    foreground: 'rgb(156, 163, 175)',
    background: 'rgb(255, 255, 255)',
    fontSize: '13px',
    fontWeight: '400',
  });
  assert.equal(small.severity, 'error');
  assert.match(small.message, /fails WCAG AA for body text/);

  const large = auditContrastPair({
    foreground: 'rgb(156, 163, 175)',
    background: 'rgb(255, 255, 255)',
    fontSize: '28px',
    fontWeight: '400',
  });
  assert.equal(large.severity, 'error');
  assert.match(large.message, /large text/);
});

test('says nothing about a pair that already clears AAA', () => {
  assert.equal(
    auditContrastPair({
      foreground: 'rgb(17, 24, 39)',
      background: 'rgb(255, 255, 255)',
      fontSize: '16px',
      fontWeight: '400',
    }),
    null,
  );
});

test('an element entirely on tokens produces no findings', () => {
  const result = auditElement(
    {
      selector: 'button.ok',
      colors: { color: '#FFFFFF', 'background-color': '#0066FF' },
      spacing: { 'padding-left': '16px' },
      radii: { 'border-radius': '8px' },
      contrast: null,
    },
    index,
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.errors, 0);
});

test('page audit ranks errors first and weights findings by element count', () => {
  const scan = {
    elementsScanned: 100,
    colors: [
      { value: 'rgb(139, 92, 246)', count: 7, properties: ['color'], examples: ['.badge'] },
      { value: 'rgb(10, 106, 251)', count: 44, properties: ['background-color'], examples: ['.cta'] },
      { value: 'rgb(17, 24, 39)', count: 200, properties: ['color'], examples: ['p'] },
    ],
    spacing: [{ value: 37, count: 3, properties: ['margin-bottom'], examples: ['.hero'] }],
    radii: [],
    contrast: [],
  };
  const result = auditPage(scan, index);

  assert.equal(result.findings[0].severity, 'error', 'errors lead');
  const drift = result.findings.find((finding) => finding.actual === '#0A6AFB');
  assert.equal(drift.severity, 'warning');
  assert.equal(drift.count, 44, 'carries how many elements are affected');

  // 200 of 251 colour usages sit on a token.
  assert.equal(result.coverage.color, 80);
  assert.equal(result.coverage.spacing, 0);
  assert.equal(result.coverage.radius, null, 'no radius usage means no radius score');
});

test('coverage ignores values that carry no colour', () => {
  const scan = {
    colors: [
      { value: 'rgba(0, 0, 0, 0)', count: 900, properties: ['background-color'], examples: [] },
      { value: 'rgb(0, 102, 255)', count: 10, properties: ['color'], examples: [] },
    ],
    spacing: [],
    radii: [],
    contrast: [],
  };
  assert.equal(auditPage(scan, index).coverage.color, 100);
});

// -------------------------------------------------------------------- prompt

test('the system prompt carries every token behind a cache breakpoint', () => {
  const [block] = buildSystem(tokenTree);
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
  for (const token of index.tokens) {
    assert.ok(block.text.includes(token.path), `${token.path} is in the prompt`);
  }
  assert.ok(block.text.includes('--pantheon-colors-primary'), 'includes the CSS variable form');
  assert.ok(block.text.includes('16px'), 'dimensions are rendered with units');
});

test('the audit description names the findings and the coverage', () => {
  const scan = {
    elementsScanned: 42,
    colors: [{ value: 'rgb(139, 92, 246)', count: 7, properties: ['color'], examples: ['.badge'] }],
    spacing: [],
    radii: [],
    contrast: [],
    fontFamilies: [{ value: 'Inter, sans-serif', count: 9 }],
    fontSizes: [],
    shadows: [],
  };
  const audit = auditPage(scan, index);
  const text = describeAudit(audit, { url: 'https://example.com', title: 'Example', mode: 'page' });

  assert.match(text, /42 elements scanned/);
  assert.match(text, /1 error, 0 warnings, 0 infos/);
  assert.match(text, /#8B5CF6/);
  assert.match(text, /\.badge/);
  assert.match(text, /Inter, sans-serif/);
});

test('the opening message asks a default question when the user gave none', () => {
  const audit = auditPage({ colors: [], spacing: [], radii: [], contrast: [] }, index);
  const message = buildOpeningMessage(audit, { url: 'https://x.test', mode: 'page' }, null);
  assert.equal(message.role, 'user');
  assert.match(message.content, /<audit>/);
  assert.match(message.content, /what would you fix first/);

  const asked = buildOpeningMessage(audit, { url: 'https://x.test', mode: 'page' }, 'Only colours?');
  assert.match(asked.content, /Only colours\?$/);
});

// ------------------------------------------------------------------ markdown

test('renders the markdown subset Claude emits', () => {
  assert.equal(renderMarkdown('plain text'), '<p>plain text</p>');
  assert.equal(renderMarkdown('## Heading'), '<h2>Heading</h2>');
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(renderMarkdown('use `var(--x)`'), '<p>use <code>var(--x)</code></p>');
  assert.equal(renderMarkdown('> note'), '<blockquote>note</blockquote>');
});

test('renders fenced code blocks without treating their contents as markdown', () => {
  const html = renderMarkdown('```css\n.cta {\n  color: var(--x);\n}\n```');
  assert.equal(html, '<pre><code>.cta {\n  color: var(--x);\n}</code></pre>');
  assert.ok(!html.includes('<p>'), 'code lines do not become paragraphs');
});

test('renders an unterminated fence, so a streaming answer stays readable', () => {
  const html = renderMarkdown('```css\n.cta { color: red; }');
  assert.match(html, /<pre><code>\.cta \{ color: red; \}<\/code><\/pre>/);
});

test('escapes HTML in model output', () => {
  assert.equal(
    renderMarkdown('<img src=x onerror=alert(1)>'),
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
  );
  assert.ok(!renderMarkdown('<script>alert(1)</script>').includes('<script>'));
  assert.match(renderMarkdown('```\n<b>hi</b>\n```'), /&lt;b&gt;hi&lt;\/b&gt;/);
});

test('only links http(s) URLs', () => {
  assert.match(
    renderMarkdown('[docs](https://example.com)'),
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/,
  );
  const dangerous = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!dangerous.includes('<a '), 'javascript: is left as plain text');
});
