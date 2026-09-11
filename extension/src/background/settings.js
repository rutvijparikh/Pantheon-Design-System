/**
 * Settings and the token index.
 *
 * Everything lives in `chrome.storage.local`, never `sync` — the API key is a
 * secret and syncing it would copy it to the user's Google account.
 */
import { buildIndex } from '../lib/tokens.js';

export const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'high',
  tokenSource: 'bundled',
  tokenUrl: '',
  tokenJson: '',
  showThinking: false,
};

/** Models the panel offers. Kept short on purpose. */
export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Best judgement (default)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Faster, cheaper' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fastest' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Models that support the server-side refusal fallback parameter. */
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

/** Effort levels above `high` are rejected by models that do not have them. */
const LIMITED_EFFORT_MODELS = new Set(['claude-haiku-4-5']);

export const supportsFallbacks = (model) => FALLBACK_MODELS.has(model);

/** Haiku has no `effort` at all; clamp rather than let the API 400. */
export function effortFor(model, effort) {
  if (LIMITED_EFFORT_MODELS.has(model)) return null;
  return EFFORTS.includes(effort) ? effort : 'high';
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
  invalidateTokens();
}

let cache = null;

export function invalidateTokens() {
  cache = null;
}

/**
 * Resolve the token tree from whichever source the user configured, and build
 * the audit index once. Cached until settings change, because every audit and
 * every prompt reads it.
 */
export async function getTokens() {
  if (cache) return cache;

  const settings = await getSettings();
  let tree;
  let origin;

  if (settings.tokenSource === 'inline' && settings.tokenJson.trim()) {
    tree = JSON.parse(settings.tokenJson);
    origin = 'pasted JSON';
  } else if (settings.tokenSource === 'url' && settings.tokenUrl.trim()) {
    const response = await fetch(settings.tokenUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Could not load tokens from ${settings.tokenUrl} (HTTP ${response.status})`);
    }
    tree = await response.json();
    origin = settings.tokenUrl;
  } else {
    const response = await fetch(chrome.runtime.getURL('tokens/pantheon.tokens.json'));
    tree = await response.json();
    origin = 'bundled Pantheon tokens';
  }

  const index = buildIndex(tree);
  if (index.tokens.length === 0) {
    throw new Error('That token file has no tokens in it — each token needs a `$value`.');
  }

  cache = { tree, index, origin };
  return cache;
}
