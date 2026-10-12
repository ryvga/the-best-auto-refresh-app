/**
 * The Best Auto Refresh App — automation runner (background service worker side).
 *
 * This module performs the two optional hook kinds that a saved profile can
 * carry. It is deliberately small, bounded and pessimistic:
 *
 *  - Nothing runs unless the action is enabled, its event list contains the
 *    event being delivered, and the exact optional permission for that action
 *    is already held. Requests for permission only ever happen in the popup, in
 *    a click handler — never here, and never automatically.
 *  - Webhooks: one fetch, `credentials: 'omit'`, `redirect: 'error'`,
 *    `cache: 'no-store'`, aborted after 5s. No retries (a retry could duplicate
 *    an external action). The response body is never read, stored, logged or
 *    executed; only the numeric HTTP status is recorded.
 *  - Scripts: only `chrome.userScripts.execute` in the isolated `USER_SCRIPT`
 *    world, targeting the current top document (or the document id the caller
 *    resolved). The page is never messaged, no `chrome.scripting` string
 *    injection is used, and the current document origin is verified immediately
 *    before the call so a stale post-refresh hook cannot run on another page.
 *  - The wrapper's 5s timeout bounds how long monitoring waits. It cannot
 *    interrupt an infinite loop inside page JavaScript, and it cannot undo what
 *    a script already changed.
 *  - The activity log is session-only, capped at 100 entries, and carries
 *    generic messages: no webhook URL, headers, custom code, or response text.
 *
 * The background worker calls `runActions(record, event, options)`; the popup
 * and dashboard read `getActionCapabilities(tabUrl)` and `getActionLog(tabId)`.
 */

import { describeWebhookUrl, normalizeActions, validateActions, permissionOriginForUrl } from './actions-core.js';

/** Whole-run budget: hooks must never hold a monitoring step open for longer. */
export const RUN_ACTIONS_TIMEOUT_MS = 5000;
/** Single structured-clone/JSON step cap while building a payload. */
const MAX_TEXT_SNAPSHOT = 20000;
/** Hard cap on the session-only activity log. */
export const MAX_ACTION_LOG_ENTRIES = 100;
const MAX_LOG_MESSAGE_LENGTH = 200;
const MAX_WEBHOOK_ORIGINS = 25;
const MAX_REPLACEMENT_DEPTH = 20;
const MAX_REPLACEMENT_NODES = 5000;

/** Browser-session activity survives service-worker suspension. */
const actionLog = [];
const LOG_KEY = 'abraActionLog';
let logHydration = null;
let logWrites = Promise.resolve();

function hydrateLog() {
  if (!logHydration) logHydration = (async () => {
    try {
      const stored = await chrome.storage.session.get(LOG_KEY);
      if (Array.isArray(stored[LOG_KEY])) actionLog.push(...stored[LOG_KEY].slice(-MAX_ACTION_LOG_ENTRIES));
    } catch { /* Optional log storage is best effort. */ }
  })();
  return logHydration;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function safeError(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'Unexpected automation error.';
}

async function logEntry({ tabId, event, kind, status, message }) {
  await hydrateLog();
  const entry = {
    timestamp: Date.now(),
    tabId: typeof tabId === 'number' ? tabId : null,
    event: typeof event === 'string' ? event : '',
    kind: typeof kind === 'string' ? kind : 'action',
    status: status === 'success' || status === 'failed' || status === 'skipped' ? status : 'failed',
    message: typeof message === 'string' && message !== ''
      ? message.slice(0, MAX_LOG_MESSAGE_LENGTH)
      : 'No details recorded.'
  };
  actionLog.push(entry);
  while (actionLog.length > MAX_ACTION_LOG_ENTRIES) actionLog.shift();
  const snapshot = actionLog.map((item) => ({ ...item }));
  logWrites = logWrites.then(async () => {
    try { await chrome.storage.session.set({ [LOG_KEY]: snapshot }); } catch { /* Best effort. */ }
  });
  await logWrites;
  return entry;
}

function messageForOutcome(kind, outcome) {
  const label = kind === 'script' ? 'The page script' : 'The webhook';
  switch (outcome) {
    case 'disabled':
      return `${label} is turned off, so it was skipped.`;
    case 'not-selected':
      return `${label} is not set to run for this event.`;
    case 'no-permission':
      return kind === 'script'
        ? 'JavaScript access is not granted for this hostname, so the script was skipped.'
        : 'Webhook access is not granted for this hostname, so no request was sent.';
    case 'unsupported':
      return 'This browser build cannot run isolated page scripts, so the script was skipped.';
    case 'bad-url':
      return 'The webhook URL is missing or is not a usable http or https address, so nothing was sent.';
    case 'no-code':
      return 'The script body is empty, so nothing ran.';
    case 'origin-changed':
      return `${label} was skipped because the page is no longer the monitored site.`;
    case 'budget':
      return `${label} was skipped because the previous hook used the full ${Math.round(RUN_ACTIONS_TIMEOUT_MS / 1000)} second budget.`;
    case 'timeout':
      return `${label} did not finish within ${Math.round(RUN_ACTIONS_TIMEOUT_MS / 1000)} seconds. Monitoring continues.`;
    case 'failed':
      return `${label} failed. It is recorded without request details.`;
    case 'delivered':
      return 'The request was completed without reading the response body.';
    case 'ran':
      return 'The isolated page script finished.';
    default:
      return 'No details recorded.';
  }
}

function isEnabled(value) {
  return value && typeof value === 'object' ? value.enabled === true : value === true;
}

function eventsFor(action) {
  return Array.isArray(action.events) ? action.events : ['match'];
}

/** Fetch a property from a possibly-undefined chrome API without throwing. */
function safeProperty(object, key) {
  try {
    return object ? object[key] : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Page metadata / current document                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read the current top document. Runs as a plain function in the page, returns
 * only string metadata, and is regular `chrome.scripting` — never a string
 * injection. It also yields the documentId, so user code never needs an extra
 * page evaluation just to learn which document to target.
 */
function readTopDocumentMetadata() {
  return {
    origin: String(location.origin || ''),
    url: String(location.href || ''),
    title: String(document.title || '')
  };
}

async function getTopTab(tabId) {
  try {
    if (!chrome.tabs || typeof chrome.tabs.get !== 'function' || !Number.isInteger(tabId)) return null;
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/** True when `tabUrl` is on the same origin as the session record. */
function sameOriginAs(tabUrl, recordOrigin) {
  if (typeof tabUrl !== 'string' || tabUrl === '') return false;
  let parsed;
  try {
    parsed = new URL(tabUrl);
  } catch {
    return false;
  }
  const origin = typeof recordOrigin === 'string' ? recordOrigin : '';
  if (origin === '' || origin === 'null') return false;
  return parsed.origin === origin;
}

/**
 * Resolve the document the script action may target, verifying the current
 * top-frame origin against the session record.
 *
 * Returns `{ ok: true, documentId }` or `{ ok: false, reason: 'origin-changed' | 'unavailable' }`.
 * When the caller supplies `options.documentId` it is trusted only after the
 * current document has been confirmed to be the same origin; the fixed metadata
 * function is always the thing that proves it.
 */
async function resolveTargetDocument(record, tabId, providedDocumentId) {
  const api = safeProperty(chrome, 'scripting');
  if (!api || typeof api.executeScript !== 'function') return { ok: false, reason: 'unavailable' };
  let results = null;
  try {
    results = await api.executeScript({
      target: { tabId, frameIds: [0] },
      func: readTopDocumentMetadata
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const first = Array.isArray(results) ? results[0] : null;
  const result = first && typeof first === 'object' ? first.result : null;
  if (!result || typeof result.origin !== 'string' || result.origin === '') {
    return { ok: false, reason: 'unavailable' };
  }
  if (typeof record.origin === 'string' && record.origin !== '' && result.origin !== record.origin) {
    return { ok: false, reason: 'origin-changed' };
  }
  const documentId =
    typeof providedDocumentId === 'string' && providedDocumentId !== ''
      ? providedDocumentId
      : (first && typeof first.documentId === 'string' && first.documentId !== '' ? first.documentId : '');
  if (documentId === '') return { ok: false, reason: 'unavailable' };
  if (first.documentId !== documentId) return { ok: false, reason: 'origin-changed' };
  return { ok: true, documentId };
}

/* -------------------------------------------------------------------------- */
/* Webhook payloads and templates                                             */
/* -------------------------------------------------------------------------- */

/** The documented template tokens, in the order used when substituting. */
const TEMPLATE_TOKEN_NAMES = Object.freeze([
  'event',
  'timestamp',
  'refreshCount',
  'status',
  'url',
  'title',
  'reason',
  'keyword',
  'selector'
]);

/**
 * The event snapshot handed to a script and used for template values.
 * Webhook page fields stay empty unless explicitly opted in. Local page scripts
 * receive page context independently; webhook headers, URL and body are absent.
 */
function buildEventSnapshot(record, event, reason, includePageDetails) {
  const source = record && typeof record === 'object' ? record : {};
  const config = source.config && typeof source.config === 'object' ? source.config : {};
  const lastResult = source.lastResult && typeof source.lastResult === 'object' ? source.lastResult : {};
  const status = typeof source.status === 'string' && source.status !== ''
    ? source.status
    : (event === 'match' ? 'matched' : 'running');
  const resolvedReason = typeof reason === 'string' && reason !== ''
    ? reason
    : (typeof lastResult.reason === 'string' ? lastResult.reason : '');
  const pageFields = includePageDetails === true;
  return {
    type: event,
    timestamp: Date.now(),
    refreshCount: Number.isFinite(source.refreshCount) ? source.refreshCount : 0,
    status,
    url: pageFields && typeof source.url === 'string' ? source.url : '',
    title: pageFields && typeof source.title === 'string' ? source.title : '',
    reason: pageFields ? resolvedReason : '',
    keyword: pageFields && typeof config.keyword === 'string' ? config.keyword : '',
    selector: pageFields && typeof config.selector === 'string' ? config.selector : ''
  };
}

/** Automatic payload for an empty custom body: never page content by default. */
function buildAutoPayload(snapshot) {
  return {
    event: snapshot.type,
    timestamp: snapshot.timestamp,
    refreshCount: snapshot.refreshCount,
    status: snapshot.status
  };
}

/** Optional extra fields, only when the user turned on Include page details. */
function pageDetailFields(snapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    reason: snapshot.reason,
    keyword: snapshot.keyword,
    selector: snapshot.selector
  };
}

/** JSON.stringify that cannot throw on a cyclic or oversized value. */
function stringifyJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Escape replacement text so a page-derived value can never break out of the
 * JSON string it is substituted into. JSON.stringify handles quotes and control
 * characters; `<` is escaped further so the payload can never look like HTML.
 */
function escapeReplacement(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  let quoted;
  try {
    quoted = JSON.stringify(text);
  } catch {
    return '';
  }
  if (typeof quoted !== 'string' || quoted.length < 2) return '';
  return quoted.slice(1, -1).replace(/</g, '\\u003c');
}

/**
 * Replace `{{token}}` placeholders inside string values of a parsed body.
 *
 * Only the documented token names are substituted, at most once per pass, for a
 * bounded number of passes. The result is walked defensively: depth is capped,
 * the node count is capped, and every value is copied rather than referenced.
 */
function applyTemplates(value, replacements, state, depth) {
  if (state.nodes > MAX_REPLACEMENT_NODES || depth > MAX_REPLACEMENT_DEPTH) return value;
  state.nodes += 1;
  if (typeof value === 'string') return value.replace(/\{\{(event|timestamp|refreshCount|status|url|title|reason|keyword|selector)\}\}/g,
    (_, name) => replacements[name] ?? '');
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplates(item, replacements, state, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      out[key] = applyTemplates(item, replacements, state, depth + 1);
    }
    return out;
  }
  return value;
}

/** Build a custom body JSON string, or '' when it is empty or unusable. */
function buildCustomBody(rawBody, snapshot) {
  const text = typeof rawBody === 'string' ? rawBody : '';
  if (text.trim() === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(text.length > MAX_TEXT_SNAPSHOT ? text.slice(0, MAX_TEXT_SNAPSHOT) : text);
  } catch {
    return '';
  }
  const replacements = {};
  for (const name of TEMPLATE_TOKEN_NAMES) {
    const value = name === 'event' ? snapshot.type : snapshot[name];
    replacements[name] = typeof value === 'string' ? value : String(value ?? '');
  }
  const substituted = applyTemplates(parsed, replacements, { nodes: 0 }, 0);
  return stringifyJson(substituted);
}

/** Turn validated header JSON into a plain string map. */
function headerMapFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof name === 'string' && name !== '' && typeof value === 'string') out[name] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Webhook execution                                                          */
/* -------------------------------------------------------------------------- */

/** True when the extension already holds host access for this URL. */
async function hasWebhookAccess(url) {
  const permissions = safeProperty(chrome, 'permissions');
  if (!permissions || typeof permissions.contains !== 'function') return false;
  const pattern = permissionOriginForUrl(url);
  if (pattern === '') return false;
  try {
    return (await permissions.contains({ origins: [pattern] })) === true;
  } catch {
    return false;
  }
}

/**
 * Run one webhook. Returns `{ outcome, httpStatus }`; never throws and never
 * exposes response content.
 */
async function runWebhook({ record, event, reason, action, snapshot, timeoutMs }) {
  if (isEnabled(action) !== true) return { outcome: 'disabled' };
  const canonical = describeWebhookUrl(action.url);
  if (!canonical.ok) return { outcome: 'bad-url' };
  const url = canonical.url;

  if ((await hasWebhookAccess(url)) !== true) return { outcome: 'no-permission' };
  if (record.config?.actions?.webhook?.enabled === false) return { outcome: 'disabled' };

  const method = action.method === 'GET' ? 'GET' : 'POST';
  const includeDetails = action.includePageDetails === true;
  const headers = headerMapFromText(action.headers);
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const custom = buildCustomBody(action.body, snapshot);
  const body = custom !== '' ? custom : stringifyJson({
    ...buildAutoPayload(snapshot), ...(includeDetails ? pageDetailFields(snapshot) : {})
  });

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* the run is already over */
      }
    }, timeoutMs);
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      // Credentials are never attached and redirects are never followed, so a
      // webhook cannot be turned into a cookie-carrying request or a chain.
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      // Only a POST carries the configured body.
      ...(method === 'POST' && body !== '' ? { body } : {}),
      signal: controller ? controller.signal : undefined
    });
    const httpStatus = response && Number.isFinite(response.status) ? response.status : null;
    // The response body is intentionally never read.
    return { outcome: response && response.ok === true ? 'delivered' : 'failed', httpStatus };
  } catch (error) {
    const message = safeError(error);
    if (/abort/i.test(message)) return { outcome: 'timeout' };
    return { outcome: 'failed' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Script execution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wrap user code as the body of an async function that receives the event.
 *
 * User-authored source intentionally runs as arbitrary code through userScripts,
 * never in an extension context. Event values use a JSON literal and contain
 * no webhook credentials. The wrapper returns only a generic success flag.
 */
function buildScriptWrapper(code, snapshot) {
  const serialized = stringifyJson(snapshot);
  const literal = serialized === '' ? '{}' : serialized.replace(/<\//g, '<\\/');
  return [
    '(async function(){',
    `  const __ctx = Object.freeze(${literal});`,
    '  try { await (async function(event){',
    String(code),
    '\n    })(__ctx);',
    '    return { ok: true };',
    '  } catch { return { ok: false }; }',
    '})();'
  ].join('\n');
}

/**
 * Resolve whether the isolated user-script capability is actually available and
 * granted right now. The popup asks this too, so both share one answer.
 */
async function resolveUserScriptAccess(tabUrl) {
  const api = safeProperty(chrome, 'userScripts');
  const available = Boolean(api) && typeof api.execute === 'function';
  const permissions = safeProperty(chrome, 'permissions');
  let permission = false;
  if (permissions && typeof permissions.contains === 'function') {
    try {
      permission = (await permissions.contains({ permissions: ['userScripts'] })) === true;
    } catch {
      permission = false;
    }
  }
  let originGranted = false;
  const pattern = permissionOriginForUrl(typeof tabUrl === 'string' ? tabUrl : '');
  if (pattern !== '' && permissions && typeof permissions.contains === 'function') {
    try {
      originGranted = (await permissions.contains({ origins: [pattern] })) === true;
    } catch {
      originGranted = false;
    }
  }
  return { available, permission, originGranted, pattern };
}

function capabilitiesMessage({ available, permission, originGranted, hasTabUrl, pattern }) {
  if (!permission || !originGranted) {
    return 'JavaScript access is not granted for this website yet.';
  }
  if (!available) {
    return 'Allow User Scripts is off or unavailable. Enable it in this extension’s Details page, then reload the extension.';
  }
  if (!hasTabUrl || pattern === '') {
    return 'Script access is granted, but this page cannot be scripted.';
  }
  return 'JavaScript access is granted for this website. Chrome 138 and later also needs "Allow User Scripts" switched on by hand.';
}

/** Run one page script in the isolated USER_SCRIPT world. */
async function runScript({ record, event, action, snapshot, tabId, documentId, timeoutMs }) {
  if (isEnabled(action) !== true) return { outcome: 'disabled' };
  if (typeof action.code !== 'string' || action.code.trim() === '') return { outcome: 'no-code' };

  const api = safeProperty(chrome, 'userScripts');
  if (!api || typeof api.execute !== 'function') return { outcome: 'unsupported' };

  // The current tab URL is the honest source for the permission pattern; the
  // record URL is only a fallback and is verified again just below.
  const tab = await getTopTab(tabId);
  const checkUrl =
    tab && typeof tab.url === 'string' && tab.url !== ''
      ? tab.url
      : (typeof record.url === 'string' ? record.url : '');
  const access = await resolveUserScriptAccess(checkUrl);
  if (access.available !== true || access.permission !== true) return { outcome: 'no-permission' };

  const target = await resolveTargetDocument(record, tabId, documentId);
  if (!target.ok) return { outcome: target.reason === 'origin-changed' ? 'origin-changed' : 'failed' };
  if (access.originGranted !== true) return { outcome: 'no-permission' };

  const wrapper = buildScriptWrapper(action.code, snapshot);
  let results = null;
  let executionTimer = null;
  try {
    await api.configureWorld({ worldId: 'abra-monitor', messaging: false });
    if (record.config?.actions?.script?.enabled === false) return { outcome: 'disabled' };
    const executed = api.execute({
      target: { tabId, documentIds: [target.documentId] },
      world: 'USER_SCRIPT',
      worldId: 'abra-monitor',
      js: [{ code: wrapper }]
    });
    if (!executed || typeof executed.then !== 'function') return { outcome: 'failed' };
    results = await Promise.race([
      executed,
      new Promise((resolve) => { executionTimer = setTimeout(() => resolve('timed-out'), timeoutMs); })
    ]);
  } catch {
    return { outcome: 'failed' };
  } finally {
    if (executionTimer !== null) clearTimeout(executionTimer);
  }
  if (results === 'timed-out') return { outcome: 'timeout' };
  const first = Array.isArray(results) ? results[0] : null;
  const result = first && typeof first === 'object' ? first.result : null;
  // The wrapper reports only ok/error; any secret a script produced stays inside
  // the isolated world and is never returned to the extension.
  if (first?.error || result?.ok !== true) return { outcome: 'failed' };
  return { outcome: 'ran' };
}

/* -------------------------------------------------------------------------- */
/* Public runner                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one automation event for a session record.
 *
 * `runActions(record, event, { reason?, documentId? })` awaits bounded local
 * execution and delivery, then resolves. It never throws (callers await it
 * outside their own locks) and always resolves to a summary:
 *
 *   {
 *     ok: true,
 *     event, tabId, timedOut,
 *     ran: boolean,               // at least one hook really executed
 *     failures: number,           // hooks that ran and failed
 *     results: [{ kind, status, outcome, message, httpStatus? }]
 *   }
 *
 * `documentId` is optional. When it is omitted, the current top document is
 * resolved with a fixed metadata function and its origin is verified against
 * the record before any user code runs.
 */
export async function runActions(record, event, options = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_ACTIONS_TIMEOUT_MS;
  const opts = options && typeof options === 'object' ? options : {};
  const reason = typeof opts.reason === 'string' ? opts.reason : '';
  const providedDocumentId = typeof opts.documentId === 'string' ? opts.documentId : '';
  const tabId = record && Number.isInteger(record.tabId) ? record.tabId : null;
  const eventName = typeof event === 'string' ? event : '';

  const summary = {
    ok: true,
    event: eventName,
    tabId,
    timedOut: false,
    ran: false,
    failures: 0,
    results: []
  };

  if (tabId === null) return summary;

  const actions = normalizeActions(record && record.config ? record.config.actions : null);
  const deliveries = [
    { kind: 'webhook', action: actions.webhook },
    { kind: 'script', action: actions.script }
  ];

  const validation = validateActions(record?.config?.actions);
  await Promise.all(deliveries.map(async (delivery) => {
    const { kind, action } = delivery;
    const selected = isEnabled(action) && eventsFor(action).includes(eventName);
    if (!selected) {
      // Off or not selected for this event: nothing is logged, nothing runs.
      summary.results.push({
        kind,
        status: 'skipped',
        outcome: isEnabled(action) ? 'not-selected' : 'disabled',
        message: messageForOutcome(kind, isEnabled(action) ? 'not-selected' : 'disabled')
      });
      return;
    }

    if (!validation.ok) {
      const message = 'Automation settings are invalid; nothing was executed.';
      await logEntry({ tabId, event: eventName, kind, status: 'failed', message });
      summary.failures += 1;
      summary.results.push({ kind, status: 'failed', outcome: 'failed', message });
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      summary.timedOut = true;
      await logEntry({ tabId, event: eventName, kind, status: 'skipped', message: messageForOutcome(kind, 'budget') });
      summary.results.push({ kind, status: 'skipped', outcome: 'budget', message: messageForOutcome(kind, 'budget') });
      return;
    }

    const snapshot = buildEventSnapshot(record, eventName, reason,
      kind === 'script' || action.includePageDetails === true);
    let outcome = 'failed';
    let httpStatus = null;
    if (kind === 'webhook') {
      const result = await runWebhook({ record, event: eventName, reason, action, snapshot, timeoutMs: remaining });
      outcome = result.outcome;
      httpStatus = typeof result.httpStatus === 'number' ? result.httpStatus : null;
    } else {
      const result = await runScript({
        record,
        event: eventName,
        action,
        snapshot,
        tabId,
        documentId: providedDocumentId,
        timeoutMs: remaining
      });
      outcome = result.outcome;
    }

    const failed = outcome === 'failed' || outcome === 'timeout';
    const skipped = outcome === 'disabled' || outcome === 'not-selected' || outcome === 'no-permission'
      || outcome === 'unsupported' || outcome === 'bad-url' || outcome === 'no-code'
      || outcome === 'origin-changed' || outcome === 'budget';
    const status = failed ? 'failed' : skipped ? 'skipped' : 'success';
    if (status === 'success') summary.ran = true;
    if (status === 'failed') summary.failures += 1;
    if (outcome === 'timeout' || outcome === 'budget') summary.timedOut = true;

    const logMessage = messageForOutcome(kind, outcome)
      + (httpStatus !== null ? ` (HTTP ${httpStatus})` : '');
    await logEntry({
      tabId,
      event: eventName,
      kind,
      status,
      message: logMessage
    });
    const entry = { kind, status, outcome, message: messageForOutcome(kind, outcome) };
    if (httpStatus !== null) entry.httpStatus = httpStatus;
    summary.results.push(entry);
  }));

  return summary;
}

/**
 * Trusted-UI capabilities for one tab URL.
 *
 * Always resolves `{ ok: true, scriptAvailable, scriptPermission,
 * scriptOriginGranted, webhookOrigins, message }`. `webhookOrigins` lists the
 * optional host patterns the extension currently holds, so the dashboard can
 * revoke them; it is bounded and contains patterns only, never URLs or secrets.
 */
export async function getActionCapabilities(tabUrl) {
  const url = typeof tabUrl === 'string' ? tabUrl : '';
  const access = await resolveUserScriptAccess(url);
  const permissions = safeProperty(chrome, 'permissions');

  let webhookOrigins = [];
  if (permissions && typeof permissions.getAll === 'function') {
    try {
      const all = await permissions.getAll();
      const origins = all && Array.isArray(all.origins) ? all.origins : [];
      webhookOrigins = origins
        .filter((origin) => typeof origin === 'string' && /^https?:\/\//i.test(origin))
        .slice(0, MAX_WEBHOOK_ORIGINS);
    } catch {
      webhookOrigins = [];
    }
  }

  return {
    ok: true,
    scriptAvailable: access.available === true,
    scriptPermission: access.permission === true,
    scriptOriginGranted: access.originGranted === true,
    webhookOrigins,
    message: capabilitiesMessage({
      available: access.available,
      permission: access.permission,
      originGranted: access.originGranted,
      hasTabUrl: url !== '',
      pattern: access.pattern
    })
  };
}

/** Recent browser-session activity for one tab, oldest first. */
export async function getActionLog(tabId) {
  await hydrateLog();
  const id = Number.isInteger(tabId) ? tabId : null;
  const entries = actionLog
    .filter((entry) => entry.tabId === id)
    .map((entry) => ({ ...entry }));
  return { ok: true, entries };
}
