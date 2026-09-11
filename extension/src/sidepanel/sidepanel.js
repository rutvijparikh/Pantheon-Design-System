/**
 * Side panel UI.
 *
 * Holds no API key and makes no network calls of its own: it opens a port to
 * the service worker, sends intents, and renders what comes back.
 */
import { MSG, PORT_NAME } from '../shared/messages.js';
import { renderMarkdown } from '../lib/markdown.js';

const $ = (id) => document.getElementById(id);

const ui = {
  source: $('source'),
  settings: $('settings'),
  scan: $('scan'),
  pick: $('pick'),
  export: $('export'),
  status: $('status'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  empty: $('empty'),
  report: $('report'),
  scope: $('scope'),
  coverage: $('coverage'),
  coverageOverall: $('coverage-overall'),
  coverageBreakdown: $('coverage-breakdown'),
  findings: $('findings'),
  findingsSummary: $('findings-summary'),
  findingsList: $('findings-list'),
  answer: $('answer'),
  thinking: $('thinking'),
  thinkingText: $('thinking-text'),
  prose: $('prose'),
  meta: $('meta'),
  main: $('main'),
  composer: $('composer'),
  question: $('question'),
  send: $('send'),
  stop: $('stop'),
};

let port = null;
let tabId = null;
let picking = false;
let streaming = false;
let answer = '';
let pendingFrame = null;

// -------------------------------------------------------------------- plumbing

function connect() {
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
  });
}

/** Reconnects transparently if MV3 recycled the worker between turns. */
function post(type, payload = {}) {
  if (!port) connect();
  try {
    port.postMessage({ type, tabId, ...payload });
  } catch {
    connect();
    port.postMessage({ type, tabId, ...payload });
  }
}

async function resolveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  return tab;
}

// ---------------------------------------------------------------- status + UI

function setStatus(text) {
  ui.status.textContent = text ?? '';
  ui.status.hidden = !text;
}

function showBanner(text, actionLabel, onAction) {
  ui.bannerText.textContent = text;
  ui.banner.hidden = false;
  if (actionLabel) {
    ui.bannerAction.textContent = actionLabel;
    ui.bannerAction.hidden = false;
    ui.bannerAction.onclick = onAction;
  } else {
    ui.bannerAction.hidden = true;
    ui.bannerAction.onclick = null;
  }
}

const hideBanner = () => {
  ui.banner.hidden = true;
};

function setBusy(busy) {
  streaming = busy;
  ui.scan.disabled = busy;
  ui.pick.disabled = busy;
  ui.send.disabled = busy;
  ui.stop.hidden = !busy;
}

/** The header's "18 tokens · bundled Pantheon tokens" line. */
function setSource(count, origin) {
  if (!origin) return;
  ui.source.textContent = `${count} token${count === 1 ? '' : 's'} · ${origin}`;
}

function setPicking(active) {
  picking = active;
  ui.pick.textContent = active ? 'Cancel pick' : 'Pick element';
  ui.pick.setAttribute('aria-pressed', String(active));
}

// ------------------------------------------------------------------ rendering

/** Re-render on an animation frame so a fast stream does not thrash layout. */
function scheduleRender() {
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    ui.prose.innerHTML = renderMarkdown(answer);
    ui.prose.classList.toggle('caret', streaming);
    const atBottom = ui.main.scrollHeight - ui.main.scrollTop - ui.main.clientHeight < 80;
    if (atBottom) ui.main.scrollTop = ui.main.scrollHeight;
  });
}

const COVERAGE_LABELS = { color: 'Colour', spacing: 'Spacing', radius: 'Radius' };

function renderCoverage(coverage) {
  if (!coverage || coverage.overall === null || coverage.overall === undefined) {
    ui.coverage.hidden = true;
    return;
  }
  ui.coverage.hidden = false;
  ui.coverageOverall.textContent = `${coverage.overall}%`;
  ui.coverageBreakdown.replaceChildren();

  for (const [key, label] of Object.entries(COVERAGE_LABELS)) {
    const value = coverage[key];
    if (value === null || value === undefined) continue;

    const row = document.createElement('div');
    row.className = 'row';

    const term = document.createElement('dt');
    term.textContent = label;

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('i');
    fill.style.width = `${value}%`;
    fill.style.background =
      value >= 90
        ? 'var(--pantheon-colors-success)'
        : value >= 70
          ? 'var(--pantheon-colors-warning)'
          : 'var(--pantheon-colors-error)';
    track.append(fill);

    const detail = document.createElement('dd');
    detail.textContent = `${value}%`;

    row.append(term, track, detail);
    ui.coverageBreakdown.append(row);
  }
}

function renderFindings(findings) {
  ui.findingsList.replaceChildren();
  if (findings.length === 0) {
    ui.findings.hidden = true;
    return;
  }
  ui.findings.hidden = false;

  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const parts = [
    counts.error ? `${counts.error} to fix` : null,
    counts.warning ? `${counts.warning} drifting` : null,
    counts.info ? `${counts.info} to note` : null,
  ].filter(Boolean);
  ui.findingsSummary.textContent = `${findings.length} findings — ${parts.join(', ')}`;

  for (const finding of findings.slice(0, 60)) {
    const item = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = `dot ${finding.severity}`;

    const body = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'finding-head';

    const property = document.createElement('code');
    property.textContent = finding.property;
    head.append(property);

    if (finding.category === 'color' && finding.actual) {
      const swatches = document.createElement('span');
      swatches.className = 'swatches';
      for (const color of [finding.actual, finding.expected].filter(Boolean)) {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = color;
        swatch.title = color;
        swatches.append(swatch);
      }
      head.append(swatches);
    }

    if (finding.count > 1) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `×${finding.count}`;
      head.append(count);
    }

    const message = document.createElement('div');
    message.className = 'finding-body';
    message.textContent = finding.message;

    body.append(head, message);
    item.append(dot, body);
    ui.findingsList.append(item);
  }
}

function renderReport({ audit, context }) {
  ui.empty.hidden = true;
  ui.report.hidden = false;
  ui.scope.textContent =
    context.mode === 'element'
      ? `${context.selector} · ${context.url}`
      : `${audit.elementsScanned} elements · ${context.url}${
          context.truncated ? ' (truncated)' : ''
        }`;
  renderCoverage(audit.coverage);
  renderFindings(audit.findings);
}

function resetAnswer() {
  answer = '';
  ui.answer.hidden = false;
  ui.prose.replaceChildren();
  ui.thinking.hidden = true;
  ui.thinkingText.textContent = '';
  ui.meta.hidden = true;
}

// ------------------------------------------------------------------- messages

function onMessage(message) {
  switch (message.type) {
    case MSG.STATUS: {
      if ('picking' in message) setPicking(Boolean(message.picking));
      if ('busy' in message) setBusy(Boolean(message.busy));
      if ('stage' in message) setStatus(message.stage);
      setSource(message.tokenCount, message.origin);
      if (message.ready === false) {
        showBanner('Add your Anthropic API key to ask Claude.', 'Open options', () =>
          chrome.runtime.openOptionsPage(),
        );
      }
      break;
    }

    case MSG.AUDIT:
      hideBanner();
      // Each audit reports which token set it ran against, so changing the
      // source in options shows up here without reopening the panel.
      setSource(message.tokenCount, message.tokenOrigin);
      renderReport(message);
      resetAnswer();
      break;

    case MSG.DELTA:
      answer += message.text;
      scheduleRender();
      break;

    case MSG.THINKING:
      ui.thinking.hidden = false;
      ui.thinkingText.textContent += message.text;
      break;

    case MSG.DONE:
      setBusy(false);
      setStatus(null);
      if (message.css) {
        navigator.clipboard
          .writeText(message.css)
          .then(() => setStatus(`Copied ${message.origin} as CSS custom properties.`))
          .catch(() => setStatus('Could not reach the clipboard.'));
        break;
      }
      scheduleRender();
      if (message.usage) {
        const input = message.usage.input_tokens ?? 0;
        const output = message.usage.output_tokens ?? 0;
        const cached = message.usage.cache_read_input_tokens ?? 0;
        const cacheNote = cached ? `, ${cached} cached` : '';
        ui.meta.textContent = `${message.model} · ${input} in${cacheNote} · ${output} out`;
        ui.meta.hidden = false;
      }
      break;

    case MSG.ERROR:
      setBusy(false);
      setStatus(null);
      setPicking(false);
      if (message.kind === 'permission') {
        showBanner(
          'Pantheon Copilot needs permission to read this site.',
          'Grant access',
          async () => {
            const granted = await chrome.permissions.request({ origins: [message.origin] });
            if (granted) {
              hideBanner();
              post(MSG.SCAN_PAGE, { question: null });
            }
          },
        );
        break;
      }
      if (message.kind === 'aborted') {
        setStatus('Stopped.');
        break;
      }
      showBanner(
        message.message,
        message.kind === 'auth' ? 'Open options' : null,
        message.kind === 'auth' ? () => chrome.runtime.openOptionsPage() : null,
      );
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------------ user input

ui.scan.addEventListener('click', () => {
  hideBanner();
  resetAnswer();
  post(MSG.SCAN_PAGE, { question: null });
});

ui.pick.addEventListener('click', () => {
  hideBanner();
  post(picking ? MSG.CANCEL_PICK : MSG.START_PICK);
});

ui.export.addEventListener('click', () => post(MSG.EXPORT_CSS));

ui.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

ui.stop.addEventListener('click', () => post(MSG.STOP));

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = ui.question.value.trim();
  if (!question || streaming) return;
  ui.question.value = '';
  ui.question.style.height = 'auto';
  hideBanner();
  resetAnswer();
  post(MSG.ASK, { question });
});

/** Enter sends, Shift+Enter adds a line. */
ui.question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ui.composer.requestSubmit();
  }
});

ui.question.addEventListener('input', () => {
  ui.question.style.height = 'auto';
  ui.question.style.height = `${Math.min(ui.question.scrollHeight, 120)}px`;
});

/** Following the active tab keeps the panel about the page in front of you. */
chrome.tabs.onActivated.addListener(async () => {
  await resolveTab();
  post(MSG.GET_SETTINGS);
});

async function init() {
  connect();
  await resolveTab();
  post(MSG.GET_SETTINGS);
}

init();
