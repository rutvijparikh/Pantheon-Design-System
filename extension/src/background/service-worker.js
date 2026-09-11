/**
 * Service worker: the only place that holds the API key and talks to Claude.
 *
 * The side panel drives it over a long-lived port (streaming needs one), the
 * page-side collector reports through one-off messages, and the conversation
 * lives in `chrome.storage.session` because MV3 is free to unload this worker
 * between turns — in-memory transcripts would silently vanish.
 */
import { MSG, PORT_NAME } from '../shared/messages.js';
import { auditElement, auditPage } from '../lib/audit.js';
import { toCssVariables } from '../lib/tokens.js';
import { buildOpeningMessage, buildSystem } from '../lib/prompt.js';
import { createClient, describeError, streamAnswer, textOf } from './claude.js';
import { getSettings, getTokens, invalidateTokens } from './settings.js';

/** Pages Chrome forbids injecting into — worth naming so the error is useful. */
const BLOCKED = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/;

/** Open the side panel when the toolbar icon is clicked. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['tokenSource', 'tokenUrl', 'tokenJson'].some((key) => key in changes)) invalidateTokens();
});

// ------------------------------------------------------------------ transcript

const sessionKey = (tabId) => `session:${tabId}`;

async function loadSession(tabId) {
  const stored = await chrome.storage.session.get(sessionKey(tabId));
  return stored[sessionKey(tabId)] ?? { messages: [], context: null };
}

async function saveSession(tabId, session) {
  await chrome.storage.session.set({ [sessionKey(tabId)]: session });
}

async function clearSession(tabId) {
  await chrome.storage.session.remove(sessionKey(tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => clearSession(tabId));

// ----------------------------------------------------------------- panel ports

/** tabId → the panel port currently watching that tab. */
const ports = new Map();
/** tabId → AbortController for the turn in flight. */
const inflight = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let boundTab = null;

  const send = (type, payload = {}) => {
    try {
      port.postMessage({ type, ...payload });
    } catch {
      // The panel closed mid-stream; nothing to do.
    }
  };

  port.onMessage.addListener(async (message) => {
    const tabId = message?.tabId;
    if (typeof tabId === 'number' && boundTab !== tabId) {
      if (boundTab !== null) ports.delete(boundTab);
      boundTab = tabId;
      ports.set(tabId, send);
    }

    try {
      await handle(message, send);
    } catch (error) {
      // The panel, not the worker, has to ask for host access: the API only
      // grants it from a user gesture in an extension page.
      if (error?.needsPermission) {
        send(MSG.ERROR, {
          kind: 'permission',
          origin: error.needsPermission,
          message: error.message,
        });
      } else {
        send(MSG.ERROR, describeError(error));
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (boundTab !== null) ports.delete(boundTab);
  });
});

/** Post to whichever panel is watching this tab, if any. */
const toPanel = (tabId, type, payload) => ports.get(tabId)?.(type, payload);

// -------------------------------------------------------------------- handlers

async function handle(message, send) {
  switch (message.type) {
    case MSG.SCAN_PAGE:
      return scanPage(message.tabId, message.question, send);
    case MSG.START_PICK:
      return startPick(message.tabId, send);
    case MSG.CANCEL_PICK:
      return cancelPick(message.tabId, send);
    case MSG.ASK:
      return ask(message.tabId, message.question, send);
    case MSG.STOP:
      inflight.get(message.tabId)?.abort();
      return undefined;
    case MSG.EXPORT_CSS: {
      const { tree, origin } = await getTokens();
      return send(MSG.DONE, { css: toCssVariables(tree), origin });
    }
    case MSG.GET_SETTINGS: {
      const settings = await getSettings();
      let origin = null;
      let tokenCount = 0;
      try {
        const tokens = await getTokens();
        origin = tokens.origin;
        tokenCount = tokens.index.tokens.length;
      } catch (error) {
        send(MSG.ERROR, describeError(error));
      }
      return send(MSG.STATUS, {
        ready: Boolean(settings.apiKey),
        model: settings.model,
        effort: settings.effort,
        showThinking: settings.showThinking,
        origin,
        tokenCount,
      });
    }
    default:
      return undefined;
  }
}

/**
 * Inject the collector into a tab, or explain why we cannot.
 *
 * Access can come from a granted host permission or from `activeTab`, and only
 * the injection itself knows which applies — `permissions.contains` reports
 * false under `activeTab` even though the injection would succeed. So try
 * first, and treat a failure as "ask for this origin".
 */
async function ensureInspector(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || BLOCKED.test(tab.url)) {
    throw new Error(
      'Chrome does not allow extensions to read this page. Open a normal http(s) page and try again.',
    );
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['inspector.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inspector.js'] });
  } catch (cause) {
    const error = new Error('Pantheon Copilot needs permission to read this site.');
    error.needsPermission = originOf(tab.url);
    error.cause = cause;
    throw error;
  }
  return tab;
}

const originOf = (url) => `${new URL(url).origin}/*`;

async function scanPage(tabId, question, send) {
  send(MSG.STATUS, { busy: true, stage: 'Reading the page…' });
  const tab = await ensureInspector(tabId);
  const scan = await chrome.tabs.sendMessage(tabId, { type: MSG.COLLECT_PAGE });
  if (!scan) throw new Error('The page did not respond. Reload it and try again.');

  send(MSG.STATUS, { busy: true, stage: 'Auditing against Pantheon…' });
  const { tree, index, origin } = await getTokens();
  const audit = auditPage(scan, index);
  const context = {
    mode: 'page',
    url: scan.url ?? tab.url,
    title: scan.title ?? tab.title,
    truncated: scan.truncated,
  };

  send(MSG.AUDIT, { audit, context, tokenOrigin: origin, tokenCount: index.tokens.length });

  await startTurn(tabId, {
    tree,
    context,
    message: buildOpeningMessage(audit, context, question),
    reset: true,
    send,
  });
}

async function startPick(tabId, send) {
  await ensureInspector(tabId);
  await chrome.tabs.sendMessage(tabId, { type: MSG.PICK_ELEMENT });
  send(MSG.STATUS, { picking: true, stage: 'Click an element on the page — Esc to cancel.' });
}

async function cancelPick(tabId, send) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.ABORT_PICK });
  } catch {
    // The tab navigated away; the picker is gone with it.
  }
  send(MSG.STATUS, { picking: false, stage: null });
}

/** The collector reports a picked element here. */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // The options page asks us to validate a key, because the SDK only lives here.
  if (message?.type === MSG.TEST_KEY) {
    testKey(message.apiKey, message.model).then(respond);
    return true;
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return false;

  if (message?.type === MSG.PICK_ABORTED) {
    toPanel(tabId, MSG.STATUS, { picking: false, stage: null });
    return false;
  }

  if (message?.type === MSG.ELEMENT_PICKED) {
    handlePicked(tabId, message.sample).catch((error) => {
      toPanel(tabId, MSG.ERROR, describeError(error));
    });
    return false;
  }

  return false;
});

async function handlePicked(tabId, sample) {
  const send = ports.get(tabId);
  if (!send) return;

  send(MSG.STATUS, { picking: false, busy: true, stage: 'Auditing the element…' });
  const { tree, index, origin } = await getTokens();
  const audit = auditElement(sample, index);
  const tab = await chrome.tabs.get(tabId);
  const context = {
    mode: 'element',
    url: tab.url,
    title: tab.title,
    selector: sample.selector,
    tag: sample.tag,
    text: sample.text,
  };

  send(MSG.AUDIT, {
    audit,
    context,
    sample,
    tokenOrigin: origin,
    tokenCount: index.tokens.length,
  });
  await startTurn(tabId, {
    tree,
    context,
    message: buildOpeningMessage(audit, context, null),
    reset: true,
    send,
  });
}

async function ask(tabId, question, send) {
  // Check the key before the transcript: without this, a follow-up asked before
  // any key is set reports "scan a page first", which is not the problem.
  const { apiKey } = await getSettings();
  if (!apiKey) {
    send(MSG.ERROR, {
      kind: 'auth',
      message: 'Add your Anthropic API key in the extension options to ask Claude.',
    });
    return;
  }

  const session = await loadSession(tabId);
  if (session.messages.length === 0) {
    throw new Error('Scan a page or pick an element first, so there is something to discuss.');
  }
  const { tree } = await getTokens();
  await startTurn(tabId, {
    tree,
    context: session.context,
    message: { role: 'user', content: question },
    reset: false,
    send,
  });
}

/** Append a user turn and stream the answer back to the panel. */
async function startTurn(tabId, { tree, context, message, reset, send }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    send(MSG.ERROR, {
      kind: 'auth',
      message: 'Add your Anthropic API key in the extension options to ask Claude.',
    });
    return;
  }

  const session = reset ? { messages: [], context } : await loadSession(tabId);
  session.context = context ?? session.context;
  session.messages.push(message);

  inflight.get(tabId)?.abort();
  const controller = new AbortController();
  inflight.set(tabId, controller);

  send(MSG.STATUS, { busy: true, stage: 'Asking Claude…' });

  try {
    const response = await streamAnswer({
      apiKey: settings.apiKey,
      model: settings.model,
      effort: settings.effort,
      showThinking: settings.showThinking,
      system: buildSystem(tree),
      messages: session.messages,
      signal: controller.signal,
      onDelta: (text) => send(MSG.DELTA, { text }),
      onThinking: (text) => send(MSG.THINKING, { text }),
    });

    session.messages.push({ role: 'assistant', content: response.content });
    await saveSession(tabId, session);
    send(MSG.DONE, { usage: response.usage, model: response.model, text: textOf(response) });
  } catch (error) {
    // Drop the unanswered user turn so a retry does not send it twice.
    session.messages.pop();
    await saveSession(tabId, session);
    send(MSG.ERROR, describeError(error));
  } finally {
    if (inflight.get(tabId) === controller) inflight.delete(tabId);
  }
}

/**
 * Validate a key and a model without spending tokens: retrieving the model
 * exercises authentication and per-model access, and returns no completion.
 */
async function testKey(apiKey, model) {
  if (!apiKey?.trim()) return { ok: false, message: 'Enter a key first.' };
  try {
    const info = await createClient(apiKey.trim()).models.retrieve(model);
    return { ok: true, message: `Key works — ${info.display_name ?? info.id} is available.` };
  } catch (error) {
    return { ok: false, message: describeError(error).message };
  }
}
