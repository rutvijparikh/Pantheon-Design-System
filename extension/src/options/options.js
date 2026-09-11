/**
 * Options page.
 *
 * Writes straight to `chrome.storage.local`; the service worker notices the
 * change and rebuilds the token index. Changes save as you make them, so there
 * is no Save button to forget.
 */
import { MSG } from '../shared/messages.js';
import { DEFAULTS, EFFORTS, MODELS } from '../background/settings.js';
import { buildIndex } from '../lib/tokens.js';

const $ = (id) => document.getElementById(id);

const ui = {
  apiKey: $('api-key'),
  reveal: $('reveal'),
  test: $('test'),
  testResult: $('test-result'),
  model: $('model'),
  modelNote: $('model-note'),
  effort: $('effort'),
  showThinking: $('show-thinking'),
  tokenUrl: $('token-url'),
  tokenJson: $('token-json'),
  tokenResult: $('token-result'),
  origins: $('origins'),
  saved: $('saved'),
};

for (const model of MODELS) {
  const option = document.createElement('option');
  option.value = model.id;
  option.textContent = model.label;
  ui.model.append(option);
}

// ------------------------------------------------------------------ feedback

let savedTimer = null;

function flashSaved() {
  ui.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    ui.saved.hidden = true;
  }, 1400);
}

function setResult(element, ok, message) {
  element.hidden = !message;
  element.textContent = message ?? '';
  element.classList.toggle('ok', Boolean(message) && ok);
  element.classList.toggle('bad', Boolean(message) && !ok);
}

const debounce = (fn, wait) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

async function save(patch) {
  await chrome.storage.local.set(patch);
  flashSaved();
}

// ------------------------------------------------------------------- settings

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };

  ui.apiKey.value = settings.apiKey;
  ui.model.value = MODELS.some((model) => model.id === settings.model)
    ? settings.model
    : DEFAULTS.model;
  ui.effort.value = EFFORTS.includes(settings.effort) ? settings.effort : DEFAULTS.effort;
  ui.showThinking.checked = settings.showThinking;
  ui.tokenUrl.value = settings.tokenUrl;
  ui.tokenJson.value = settings.tokenJson;
  $(`source-${settings.tokenSource}`).checked = true;

  describeModel();
  validateJson();
  await renderOrigins();
}

function describeModel() {
  const model = MODELS.find((entry) => entry.id === ui.model.value);
  ui.modelNote.textContent = model?.note ?? '';
  // Haiku has no effort parameter, so the control would be a lie.
  const supportsEffort = ui.model.value !== 'claude-haiku-4-5';
  ui.effort.disabled = !supportsEffort;
  ui.effort.title = supportsEffort ? '' : 'This model does not take an effort level.';
}

/** Parse the pasted token file as the user types, so mistakes surface early. */
function validateJson() {
  const raw = ui.tokenJson.value.trim();
  if (!raw) {
    setResult(ui.tokenResult, true, null);
    return;
  }
  try {
    const index = buildIndex(JSON.parse(raw));
    if (index.tokens.length === 0) {
      setResult(ui.tokenResult, false, 'Parsed, but no tokens found — each one needs a `$value`.');
      return;
    }
    setResult(
      ui.tokenResult,
      true,
      `${index.tokens.length} tokens — ${index.colors.length} colours, ${index.dimensions.length} dimensions.`,
    );
  } catch (error) {
    setResult(ui.tokenResult, false, `Not valid JSON: ${error.message}`);
  }
}

// ---------------------------------------------------------------- site access

async function renderOrigins() {
  const { origins } = await chrome.permissions.getAll();
  ui.origins.replaceChildren();

  if (!origins || origins.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No sites granted yet.';
    ui.origins.append(empty);
    return;
  }

  for (const origin of origins) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin;

    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await renderOrigins();
    });

    item.append(label, revoke);
    ui.origins.append(item);
  }
}

// -------------------------------------------------------------------- wiring

ui.apiKey.addEventListener(
  'input',
  debounce(() => {
    save({ apiKey: ui.apiKey.value.trim() });
    setResult(ui.testResult, true, null);
  }, 400),
);

ui.reveal.addEventListener('click', () => {
  const hidden = ui.apiKey.type === 'password';
  ui.apiKey.type = hidden ? 'text' : 'password';
  ui.reveal.textContent = hidden ? 'Hide' : 'Show';
});

ui.test.addEventListener('click', async () => {
  ui.test.disabled = true;
  setResult(ui.testResult, true, 'Checking…');
  const result = await chrome.runtime.sendMessage({
    type: MSG.TEST_KEY,
    apiKey: ui.apiKey.value,
    model: ui.model.value,
  });
  setResult(ui.testResult, result.ok, result.message);
  ui.test.disabled = false;
});

ui.model.addEventListener('change', () => {
  describeModel();
  save({ model: ui.model.value });
});

ui.effort.addEventListener('change', () => save({ effort: ui.effort.value }));

ui.showThinking.addEventListener('change', () => save({ showThinking: ui.showThinking.checked }));

for (const radio of document.querySelectorAll('input[name="token-source"]')) {
  radio.addEventListener('change', () => save({ tokenSource: radio.value }));
}

ui.tokenUrl.addEventListener(
  'input',
  debounce(() => save({ tokenUrl: ui.tokenUrl.value.trim() }), 400),
);

ui.tokenJson.addEventListener('input', () => {
  validateJson();
  debouncedSaveJson();
});

const debouncedSaveJson = debounce(() => save({ tokenJson: ui.tokenJson.value }), 500);

chrome.permissions.onAdded.addListener(renderOrigins);
chrome.permissions.onRemoved.addListener(renderOrigins);

load();
