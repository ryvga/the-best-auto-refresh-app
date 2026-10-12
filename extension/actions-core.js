/**
 * The Best Auto Refresh App — automation schema (shared ES module, no chrome.*
 * and no DOM APIs, so Node and the extension pages can import it unchanged).
 *
 * This module owns everything the popup, the dashboard and the engine runner
 * must agree on for optional automation hooks:
 *
 *   ACTION_EVENTS            the complete event vocabulary (order matters: the
 *                            UI renders the event checkboxes in this order).
 *   DEFAULT_ACTIONS          the exact safe default shape stored in profiles.
 *   normalizeActions(raw)    "complete safe schema" — always returns a usable
 *                            object, never throws, never evaluates anything.
 *   validateActions(raw)     strict validation of *enabled* actions only, plus
 *                            a normalized copy and a field/message error list.
 *   permissionOriginForUrl   Chrome host-permission match pattern for a URL.
 *
 * Privacy rules encoded here:
 *  - Nothing in this file requests a permission, sends a request or runs code.
 *  - A webhook URL is rejected when it carries credentials or uses plain HTTP
 *    on anything other than an unambiguous loopback host. Chrome match patterns
 *    ignore the port, so the granted access always covers a whole hostname;
 *    that is stated plainly in the docs and the UI, never hidden.
 *  - Stored fields are length bounded even when the action is disabled, so a
 *    corrupted profile can never blow up storage: code <= 20000, body <= 10000,
 *    headers <= 4000, url <= 2048, and bounded event lists only.
 *  - Only fields of an *enabled* action can make validation fail. Disabled or
 *    unfinished automation stays storable (legacy and draft behaviour).
 */

/* -------------------------------------------------------------------------- */
/* Shared schema                                                              */
/* -------------------------------------------------------------------------- */

/** Every automation event, in display order. Values are plain strings. */
export const ACTION_EVENTS = Object.freeze([
  'start',
  'before-refresh',
  'after-refresh',
  'check',
  'match',
  'limit',
  'manual-stop',
  'error',
  'pause',
  'resume'
]);

/** Event names the engine may actually deliver (a frozen copy for lookups). */
const EVENT_SET = new Set(ACTION_EVENTS);

/** The only world a script action may run in this release. */
export const SCRIPT_WORLD = 'USER_SCRIPT';

/** Stored field caps. Exported so the UI and tests can assert them by name. */
export const MAX_URL_LENGTH = 2048;
export const MAX_HEADERS_LENGTH = 4000;
export const MAX_BODY_LENGTH = 10000;
export const MAX_CODE_LENGTH = 20000;
export const MAX_EVENTS = ACTION_EVENTS.length;

/** Header names that must never be set by user automation. */
const RESERVED_HEADER_NAMES = new Set([
  'accept-charset',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto'
]);

/** `Proxy-*` and `Sec-*` are reserved prefixes; `x-forwarded-*` is explicit. */
const RESERVED_HEADER_PREFIXES = ['proxy-', 'sec-'];

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Plain HTTP is a development convenience only, so it is limited to hosts that
 * can only be the local machine. Anything ambiguous (a name that merely starts
 * with "localhost", a non-canonical numeric loopback, a trailing dot) is left
 * to HTTPS rather than guessed at.
 */
const LOOPBACK_NAMES = new Set([
  'localhost',
  '127.0.0.1',
]);

/**
 * The complete default actions object. Frozen so a caller cannot accidentally
 * mutate the shared default that profiles and the popup both reference.
 */
export const DEFAULT_ACTIONS = Object.freeze({
  webhook: Object.freeze({
    enabled: false,
    events: Object.freeze(['match']),
    url: '',
    method: 'POST',
    headers: '{}',
    body: '',
    includePageDetails: false
  }),
  script: Object.freeze({
    enabled: false,
    events: Object.freeze(['match']),
    code: '',
    world: SCRIPT_WORLD
  })
});

/* -------------------------------------------------------------------------- */
/* Small coercion helpers (never throw)                                       */
/* -------------------------------------------------------------------------- */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return false;
}

/** Bounded, trimmed text. Non-strings are rejected rather than coerced. */
function boundedText(value, maxLength, truncation) {
  if (typeof value !== 'string') return { text: '', truncated: false };
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true, originalLength: value.length };
}

/**
 * Coerce a headers value into the stored string form. Objects/arrays are
 * serialized once so the stored value is always JSON text; raw text is kept
 * exactly as typed, invalid JSON included, so a draft round-trips losslessly.
 */
function headersText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function codeText(value) {
  return typeof value === 'string' ? value : '';
}

function urlText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize an event selection: only known event names, in shared order, with
 * duplicates removed. An empty or unusable selection falls back to the default
 * `['match']` so stored profiles always carry at least one deliverable event.
 */
export function normalizeEvents(raw, fallback = ['match']) {
  const wanted = new Set();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && EVENT_SET.has(entry) && !wanted.has(entry)) {
        wanted.add(entry);
        if (wanted.size >= MAX_EVENTS) break;
      }
    }
  }
  if (wanted.size === 0) {
    if (Array.isArray(raw)) return [];
    const base = Array.isArray(fallback) && fallback.length > 0 ? fallback : ['match'];
    return ACTION_EVENTS.filter((event) => base.includes(event));
  }
  return ACTION_EVENTS.filter((event) => wanted.has(event));
}

/* -------------------------------------------------------------------------- */
/* URL rules                                                                  */
/* -------------------------------------------------------------------------- */

function isLoopbackHostname(hostname) {
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (host === '') return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return LOOPBACK_NAMES.has(bare);
}

/**
 * Decide whether a webhook URL may be used and stored.
 *
 * Returns `{ ok: true, url }` with the parsed absolute URL string, or
 * `{ ok: false, error }` with a user-safe explanation. Rules:
 *  - absolute http/https only; nothing else is ever fetched;
 *  - no `user:password@` credentials (they would end up in stored settings);
 *  - plain http only for an unambiguous loopback hostname.
 */
export function describeWebhookUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { ok: false, error: 'Enter the webhook URL.' };
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, error: `The webhook URL must be ${MAX_URL_LENGTH} characters or fewer.` };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'That is not a complete http or https address.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'The webhook must use http or https.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'Remove the username and password from the webhook URL; credentials stay out of stored settings.' };
  }
  if (parsed.hostname === '') {
    return { ok: false, error: 'The webhook URL needs a hostname.' };
  }
  if (parsed.hostname.includes('*')) {
    return { ok: false, error: 'Enter one specific hostname, not a wildcard.' };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      error: 'Plain http is only allowed for local development hosts (localhost or a loopback address). Use https for other servers.'
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Chrome host-permission match pattern for a URL: `scheme://hostname/*`.
 *
 * Chrome match patterns cannot express a port, so the pattern (and therefore
 * the grant) always covers the whole hostname. Returns '' when the URL cannot
 * be represented — a browser page, a local file, credentials, or a hostname
 * that is not a real site. Callers treat '' as "not a usable page".
 */
export function permissionOriginForUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (value === '') return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username !== '' || parsed.password !== '') return '';
  const hostname = parsed.hostname;
  if (hostname === '') return '';
  if (hostname.includes('*')) return '';
  if (parsed.protocol === 'http:' && !isLoopbackHostname(hostname)) return '';
  return `${parsed.protocol}//${hostname}/*`;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalizeWebhook(raw) {
  const source = asObject(raw);
  const events = normalizeEvents(source.events);
  const method = typeof source.method === 'string' ? source.method.trim().toUpperCase() : '';
  const headers = source.headers === undefined || source.headers === null ? '{}' : headersText(source.headers);
  const body = headersText(source.body);
  const url = urlText(source.url);
  return {
    enabled: asBoolean(source.enabled),
    events,
    url: url.slice(0, MAX_URL_LENGTH),
    method: method === 'GET' ? 'GET' : 'POST',
    headers: headers.slice(0, MAX_HEADERS_LENGTH),
    body: body.slice(0, MAX_BODY_LENGTH),
    includePageDetails: asBoolean(source.includePageDetails)
  };
}

function normalizeScript(raw) {
  const source = asObject(raw);
  const events = normalizeEvents(source.events);
  const code = codeText(source.code);
  return {
    enabled: asBoolean(source.enabled),
    events,
    code: code.slice(0, MAX_CODE_LENGTH),
    // One world only in this release; MAIN is deliberately not offered.
    world: SCRIPT_WORLD
  };
}

/**
 * Complete safe schema: always returns the full actions object with every field
 * present, trimmed to the documented bounds. Never throws, never validates the
 * meaning of a URL or a JSON body — that is `validateActions`' job.
 */
export function normalizeActions(raw) {
  const source = asObject(raw);
  return {
    webhook: normalizeWebhook(source.webhook),
    script: normalizeScript(source.script)
  };
}

/* -------------------------------------------------------------------------- */
/* Header / body validation                                                   */
/* -------------------------------------------------------------------------- */

function reservedHeaderReason(name) {
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower)) return true;
  return RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Parse custom headers. Returns `{ ok: true, value }` with a plain string map,
 * `{ ok: true, value: null }` when headers are empty/blank, or
 * `{ ok: false, message }`.
 */
export function parseHeaderObject(raw) {
  const text = headersText(raw);
  if (text.trim() === '') return { ok: true, value: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Custom headers must be a JSON object, for example {"Authorization":"Bearer …"}.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'Custom headers must be a JSON object of header names and values.' };
  }
  const value = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (name.trim() === '') {
      return { ok: false, message: 'A custom header name cannot be empty.' };
    }
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, message: `"${name}" is not a valid header name.` };
    }
    if (reservedHeaderReason(name)) {
      return { ok: false, message: `The header "${name}" is managed by the browser and cannot be set here.` };
    }
    if (typeof headerValue !== 'string') {
      return { ok: false, message: `The value of the header "${name}" must be text.` };
    }
    if (headerValue.length > 1000) {
      return { ok: false, message: `The value of the header "${name}" must be 1000 characters or fewer.` };
    }
    value[name] = headerValue;
  }
  return { ok: true, value };
}

/** Parse a custom body as JSON. Returns `{ ok, value | message }`. */
export function parseBodyObject(raw) {
  const text = headersText(raw);
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      message: 'The custom body must be valid JSON. Leave it empty to send the automatic event payload.'
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Action validation                                                          */
/* -------------------------------------------------------------------------- */

function errorResult(errors) {
  const first = errors.length > 0 ? errors[0].message : 'Check the automation settings.';
  return {
    ok: false,
    actions: null,
    errors,
    error: errors.map((entry) => entry.message).join(' ') || first
  };
}

/**
 * Validate raw actions from the UI or a stored profile.
 *
 * Returns `{ ok: true, actions, errors: [] }` or
 * `{ ok: false, actions: null, errors: [{field, message}], error }`.
 *
 * Only fields belonging to an *enabled* action are rejected. Length overflow is
 * always reported (the stored value would otherwise be silently truncated).
 * The returned `actions` is the normalized form, ready to store or run.
 */
export function validateActions(raw) {
  const source = asObject(raw);
  const actions = normalizeActions(source);
  const webhookRaw = asObject(source.webhook);
  const scriptRaw = asObject(source.script);
  const errors = [];

  const webhookUrlLength = urlText(webhookRaw.url).length;
  if (webhookUrlLength > MAX_URL_LENGTH) {
    errors.push({ field: 'webhook.url', message: `The webhook URL must be ${MAX_URL_LENGTH} characters or fewer.` });
  }
  if (headersText(webhookRaw.headers).length > MAX_HEADERS_LENGTH) {
    errors.push({ field: 'webhook.headers', message: `Custom headers must be ${MAX_HEADERS_LENGTH} characters or fewer.` });
  }
  if (headersText(webhookRaw.body).length > MAX_BODY_LENGTH) {
    errors.push({ field: 'webhook.body', message: `The custom body must be ${MAX_BODY_LENGTH} characters or fewer.` });
  }
  if (codeText(scriptRaw.code).length > MAX_CODE_LENGTH) {
    errors.push({ field: 'script.code', message: `The script must be ${MAX_CODE_LENGTH} characters or fewer.` });
  }

  if (actions.webhook.enabled) {
    const url = describeWebhookUrl(actions.webhook.url);
    if (!url.ok) errors.push({ field: 'webhook.url', message: url.error });

    const headers = parseHeaderObject(source.webhook ? source.webhook.headers : '');
    if (!headers.ok) errors.push({ field: 'webhook.headers', message: headers.message });

    const body = parseBodyObject(source.webhook ? source.webhook.body : '');
    if (!body.ok) errors.push({ field: 'webhook.body', message: body.message });

    const rawMethod = typeof webhookRaw.method === 'string' ? webhookRaw.method.trim().toUpperCase() : '';
    if (rawMethod !== '' && rawMethod !== 'GET' && rawMethod !== 'POST') {
      errors.push({ field: 'webhook.method', message: "The webhook method must be POST or GET." });
    }

    if (actions.webhook.events.length === 0) {
      errors.push({ field: 'webhook.events', message: 'Choose at least one event for the webhook.' });
    }
  }

  if (actions.script.enabled && actions.script.code.trim() === '') {
    errors.push({ field: 'script.code', message: 'Write the script body, or turn JavaScript automation off.' });
  }
  if (actions.script.enabled && actions.script.events.length === 0) {
    errors.push({ field: 'script.events', message: 'Choose at least one event for JavaScript.' });
  }

  if (errors.length > 0) return errorResult(errors);
  return { ok: true, actions, errors: [] };
}
