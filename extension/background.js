/**
 * The Best Auto Refresh App — background service worker (MV3, `type: module`).
 *
 * Design decisions worth knowing before changing this file:
 *
 * 1. The service worker is event driven and may be killed at any moment, so it
 *    never relies on a long-lived timer. All waiting is expressed either as a
 *    one-shot chrome.alarms watchdog (>= 30s, Chrome's floor) or as a timer
 *    owned by the page content script (sub-30s waits and the settled check
 *    right after a reload).
 * 2. The background is the only decision maker. The page reports a normalized
 *    snapshot; only the background evaluates the stop condition, so a stale or
 *    forged page can never cause a reload.
 * 3. Session state lives in chrome.storage.session (in memory, trusted
 *    contexts only, cleared by the browser on restart) and is mirrored in RAM.
 * 4. Every session carries a random token plus a generation counter. Any
 *    START/PAUSE/RESUME/STOP bumps the generation, which invalidates every in
 *    flight message from the previous state. All per-tab work is serialized
 *    through a promise lock so two UI clicks cannot race.
 * 5. Timing model: nextRefreshAt is when the next reload is due. After a reload
 *    the page settles and checks immediately; if the condition is still unmet
 *    the background waits until nextRefreshAt and then reloads.
 * 6. The toolbar badge counts down to nextRefreshAt. The page owns a one-per-
 *    second ABRA_COUNTDOWN heartbeat (identity only, no page content) so the
 *    countdown survives the popup closing and never depends on a service-worker
 *    timer. The background recomputes the number from its own deadline, ignores
 *    heartbeats that arrive too fast, never writes storage or takes the tab lock
 *    for one, and re-applies the correct badge from storage after a restart.
 *
 * Permissions used: activeTab + scripting (inject on user gesture, re-inject
 * after same-origin reloads), storage (local UI data + durable session state),
 * alarms (watchdog). No required host, tabs or notification permissions.
 * Optional automation uses separately granted host/userScripts access.
 */
import {
  PICK_TTL_MS,
  alarmNameForTab,
  badgeColorFor,
  bumpGeneration,
  countdownSecondsUntil,
  createSessionRecord,
  createSessionToken,
  describeRestrictedTarget,
  intervalMsFor,
  originOf,
  planCycle,
  publicSessionState,
  sameOrigin,
  sessionBadgeText,
  shouldAcceptCountdown,
  tabIdFromAlarmName,
  toFiniteNumber,
  validateConfig,
  validateContentMessage,
  validateCountdownMessage,
  validateInteractionMessage,
  validatePickMessage,
  validateUiMessage,
  watchdogDelayMs,
  withDefaults
} from './core.js';
import { runActions, getActionCapabilities, getActionLog, testWebhook, evaluatePredicate } from './actions.js';

const SESSION_KEY = 'abraSessions';
const PICKED_KEY = 'pickedSelector';
const MAX_PERSISTED_SESSIONS = 50;
const MAX_WATCHDOG_RETRIES = 3;
const TICK_TOLERANCE_MS = 1000;
const RELOAD_GUARD_MS = 1500;
const ALARM_PREFIX = 'abra-watchdog:';

/** tabId -> session record (mirrors chrome.storage.session). */
const sessions = new Map();
/** tabId -> { tabId, token, expiresAt } one-time element picker grants. */
const picks = new Map();
/** tabId -> tail of the promise chain serializing work for that tab. */
const locks = new Map();
/**
 * tabId -> { text, color, title, lastCountdownAt }: the badge values currently
 * applied plus the countdown heartbeat rate gate. RAM only, never persisted.
 */
const badgeState = new Map();
let hydratePromise = null;

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function safeCall(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') result.catch(() => {});
    return result;
  } catch {
    return null;
  }
}

function describeError(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'Unexpected engine error.';
}

function describeInjectionError(error) {
  const text = describeError(error);
  if (/cannot be scripted|extensions gallery|web store|chrome:\/\//i.test(text)) {
    return 'This page cannot be monitored by extensions. Open a normal website and try again.';
  }
  if (/Cannot access contents|must request permission|host permission|Cannot access a chrome/i.test(text)) {
    return 'The extension does not have access to this tab. Open the tab, click the extension icon, then start again.';
  }
  if (/No tab with id|tab was closed|Invalid tab ID|No window with id/i.test(text)) {
    return 'That tab is no longer open.';
  }
  if (/file:\/\//i.test(text)) {
    return 'Access to file URLs is disabled. Turn on "Allow access to file URLs" for this extension, then try again.';
  }
  return `The page could not be reached: ${text}`;
}

function readTabId(msg) {
  const value = msg ? msg.tabId : undefined;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nextIntervalMs(record) {
  return intervalMsFor(record.config);
}

function normalizeRecord(tabId, raw) {
  const base = createSessionRecord({
    tabId,
    token: typeof raw.token === 'string' && raw.token !== '' ? raw.token : createSessionToken(),
    config: withDefaults(raw.config)
  });
  const statuses = ['running', 'paused', 'matched', 'stopped', 'error'];
  const record = {
    ...base,
    generation: toFiniteNumber(raw.generation) || 1,
    url: typeof raw.url === 'string' ? raw.url : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    origin: typeof raw.origin === 'string' ? raw.origin : originOf(raw.url),
    status: statuses.includes(raw.status) ? raw.status : 'stopped',
    refreshCount: toFiniteNumber(raw.refreshCount) || 0,
    nextRefreshAt: toFiniteNumber(raw.nextRefreshAt),
    scheduledFor: toFiniteNumber(raw.scheduledFor),
    lastReloadAt: toFiniteNumber(raw.lastReloadAt),
    reloadPendingAt: toFiniteNumber(raw.reloadPendingAt),
    watchdogRetries: toFiniteNumber(raw.watchdogRetries) || 0,
    startedAt: toFiniteNumber(raw.startedAt) || Date.now(),
    lastCheckedAt: toFiniteNumber(raw.lastCheckedAt),
    lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    baseline: raw.baseline && typeof raw.baseline === 'object' ? raw.baseline : null,
    documentId: typeof raw.documentId === 'string' ? raw.documentId : null,
    pendingRefreshCount: toFiniteNumber(raw.pendingRefreshCount),
    completedRefreshCount: toFiniteNumber(raw.completedRefreshCount) || 0
  };
  return record;
}

/* -------------------------------------------------------------------------- */
/* Durable state                                                              */
/* -------------------------------------------------------------------------- */

function ensureHydrated() {
  if (!hydratePromise) hydratePromise = hydrate();
  return hydratePromise;
}

async function hydrate() {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const raw = stored ? stored[SESSION_KEY] : null;
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const tabId = Number(key);
        if (!Number.isInteger(tabId) || !value || typeof value !== 'object') continue;
        if (sessions.size >= MAX_PERSISTED_SESSIONS) break;
        sessions.set(tabId, normalizeRecord(tabId, value));
      }
    }
  } catch {
    /* session storage is best effort */
  }
  await clearAllWatchdogs();
  for (const record of sessions.values()) {
    // Resumes the countdown from the stored deadline after a worker restart.
    refreshBadge(record);
    if (record.status !== 'running') continue;
    scheduleWatchdog(record);
    // The worker may have been asleep past the due time: recover immediately
    // instead of waiting for the next alarm.
    const due = toFiniteNumber(record.nextRefreshAt);
    if (due !== null && due <= Date.now()) {
      handleAlarm({ name: alarmNameForTab(record.tabId) }).catch(() => {
        /* recovery is best effort */
      });
    }
  }
}

async function persistSessions() {
  if (!chrome.storage || !chrome.storage.session) return;
  const payload = {};
  let count = 0;
  for (const [tabId, record] of sessions) {
    if (count >= MAX_PERSISTED_SESSIONS) break;
    payload[String(tabId)] = record;
    count += 1;
  }
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: payload });
    return;
  } catch {
    /* fall through: likely a quota error from large text baselines */
  }
  const trimmed = {};
  for (const [key, record] of Object.entries(payload)) {
    trimmed[key] = { ...record, baseline: null };
  }
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: trimmed });
  } catch {
    /* storage failures must never break monitoring */
  }
}

async function clearAllWatchdogs() {
  if (!chrome.alarms) return;
  try {
    const alarms = await chrome.alarms.getAll();
    await Promise.all(
      alarms
        .filter((alarm) => typeof alarm.name === 'string' && alarm.name.startsWith(ALARM_PREFIX))
        .map((alarm) => chrome.alarms.clear(alarm.name))
    );
  } catch {
    /* ignore */
  }
}

function scheduleWatchdog(record) {
  if (!chrome.alarms || !record) return;
  if (record.status !== 'running') {
    clearWatchdog(record.tabId);
    return;
  }
  const due = toFiniteNumber(record.nextRefreshAt);
  const waitMs = due === null ? 0 : Math.max(0, due - Date.now());
  const when = Date.now() + watchdogDelayMs(waitMs);
  safeCall(() => chrome.alarms.create(alarmNameForTab(record.tabId), { when }));
}

function clearWatchdog(tabId) {
  if (!chrome.alarms) return;
  safeCall(() => chrome.alarms.clear(alarmNameForTab(tabId)));
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                     */
/* -------------------------------------------------------------------------- */

function badgeStateFor(tabId) {
  let state = badgeState.get(tabId);
  if (!state) {
    state = { text: null, color: null, title: null, lastCountdownAt: 0 };
    badgeState.set(tabId, state);
  }
  return state;
}

/**
 * Hover title. While running it always carries the exact remaining seconds,
 * even when the badge itself has switched to compact minutes or hours.
 */
function buildBadgeTitle(record, now = Date.now()) {
  const refreshes = record.refreshCount > 0 ? ` — ${record.refreshCount} refresh(es)` : '';
  switch (record.status) {
    case 'running': {
      const seconds = countdownSecondsUntil(record.nextRefreshAt, now);
      const next =
        seconds === null
          ? 'waiting for the next check'
          : seconds <= 0
            ? 'refresh due now'
            : `next refresh in ${seconds}s`;
      return `The Best Auto Refresh App — monitoring — ${next}${refreshes}`;
    }
    case 'paused':
      return `The Best Auto Refresh App — paused${refreshes}`;
    case 'matched':
      return `The Best Auto Refresh App — stop condition met${refreshes}`;
    case 'error':
      return `The Best Auto Refresh App — stopped: ${record.error || 'error'}`;
    default:
      return 'The Best Auto Refresh App';
  }
}

/**
 * Apply the shared badge formatter to one tab. The countdown changes every
 * second, so only the values that actually differ are pushed to the toolbar.
 */
function refreshBadge(record, now = Date.now()) {
  if (!chrome.action || !record) return;
  const tabId = record.tabId;
  const text = sessionBadgeText(record, now);
  const color = badgeColorFor(record.status);
  const title = buildBadgeTitle(record, now);
  const state = badgeStateFor(tabId);
  if (state.text !== text) {
    state.text = text;
    safeCall(() => chrome.action.setBadgeText({ tabId, text }));
  }
  if (state.color !== color) {
    state.color = color;
    safeCall(() => chrome.action.setBadgeBackgroundColor({ tabId, color }));
  }
  if (state.title !== title) {
    state.title = title;
    safeCall(() => chrome.action.setTitle({ tabId, title }));
  }
}

function clearBadge(tabId) {
  badgeState.delete(tabId);
  if (!chrome.action) return;
  safeCall(() => chrome.action.setBadgeText({ tabId, text: '' }));
}

/* -------------------------------------------------------------------------- */
/* Per-tab serialization                                                      */
/* -------------------------------------------------------------------------- */

function withTabLock(tabId, task) {
  const previous = locks.get(tabId) || Promise.resolve();
  const chained = previous.then(() => task());
  const settled = chained.catch((error) => ({ ok: false, error: describeError(error) }));
  locks.set(
    tabId,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

/* -------------------------------------------------------------------------- */
/* Tab + content script plumbing                                              */
/* -------------------------------------------------------------------------- */

async function getTabInfo(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        let lastError = null;
        try {
          lastError = chrome.runtime.lastError;
        } catch {
          lastError = null;
        }
        if (lastError) {
          resolve({ ok: false, error: lastError.message || 'The page is not listening.' });
          return;
        }
        resolve(response && typeof response === 'object' ? response : { ok: false, error: 'The page did not answer.' });
      });
    } catch (error) {
      resolve({ ok: false, error: describeError(error) });
    }
  });
}

/** Handshake, injecting content.js first when the page does not have it. */
async function ensureContent(tabId) {
  const first = await sendToTab(tabId, { type: 'ABRA_HANDSHAKE' });
  if (first.ok === true && first.ready === true) return first;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
  } catch (error) {
    return { ok: false, error: describeInjectionError(error) };
  }
  const second = await sendToTab(tabId, { type: 'ABRA_HANDSHAKE' });
  if (second.ok === true && second.ready === true) return second;
  return { ok: false, error: second.error || 'The page did not load the monitoring helper.' };
}

/**
 * (Re)attach the page to a session. `delayMs` is when the page should run its
 * next settle-and-check cycle: 0 right after a reload, the remaining time to
 * nextRefreshAt when the cadence must not be disturbed.
 */
async function attachSession(record, delayMs) {
  delete record.reloadInteractionGeneration;
  const wait = Math.max(0, toFiniteNumber(delayMs) || 0);
  const response = await sendToTab(record.tabId, {
    type: 'ABRA_SESSION',
    tabId: record.tabId,
    token: record.token,
    generation: record.generation,
    // Webhook credentials and user code never enter the monitoring helper.
    config: Object.fromEntries(Object.entries(record.config).filter(([key]) => key !== 'actions')),
    baseline: record.baseline,
    status: record.status,
    delayMs: wait
  });
  if (!response || response.ok !== true) {
    return { ok: false, error: (response && response.error) || 'The page did not accept the monitoring session.' };
  }
  if (typeof response.url === 'string' && response.url !== '') record.url = response.url;
  if (typeof response.title === 'string') record.title = response.title;
  record.scheduledFor = Date.now() + wait;
  return { ok: true };
}

async function notifyStatus(record, status) {
  await sendToTab(record.tabId, {
    type: 'ABRA_STATUS',
    tabId: record.tabId,
    token: record.token,
    generation: record.generation,
    status
  });
}

async function captureDocument(record) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: record.tabId, frameIds: [0] },
      func: () => location.href
    });
    const top = results.find((entry) => entry.frameId === 0);
    if (!top || !sameOrigin(top.result, record.origin)) return false;
    record.documentId = top.documentId || null;
    return true;
  } catch {
    record.documentId = null;
    return false;
  }
}

async function fireActions(record, event, reason = '') {
  try {
    await runActions(record, event, { reason, documentId: record.documentId });
  } catch {
    // Optional actions never turn a healthy monitor into an engine error.
  }
}

async function isCurrentDocument(record) {
  if (!record.documentId) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: record.tabId, frameIds: [0] }, func: () => location.href
    });
    const top = results.find((entry) => entry.frameId === 0);
    return top?.documentId === record.documentId && sameOrigin(top.result, record.origin);
  } catch { return false; }
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

async function finishWithMatched(record, reason) {
  bumpGeneration(record);
  record.status = 'matched';
  record.error = null;
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.reloadPendingAt = null;
  record.lastResult = { met: true, reason, checkedAt: Date.now() };
  clearWatchdog(record.tabId);
  refreshBadge(record);
  await notifyStatus(record, 'stopped');
  await persistSessions();
  await fireActions(record, 'match', reason);
  return { ok: true, action: 'stop', state: publicSessionState(record), reason };
}

async function finishStopped(record, reason, event = 'limit') {
  bumpGeneration(record);
  record.status = 'stopped';
  record.error = null;
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.reloadPendingAt = null;
  record.lastResult = { met: false, reason, checkedAt: Date.now() };
  clearWatchdog(record.tabId);
  refreshBadge(record);
  await notifyStatus(record, 'stopped');
  await persistSessions();
  await fireActions(record, event, reason);
  return { ok: true, action: 'stop', state: publicSessionState(record), reason };
}

async function finishWithError(record, message) {
  bumpGeneration(record);
  record.status = 'error';
  record.error = message;
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.reloadPendingAt = null;
  record.lastResult = { met: false, reason: message, checkedAt: Date.now() };
  clearWatchdog(record.tabId);
  refreshBadge(record);
  await notifyStatus(record, 'stopped');
  await persistSessions();
  await fireActions(record, 'error', message);
  return { ok: true, action: 'stop', state: publicSessionState(record), error: message };
}

async function teardownSession(record) {
  if (!record) return;
  bumpGeneration(record);
  record.status = 'stopped';
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.reloadPendingAt = null;
  clearWatchdog(record.tabId);
  await notifyStatus(record, 'stopped');
  await persistSessions();
}

/** A hidden page that should not be refreshed waits here until it is visible. */
function parkSession(record) {
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.lastResult = {
    met: false,
    reason: 'Paused while the tab is in the background (pause-when-hidden is on).',
    checkedAt: Date.now()
  };
  clearWatchdog(record.tabId);
  refreshBadge(record);
}

/* -------------------------------------------------------------------------- */
/* Condition checks (the only place a reload is authorized)                   */
/* -------------------------------------------------------------------------- */

async function runCheck(record, msg) {
  if (sessions.get(record.tabId) !== record) {
    return { ok: false, error: 'Message rejected: the session changed.' };
  }
  if (record.status !== 'running') {
    // A report that was already queued when the session paused (or ended) must
    // never reload: answer benignly so the page simply stops counting down.
    return { ok: true, action: 'wait' };
  }

  const now = Date.now();
  const pendingAt = toFiniteNumber(record.reloadPendingAt);
  if (pendingAt !== null && now - pendingAt < RELOAD_GUARD_MS) {
    // A second driver (page timer + watchdog) reported while a reload is
    // already in flight; make it wait instead of queueing another reload.
    return { ok: true, action: 'schedule', delayMs: RELOAD_GUARD_MS - (now - pendingAt) };
  }
  record.reloadPendingAt = null;

  const snapshot = msg.snapshot && typeof msg.snapshot === 'object' ? msg.snapshot : {};
  if (typeof msg.url === 'string' && msg.url !== '') record.url = msg.url;
  if (typeof msg.title === 'string') record.title = msg.title;
  record.lastCheckedAt = now;
  record.watchdogRetries = 0;
  // A page action may navigate. Leave navigation recovery to onUpdated and
  // never apply a snapshot or reload decision to its replacement document.
  if (!await isCurrentDocument(record)) return { ok: true, action: 'wait' };

  // A custom JavaScript condition runs here, after the page reported its settled
  // snapshot, so it sees the same content the planner is about to judge. Its
  // boolean is attached to the snapshot and every matching decision stays in the
  // pure planner below. The runner never throws and never ends a session: a
  // predicate that errors, is blocked, or never settles simply reports why and
  // the refresh cycle continues.
  record.checkCount = (Number.isFinite(record.checkCount) ? record.checkCount : 0) + 1;
  if (record.config && record.config.stopCondition === 'script-predicate') {
    snapshot.predicate = await evaluatePredicate({
      record,
      tabId: record.tabId,
      documentId: record.documentId,
      snapshot,
      code: record.config.predicateScript
    });
    if (sessions.get(record.tabId) !== record || record.status !== 'running'
        || !await isCurrentDocument(record)) return { ok: true, action: 'wait' };
  }

  // core.planCycle owns every matching/timing decision; this file only applies
  // the chrome side effects (storage, badge, alarms, page messages).
  const plan = planCycle({ record, snapshot, now });
  record.baseline = plan.baseline || null;
  record.lastResult = plan.lastResult;
  record.nextRefreshAt = plan.nextRefreshAt;
  await fireActions(record, 'check', plan.reason);
  if (sessions.get(record.tabId) !== record || record.status !== 'running'
      || !await isCurrentDocument(record) || record.interactionRequested) return { ok: true, action: 'wait' };

  if (plan.kind === 'matched') {
    return finishWithMatched(record, plan.reason);
  }
  if (plan.kind === 'stopped') {
    return finishStopped(record, plan.reason);
  }
  if (plan.kind === 'error') {
    return finishWithError(record, plan.reason);
  }

  if (plan.kind === 'wait') {
    record.scheduledFor = plan.nextRefreshAt;
    await persistSessions();
    scheduleWatchdog(record);
    refreshBadge(record, now);
    return {
      ok: true,
      action: 'schedule',
      delayMs: Math.max(0, plan.delayMs || 0),
      nextRefreshAt: plan.nextRefreshAt
    };
  }

  await fireActions(record, 'before-refresh', plan.reason);
  if (sessions.get(record.tabId) !== record || record.status !== 'running'
      || !await isCurrentDocument(record) || record.interactionRequested) return { ok: true, action: 'wait' };
  record.refreshCount = plan.refreshCount;
  record.lastReloadAt = now;
  record.reloadPendingAt = now;
  record.nextRefreshAt = plan.nextRefreshAt;
  record.scheduledFor = now + Math.max(0, Math.round((toFiniteNumber(record.config.settleSeconds) || 0) * 1000));
  const prepared = await sendToTab(record.tabId, {
    type: 'ABRA_PREPARE_RELOAD', tabId: record.tabId,
    token: record.token, generation: record.generation
  });
  if (record.interactionRequested || record.status !== 'running') return { ok: true, action: 'wait' };
  if (!prepared.ok) return finishWithError(record, 'The page could not prepare for its next refresh.');
  record.reloadInteractionGeneration = record.generation;
  bumpGeneration(record);
  record.pendingRefreshCount = record.refreshCount;
  await persistSessions();
  scheduleWatchdog(record);
  refreshBadge(record);
  if (record.interactionRequested || record.status !== 'running') return { ok: true, action: 'wait' };
  try {
    await chrome.tabs.reload(record.tabId, { bypassCache: record.config.bypassCache });
  } catch (error) {
    return finishWithError(record, describeInjectionError(error));
  }
  return {
    ok: true,
    action: 'wait',
    nextRefreshAt: record.nextRefreshAt,
    refreshCount: record.refreshCount
  };
}

/* -------------------------------------------------------------------------- */
/* UI request handlers                                                        */
/* -------------------------------------------------------------------------- */

async function handleStart(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) {
    return { ok: false, error: 'A tab id is required to start monitoring.' };
  }
  const validation = validateConfig(msg.config);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  const config = validation.config;

  return withTabLock(tabId, async () => {
    const existing = sessions.get(tabId);
    if (existing) await teardownSession(existing);

    const tabInfo = await getTabInfo(tabId);
    if (!tabInfo) return { ok: false, error: 'That tab is no longer open.' };
    if (tabInfo.url) {
      const restricted = describeRestrictedTarget(tabInfo.url);
      if (restricted) return { ok: false, error: restricted };
    }

    const handshake = await ensureContent(tabId);
    if (!handshake.ok) return { ok: false, error: handshake.error };

    const url = typeof handshake.url === 'string' && handshake.url !== '' ? handshake.url : tabInfo.url || '';
    const restricted = describeRestrictedTarget(url);
    if (restricted) return { ok: false, error: restricted };

    const now = Date.now();
    const record = createSessionRecord({ tabId, token: createSessionToken(), config, now });
    record.url = url;
    record.title = handshake.title || '';
    record.origin = originOf(url);
    record.nextRefreshAt = now + nextIntervalMs(record);
    record.pendingRefreshCount = null;
    record.completedRefreshCount = 0;
    sessions.set(tabId, record);
    await captureDocument(record);

    const attached = await attachSession(record, 0);
    if (!attached.ok) {
      sessions.delete(tabId);
      await persistSessions();
      return { ok: false, error: attached.error };
    }

    refreshBadge(record);
    scheduleWatchdog(record);
    await persistSessions();
    await fireActions(record, 'start');
    return { ok: true, state: publicSessionState(record) };
  });
}

async function handleStop(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required to stop monitoring.' };
  return withTabLock(tabId, async () => {
    const record = sessions.get(tabId);
    if (!record) return { ok: true, state: null };
    if (record.status === 'running' || record.status === 'paused') {
      await finishStopped(record, 'Stopped by the user.', 'manual-stop');
    } else {
      clearWatchdog(tabId);
      clearBadge(tabId);
      await persistSessions();
    }
    return { ok: true, state: publicSessionState(record) };
  });
}

async function handlePause(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required to pause monitoring.' };
  return withTabLock(tabId, () => pauseSession(sessions.get(tabId), 'Paused by the user.'));
}

/**
 * The one pause transition, shared by the popup's Pause button and automatic
 * pause-on-interaction. Callers own the per-tab lock: this function must never
 * take it, or an interaction arriving while a check is in flight would deadlock
 * against its own tab.
 */
async function pauseSession(record, reason) {
  if (!record) return { ok: false, error: 'No monitoring session for this tab.' };
  if (record.status === 'paused') return { ok: true, state: publicSessionState(record) };
  if (record.status !== 'running') {
    return { ok: false, error: `This tab is not being monitored (status: ${record.status}).` };
  }
  bumpGeneration(record);
  record.status = 'paused';
  delete record.interactionRequested;
  record.nextRefreshAt = null;
  record.scheduledFor = null;
  record.reloadPendingAt = null;
  record.lastResult = { met: false, reason, checkedAt: Date.now() };
  clearWatchdog(record.tabId);
  refreshBadge(record);
  await notifyStatus(record, 'paused');
  await persistSessions();
  await fireActions(record, 'pause');
  return { ok: true, state: publicSessionState(record) };
}

async function handleResume(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required to resume monitoring.' };
  return withTabLock(tabId, async () => {
    const record = sessions.get(tabId);
    if (!record) return { ok: false, error: 'No monitoring session for this tab.' };
    if (record.status === 'running') return { ok: true, state: publicSessionState(record) };
    if (record.status !== 'paused') {
      return { ok: false, error: `This session cannot be resumed (status: ${record.status}). Start it again instead.` };
    }

    const tabInfo = await getTabInfo(tabId);
    if (!tabInfo) return { ok: false, error: 'That tab is no longer open.' };
    if (tabInfo.url) {
      const restricted = describeRestrictedTarget(tabInfo.url);
      if (restricted) return { ok: false, error: restricted };
    }

    const handshake = await ensureContent(tabId);
    if (!handshake.ok) return { ok: false, error: handshake.error };
    const url = typeof handshake.url === 'string' && handshake.url !== '' ? handshake.url : tabInfo.url || '';
    if (record.origin && url && !sameOrigin(url, record.origin)) {
      await finishWithError(
        record,
        `The tab moved to a different site (${originOf(url) || url}), so monitoring stopped. Start it again on the new page.`
      );
      return { ok: false, error: record.error };
    }

    bumpGeneration(record);
    record.status = 'running';
    record.error = null;
    record.nextRefreshAt = null;
    record.lastResult = { met: false, reason: 'Resumed by the user.', checkedAt: Date.now() };
    if (url) {
      record.url = url;
      record.origin = originOf(url);
    }
    if (typeof handshake.title === 'string' && handshake.title !== '') record.title = handshake.title;

    await captureDocument(record);
    await fireActions(record, 'resume');

    const attached = await attachSession(record, 0);
    if (!attached.ok) {
      await finishWithError(record, attached.error);
      return { ok: false, error: attached.error };
    }
    refreshBadge(record);
    scheduleWatchdog(record);
    await persistSessions();
    return { ok: true, state: publicSessionState(record) };
  });
}

async function handleGetState(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required.' };
  return { ok: true, state: publicSessionState(sessions.get(tabId) || null) };
}

async function handleGetAll() {
  await pruneMissingTabs();
  const list = [];
  for (const record of sessions.values()) list.push(publicSessionState(record));
  list.sort((a, b) => a.tabId - b.tabId);
  return { ok: true, sessions: list };
}

/**
 * Explicit "send one test request" for the trusted extension UI only.
 *
 * The message router has already proven the sender is an extension page. This
 * handler adds nothing else: no monitor is required, no permission is ever
 * requested here, no page code runs, and no session state is read or changed.
 * `testWebhook` owns the single bounded fetch, the actions-core validation and
 * the per-tab in-flight guard; its result is returned to the UI unchanged.
 */
async function handleTestWebhook(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required to test the webhook.' };
  if (!await getTabInfo(tabId)) return { ok: false, error: 'That tab is no longer open.' };
  return testWebhook({ tabId, webhook: msg.webhook });
}

async function handlePickElement(msg) {
  const tabId = readTabId(msg);
  if (tabId === null) return { ok: false, error: 'A tab id is required to pick an element.' };
  return withTabLock(tabId, async () => {
    const record = sessions.get(tabId) || null;
    picks.delete(tabId);

    const tabInfo = await getTabInfo(tabId);
    if (!tabInfo) return { ok: false, error: 'That tab is no longer open.' };
    if (tabInfo.url) {
      const restricted = describeRestrictedTarget(tabInfo.url);
      if (restricted) return { ok: false, error: restricted };
    }

    const content = await ensureContent(tabId);
    if (!content.ok) return { ok: false, error: content.error };

    if (record && record.status === 'running') {
      // Keep the page's session identity current without disturbing the cadence.
      const due = toFiniteNumber(record.nextRefreshAt);
      const remaining = due === null ? 0 : Math.max(0, due - Date.now());
      const attached = await attachSession(record, remaining);
      if (!attached.ok) return { ok: false, error: attached.error };
    }

    const pickToken = createSessionToken();
    picks.set(tabId, { tabId, token: pickToken, expiresAt: Date.now() + PICK_TTL_MS });
    const response = await sendToTab(tabId, { type: 'ABRA_PICK', tabId, pickToken, active: true });
    if (!response || response.ok !== true) {
      picks.delete(tabId);
      return { ok: false, error: (response && response.error) || 'The element picker could not be shown on this page.' };
    }
    return { ok: true, state: publicSessionState(record), picker: true };
  });
}

/* -------------------------------------------------------------------------- */
/* Content script messages                                                    */
/* -------------------------------------------------------------------------- */

async function handleReport(msg, sender) {
  const tabId = sender.tab.id;
  const record = sessions.get(tabId) || null;
  const validation = validateContentMessage(record, sender, msg);
  if (!validation.ok) return validation;
  if (sender.frameId !== 0 || (record.documentId && sender.documentId !== record.documentId)) {
    return { ok: false, error: 'Message rejected: this is not the monitored document.' };
  }
  // A report that was already queued when the session paused must be inert: it
  // may not move the schedule, flip a status or authorize a reload.
  if (record.status !== 'running') return { ok: true, action: 'wait' };

  const now = Date.now();
  record.watchdogRetries = 0;

  if (msg.kind === 'hidden') {
    parkSession(record);
    await persistSessions();
    return { ok: true, action: 'wait' };
  }

  if (msg.kind === 'visible') {
    if (record.status !== 'running') return { ok: true, action: 'wait' };
    record.nextRefreshAt = null;
    record.scheduledFor = now;
    scheduleWatchdog(record);
    refreshBadge(record, now);
    await persistSessions();
    return { ok: true, action: 'schedule', delayMs: 0 };
  }

  const scheduledFor = toFiniteNumber(record.scheduledFor);
  if (scheduledFor !== null && now < scheduledFor - TICK_TOLERANCE_MS) {
    return {
      ok: true,
      action: 'schedule',
      delayMs: Math.max(0, scheduledFor - TICK_TOLERANCE_MS - now),
      nextRefreshAt: toFiniteNumber(record.nextRefreshAt)
    };
  }

  return withTabLock(tabId, () => runCheck(record, msg));
}

/**
 * One-per-second badge heartbeat from the monitored top frame.
 *
 * It carries identity only: no page text, URL or title. The background
 * recomputes the countdown from its own nextRefreshAt, ignores heartbeats that
 * arrive faster than the rate gate, and deliberately takes no tab lock and
 * writes no storage, so a heartbeat can never move the schedule, deadlock a
 * check or reset a timer.
 */
function handleCountdown(msg, sender) {
  const tabId = sender.tab.id;
  const record = sessions.get(tabId) || null;
  const validation = validateCountdownMessage(record, sender, msg);
  if (!validation.ok) return validation;
  if (record.status !== 'running') return { ok: true, ignored: true };

  const now = Date.now();
  const state = badgeStateFor(tabId);
  if (!shouldAcceptCountdown(state.lastCountdownAt, now)) {
    return { ok: true, throttled: true };
  }
  state.lastCountdownAt = now;
  refreshBadge(record, now);
  return { ok: true };
}

/**
 * A trusted gesture in the monitored top frame asks for a pause (pause on
 * interaction). The payload is identity only; the sender's frame id, document
 * id and origin are supplied by the browser, and both are checked before the
 * shared pause transition runs. Once the record pauses, its generation moves,
 * so any other in-flight message from the old document is refused.
 */
async function handleInteraction(msg, sender) {
  const tabId = sender.tab.id;
  const record = sessions.get(tabId) || null;
  // Reload preparation advances the engine generation while the old document
  // remains visible. Its gestures may still cancel that pending navigation.
  const interactionRecord = current => current && current.reloadPendingAt != null
    && current.reloadInteractionGeneration === msg.generation
    && current.documentId && sender.documentId === current.documentId
    ? { ...current, generation: msg.generation } : current;
  const validation = validateInteractionMessage(interactionRecord(record), sender, msg);
  if (!validation.ok) return validation;
  if (sender.frameId !== 0 || (record.documentId && sender.documentId !== record.documentId)) {
    return { ok: false, error: 'Message rejected: this is not the monitored document.' };
  }
  // Invalidate a pending reload before waiting behind a slow event hook.
  // Identity is validated first; this flag affects only this exact record.
  record.interactionRequested = true;
  return withTabLock(tabId, async () => {
    const current = sessions.get(tabId);
    // The lock may have waited behind a check: the record must be the same one
    // that was validated, still running and still opted in.
    if (current !== record) return { ok: false, error: 'Message rejected: the session changed.' };
    const checked = validateInteractionMessage(interactionRecord(current), sender, msg);
    if (!checked.ok) { delete current.interactionRequested; return checked; }
    if (current.status !== 'running') {
      return { ok: false, error: 'Message rejected: the session is no longer running.' };
    }
    if (!current.config || current.config.pauseOnInteraction !== true) {
      return { ok: false, error: 'Message rejected: pause on interaction is off for this session.' };
    }
    return pauseSession(current, 'Paused automatically after you used the page. Press Resume to continue.');
  });
}

async function handlePicked(msg, sender) {
  const tabId = sender.tab.id;
  const pending = picks.get(tabId) || null;
  const record = sessions.get(tabId) || null;
  const validation = validatePickMessage(pending, record, sender, msg);
  if (!validation.ok) return validation;

  picks.delete(tabId);
  const selector = typeof msg.selector === 'string' ? msg.selector.trim() : '';
  if (selector === '') {
    return { ok: false, error: 'No element selector was captured. Try picking again.' };
  }
  try {
    await chrome.storage.local.set({ [PICKED_KEY]: { tabId, selector } });
  } catch {
    /* the popup also receives the selector directly */
  }
  return {
    ok: true,
    state: publicSessionState(record),
    pickedSelector: { tabId, selector }
  };
}

async function handlePickCancelled(msg, sender) {
  const pending = picks.get(sender.tab.id) || null;
  const record = sessions.get(sender.tab.id) || null;
  const validation = validatePickMessage(pending, record, sender, msg);
  if (!validation.ok) return validation;
  picks.delete(sender.tab.id);
  return { ok: true, state: publicSessionState(record), picker: false };
}

/* -------------------------------------------------------------------------- */
/* Tab, alarm and lifecycle events                                            */
/* -------------------------------------------------------------------------- */

async function handleTabUpdated(tabId, changeInfo) {
  await ensureHydrated();
  const record = sessions.get(tabId);
  if (!record || record.status !== 'running') return;
  if (changeInfo.status !== 'complete' && typeof changeInfo.url !== 'string') return;

  await withTabLock(tabId, async () => {
    const current = sessions.get(tabId);
    if (!current || current !== record || current.status !== 'running') return;

    const info = await getTabInfo(tabId);
    if (!info) {
      sessions.delete(tabId);
      clearWatchdog(tabId);
      await persistSessions();
      return;
    }
    const url = (typeof changeInfo.url === 'string' && changeInfo.url) || info.url || current.url;

    if (url && current.origin && !sameOrigin(url, current.origin)) {
      await finishWithError(
        current,
        `The tab moved to a different site (${originOf(url) || url}), so monitoring stopped. Start it again on the new page.`
      );
      return;
    }

    const content = await ensureContent(tabId);
    if (!content.ok) {
      await finishWithError(current, content.error);
      return;
    }

    // Same origin: re-inject if needed and settle-and-check straight away so a
    // change produced by the reload is detected immediately.
    await captureDocument(current);
    const attached = await attachSession(current, 0);
    if (!attached.ok) {
      await finishWithError(current, attached.error);
      return;
    }
    if (changeInfo.status === 'complete' && current.pendingRefreshCount !== null
        && current.pendingRefreshCount > (current.completedRefreshCount || 0)) {
      current.completedRefreshCount = current.pendingRefreshCount;
      current.pendingRefreshCount = null;
      // Persist the completion marker before dispatching optional side effects.
      await persistSessions();
      await fireActions(current, 'after-refresh');
    }
    scheduleWatchdog(current);
    await persistSessions();
  });
}

async function handleAlarm(alarm) {
  const tabId = tabIdFromAlarmName(alarm && alarm.name);
  if (tabId === null) return;
  await ensureHydrated();
  const record = sessions.get(tabId);
  if (!record || record.status !== 'running') {
    clearWatchdog(tabId);
    return;
  }

  await withTabLock(tabId, async () => {
    const current = sessions.get(tabId);
    if (!current || current !== record || current.status !== 'running') return;

    const retries = (toFiniteNumber(current.watchdogRetries) || 0) + 1;
    current.watchdogRetries = retries;
    if (retries > MAX_WATCHDOG_RETRIES) {
      await finishWithError(
        current,
        'The page stopped answering the extension, so monitoring was stopped to avoid endless retries. Start it again to retry.'
      );
      return;
    }

    const content = await ensureContent(tabId);
    if (!content.ok) {
      await finishWithError(current, content.error);
      return;
    }
    await captureDocument(current);
    const attached = await attachSession(current, 0);
    if (!attached.ok) {
      await finishWithError(current, attached.error);
      return;
    }
    scheduleWatchdog(current);
    await persistSessions();
    // attachSession already schedules a settled check. Never await a tick
    // report while holding its tab lock: the report needs that same lock.
  });
}

async function handleTabRemoved(tabId) {
  await ensureHydrated();
  try { await chrome.storage.session.remove([`popupDraft:${tabId}`, `popupSettings:${tabId}`]); } catch { /* Best effort cleanup. */ }
  await withTabLock(tabId, async () => {
    sessions.delete(tabId);
    picks.delete(tabId);
    badgeState.delete(tabId);
    clearWatchdog(tabId);
    await persistSessions();
  });
  locks.delete(tabId);
}

async function pruneMissingTabs() {
  let live = null;
  try {
    const tabs = await chrome.tabs.query({});
    live = new Set(tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)));
  } catch {
    return;
  }
  let changed = false;
  for (const tabId of Array.from(sessions.keys())) {
    if (!live.has(tabId)) {
      sessions.delete(tabId);
      picks.delete(tabId);
      locks.delete(tabId);
      badgeState.delete(tabId);
      changed = true;
    }
  }
  if (changed) await persistSessions();
}

async function handleStartup() {
  // A browser restart must not silently resume monitoring.
  sessions.clear();
  picks.clear();
  badgeState.clear();
  await persistSessions();
  await clearAllWatchdogs();
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) clearBadge(tab.id);
  } catch {
    /* ignore */
  }
}

async function handleInstalled() {
  safeCall(() => chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
  await handleStartup();
}

/* -------------------------------------------------------------------------- */
/* Message router                                                             */
/* -------------------------------------------------------------------------- */

async function handleContentMessage(msg, sender) {
  switch (msg.type) {
    case 'ABRA_REPORT':
      return handleReport(msg, sender);
    case 'ABRA_COUNTDOWN':
      return handleCountdown(msg, sender);
    case 'ABRA_INTERACTION':
      return handleInteraction(msg, sender);
    case 'ABRA_PICKED':
      return handlePicked(msg, sender);
    case 'ABRA_PICK_CANCELLED':
      return handlePickCancelled(msg, sender);
    default:
      return { ok: false, error: `Message rejected: unsupported type "${String(msg.type)}".` };
  }
}

async function handleIncoming(msg, sender) {
  await ensureHydrated();
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'Unsupported message.' };
  }
  if (msg.type.startsWith('ABRA_')) {
    if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
      return { ok: false, error: 'Message rejected: page messages must come from a tab.' };
    }
    return handleContentMessage(msg, sender);
  }

  const uiCheck = validateUiMessage(sender, msg, {
    extensionId: chrome.runtime.id,
    extensionOrigin: chrome.runtime.getURL('')
  });
  if (!uiCheck.ok) return uiCheck;

  switch (msg.type) {
    case 'START':
      return handleStart(msg);
    case 'STOP':
      return handleStop(msg);
    case 'PAUSE':
      return handlePause(msg);
    case 'RESUME':
      return handleResume(msg);
    case 'GET_STATE':
      return handleGetState(msg);
    case 'GET_ALL':
      return handleGetAll();
    case 'PICK_ELEMENT':
      return handlePickElement(msg);
    case 'TEST_WEBHOOK':
      return handleTestWebhook(msg);
    case 'ACTION_CAPABILITIES': {
      const tabId = readTabId(msg);
      const tab = tabId === null ? null : await getTabInfo(tabId);
      return getActionCapabilities(tab?.url || '');
    }
    case 'ACTION_LOG': {
      const tabId = readTabId(msg);
      if (tabId === null) return { ok: false, error: 'A tab id is required.' };
      return getActionLog(tabId);
    }
    case 'DISABLE_ACTION': {
      const tabId = readTabId(msg);
      if (tabId === null || !['webhook', 'script'].includes(msg.kind)) {
        return { ok: false, error: 'A tab and action kind are required.' };
      }
      const record = sessions.get(tabId);
      if (record?.config?.actions?.[msg.kind]) record.config.actions[msg.kind].enabled = false;
      await persistSessions();
      return { ok: true, state: publicSessionState(record || null) };
    }
    default:
      return { ok: false, error: `Message rejected: unsupported type "${msg.type}".` };
  }
}

/* -------------------------------------------------------------------------- */
/* Listeners (registered synchronously so no event is missed)                 */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleIncoming(msg, sender)
    .then((response) => sendResponse(response || { ok: false, error: 'No response.' }))
    .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAlarm(alarm).catch(() => {
    /* alarms must never throw into the event loop */
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(() => {
    /* ignore */
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  handleTabUpdated(tabId, changeInfo || {}).catch(() => {
    /* ignore */
  });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    handleStartup().catch(() => {
      /* ignore */
    });
  });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    handleInstalled().catch(() => {
      /* ignore */
    });
  });
}
