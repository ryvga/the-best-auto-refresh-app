/**
 * The Best Auto Refresh App — ntfy quick-setup helpers.
 *
 * Pure functions only: no chrome.*, no DOM, no network, no timers. The popup
 * uses these to turn a server address and a topic name into the plain webhook
 * fields that already exist, and tests/ntfy.test.mjs covers the same functions.
 *
 * Three deliberate rules live here:
 *  - Nothing is sent, requested, enabled or stored by these helpers. The caller
 *    writes the returned fields only after an explicit button press.
 *  - Server rules are not re-invented: describeWebhookUrl() from
 *    ./actions-core.js decides what a usable address is (https anywhere, plain
 *    http only for localhost / 127.0.0.1, never credentials, never a wildcard).
 *  - The generated body is `JSON.stringify` output, so a title or message that
 *    contains quotes, backslashes, newlines or unicode can never break the JSON
 *    or inject an extra field. The topic is restricted to the characters ntfy
 *    itself allows.
 *
 * The generated webhook is a POST to the server root (`https://ntfy.sh`) whose
 * JSON body carries `topic`, `title` and `message`. Page details stay off, so
 * `{{url}}`, `{{title}}`, `{{keyword}}` and `{{selector}}` are never requested.
 */

import { describeWebhookUrl, MAX_BODY_LENGTH } from './actions-core.js';

/** The public server used when the user does not run their own. */
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/** ntfy rules: 1–64 characters, letters, numbers, dashes and underscores. */
export const NTFY_MAX_TOPIC_LENGTH = 64;
export const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Where a generate request goes first; also the field a user is likeliest to mistype. */
export const NTFY_SERVER_FIELD = 'ntfy-server';
export const NTFY_TOPIC_FIELD = 'ntfy-topic';

/**
 * The body is short by design. These caps only exist so a caller cannot hand
 * this module an unbounded string; the normalised webhook body is checked
 * against the shared MAX_BODY_LENGTH before it is returned.
 */
export const NTFY_MAX_TITLE_LENGTH = 120;
export const NTFY_MAX_MESSAGE_LENGTH = 400;

/** Notification heading, kept free of page details on purpose. */
export const NTFY_DEFAULT_TITLE = 'The Best Auto Refresh App';

/** Message text. Both placeholder tokens are exactly the shared ones. */
export const NTFY_DEFAULT_MESSAGE = 'Refresh monitor: {{event}} ({{refreshCount}} refreshes)';

/**
 * The events a finished run is reported for: a match, a limit, a manual stop
 * and an error. Deliberately not every event, so a long watch cannot turn into
 * a stream of notifications. The order matches ACTION_EVENTS in actions-core.js.
 */
export const NTFY_DEFAULT_EVENTS = Object.freeze(['match', 'limit', 'manual-stop', 'error']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * The address to publish to. Reuses the shared webhook URL rules (https
 * anywhere, plain http only for localhost / 127.0.0.1, no credentials, no
 * wildcard) and then strips one or more trailing slashes so the root address is
 * `https://ntfy.sh` rather than `https://ntfy.sh/`. A path or port is kept: a
 * self-hosted server may live at `https://example.com/ntfy` or
 * `http://127.0.0.1:8080`.
 */
export function describeNtfyServer(raw) {
  const value = text(raw).trim();
  if (value === '') {
    return { ok: false, error: 'Enter the ntfy server address, such as https://ntfy.sh.' };
  }
  const described = describeWebhookUrl(value);
  if (!described.ok) {
    // The underlying reason is preserved verbatim rather than summarised away.
    return { ok: false, error: `That ntfy server address cannot be used: ${described.error}` };
  }
  const server = described.url.replace(/\/+$/, '');
  return { ok: true, server: server === '' ? described.url : server };
}

/** A topic name inside ntfy's own limits: 1–64 of A–Z a–z 0–9 _ -. */
export function describeNtfyTopic(raw) {
  const topic = text(raw).trim();
  if (topic === '') {
    return { ok: false, error: 'Enter the ntfy topic name to publish to.' };
  }
  if (topic.length > NTFY_MAX_TOPIC_LENGTH) {
    return { ok: false, error: `The topic must be ${NTFY_MAX_TOPIC_LENGTH} characters or fewer.` };
  }
  if (!NTFY_TOPIC_PATTERN.test(topic)) {
    return {
      ok: false,
      error: 'Use only letters, numbers, dashes and underscores in the topic; ntfy topic names cannot contain spaces, dots or slashes.'
    };
  }
  return { ok: true, topic };
}

function bounded(value, fallback, maxLength) {
  const raw = text(value).trim();
  if (raw === '') return fallback;
  return raw.length > maxLength ? raw.slice(0, maxLength) : raw;
}

/**
 * The JSON text the webhook will send. Exactly three keys — topic, title and
 * message — serialized once, so nothing typed can escape its own value.
 */
export function buildNtfyBody(input) {
  const source = input && typeof input === 'object' ? input : {};
  const topicResult = describeNtfyTopic(source.topic);
  if (!topicResult.ok) throw new TypeError(topicResult.error);
  const topic = topicResult.topic;
  const title = bounded(source.title, NTFY_DEFAULT_TITLE, NTFY_MAX_TITLE_LENGTH);
  const message = bounded(source.message, NTFY_DEFAULT_MESSAGE, NTFY_MAX_MESSAGE_LENGTH);
  return JSON.stringify({ topic, title, message });
}

/**
 * Validate a quick-setup pair and build the webhook patch for it.
 *
 * Returns `{ ok: true, errors: [], server, topic, webhook }` or
 * `{ ok: false, errors: [{ field, message }], server: '', topic: '', webhook: null }`.
 *
 * The patch never carries `enabled`, so a caller cannot switch the webhook on or
 * off by pressing the generate button. Every patch is a fresh object: callers
 * may mutate it freely without affecting another result.
 */
export function describeNtfySetup(input) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = [];
  const serverResult = describeNtfyServer(source.server);
  if (!serverResult.ok) errors.push({ field: NTFY_SERVER_FIELD, message: serverResult.error });
  const topicResult = describeNtfyTopic(source.topic);
  if (!topicResult.ok) errors.push({ field: NTFY_TOPIC_FIELD, message: topicResult.error });
  if (errors.length > 0) {
    return { ok: false, errors, server: '', topic: '', webhook: null };
  }

  const body = buildNtfyBody({ topic: topicResult.topic, title: source.title, message: source.message });
  if (body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      errors: [{ field: NTFY_TOPIC_FIELD, message: `The ntfy JSON body must be ${MAX_BODY_LENGTH} characters or fewer.` }],
      server: '',
      topic: '',
      webhook: null
    };
  }

  return {
    ok: true,
    errors: [],
    server: serverResult.server,
    topic: topicResult.topic,
    webhook: {
      url: serverResult.server,
      method: 'POST',
      headers: '{}',
      body,
      events: [...NTFY_DEFAULT_EVENTS],
      includePageDetails: false
    }
  };
}
