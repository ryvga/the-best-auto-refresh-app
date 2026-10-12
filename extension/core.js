/**
 * The Best Auto Refresh App — engine core (ES module, no dependencies).
 *
 * This module holds every piece of engine logic that is pure: configuration
 * validation, text normalization, snapshot/condition evaluation, session
 * records, message validation and CSS/URL helpers. It is imported by the
 * background service worker (`type: "module"`) and by the Node test suite.
 *
 * It must stay free of `chrome.*` and DOM APIs so `node --test` can import it.
 *
 * ---------------------------------------------------------------------------
 * UI CONTRACT (owned by background.js, consumed by popup/options)
 * ---------------------------------------------------------------------------
 * Requests (chrome.runtime.sendMessage):
 *   { type: 'START', tabId, config }   { type: 'STOP', tabId }
 *   { type: 'PAUSE', tabId }           { type: 'RESUME', tabId }
 *   { type: 'GET_STATE', tabId }       { type: 'GET_ALL' }
 *   { type: 'PICK_ELEMENT', tabId }
 *   { type: 'TEST_WEBHOOK', tabId, webhook }
 * Responses:
 *   { ok: true, state } | { ok: false, error }
 *   GET_ALL -> { ok: true, sessions: [state, ...] }
 *   PICK_ELEMENT -> { ok: true, state, pickedSelector } and also mirrors
 *                   { tabId, selector } into chrome.storage.local.pickedSelector
 *   TEST_WEBHOOK -> { ok: true, message, status } (HTTP status) when a request
 *                   was delivered, otherwise { ok: false, error }. It never
 *                   requires a monitor and never changes session state.
 *
 * state = {
 *   tabId, url, title,
 *   status: 'running' | 'paused' | 'matched' | 'stopped' | 'error',
 *   config, refreshCount, nextRefreshAt, startedAt, lastCheckedAt,
 *   lastResult, error
 * }
 *
 * Timestamps (startedAt, lastCheckedAt, nextRefreshAt) are epoch milliseconds
 * (numbers) so the UI can do `new Date(value)`; null when not applicable.
 * `lastResult` is `{ met: boolean, reason: string, checkedAt: number }`.
 *
 * ---------------------------------------------------------------------------
 * TOOLBAR BADGE (owned by background.js, pure formatters live here)
 * ---------------------------------------------------------------------------
 * A running session shows ceil((nextRefreshAt - now) / 1000) seconds, as plain
 * digits up to 999, then compact minutes/hours. While the deadline is unknown
 * (loading, settling, checking, parked) it shows an ellipsis instead of a
 * misleading 0. Paused shows the pause bars, matched DONE, error ERR and
 * stopped an empty badge. The hover title always carries the exact seconds.
 *
 * The page keeps the badge moving with a lightweight ABRA_COUNTDOWN heartbeat
 * (one per second, no page content, no storage writes) so the countdown works
 * with the popup closed and does not depend on a service-worker timer.
 */

import { DEFAULT_ACTIONS, normalizeActions, validateActions } from './actions-core.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Hard floor for every user supplied interval, in seconds. */
export const MIN_INTERVAL_SECONDS = 5;
/** Chrome throttles alarms below 30s, so short waits are owned by the page. */
export const MIN_ALARM_SECONDS = 30;
/** 24 hours — beyond this a "refresh interval" is certainly a typo. */
export const MAX_INTERVAL_SECONDS = 86400;
export const MAX_SETTLE_SECONDS = 60;
export const MAX_REFRESH_LIMIT = 100000;
export const MAX_MINUTES_LIMIT = 10080;
export const MAX_KEYWORD_LENGTH = 500;
export const MAX_SELECTOR_LENGTH = 1000;
/**
 * Upper bound for a custom JavaScript stop condition. Generous enough for real
 * logic, small enough that a pasted file cannot be smuggled into the session
 * record that already travels through storage and messaging.
 */
export const MAX_PREDICATE_LENGTH = 20000;
/**
 * A custom condition runs inside the page, so it is raced against this budget.
 * A predicate that never settles must not be able to stall a refresh cycle.
 */
export const PREDICATE_TIMEOUT_MS = 3000;
/** Budget for the page text handed to the predicate as `context.text`. */
export const MAX_PREDICATE_CONTEXT_CHARS = 20000;
/** Snapshot size cap (~200k chars) to keep chrome.storage.session small. */
export const MAX_TEXT_SNAPSHOT = 200000;
/** Element picker requests expire so a forgotten picker cannot be replayed. */
export const PICK_TTL_MS = 5 * 60 * 1000;
/** Grace given to the watchdog alarm after the expected fire time. */
export const WATCHDOG_GRACE_MS = 15000;

export const INTERVAL_MODES = Object.freeze(['fixed', 'random']);
export const STOP_CONDITIONS = Object.freeze([
  'never',
  'page-change',
  'element-change',
  'keyword-found',
  'keyword-missing',
  'element-found',
  'element-missing',
  'script-predicate'
]);
export const KEYWORD_CONDITIONS = Object.freeze(['keyword-found', 'keyword-missing']);
export const SELECTOR_CONDITIONS = Object.freeze(['element-change', 'element-found', 'element-missing']);
/** Conditions whose logic lives in user-authored JavaScript. */
export const SCRIPT_CONDITIONS = Object.freeze(['script-predicate']);

export const DEFAULT_CONFIG = Object.freeze({
  intervalMode: 'fixed',
  intervalSeconds: 30,
  minSeconds: 20,
  maxSeconds: 60,
  stopCondition: 'never',
  keyword: '',
  selector: '',
  /**
   * Body of a JavaScript function used by the `script-predicate` condition. It
   * runs in the page after the settle delay and stops the session when it
   * returns a truthy value. Empty unless the user opts into that condition.
   */
  predicateScript: '',
  caseSensitive: false,
  wholeWord: false,
  settleSeconds: 2,
  maxRefreshes: 0,
  maxMinutes: 0,
  preserveScroll: true,
  bypassCache: false,
  pauseWhenHidden: false,
  // Off by default: a trusted click or keystroke in the page pauses the session
  // until the user resumes it by hand. Validated exactly like pauseWhenHidden.
  pauseOnInteraction: false,
  ignoreSelector: '',
  actions: DEFAULT_ACTIONS
});

export const UI_MESSAGE_TYPES = Object.freeze([
  'START',
  'STOP',
  'PAUSE',
  'RESUME',
  'GET_STATE',
  'GET_ALL',
  'PICK_ELEMENT',
  'ACTION_CAPABILITIES',
  'ACTION_LOG',
  'DISABLE_ACTION',
  'TEST_WEBHOOK',
  'SAVE_PROFILE',
  'DELETE_PROFILE'
]);

/** Content-script -> background message types (engine internal). */
export const CONTENT_MESSAGE_TYPES = Object.freeze([
  'ABRA_REPORT',
  'ABRA_PICKED',
  'ABRA_PICK_CANCELLED',
  'ABRA_COUNTDOWN',
  'ABRA_INTERACTION'
]);

/**
 * Badge text while a running session has no concrete deadline yet (the page is
 * loading, settling or being checked). Never render a misleading "0" there.
 */
export const BADGE_PENDING_TEXT = '…';
/** Plain seconds are shown up to this value; longer waits use compact units. */
export const BADGE_MAX_COUNTDOWN_SECONDS = 999;
/**
 * Countdown heartbeats are cheap but not free: the background ignores any that
 * arrive closer together than this. A well-behaved page sends one per second;
 * a page with duplicate timers is capped at a few updates per second.
 */
export const COUNTDOWN_MIN_GAP_MS = 250;

export const BADGE_TEXT = Object.freeze({
  running: BADGE_PENDING_TEXT,
  paused: 'II',
  matched: 'DONE',
  stopped: '',
  error: 'ERR'
});

export const BADGE_COLOR = Object.freeze({
  running: '#0f766e',
  paused: '#64748b',
  matched: '#15803d',
  stopped: '#94a3b8',
  error: '#b91c1c'
});

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Coerce to a finite number or return null. */
export function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function clamp(value, min, max) {
  const n = toFiniteNumber(value);
  if (n === null) return min;
  return Math.min(Math.max(n, min), max);
}

/** Clamp any interval-like value to the supported range. */
export function clampIntervalSeconds(value) {
  return clamp(value, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
}

/** Accepts booleans and the strings 'true'/'false'; null means "invalid". */
export function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Text normalization                                                         */
/* -------------------------------------------------------------------------- */

const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Collapse all whitespace runs into single spaces and trim. */
export function normalizeWhitespace(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize text for comparisons. Case is folded by default (matching the
 * default config); page/element change detection calls this with
 * `caseSensitive: true` so a case flip still counts as a change.
 */
export function normalizeText(value, options = {}) {
  const text = normalizeWhitespace(value);
  return options.caseSensitive === true ? text : text.toLowerCase();
}

export function truncateText(value, max = MAX_TEXT_SNAPSHOT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keyword search with optional case folding and whole-word boundaries.
 * Word characters are Unicode letters, digits and underscore.
 */
export function matchText(haystack, needle, options = {}) {
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const text = normalizeWhitespace(haystack);
  const term = normalizeWhitespace(needle);
  if (!term) return false;
  if (wholeWord) {
    const pattern = `(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`;
    const flags = caseSensitive ? 'gu' : 'giu';
    try {
      return new RegExp(pattern, flags).test(text);
    } catch {
      return false;
    }
  }
  return caseSensitive ? text.includes(term) : text.toLowerCase().includes(term.toLowerCase());
}

/**
 * Normalise the outcome of a custom JavaScript condition.
 *
 * The value is produced by the extension's own runner, never by the page, and
 * is reduced here to plain booleans and one short reason string so nothing else
 * can travel back into the comparison pipeline with it.
 */
export function normalizePredicateResult(value) {
  const source = value && typeof value === 'object' ? value : null;
  const reason = source && typeof source.reason === 'string' && source.reason !== ''
    ? source.reason.slice(0, 300)
    : '';
  if (!source || source.ran !== true) {
    return { ran: false, value: false, reason: reason || 'A custom condition is not available for this page.' };
  }
  return { ran: true, value: source.value === true, reason: null };
}

/** Build the comparable snapshot object the page sends to the background. */
export function normalizeSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  // Only strings are trusted: a page must not be able to inject numbers or
  // objects into the comparison pipeline.
  const rawText = typeof source.text === 'string' ? source.text : '';
  const rawSelectorText = typeof source.selectorText === 'string' ? source.selectorText : '';
  return {
    url: typeof source.url === 'string' ? source.url : '',
    text: truncateText(normalizeWhitespace(rawText)).text,
    selectorText: truncateText(normalizeWhitespace(rawSelectorText)).text,
    selectorExists: source.selectorExists === true,
    predicate: normalizePredicateResult(source.predicate)
  };
}

/** A baseline is only valid once it holds a real observation (never "missing"). */
export function createBaseline(snapshot, now = Date.now()) {
  const snap = normalizeSnapshot(snapshot);
  return {
    text: snap.text,
    selectorText: snap.selectorText,
    selectorExists: snap.selectorExists,
    hasText: snap.text.length > 0,
    hasSelector: snap.selectorExists === true,
    capturedAt: now
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function readNumberField(input, field, errors, { min, max, fallback, unit = '' }) {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = toFiniteNumber(raw);
  if (value === null) {
    errors.push({ field, message: `${field} must be a number.` });
    return fallback;
  }
  if (value < min || value > max) {
    errors.push({
      field,
      message: `${field} must be between ${min}${unit} and ${max}${unit}.`
    });
    return clamp(value, min, max);
  }
  return value;
}

function readIntegerField(input, field, errors, { min, max, fallback }) {
  const value = readNumberField(input, field, errors, { min, max, fallback });
  return Math.round(value);
}

function readStringField(input, field, errors, { maxLength, fallback = '' }) {
  const raw = input[field];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    errors.push({ field, message: `${field} must be text.` });
    return fallback;
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    errors.push({ field, message: `${field} must be ${maxLength} characters or fewer.` });
    return value.slice(0, maxLength);
  }
  return value;
}

function readBooleanField(input, field, errors, fallback) {
  const raw = input[field];
  if (raw === undefined || raw === null) return fallback;
  const value = coerceBoolean(raw);
  if (value === null) {
    errors.push({ field, message: `${field} must be true or false.` });
    return fallback;
  }
  return value;
}

/**
 * Validate and complete a raw config from the UI.
 * Returns `{ ok: true, config, errors: [] }` or
 *         `{ ok: false, error, errors, config }` where `config` is the closest
 *         safe interpretation (never used by the caller when `ok` is false).
 */
export function validateConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const config = { ...DEFAULT_CONFIG };

  if (input.intervalMode === undefined || input.intervalMode === null) {
    config.intervalMode = DEFAULT_CONFIG.intervalMode;
  } else if (INTERVAL_MODES.includes(input.intervalMode)) {
    config.intervalMode = input.intervalMode;
  } else {
    errors.push({ field: 'intervalMode', message: "intervalMode must be 'fixed' or 'random'." });
  }

  config.intervalSeconds = readNumberField(input, 'intervalSeconds', errors, {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
    fallback: DEFAULT_CONFIG.intervalSeconds,
    unit: 's'
  });
  config.minSeconds = readNumberField(input, 'minSeconds', errors, {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
    fallback: DEFAULT_CONFIG.minSeconds,
    unit: 's'
  });
  config.maxSeconds = readNumberField(input, 'maxSeconds', errors, {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
    fallback: DEFAULT_CONFIG.maxSeconds,
    unit: 's'
  });
  if (config.maxSeconds < config.minSeconds) {
    errors.push({
      field: 'maxSeconds',
      message: 'maxSeconds must be greater than or equal to minSeconds.'
    });
  }

  if (input.stopCondition === undefined || input.stopCondition === null) {
    config.stopCondition = DEFAULT_CONFIG.stopCondition;
  } else if (STOP_CONDITIONS.includes(input.stopCondition)) {
    config.stopCondition = input.stopCondition;
  } else {
    errors.push({
      field: 'stopCondition',
      message: `stopCondition must be one of: ${STOP_CONDITIONS.join(', ')}.`
    });
  }

  config.keyword = readStringField(input, 'keyword', errors, {
    maxLength: MAX_KEYWORD_LENGTH,
    fallback: DEFAULT_CONFIG.keyword
  });
  config.selector = readStringField(input, 'selector', errors, {
    maxLength: MAX_SELECTOR_LENGTH,
    fallback: DEFAULT_CONFIG.selector
  });
  config.ignoreSelector = readStringField(input, 'ignoreSelector', errors, {
    maxLength: MAX_SELECTOR_LENGTH,
    fallback: DEFAULT_CONFIG.ignoreSelector
  });
  config.predicateScript = readStringField(input, 'predicateScript', errors, {
    maxLength: MAX_PREDICATE_LENGTH,
    fallback: DEFAULT_CONFIG.predicateScript
  });

  config.caseSensitive = readBooleanField(input, 'caseSensitive', errors, DEFAULT_CONFIG.caseSensitive);
  config.wholeWord = readBooleanField(input, 'wholeWord', errors, DEFAULT_CONFIG.wholeWord);
  config.preserveScroll = readBooleanField(input, 'preserveScroll', errors, DEFAULT_CONFIG.preserveScroll);
  config.bypassCache = readBooleanField(input, 'bypassCache', errors, DEFAULT_CONFIG.bypassCache);
  config.pauseWhenHidden = readBooleanField(input, 'pauseWhenHidden', errors, DEFAULT_CONFIG.pauseWhenHidden);
  config.pauseOnInteraction = readBooleanField(input, 'pauseOnInteraction', errors, DEFAULT_CONFIG.pauseOnInteraction);

  config.settleSeconds = readNumberField(input, 'settleSeconds', errors, {
    min: 0,
    max: MAX_SETTLE_SECONDS,
    fallback: DEFAULT_CONFIG.settleSeconds,
    unit: 's'
  });
  config.maxRefreshes = readIntegerField(input, 'maxRefreshes', errors, {
    min: 0,
    max: MAX_REFRESH_LIMIT,
    fallback: DEFAULT_CONFIG.maxRefreshes
  });
  config.maxMinutes = readNumberField(input, 'maxMinutes', errors, {
    min: 0,
    max: MAX_MINUTES_LIMIT,
    fallback: DEFAULT_CONFIG.maxMinutes,
    unit: 'm'
  });

  if (KEYWORD_CONDITIONS.includes(config.stopCondition) && config.keyword === '') {
    errors.push({
      field: 'keyword',
      message: 'A keyword is required for keyword stop conditions.'
    });
  }
  if (SELECTOR_CONDITIONS.includes(config.stopCondition) && config.selector === '') {
    errors.push({
      field: 'selector',
      message: 'A CSS selector is required for element stop conditions.'
    });
  }
  if (SCRIPT_CONDITIONS.includes(config.stopCondition) && config.predicateScript === '') {
    errors.push({
      field: 'predicateScript',
      message: 'A JavaScript condition is required for the custom stop condition.'
    });
  }
  if (config.selector !== '' && !looksLikeValidSelector(config.selector)) {
    errors.push({ field: 'selector', message: 'The selector looks incomplete.' });
  }
  if (config.ignoreSelector !== '' && !looksLikeValidSelector(config.ignoreSelector)) {
    errors.push({ field: 'ignoreSelector', message: 'The ignored selector looks incomplete.' });
  }

  const actionValidation = validateActions(input.actions);
  config.actions = actionValidation.actions;
  errors.push(...actionValidation.errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      config,
      error: errors.map((entry) => entry.message).join(' ')
    };
  }
  return { ok: true, config, errors: [] };
}

/** Default config merged with any partial overrides (no validation). */
export function withDefaults(partial) {
  const source = partial && typeof partial === 'object' ? partial : {};
  return { ...DEFAULT_CONFIG, ...source, actions: normalizeActions(source.actions) };
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/** Choose the next interval in seconds; `random` is injectable for tests. */
export function pickIntervalSeconds(config, random = Math.random) {
  const cfg = withDefaults(config);
  if (cfg.intervalMode !== 'random') {
    return clampIntervalSeconds(cfg.intervalSeconds);
  }
  const min = clampIntervalSeconds(cfg.minSeconds);
  const max = Math.max(min, clampIntervalSeconds(cfg.maxSeconds));
  const raw = typeof random === 'function' ? toFiniteNumber(random()) : toFiniteNumber(random);
  const unit = raw === null ? 0 : Math.min(Math.max(raw, 0), 0.999999999);
  return min + Math.floor(unit * (max - min + 1));
}

/** Chrome cannot promise alarms faster than 30s; those waits belong to the page. */
export function usesPageTimer(delayMs) {
  const delay = toFiniteNumber(delayMs) ?? 0;
  return delay < MIN_ALARM_SECONDS * 1000;
}

/** Interval in milliseconds for the next cycle (>= 1s, random when configured). */
export function intervalMsFor(config, random = Math.random) {
  return Math.max(1000, Math.round(pickIntervalSeconds(config, random) * 1000));
}

/**
 * A reload may fire as soon as its due time is within this window, which keeps
 * page timers and watchdog alarms from disagreeing by a few milliseconds.
 */
export const RELOAD_EARLY_TOLERANCE_MS = 1000;

/** Watchdog alarm delay: never sooner than the alarm floor, 15s of slack after. */
export function watchdogDelayMs(delayMs) {
  const delay = Math.max(0, toFiniteNumber(delayMs) ?? 0);
  return Math.max(MIN_ALARM_SECONDS * 1000, delay + WATCHDOG_GRACE_MS);
}

export function alarmNameForTab(tabId) {
  return `abra-watchdog:${tabId}`;
}

export function tabIdFromAlarmName(name) {
  const match = /^abra-watchdog:(\d+)$/.exec(String(name ?? ''));
  return match ? Number(match[1]) : null;
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

function conditionResult(status, reason, baseline, keywordFound) {
  return { status, reason, baseline, keywordFound };
}

/**
 * Evaluate the configured stop condition.
 *
 * `current` is a snapshot: `{ text, selectorText, selectorExists, url }`.
 * `baseline` is a previously stored baseline (or null).
 *
 * Returns `{ status: 'baseline' | 'matched' | 'continue', reason, baseline,
 * keywordFound }`. `baseline` is the value the caller must persist.
 *
 * Rules worth remembering:
 *  - A missing selector never becomes a baseline; the baseline is captured on
 *    the first check where the element exists.
 *  - Keyword conditions with a configured `selector` are scoped to that
 *    element and cannot match while the scope element is absent.
 */
export function evaluateCondition({ baseline = null, current, config, now = Date.now() }) {
  const cfg = withDefaults(config);
  const snap = normalizeSnapshot(current);
  const base = baseline && typeof baseline === 'object' ? baseline : null;
  const condition = cfg.stopCondition;
  const keywordOptions = {
    caseSensitive: cfg.caseSensitive === true,
    wholeWord: cfg.wholeWord === true
  };
  const scopeConfigured = cfg.selector !== '';
  const scopedText = scopeConfigured ? (snap.selectorExists ? snap.selectorText : null) : snap.text;
  const keywordFound = scopedText === null ? false : matchText(scopedText, cfg.keyword, keywordOptions);

  switch (condition) {
    case 'never':
      return conditionResult(
        'continue',
        'Refreshing until you stop it or a limit is reached.',
        base ?? createBaseline(snap, now),
        keywordFound
      );

    case 'page-change': {
      const stored = base && base.hasText === true ? base : null;
      if (!stored) {
        if (snap.text.length === 0) {
          return conditionResult(
            'baseline',
            'No visible page text yet; waiting before capturing a baseline.',
            null,
            keywordFound
          );
        }
        return conditionResult(
          'baseline',
          'Baseline captured. Watching page text for changes.',
          createBaseline(snap, now),
          keywordFound
        );
      }
      if (snap.text !== stored.text) {
        return conditionResult('matched', 'Page text changed since the baseline.', stored, keywordFound);
      }
      return conditionResult('continue', 'Page text is unchanged since the baseline.', stored, keywordFound);
    }

    case 'element-change': {
      const stored = base && base.hasSelector === true && base.selectorExists === true ? base : null;
      if (!stored) {
        if (!snap.selectorExists) {
          return conditionResult(
            'baseline',
            'Selector does not match yet; no baseline is captured until the element exists.',
            null,
            keywordFound
          );
        }
        return conditionResult(
          'baseline',
          'Element baseline captured. Watching it for changes.',
          createBaseline(snap, now),
          keywordFound
        );
      }
      if (!snap.selectorExists) {
        return conditionResult('matched', 'The watched element disappeared.', stored, keywordFound);
      }
      if (snap.selectorText !== stored.selectorText) {
        return conditionResult('matched', 'The watched element changed since the baseline.', stored, keywordFound);
      }
      return conditionResult('continue', 'The watched element is unchanged since the baseline.', stored, keywordFound);
    }

    case 'keyword-found': {
      if (scopeConfigured && !snap.selectorExists) {
        return conditionResult(
          'continue',
          `Keyword "${cfg.keyword}" cannot be confirmed while the scope selector does not match.`,
          base,
          keywordFound
        );
      }
      if (keywordFound) {
        return conditionResult('matched', `Keyword "${cfg.keyword}" was found.`, base, keywordFound);
      }
      return conditionResult('continue', `Keyword "${cfg.keyword}" is not present yet.`, base, keywordFound);
    }

    case 'keyword-missing': {
      if (scopeConfigured && !snap.selectorExists) {
        return conditionResult(
          'continue',
          'Scope selector does not match; waiting before treating the keyword as missing.',
          base,
          keywordFound
        );
      }
      if (!keywordFound) {
        return conditionResult('matched', `Keyword "${cfg.keyword}" is no longer present.`, base, keywordFound);
      }
      return conditionResult('continue', `Keyword "${cfg.keyword}" is still present.`, base, keywordFound);
    }

    case 'element-found': {
      if (snap.selectorExists) {
        return conditionResult('matched', 'An element matching the selector appeared.', base, keywordFound);
      }
      return conditionResult('continue', 'No element matching the selector yet.', base, keywordFound);
    }

    case 'element-missing': {
      if (!snap.selectorExists) {
        return conditionResult('matched', 'The element matching the selector is gone.', base, keywordFound);
      }
      return conditionResult('continue', 'The element matching the selector is still present.', base, keywordFound);
    }

    case 'script-predicate': {
      // The predicate itself ran in the page before this planner was called.
      // Anything short of a clean `true` continues: a predicate that throws, is
      // blocked by permissions, or never settles must not end a session by
      // accident, which is exactly the flaky-content case this condition exists
      // to handle.
      const script = snap.predicate;
      if (script.ran !== true) {
        return conditionResult('continue', script.reason, base, keywordFound);
      }
      if (script.value === true) {
        return conditionResult('matched', 'Your custom condition returned true.', base, keywordFound);
      }
      return conditionResult(
        'continue',
        script.reason || 'Your custom condition returned false.',
        base,
        keywordFound
      );
    }

    default:
      return conditionResult(
        'baseline',
        `Unknown stop condition "${condition}" was ignored.`,
        base,
        keywordFound
      );
  }
}

/**
 * Check user limits *after* a check decided to continue. Limits are a normal
 * end of work, so the session stops rather than errors.
 */
export function evaluateLimits(record, now = Date.now()) {
  const cfg = withDefaults(record && record.config);
  const refreshCount = toFiniteNumber(record && record.refreshCount) ?? 0;
  if (cfg.maxRefreshes > 0 && refreshCount >= cfg.maxRefreshes) {
    return {
      stopped: true,
      status: 'stopped',
      reason: `Reached the maximum of ${cfg.maxRefreshes} refresh${cfg.maxRefreshes === 1 ? '' : 'es'}.`
    };
  }
  const startedAt = toFiniteNumber(record && record.startedAt);
  if (cfg.maxMinutes > 0 && startedAt !== null && now - startedAt >= cfg.maxMinutes * 60000) {
    return {
      stopped: true,
      status: 'stopped',
      reason: `Reached the maximum duration of ${cfg.maxMinutes} minute${cfg.maxMinutes === 1 ? '' : 's'}.`
    };
  }
  return { stopped: false };
}

/* -------------------------------------------------------------------------- */
/* Cycle planning                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pure cycle planner: given a session record and a page snapshot, decide what
 * the engine must do next. background.js maps the result onto chrome APIs;
 * tests exercise the timing model here directly.
 *
 * `nextRefreshAt` is when the next reload is due. A cycle either waits for that
 * moment (kind 'wait'), reloads (kind 'reload') or ends the session
 * ('matched' | 'stopped' | 'error'). A brand new session never reloads on its
 * first check: the first cycle only captures a baseline and arms the interval.
 *
 * Returns:
 *   { kind, reason, baseline, lastResult, nextRefreshAt, refreshCount, delayMs }
 */
export function planCycle({ record, snapshot, now = Date.now(), random = Math.random }) {
  const config = withDefaults(record && record.config);
  const baselineIn = record && record.baseline && typeof record.baseline === 'object' ? record.baseline : null;
  const refreshCount = toFiniteNumber(record && record.refreshCount) || 0;
  const current = snapshot && typeof snapshot === 'object' ? snapshot : {};

  if (typeof current.selectorError === 'string' && current.selectorError !== '') {
    const reason = `The selector "${config.selector}" could not be used on this page: ${current.selectorError}`;
    return {
      kind: 'error',
      reason,
      baseline: baselineIn,
      lastResult: { met: false, reason, checkedAt: now },
      nextRefreshAt: null,
      refreshCount,
      delayMs: 0
    };
  }

  const result = evaluateCondition({ baseline: baselineIn, current, config, now });
  const baseline = result.baseline || baselineIn;
  const lastResult = { met: result.status === 'matched', reason: result.reason, checkedAt: now };

  if (result.status === 'matched') {
    return {
      kind: 'matched',
      reason: result.reason,
      baseline,
      lastResult,
      nextRefreshAt: null,
      refreshCount,
      delayMs: 0
    };
  }

  const limits = evaluateLimits({ config, refreshCount, startedAt: record ? record.startedAt : now }, now);
  if (limits.stopped) {
    return {
      kind: 'stopped',
      reason: limits.reason,
      baseline,
      lastResult: { met: false, reason: limits.reason, checkedAt: now },
      nextRefreshAt: null,
      refreshCount,
      delayMs: 0
    };
  }

  const due = toFiniteNumber(record && record.nextRefreshAt);
  if (due === null) {
    const nextRefreshAt = now + intervalMsFor(config, random);
    return {
      kind: 'wait',
      reason: result.reason,
      baseline,
      lastResult,
      nextRefreshAt,
      refreshCount,
      delayMs: nextRefreshAt - now
    };
  }

  if (now + RELOAD_EARLY_TOLERANCE_MS < due) {
    return {
      kind: 'wait',
      reason: result.reason,
      baseline,
      lastResult,
      nextRefreshAt: due,
      refreshCount,
      delayMs: Math.max(0, due - now)
    };
  }

  const nextRefreshAt = now + intervalMsFor(config, random);
  return {
    kind: 'reload',
    reason: result.reason,
    baseline,
    lastResult,
    nextRefreshAt,
    refreshCount: refreshCount + 1,
    delayMs: 0
  };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export function createSessionToken(randomValues) {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  let bytes;
  if (randomValues && typeof randomValues === 'function') {
    bytes = randomValues(16);
  } else if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    bytes = cryptoObj.getRandomValues(new Uint8Array(16));
  } else {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] + 0x100).toString(16).slice(1);
  }
  return out;
}

export function createSessionRecord({ tabId, token, config, now = Date.now() }) {
  return {
    tabId,
    token: token || createSessionToken(),
    generation: 1,
    url: '',
    title: '',
    origin: '',
    status: 'running',
    config: withDefaults(config),
    refreshCount: 0,
    nextRefreshAt: null,
    scheduledFor: null,
    startedAt: now,
    lastCheckedAt: null,
    lastResult: null,
    error: null,
    baseline: null,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Advance the identity of a session. Every in-flight message from the previous
 * generation becomes invalid the moment this is called, which is what makes
 * START/Pause/Resume/Stop race-free.
 */
export function bumpGeneration(record, now = Date.now()) {
  if (!record) return record;
  record.generation = (toFiniteNumber(record.generation) ?? 0) + 1;
  record.updatedAt = now;
  return record;
}

/** Project a record onto the exact UI contract shape (no secrets leaked). */
export function publicSessionState(record) {
  if (!record) return null;
  return {
    tabId: record.tabId,
    url: record.url || '',
    title: record.title || '',
    status: record.status,
    config: { ...withDefaults(record.config) },
    refreshCount: toFiniteNumber(record.refreshCount) ?? 0,
    nextRefreshAt: toFiniteNumber(record.nextRefreshAt),
    startedAt: toFiniteNumber(record.startedAt),
    lastCheckedAt: toFiniteNumber(record.lastCheckedAt),
    lastResult: record.lastResult
      ? {
          met: record.lastResult.met === true,
          reason: String(record.lastResult.reason ?? ''),
          checkedAt: toFiniteNumber(record.lastResult.checkedAt)
        }
      : null,
    error: record.error ? String(record.error) : null
  };
}

export function badgeTextFor(status) {
  return Object.prototype.hasOwnProperty.call(BADGE_TEXT, status) ? BADGE_TEXT[status] : '';
}

export function badgeColorFor(status) {
  return Object.prototype.hasOwnProperty.call(BADGE_COLOR, status) ? BADGE_COLOR[status] : BADGE_COLOR.stopped;
}

/**
 * Remaining whole seconds until `nextRefreshAt`, rounded up so the toolbar
 * never shows a smaller number than the real wait. Null when no deadline is
 * known (the session is loading, settling, checking or parked).
 */
export function countdownSecondsUntil(nextRefreshAt, now = Date.now()) {
  const due = toFiniteNumber(nextRefreshAt);
  if (due === null) return null;
  const nowMs = toFiniteNumber(now);
  if (nowMs === null) return null;
  return Math.ceil((due - nowMs) / 1000);
}

/**
 * Compact badge text for a whole number of seconds. A badge fits roughly four
 * characters, so waits of 1000s and beyond switch to minutes and hours.
 */
export function compactCountdownText(totalSeconds) {
  const raw = toFiniteNumber(totalSeconds);
  const seconds = Math.floor(Math.max(0, raw === null ? 0 : raw));
  if (seconds <= BADGE_MAX_COUNTDOWN_SECONDS) return String(seconds);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Toolbar text for a running session: exact seconds, a compact minute/hour
 * value for long waits, or the pending ellipsis when no deadline is known.
 */
export function badgeCountdownText(nextRefreshAt, now = Date.now()) {
  const seconds = countdownSecondsUntil(nextRefreshAt, now);
  if (seconds === null) return BADGE_PENDING_TEXT;
  return compactCountdownText(seconds);
}

/** Toolbar text for a whole session record (non-running statuses come from BADGE_TEXT). */
export function sessionBadgeText(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return '';
  if (record.status === 'running') return badgeCountdownText(record.nextRefreshAt, now);
  return badgeTextFor(record.status);
}

/** True while a session should be receiving ticks and holding an alarm. */
export function isSessionActive(record) {
  return Boolean(record) && record.status === 'running';
}

/* -------------------------------------------------------------------------- */
/* Message validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Validate a message coming from a page content script.
 * Both the transport sender and the payload identity must agree, so a stale
 * page, a forged tab id, an old generation or a replayed token are all refused.
 */
export function validateContentMessage(record, sender, msg) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    return { ok: false, error: 'Message rejected: sender is not a monitored tab.' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Message rejected: malformed payload.' };
  }
  if (!CONTENT_MESSAGE_TYPES.includes(msg.type)) {
    return { ok: false, error: `Message rejected: unsupported type "${String(msg.type)}".` };
  }
  if (!record) {
    return { ok: false, error: 'Message rejected: no active session for this tab.' };
  }
  if (sender.tab.id !== record.tabId || Number(msg.tabId) !== record.tabId) {
    return { ok: false, error: 'Message rejected: sender does not match the session tab.' };
  }
  if (typeof msg.token !== 'string' || msg.token === '' || msg.token !== record.token) {
    return { ok: false, error: 'Message rejected: session token mismatch.' };
  }
  if (toFiniteNumber(msg.generation) !== (toFiniteNumber(record.generation) ?? 0)) {
    return { ok: false, error: 'Message rejected: stale session generation.' };
  }
  if (record.status !== 'running' && record.status !== 'paused') {
    return { ok: false, error: 'Message rejected: the session is no longer running.' };
  }
  return { ok: true };
}

/** Validate a message from the popup or options page. */
export function validateUiMessage(sender, msg, context = {}) {
  const extensionId = context.extensionId || '';
  const extensionOrigin = context.extensionOrigin || '';
  if (!sender || typeof sender !== 'object') {
    return { ok: false, error: 'Message rejected: missing sender.' };
  }
  if (extensionId && sender.id !== extensionId) {
    return { ok: false, error: 'Message rejected: unknown sender.' };
  }
  const senderUrl = typeof sender.url === 'string' ? sender.url : '';
  if (!extensionOrigin || !senderUrl.startsWith(extensionOrigin)) {
    return { ok: false, error: 'Message rejected: only the extension UI can control monitoring.' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Message rejected: malformed payload.' };
  }
  if (!UI_MESSAGE_TYPES.includes(msg.type)) {
    return { ok: false, error: `Message rejected: unsupported type "${String(msg.type)}".` };
  }
  return { ok: true };
}

/**
 * Picker messages are authorized by a short-lived one-time token instead of a
 * monitoring session, because the user may pick an element before starting.
 */
export function validatePickMessage(pending, record, sender, msg, now = Date.now()) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    return { ok: false, error: 'Message rejected: sender is not a tab.' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'Message rejected: malformed picker payload.' };
  }
  if (msg.type !== 'ABRA_PICKED' && msg.type !== 'ABRA_PICK_CANCELLED') {
    return { ok: false, error: `Message rejected: unsupported picker type "${String(msg.type)}".` };
  }
  if (!pending) {
    return { ok: false, error: 'Message rejected: no element picker is active for this tab.' };
  }
  if (pending.tabId !== sender.tab.id || Number(msg.tabId) !== sender.tab.id) {
    return { ok: false, error: 'Message rejected: sender does not match the picker request.' };
  }
  if (toFiniteNumber(pending.expiresAt) !== null && (toFiniteNumber(pending.expiresAt) ?? 0) <= now) {
    return { ok: false, error: 'Message rejected: the element picker request expired.' };
  }
  if (typeof msg.pickToken !== 'string' || msg.pickToken === '' || msg.pickToken !== pending.token) {
    return { ok: false, error: 'Message rejected: picker token mismatch.' };
  }
  if (record) {
    if (msg.token !== record.token) {
      return { ok: false, error: 'Message rejected: session token mismatch.' };
    }
    if (toFiniteNumber(msg.generation) !== (toFiniteNumber(record.generation) ?? 0)) {
      return { ok: false, error: 'Message rejected: stale session generation.' };
    }
  }
  return { ok: true };
}

/** Decode a tick report arriving for a running session; guards double timers. */
export function shouldAcceptTick(record, now = Date.now(), toleranceMs = 1000) {
  if (!isSessionActive(record)) {
    return { ok: false, error: 'Message rejected: the session is not running.' };
  }
  const scheduledFor = toFiniteNumber(record.scheduledFor);
  if (scheduledFor !== null && now < scheduledFor - toleranceMs) {
    return { ok: false, error: 'Message rejected: the check arrived before it was scheduled.' };
  }
  return { ok: true };
}

/**
 * Validate a per-second countdown heartbeat from the monitored page.
 *
 * This is deliberately narrower than `validateContentMessage`: the sender must
 * be the top frame (frame 0) of the session tab, and the token, generation and
 * page origin must all still agree. The message carries no page content, only
 * refreshes the toolbar badge, and never moves the schedule.
 */
export function validateCountdownMessage(record, sender, msg) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    return { ok: false, error: 'Message rejected: sender is not a monitored tab.' };
  }
  if (sender.frameId !== 0) {
    return { ok: false, error: 'Message rejected: the countdown must come from the top frame.' };
  }
  if (!msg || typeof msg !== 'object' || msg.type !== 'ABRA_COUNTDOWN') {
    return { ok: false, error: 'Message rejected: malformed countdown payload.' };
  }
  if (!record) {
    return { ok: false, error: 'Message rejected: no active session for this tab.' };
  }
  if (sender.tab.id !== record.tabId || Number(msg.tabId) !== record.tabId) {
    return { ok: false, error: 'Message rejected: sender does not match the session tab.' };
  }
  if (typeof msg.token !== 'string' || msg.token === '' || msg.token !== record.token) {
    return { ok: false, error: 'Message rejected: session token mismatch.' };
  }
  if (toFiniteNumber(msg.generation) !== (toFiniteNumber(record.generation) ?? 0)) {
    return { ok: false, error: 'Message rejected: stale session generation.' };
  }
  const senderOrigin =
    typeof sender.origin === 'string' && sender.origin !== '' ? sender.origin : originOf(sender.url);
  if (record.origin && senderOrigin !== record.origin) {
    return { ok: false, error: 'Message rejected: the page origin changed.' };
  }
  if (record.status !== 'running' && record.status !== 'paused') {
    return { ok: false, error: 'Message rejected: the session is no longer running.' };
  }
  return { ok: true };
}

/** Rate gate for countdown heartbeats: true when one may be handled now. */
export function shouldAcceptCountdown(lastAcceptedAt, now = Date.now(), minGapMs = COUNTDOWN_MIN_GAP_MS) {
  const last = toFiniteNumber(lastAcceptedAt);
  if (last === null) return true;
  const nowMs = toFiniteNumber(now);
  if (nowMs === null) return false;
  const gap = toFiniteNumber(minGapMs);
  return nowMs - last >= (gap === null ? COUNTDOWN_MIN_GAP_MS : gap);
}

/* -------------------------------------------------------------------------- */
/* Interaction pausing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Input types that are controls rather than text fields: typing does not apply
 * to them, but Enter/Space activates them like a click.
 */
export const NON_TEXT_INPUT_TYPES = Object.freeze([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
]);

const NON_TEXT_INPUT_SET = new Set(NON_TEXT_INPUT_TYPES);

const INTERACTION_CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab'
]);

/**
 * Local-only gesture classification. This object is never reported; the page
 * sends only session identity and a trusted-gesture flag:
 *   { kind: 'pointer' | 'key' | 'input', tagName?, inputType?,
 *     isContentEditable?, role?, hasHref?, key? }
 */
function interactionInfo(info) {
  return info && typeof info === 'object' ? info : {};
}

/** True when the interaction target is somewhere the user types text. */
export function isEditableInteractionTarget(info) {
  const source = interactionInfo(info);
  if (source.isContentEditable === true) return true;
  const tag = typeof source.tagName === 'string' ? source.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof source.inputType === 'string' && source.inputType.trim() !== ''
    ? source.inputType.trim().toLowerCase()
    : 'text';
  return !NON_TEXT_INPUT_SET.has(type);
}

/** True when Enter/Space on the target activates a link, button or control. */
export function isInteractionControl(info) {
  const source = interactionInfo(info);
  const tag = typeof source.tagName === 'string' ? source.tagName.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'SUMMARY') return true;
  if (tag === 'A') return source.hasHref === true;
  if (tag === 'INPUT') return !isEditableInteractionTarget(source);
  const role = typeof source.role === 'string' ? source.role.toLowerCase() : '';
  return INTERACTION_CONTROL_ROLES.has(role);
}

/**
 * Decide whether an already-trusted gesture is meaningful enough to pause a
 * running session: any primary pointer press, typing/input inside an editable
 * field or contenteditable, and Enter/Space on a control.
 *
 * Synthetic events are filtered by the caller (`event.isTrusted`), the picker
 * gestures are filtered by the caller too, and an unknown kind never matches.
 */
export function isMeaningfulInteraction(info) {
  const source = interactionInfo(info);
  if (!['pointer', 'key', 'input'].includes(source.kind)) return false;
  if (source.kind === 'pointer') return true;
  if (isEditableInteractionTarget(source)) return true;
  if (source.kind === 'input') return false;
  if (source.kind === 'key') {
    const key = typeof source.key === 'string' ? source.key : '';
    return (key === 'Enter' || key === ' ' || key === 'Spacebar') && isInteractionControl(source);
  }
  return false;
}

/**
 * Fields that must never appear in an interaction report. The message is
 * identity only: if it carries event, key, text or page data it is refused
 * instead of being stored or forwarded anywhere.
 */
const INTERACTION_DATA_FIELDS = Object.freeze([
  'data',
  'key',
  'selector',
  'target',
  'text',
  'title',
  'url',
  'value'
]);

/**
 * Validate the pause-on-interaction request sent by the monitored top frame.
 *
 * It is deliberately narrow, like `validateCountdownMessage`: the sender must
 * be the top frame (frame 0) of the session tab, the token, generation and page
 * origin must all still agree, the session must be running, pause-on-interaction
 * must be enabled in the session config, and the payload must declare a real
 * (non-synthetic) gesture and carry no data fields.
 *
 * The frame id, document id and origin used by the background come from the
 * browser's `sender`, never from the page payload, so a stale or foreign
 * document can never pause the replacement session.
 */
export function validateInteractionMessage(record, sender, msg) {
  if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) {
    return { ok: false, error: 'Message rejected: sender is not a monitored tab.' };
  }
  if (sender.frameId !== 0) {
    return { ok: false, error: 'Message rejected: the interaction must come from the top frame.' };
  }
  if (!msg || typeof msg !== 'object' || msg.type !== 'ABRA_INTERACTION') {
    return { ok: false, error: 'Message rejected: malformed interaction payload.' };
  }
  if (msg.trusted !== true) {
    return { ok: false, error: 'Message rejected: only a real user interaction can pause.' };
  }
  for (const field of INTERACTION_DATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(msg, field)) {
      return { ok: false, error: 'Message rejected: interaction reports carry identity only.' };
    }
  }
  if (!record) {
    return { ok: false, error: 'Message rejected: no active session for this tab.' };
  }
  if (!record.config || record.config.pauseOnInteraction !== true) {
    return { ok: false, error: 'Message rejected: pause on interaction is off for this session.' };
  }
  if (record.documentId && sender.documentId !== record.documentId) {
    return { ok: false, error: 'Message rejected: this is not the monitored document.' };
  }
  if (sender.tab.id !== record.tabId || Number(msg.tabId) !== record.tabId) {
    return { ok: false, error: 'Message rejected: sender does not match the session tab.' };
  }
  if (typeof msg.token !== 'string' || msg.token === '' || msg.token !== record.token) {
    return { ok: false, error: 'Message rejected: session token mismatch.' };
  }
  if (toFiniteNumber(msg.generation) !== (toFiniteNumber(record.generation) ?? 0)) {
    return { ok: false, error: 'Message rejected: stale session generation.' };
  }
  const senderOrigin =
    typeof sender.origin === 'string' && sender.origin !== '' ? sender.origin : originOf(sender.url);
  if (record.origin && senderOrigin !== record.origin) {
    return { ok: false, error: 'Message rejected: the page origin changed.' };
  }
  if (record.status !== 'running') {
    return { ok: false, error: 'Message rejected: the session is no longer running.' };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* CSS selector helpers (picker)                                              */
/* -------------------------------------------------------------------------- */

/** CSS.escape-compatible identifier escaping. */
export function escapeCssIdentifier(value) {
  const str = String(value ?? '');
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.codePointAt(i);
    const char = String.fromCodePoint(code);
    if (code > 0xffff) i += 1;
    if (code === 0) {
      out += '\uFFFD';
      continue;
    }
    const isControl = (code >= 0x01 && code <= 0x1f) || code === 0x7f;
    const isDigit = code >= 0x30 && code <= 0x39;
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isSafePunct = code === 0x2d || code === 0x5f;
    const isNonAscii = code >= 0x80;
    if (isControl) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && isDigit) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 1 && isDigit && str.charCodeAt(0) === 0x2d) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (isLetter || isDigit || isSafePunct || isNonAscii) {
      out += char;
      continue;
    }
    out += `\\${char}`;
  }
  return out;
}

/** Escaping for the inside of a double-quoted attribute value. */
export function escapeCssString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
}

export function attributeSelector(name, value) {
  return `[${escapeCssIdentifier(name)}="${escapeCssString(value)}"]`;
}

/** Join picker selectors from the outermost ancestor down to the target. */
export function buildSelectorFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => String(part ?? '').trim())
    .filter((part) => part !== '')
    .join(' > ');
}

/**
 * Cheap structural sanity check for user supplied selectors. It cannot prove a
 * selector is valid (only the page's own CSS engine can) but it rejects the
 * obvious typos and rule-injection attempts before we store anything.
 */
export function looksLikeValidSelector(selector) {
  if (typeof selector !== 'string') return false;
  const value = selector.trim();
  if (value === '') return false;
  if (/[{};]/.test(value)) return false;
  let depthSquare = 0;
  let depthRound = 0;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') depthSquare += 1;
    else if (char === ']') depthSquare -= 1;
    else if (char === '(') depthRound += 1;
    else if (char === ')') depthRound -= 1;
    if (depthSquare < 0 || depthRound < 0) return false;
  }
  return quote === '' && depthSquare === 0 && depthRound === 0;
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

const RESTRICTED_SCHEMES = new Set([
  'chrome:',
  'chrome-search:',
  'chrome-untrusted:',
  'chrome-extension:',
  'edge:',
  'edge-extension:',
  'about:',
  'devtools:',
  'view-source:',
  'data:',
  'blob:',
  'filesystem:',
  'javascript:',
  'brave:',
  'opera:',
  'vivaldi:',
  'moz-extension:'
]);

const WEBSTORE_HOSTS = new Map([
  ['chrome.google.com', '/webstore'],
  ['chromewebstore.google.com', '/']
]);

/**
 * Returns null when the target can be monitored, otherwise a human readable
 * reason. Monitoring is limited to normal HTTP and HTTPS websites.
 */
export function describeRestrictedTarget(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return 'The tab does not have a web address yet.';
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'This address cannot be monitored.';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const prefix = WEBSTORE_HOSTS.get(parsed.hostname);
    if (prefix !== undefined && (prefix === '/' || parsed.pathname === prefix || parsed.pathname.startsWith(prefix + '/'))) {
      return 'Chrome Web Store pages cannot be monitored by extensions.';
    }
    return null;
  }
  if (parsed.protocol === 'file:') return 'Local files cannot be monitored. Open an HTTP or HTTPS website.';
  if (RESTRICTED_SCHEMES.has(parsed.protocol)) {
    return `Browser and extension pages (${parsed.protocol}) cannot be monitored.`;
  }
  return `The ${parsed.protocol} scheme is not supported.`;
}

export function isRestrictedUrl(url) {
  return describeRestrictedTarget(url) !== null;
}

/** Compare two URLs by origin (used to end cross-origin monitoring). */
export function sameOrigin(a, b) {
  try {
    const first = new URL(a).origin;
    const second = new URL(b).origin;
    return first !== 'null' && second !== 'null' && first === second;
  } catch {
    return false;
  }
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
