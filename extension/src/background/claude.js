/**
 * The Claude client.
 *
 * Lives in the service worker so the API key never enters a page or the panel's
 * DOM. `dangerouslyAllowBrowser` is required here: the worker's fetches carry a
 * `chrome-extension://` origin, and the flag is what sends the
 * `anthropic-dangerous-direct-browser-access` header the API needs to accept
 * them. The key is still the user's own, stored locally and sent only to
 * api.anthropic.com.
 */
import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { effortFor, supportsFallbacks } from './settings.js';

/** Streaming, so a large ceiling costs nothing and never truncates a review. */
const MAX_TOKENS = 64000;

export function createClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/**
 * Stream one turn. Calls `onDelta` with answer text, `onThinking` with reasoning
 * summaries when the user asked to see them, and resolves with the final
 * message so the caller can append it to the conversation.
 */
export async function streamAnswer({
  apiKey,
  model,
  effort,
  showThinking,
  system,
  messages,
  signal,
  onDelta,
  onThinking,
}) {
  const client = createClient(apiKey);

  const request = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    thinking: { type: 'adaptive', display: showThinking ? 'summarized' : 'omitted' },
  };

  const resolvedEffort = effortFor(model, effort);
  if (resolvedEffort) request.output_config = { effort: resolvedEffort };

  // On a policy decline the API re-runs the same request on a fallback model
  // inside the same call, so a refusal does not dead-end the panel.
  const useFallbacks = supportsFallbacks(model);
  if (useFallbacks) {
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }

  const stream = useFallbacks
    ? client.beta.messages.stream(request, { signal })
    : client.messages.stream(request, { signal });

  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'text_delta') onDelta?.(event.delta.text);
    else if (event.delta.type === 'thinking_delta') onThinking?.(event.delta.thinking);
  }

  const message = await stream.finalMessage();

  // A refusal arrives as HTTP 200 with no usable content, so check it before
  // reading the text.
  if (message.stop_reason === 'refusal') {
    const reason = message.stop_details?.explanation;
    throw new Error(
      `Claude declined to answer this one${reason ? `: ${reason}` : '.'}${
        useFallbacks ? ' The fallback model declined as well.' : ''
      }`,
    );
  }

  return message;
}

/** Plain text of an assistant message, for the transcript. */
export function textOf(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Turn an SDK error into something worth showing in the panel. */
export function describeError(error) {
  if (error instanceof APIUserAbortError) return { message: 'Stopped.', kind: 'aborted' };
  if (error instanceof AuthenticationError) {
    return {
      message: 'That API key was rejected. Check it in the extension options.',
      kind: 'auth',
    };
  }
  if (error instanceof PermissionDeniedError) {
    return {
      message: 'That key does not have access to this model. Try another model in options.',
      kind: 'auth',
    };
  }
  if (error instanceof RateLimitError) {
    return { message: 'Rate limited by the API. Wait a moment and try again.', kind: 'rate' };
  }
  if (error instanceof BadRequestError) {
    return { message: `The API rejected the request: ${error.message}`, kind: 'request' };
  }
  if (error instanceof APIConnectionError) {
    return { message: 'Could not reach api.anthropic.com. Check your connection.', kind: 'network' };
  }
  if (error instanceof APIError) {
    return { message: `API error ${error.status ?? ''}: ${error.message}`.trim(), kind: 'api' };
  }
  return { message: error?.message ?? String(error), kind: 'unknown' };
}
