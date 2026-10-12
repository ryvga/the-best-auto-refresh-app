/* The Best Auto Refresh App — dashboard controller.
 *
 * Engine interface (fixed contract):
 *   { type: 'GET_ALL' }                            -> { ok:true, sessions: [] }
 *   { type: 'STOP' | 'PAUSE' | 'RESUME', tabId }   -> { ok:true, state } | { ok:false, error }
 *
 * Locally owned storage keys: `defaults` (one config) and `profiles` (saved configs).
 *
 * Automation (webhooks and page scripts) is configured in the popup, for the tab
 * the user is looking at. This page never edits it, but it must never erase it
 * either: the normalised `actions` of whatever was loaded is carried through
 * every save, and the dashboard shows and revokes the optional access granted.
 */

import { normalizeActions, DEFAULT_ACTIONS } from './actions-core.js';

'use strict';

(() => {
  // ---------------------------------------------------------------- constants

  const MIN_INTERVAL_SECONDS = 5;
  const MAX_INTERVAL_SECONDS = 86400;
  const MAX_SETTLE_SECONDS = 60;
  const MAX_REFRESH_LIMIT = 100000;
  const MAX_MINUTES_LIMIT = 10080;
  const MAX_KEYWORD_LENGTH = 500;
  const MAX_SELECTOR_LENGTH = 1000;
  const POLL_MS = 2000;
  const TICK_MS = 1000;
  const NOTE_TIMEOUT_MS = 9000;
  const STATUS_HOLD_MS = 4000;

  const DEFAULT_CONFIG = Object.freeze({
    intervalMode: 'fixed',
    intervalSeconds: 30,
    minSeconds: 20,
    maxSeconds: 60,
    stopCondition: 'never',
    keyword: '',
    selector: '',
    caseSensitive: false,
    wholeWord: false,
    settleSeconds: 2,
    maxRefreshes: 0,
    maxMinutes: 0,
    preserveScroll: true,
    bypassCache: false,
    pauseWhenHidden: false,
    // Off by default; the engine owns the pause itself and waits for Resume.
    pauseOnInteraction: false,
    ignoreSelector: '',
    actions: DEFAULT_ACTIONS
  });

  const STOP_CONDITION_SET = new Set([
    'never',
    'page-change',
    'element-change',
    'keyword-found',
    'keyword-missing',
    'element-found',
    'element-missing'
  ]);
  const KEYWORD_CONDITIONS = new Set(['keyword-found', 'keyword-missing']);
  const SELECTOR_CONDITIONS = new Set(['element-change', 'element-found', 'element-missing']);

  const STATUS_TEXT = {
    idle: 'Idle',
    running: 'Refreshing',
    paused: 'Paused',
    matched: 'Matched',
    stopped: 'Stopped',
    error: 'Error'
  };

  const CONDITION_TEXT = {
    'never': 'until stopped',
    'page-change': 'page text changes',
    'element-change': 'element changes',
    'keyword-found': 'keyword appears',
    'keyword-missing': 'keyword disappears',
    'element-found': 'element appears',
    'element-missing': 'element disappears'
  };

  const VALIDATED_FIELDS = [
    'interval-seconds',
    'min-seconds',
    'max-seconds',
    'settle-seconds',
    'max-refreshes',
    'max-minutes',
    'keyword',
    'selector',
    'ignore-selector'
  ];

  const PRESET_VALUES = ['10', '30', '60'];
  const PREVIEW_NOTE = 'Preview only — nothing was saved to browser storage.';

  // How many optional entries the access list will render. A generous ceiling
  // that still keeps a pathological getAll() result from flooding the page.
  const MAX_PERMISSION_ROWS = 50;

  // Profile scope metadata. `scope: 'global' | 'site' | 'page'` with `target`
  // holding the exact origin for site profiles and origin+pathname+search for
  // page profiles; global profiles keep an empty target. Profiles saved before
  // scopes existed read back as global, so nothing is lost.
  const PROFILE_SCOPE_SET = new Set(['page', 'site', 'global']);
  const PROFILE_SCOPE_NOUN = {
    page: 'this page only',
    site: 'this website',
    global: 'everywhere'
  };
  const MAX_PROFILE_NAME = 60;

  // ------------------------------------------------------------ environment

  const env = (() => {
    const hasChrome = typeof chrome !== 'undefined' && chrome !== null;
    const hasRuntime = hasChrome && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
    const extensionId = hasRuntime && typeof chrome.runtime.id === 'string' ? chrome.runtime.id : '';
    return {
      hasChrome,
      hasRuntime,
      extensionId,
      hasStorage: hasChrome && !!chrome.storage && !!chrome.storage.local,
      hasManifest: hasRuntime && typeof chrome.runtime.getManifest === 'function',
      // Optional-permission management. Absent on old builds (or in a preview
      // page), which the Automation access section explains rather than breaking.
      hasPermissions: hasChrome && !!chrome.permissions
        && typeof chrome.permissions.getAll === 'function'
        && typeof chrome.permissions.remove === 'function',
      hasPermissionEvents: hasChrome && !!chrome.permissions
        && !!chrome.permissions.onAdded && typeof chrome.permissions.onAdded.addListener === 'function',
      live: hasRuntime && extensionId !== '' && hasChrome && !!chrome.tabs && typeof chrome.tabs.query === 'function'
    };
  })();

  // -------------------------------------------------------------- dom lookup

  const ui = {};
  [
    'preview-banner', 'preview-banner-text', 'brand-icon', 'brand-fallback',
    'sessions-body', 'monitor-status', 'refresh-sessions', 'stop-all-tabs',
    'defaults-form', 'custom-panel', 'fixed-field', 'random-fields',
    'interval-seconds', 'min-seconds', 'max-seconds', 'stop-condition',
    'keyword-panel', 'keyword', 'selector-panel', 'selector',
    'settle-seconds', 'max-refreshes', 'max-minutes', 'ignore-selector',
    'case-sensitive', 'whole-word', 'preserve-scroll', 'bypass-cache',
    'pause-when-hidden', 'pause-on-interaction', 'defaults-alert', 'defaults-note', 'save-defaults',
    'reset-defaults', 'profile-name', 'save-profile', 'profiles-list',
    'profiles-note', 'profiles-alert', 'app-version',
    'refresh-permissions', 'permissions-status', 'permissions-alert', 'permissions-list'
  ].forEach((id) => { ui[id] = document.getElementById(id); });

  // ------------------------------------------------------------------ state

  let formDirty = false;
  let pollTimer = null;
  let tickTimer = null;
  let noteTimer = null;
  let statusTimer = null;
  let requestInFlight = false;
  let statusHoldUntil = 0;
  // The automation this page is carrying. It is owned by the popup, so the
  // dashboard only ever holds the normalised copy of what it loaded and writes
  // that same copy back; saving defaults here must never clear it.
  let currentActions = DEFAULT_ACTIONS;
  const rows = new Map();

  // ------------------------------------------------------------ small utils

  function el(id) { return document.getElementById(id); }

  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function clampNumber(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    if (s < 60) return `${s}s`;
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function formatWhen(timestamp) {
    if (!Number.isFinite(timestamp)) return '—';
    try {
      return new Date(timestamp).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (error) {
      return '—';
    }
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const minSeconds = clampInt(source.minSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.minSeconds);
    return {
      intervalMode: source.intervalMode === 'random' ? 'random' : 'fixed',
      intervalSeconds: clampInt(source.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.intervalSeconds),
      minSeconds,
      maxSeconds: Math.max(minSeconds, clampInt(source.maxSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.maxSeconds)),
      stopCondition: STOP_CONDITION_SET.has(source.stopCondition) ? source.stopCondition : DEFAULT_CONFIG.stopCondition,
      keyword: typeof source.keyword === 'string' ? source.keyword : '',
      selector: typeof source.selector === 'string' ? source.selector : '',
      caseSensitive: source.caseSensitive === true,
      wholeWord: source.wholeWord === true,
      settleSeconds: clampNumber(source.settleSeconds, 0, MAX_SETTLE_SECONDS, DEFAULT_CONFIG.settleSeconds),
      maxRefreshes: clampInt(source.maxRefreshes, 0, MAX_REFRESH_LIMIT, DEFAULT_CONFIG.maxRefreshes),
      maxMinutes: clampNumber(source.maxMinutes, 0, MAX_MINUTES_LIMIT, DEFAULT_CONFIG.maxMinutes),
      preserveScroll: source.preserveScroll !== false,
      bypassCache: source.bypassCache === true,
      pauseWhenHidden: source.pauseWhenHidden === true,
      pauseOnInteraction: source.pauseOnInteraction === true,
      ignoreSelector: typeof source.ignoreSelector === 'string' ? source.ignoreSelector : '',
      // Automation survives every defaults/profile round trip untouched.
      actions: normalizeActions(source.actions)
    };
  }

  /** "Includes a webhook." / "Includes a page script." for profile meta lines. */
  function profileAutomationLabel(raw) {
    const actions = normalizeActions(raw);
    const parts = [];
    if (actions.webhook.enabled) parts.push('a webhook');
    if (actions.script.enabled) parts.push('a page script');
    if (!parts.length) return '';
    return `automation: ${parts.join(' + ')}`;
  }

  function describeInterval(config) {
    return config.intervalMode === 'random'
      ? `Random ${config.minSeconds}–${config.maxSeconds}s`
      : `Fixed ${config.intervalSeconds}s`;
  }

  // -------------------------------------------------------------- messaging

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!env.live) {
        resolve({ ok: false, error: 'preview' });
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({ ok: false, error: lastError.message || 'The extension background service is not responding.' });
            return;
          }
          finish(response);
        });
      } catch (error) {
        finish({ ok: false, error: (error && error.message) || 'Could not reach the extension background service.' });
      }
    });
  }

  function unwrap(response) {
    if (!response || typeof response !== 'object') {
      return { ok: false, error: 'The extension engine sent an empty response.' };
    }
    if (response.ok === true) {
      return {
        ok: true,
        state: response.state || null,
        sessions: Array.isArray(response.sessions) ? response.sessions : []
      };
    }
    if (response.ok === false) {
      return {
        ok: false,
        error: typeof response.error === 'string' && response.error ? response.error : 'The engine reported an unknown error.'
      };
    }
    if (Array.isArray(response.sessions)) return { ok: true, state: null, sessions: response.sessions };
    if (response.state) return { ok: true, state: response.state, sessions: [] };
    return { ok: false, error: 'The extension engine sent an unrecognised response.' };
  }

  // ---------------------------------------------------------------- storage

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!env.hasStorage) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get(keys, (items) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve(items && typeof items === 'object' ? items : {});
        });
      } catch (error) {
        resolve({});
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve) => {
      if (!env.hasStorage) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set(items, () => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(!failed);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  // --------------------------------------------------------- profile scopes

  /** A parsed http(s) address, so credentials never reach stored scope text. */
  function parseHttpUrl(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { origin: url.origin, pathname: url.pathname || '/', search: url.search || '' };
    } catch (error) {
      return null;
    }
  }

  function normalizeScope(raw) {
    return PROFILE_SCOPE_SET.has(raw) ? raw : 'global';
  }

  function scopeTarget(scope, raw) {
    if (scope === 'global') return '';
    const parts = parseHttpUrl(raw);
    if (!parts) return '';
    return scope === 'site' ? parts.origin : `${parts.origin}${parts.pathname}${parts.search}`;
  }

  function normalizeProfileTarget(scope, raw) {
    if (scope === 'global') return '';
    if (typeof raw !== 'string' || raw === '') return '';
    const parts = parseHttpUrl(raw);
    if (!parts) return '';
    return scope === 'site' ? parts.origin : `${parts.origin}${parts.pathname}${parts.search}`;
  }

  /** Plain-language description of what a profile applies to. */
  function describeScope(scope, target) {
    const noun = PROFILE_SCOPE_NOUN[scope] || PROFILE_SCOPE_NOUN.global;
    if (scope === 'global' || !target) return `Applies ${noun}`;
    const parts = parseHttpUrl(target);
    const where = parts ? (scope === 'site' ? parts.origin : `${parts.origin}${parts.pathname}${parts.search}`) : target;
    return `Applies ${noun} · ${where}`;
  }

  function readProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
      .map((item, index) => {
        const scope = normalizeScope(item.scope);
        return {
          id: typeof item.id === 'string' && item.id ? item.id : `profile-${index}`,
          name: item.name.slice(0, MAX_PROFILE_NAME),
          config: normalizeConfig(item.config),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
          scope,
          target: normalizeProfileTarget(scope, item.target)
        };
      });
  }

  // --------------------------------------------------------- live regions

  function setNote(text) {
    ui['defaults-note'].textContent = text || '';
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    if (text) noteTimer = setTimeout(() => { ui['defaults-note'].textContent = ''; }, NOTE_TIMEOUT_MS);
  }

  function setProfilesNote(text) {
    ui['profiles-note'].textContent = text || '';
  }

  function setStatus(text, variant) {
    ui['monitor-status'].textContent = text || '';
    ui['monitor-status'].className = 'status-line' + (variant ? ` ${variant}` : '');
  }

  function setAlert(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  function previewOnly() {
    setStatus('Preview only — no extension engine is reachable from this page.', 'is-error');
    setNote(PREVIEW_NOTE);
  }

  // -------------------------------------------------------------- form logic

  function checkedValue(name) {
    const input = ui['defaults-form'].querySelector(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  }

  function setChecked(name, value) {
    const input = ui['defaults-form'].querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }

  function setFieldError(fieldId, message) {
    const input = el(fieldId);
    const error = el(`err-${fieldId}`);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  function clearFieldError(fieldId) {
    const input = el(fieldId);
    const error = el(`err-${fieldId}`);
    if (input) input.removeAttribute('aria-invalid');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }

  function clearAllFieldErrors() {
    VALIDATED_FIELDS.forEach(clearFieldError);
    setAlert(ui['defaults-alert'], '');
  }

  function hasVisibleFieldError() {
    return VALIDATED_FIELDS.some((fieldId) => {
      const error = el(`err-${fieldId}`);
      return error && !error.hidden;
    });
  }

  function showErrors(errors) {
    clearAllFieldErrors();
    errors.forEach(({ id, message }) => setFieldError(id, message));
    ui['defaults-alert'].textContent = errors.length === 1
      ? `Please fix one field: ${errors[0].message}`
      : `Please fix ${errors.length} fields before saving.`;
    ui['defaults-alert'].hidden = false;
    const first = el(errors[0].id);
    if (first && typeof first.focus === 'function') first.focus();
  }

  function isValidCssSelector(selector) {
    if (!selector) return true;
    try {
      document.querySelector(selector);
      return true;
    } catch (error) {
      return false;
    }
  }

  function readInteger(fieldId, min, max, message, errors) {
    const raw = el(fieldId).value.trim();
    const value = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      errors.push({ id: fieldId, message });
      return null;
    }
    return value;
  }

  function readDecimal(fieldId, min, max, message, errors) {
    const raw = el(fieldId).value.trim();
    const value = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push({ id: fieldId, message });
      return null;
    }
    return value;
  }

  function collectForm() {
    const errors = [];
    const preset = checkedValue('intervalPreset') || '30';

    let intervalMode = 'fixed';
    let intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
    let minSeconds = DEFAULT_CONFIG.minSeconds;
    let maxSeconds = DEFAULT_CONFIG.maxSeconds;

    if (preset === 'custom') {
      intervalMode = checkedValue('intervalMode') || 'fixed';
      if (intervalMode === 'random') {
        const min = readInteger('min-seconds', MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS,
          `Enter a whole number of seconds (${MIN_INTERVAL_SECONDS} or more).`, errors);
        const max = readInteger('max-seconds', MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS,
          `Enter a whole number of seconds (${MIN_INTERVAL_SECONDS} or more).`, errors);
        if (min !== null) minSeconds = min;
        if (max !== null) maxSeconds = max;
        if (min !== null && max !== null && max < min) {
          errors.push({ id: 'max-seconds', message: 'The longest wait must not be shorter than the shortest wait.' });
        }
      } else {
        const value = readInteger('interval-seconds', MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS,
          `Enter a whole number of seconds (${MIN_INTERVAL_SECONDS} or more).`, errors);
        if (value !== null) intervalSeconds = value;
      }
    } else {
      const value = readInteger('interval-seconds', MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS,
        `Enter a whole number of seconds (${MIN_INTERVAL_SECONDS} or more).`, errors);
      intervalSeconds = value === null ? Number(preset) || DEFAULT_CONFIG.intervalSeconds : value;
    }

    const settleSeconds = readDecimal('settle-seconds', 0, MAX_SETTLE_SECONDS,
      `Settle time must be between 0 and ${MAX_SETTLE_SECONDS} seconds.`, errors);
    const maxRefreshes = readInteger('max-refreshes', 0, MAX_REFRESH_LIMIT,
      'Enter 0 for unlimited, or a whole number of refreshes.', errors);
    const maxMinutes = readDecimal('max-minutes', 0, MAX_MINUTES_LIMIT,
      'Enter 0 for unlimited, or a number of minutes.', errors);

    const stopCondition = STOP_CONDITION_SET.has(ui['stop-condition'].value)
      ? ui['stop-condition'].value
      : DEFAULT_CONFIG.stopCondition;
    const keyword = ui.keyword.value.trim();
    const selector = ui.selector.value.trim();
    const ignoreSelector = ui['ignore-selector'].value.trim();

    if (KEYWORD_CONDITIONS.has(stopCondition) && keyword === '') {
      errors.push({ id: 'keyword', message: 'Type the keyword to watch for.' });
    }
    if (SELECTOR_CONDITIONS.has(stopCondition) && selector === '') {
      errors.push({ id: 'selector', message: 'Add a CSS selector. You can pick one in the popup.' });
    }
    if (selector !== '' && !isValidCssSelector(selector)) {
      errors.push({ id: 'selector', message: 'That does not look like a valid CSS selector.' });
    }
    if (ignoreSelector !== '' && !isValidCssSelector(ignoreSelector)) {
      errors.push({ id: 'ignore-selector', message: 'That does not look like a valid CSS selector.' });
    }
    if (keyword.length > MAX_KEYWORD_LENGTH) {
      errors.push({ id: 'keyword', message: `Keep the keyword under ${MAX_KEYWORD_LENGTH} characters.` });
    }
    if (selector.length > MAX_SELECTOR_LENGTH) {
      errors.push({ id: 'selector', message: `Keep the selector under ${MAX_SELECTOR_LENGTH} characters.` });
    }
    if (ignoreSelector.length > MAX_SELECTOR_LENGTH) {
      errors.push({ id: 'ignore-selector', message: `Keep the selector under ${MAX_SELECTOR_LENGTH} characters.` });
    }

    const config = normalizeConfig({
      intervalMode,
      intervalSeconds,
      minSeconds,
      maxSeconds,
      stopCondition,
      keyword,
      selector,
      caseSensitive: ui['case-sensitive'].checked,
      wholeWord: ui['whole-word'].checked,
      settleSeconds: settleSeconds === null ? DEFAULT_CONFIG.settleSeconds : settleSeconds,
      maxRefreshes: maxRefreshes === null ? DEFAULT_CONFIG.maxRefreshes : maxRefreshes,
      maxMinutes: maxMinutes === null ? DEFAULT_CONFIG.maxMinutes : maxMinutes,
      preserveScroll: ui['preserve-scroll'].checked,
      bypassCache: ui['bypass-cache'].checked,
      pauseWhenHidden: ui['pause-when-hidden'].checked,
      pauseOnInteraction: ui['pause-on-interaction'].checked,
      ignoreSelector,
      // Never edited here, but always carried: saving defaults or a profile from
      // the dashboard keeps whatever automation the popup already stored.
      actions: currentActions
    });

    return { config, errors };
  }

  function applyConfigToForm(raw) {
    const config = normalizeConfig(raw);
    currentActions = config.actions;
    const preset = config.intervalMode === 'fixed' && PRESET_VALUES.includes(String(config.intervalSeconds))
      ? String(config.intervalSeconds)
      : 'custom';

    setChecked('intervalPreset', preset);
    setChecked('intervalMode', config.intervalMode);

    el('interval-seconds').value = String(preset === 'custom' ? config.intervalSeconds : Number(preset));
    el('min-seconds').value = String(config.minSeconds);
    el('max-seconds').value = String(config.maxSeconds);
    ui['stop-condition'].value = config.stopCondition;
    ui.keyword.value = config.keyword;
    ui.selector.value = config.selector;
    ui['case-sensitive'].checked = config.caseSensitive;
    ui['whole-word'].checked = config.wholeWord;
    el('settle-seconds').value = String(config.settleSeconds);
    el('max-refreshes').value = String(config.maxRefreshes);
    el('max-minutes').value = String(config.maxMinutes);
    ui['preserve-scroll'].checked = config.preserveScroll;
    ui['bypass-cache'].checked = config.bypassCache;
    ui['pause-when-hidden'].checked = config.pauseWhenHidden;
    ui['pause-on-interaction'].checked = config.pauseOnInteraction;
    ui['ignore-selector'].value = config.ignoreSelector;

    syncConditionalPanels();
  }

  function syncConditionalPanels() {
    const isCustom = checkedValue('intervalPreset') === 'custom';
    ui['custom-panel'].hidden = !isCustom;
    if (isCustom) {
      const mode = checkedValue('intervalMode') || 'fixed';
      ui['fixed-field'].hidden = mode !== 'fixed';
      ui['random-fields'].hidden = mode !== 'random';
    }
    const condition = ui['stop-condition'].value;
    ui['keyword-panel'].hidden = !KEYWORD_CONDITIONS.has(condition);
    ui['selector-panel'].hidden = !SELECTOR_CONDITIONS.has(condition);
  }

  // ---------------------------------------------------------- monitored tabs

  function titleOf(session) {
    if (session && typeof session.title === 'string' && session.title.trim()) return session.title.trim();
    return 'Untitled tab';
  }

  function nextRefreshText(session) {
    if (!session || session.status !== 'running' || !Number.isFinite(session.nextRefreshAt)) return '—';
    const remaining = Math.max(0, Math.round((session.nextRefreshAt - Date.now()) / 1000));
    return remaining === 0 ? 'any moment' : `in ${formatDuration(remaining)}`;
  }

  function buildRow() {
    const refs = {
      session: null, tr: null, title: null, url: null, pill: null, pillNote: null,
      count: null, next: null, toggle: null, stop: null, idle: null
    };

    refs.tr = document.createElement('tr');
    refs.tabCell = makeEl('td', 'cell-tab');
    refs.tabCell.dataset.label = 'Tab';
    refs.title = makeEl('div', 'session-title');
    refs.url = makeEl('div', 'session-url');
    refs.tabCell.append(refs.title, refs.url);

    const statusCell = makeEl('td');
    statusCell.dataset.label = 'Status';
    refs.pill = makeEl('span', 'pill');
    refs.pillNote = makeEl('span', 'pill-note');
    refs.pillNote.hidden = true;
    statusCell.append(refs.pill, refs.pillNote);

    refs.count = makeEl('td', 'cell-num');
    refs.count.dataset.label = 'Refreshes';
    refs.next = makeEl('td', 'cell-num');
    refs.next.dataset.label = 'Next refresh';

    const actionsCell = makeEl('td', 'cell-actions');
    actionsCell.dataset.label = 'Actions';
    const wrap = makeEl('div', 'row-actions');
    refs.toggle = makeEl('button', 'btn btn-secondary btn-sm');
    refs.toggle.type = 'button';
    refs.stop = makeEl('button', 'btn btn-danger-quiet btn-sm', 'Stop');
    refs.stop.type = 'button';
    refs.idle = makeEl('span', 'status-line', 'Nothing to do');
    wrap.append(refs.toggle, refs.stop, refs.idle);
    actionsCell.appendChild(wrap);

    refs.toggle.addEventListener('click', () => onToggle(refs));
    refs.stop.addEventListener('click', () => onStop(refs));

    refs.tr.append(refs.tabCell, statusCell, refs.count, refs.next, actionsCell);
    return refs;
  }

  function updateRow(refs, session) {
    refs.session = session;
    const title = titleOf(session);
    const url = typeof session.url === 'string' ? session.url : '';
    const status = typeof session.status === 'string' ? session.status : 'stopped';

    refs.title.textContent = title;
    refs.url.textContent = url;
    if (url) refs.url.title = url;
    else refs.url.removeAttribute('title');

    refs.pill.dataset.status = status;
    refs.pill.textContent = STATUS_TEXT[status] || 'Idle';
    const reason = session.lastResult && typeof session.lastResult === 'object' && typeof session.lastResult.reason === 'string'
      ? session.lastResult.reason
      : '';
    const detail = typeof session.error === 'string' && session.error ? session.error : reason;
    if (detail) refs.pill.title = detail;
    else refs.pill.removeAttribute('title');

    /* Errors and matches deserve a visible line, not just a tooltip. */
    const notable = status === 'error' || status === 'matched';
    refs.pillNote.textContent = notable && detail ? detail : '';
    refs.pillNote.hidden = !(notable && detail);

    const count = Number.isFinite(session.refreshCount) ? session.refreshCount : 0;
    refs.count.textContent = String(count);
    refs.next.textContent = nextRefreshText(session);

    const canResume = status === 'running' || status === 'paused';
    refs.toggle.hidden = !canResume;
    if (canResume) {
      refs.toggle.textContent = status === 'running' ? 'Pause' : 'Resume';
      refs.toggle.setAttribute('aria-label', `${status === 'running' ? 'Pause' : 'Resume'} ${title}`);
    } else {
      refs.toggle.removeAttribute('aria-label');
    }

    const canStop = status === 'running' || status === 'paused' || status === 'matched';
    refs.stop.hidden = !canStop;
    if (canStop) refs.stop.setAttribute('aria-label', `Stop ${title}`);
    else refs.stop.removeAttribute('aria-label');

    refs.idle.hidden = canResume || canStop;
  }

  function placeholderRow(message, isError) {
    const tr = document.createElement('tr');
    const td = makeEl('td', isError ? 'cell-empty is-error' : 'cell-empty', message);
    td.colSpan = 5;
    tr.appendChild(td);
    return tr;
  }

  function renderSessions(sessions) {
    const body = ui['sessions-body'];
    const seen = new Set();

    sessions.forEach((session) => {
      if (!session || typeof session.tabId !== 'number') return;
      seen.add(session.tabId);
      let refs = rows.get(session.tabId);
      if (!refs) {
        refs = buildRow();
        rows.set(session.tabId, refs);
        body.appendChild(refs.tr);
      }
      updateRow(refs, session);
    });

    rows.forEach((refs, tabId) => {
      if (!seen.has(tabId)) {
        refs.tr.remove();
        rows.delete(tabId);
      }
    });

    const placeholder = el('sessions-placeholder');
    if (sessions.length === 0) {
      if (!placeholder) {
        const tr = placeholderRow('No tabs are being monitored right now. Start a refresh from the popup and it will appear here.', false);
        tr.id = 'sessions-placeholder';
        body.appendChild(tr);
      }
    } else if (placeholder) {
      placeholder.remove();
    }
  }

  function summarize(sessions) {
    if (!sessions.length) return 'No tabs are being monitored right now.';
    const counts = { running: 0, paused: 0, matched: 0, error: 0, other: 0 };
    sessions.forEach((session) => {
      const status = session && typeof session.status === 'string' ? session.status : 'other';
      if (status in counts) counts[status] += 1;
      else counts.other += 1;
    });
    const parts = [`${sessions.length} monitored tab${sessions.length === 1 ? '' : 's'}`];
    if (counts.running) parts.push(`${counts.running} refreshing`);
    if (counts.paused) parts.push(`${counts.paused} paused`);
    if (counts.matched) parts.push(`${counts.matched} matched`);
    if (counts.error) parts.push(`${counts.error} with errors`);
    return `${parts.join(' · ')}.`;
  }

  function announce(text, variant) {
    statusHoldUntil = Date.now() + STATUS_HOLD_MS;
    setStatus(text, variant);
  }

  async function loadSessions(options) {
    const opts = options || {};
    if (!env.live) {
      renderSessions([]);
      const placeholder = el('sessions-placeholder');
      if (placeholder) {
        const cell = placeholder.firstChild;
        if (cell) cell.textContent = 'Preview only — monitored tabs appear here once the extension is loaded in your browser.';
      }
      setStatus('Preview only — no extension engine is reachable from this page.');
      return;
    }
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const result = unwrap(await sendMessage({ type: 'GET_ALL' }));
      if (!result.ok) {
        renderSessions([]);
        const existing = el('sessions-placeholder');
        if (existing) existing.remove();
        const tr = placeholderRow(`Monitored tabs could not be loaded: ${result.error}`, true);
        tr.id = 'sessions-placeholder';
        ui['sessions-body'].appendChild(tr);
        setStatus(`Monitored tabs could not be loaded: ${result.error}`, 'is-error');
        return;
      }
      renderSessions(result.sessions);
      if (opts.announce || Date.now() >= statusHoldUntil) {
        setStatus(summarize(result.sessions), result.sessions.length ? 'is-success' : '');
      }
    } finally {
      requestInFlight = false;
    }
  }

  function tickCountdowns() {
    rows.forEach((refs) => {
      if (refs.session && refs.session.status === 'running') {
        refs.next.textContent = nextRefreshText(refs.session);
      }
    });
  }

  async function rowAction(tabId, type, label) {
    if (!env.live) { previewOnly(); return; }
    const result = unwrap(await sendMessage({ type, tabId }));
    if (!result.ok) {
      announce(`${label} failed: ${result.error}`, 'is-error');
      return;
    }
    await loadSessions({ announce: true });
    announce(`${label} complete.`, 'is-success');
  }

  function onToggle(refs) {
    if (!refs.session) return;
    const status = refs.session.status;
    const type = status === 'running' ? 'PAUSE' : 'RESUME';
    const label = status === 'running' ? 'Pause' : 'Resume';
    rowAction(refs.session.tabId, type, `${label} for “${titleOf(refs.session)}”`);
  }

  function onStop(refs) {
    if (!refs.session) return;
    rowAction(refs.session.tabId, 'STOP', `Stop for “${titleOf(refs.session)}”`);
  }

  async function stopAll() {
    if (!env.live) { previewOnly(); return; }
    ui['stop-all-tabs'].disabled = true;
    try {
      const list = unwrap(await sendMessage({ type: 'GET_ALL' }));
      if (!list.ok) {
        announce(`Could not list tabs: ${list.error}`, 'is-error');
        return;
      }
      const targets = list.sessions.filter((session) => session && typeof session.tabId === 'number' && session.status !== 'stopped');
      if (!targets.length) {
        announce('No monitored tabs needed stopping.', '');
        return;
      }
      let stopped = 0;
      for (const session of targets) {
        const result = unwrap(await sendMessage({ type: 'STOP', tabId: session.tabId }));
        if (result.ok) stopped += 1;
      }
      await loadSessions({ announce: true });
      announce(`Stopped ${stopped} of ${targets.length} monitored tab${targets.length === 1 ? '' : 's'}.`, 'is-success');
    } finally {
      ui['stop-all-tabs'].disabled = false;
    }
  }

  // --------------------------------------------------------------- profiles

  async function persistProfiles(profiles) {
    const saved = await storageSet({ profiles });
    return saved;
  }

  async function saveProfile() {
    const name = ui['profile-name'].value.trim().slice(0, MAX_PROFILE_NAME);
    const { config, errors } = collectForm();
    if (errors.length) { showErrors(errors); return; }
    if (!name) {
      setProfilesNote('');
      setAlert(ui['profiles-alert'], 'Give the profile a name first.');
      ui['profile-name'].focus();
      return;
    }
    setAlert(ui['profiles-alert'], '');
    if (!env.hasStorage) {
      setProfilesNote(PREVIEW_NOTE);
      return;
    }
    const stored = await storageGet(['profiles']);
    const profiles = readProfiles(stored.profiles);
    const nameKey = name.toLowerCase();
    // This page saves an unscoped profile. Only a global profile with the same
    // name is treated as the same entry: a scoped profile that happens to share
    // the name keeps its own settings, scope, and target untouched.
    const duplicate = profiles.find(
      (profile) => profile.scope === 'global' && profile.name.toLowerCase() === nameKey
    );
    const entry = {
      id: duplicate ? duplicate.id : `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      config,
      updatedAt: Date.now(),
      scope: 'global',
      target: ''
    };
    const next = duplicate
      ? profiles.map((profile) => (profile.id === duplicate.id ? entry : profile))
      : profiles.concat(entry);

    const saved = await persistProfiles(next);
    if (!saved) {
      setProfilesNote('That profile could not be saved.');
      return;
    }
    ui['profile-name'].value = '';
    renderProfiles(next);
    setProfilesNote(duplicate ? `Updated the profile “${name}”.` : `Saved the profile “${name}”.`);
  }

  async function deleteProfile(profile, button) {
    if (!env.hasStorage) {
      setProfilesNote(PREVIEW_NOTE);
      return;
    }
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = 'Confirm delete';
      setProfilesNote(`Press Confirm delete to remove “${profile.name}”.`);
      return;
    }
    const stored = await storageGet(['profiles']);
    const next = readProfiles(stored.profiles).filter((item) => item.id !== profile.id);
    const saved = await persistProfiles(next);
    if (!saved) {
      setProfilesNote('That profile could not be deleted.');
      return;
    }
    renderProfiles(next);
    setProfilesNote(`Deleted the profile “${profile.name}”.`);
  }

  async function useProfileAsDefault(profile) {
    if (!env.hasStorage) {
      setProfilesNote(PREVIEW_NOTE);
      return;
    }
    const saved = await storageSet({ defaults: profile.config });
    if (!saved) {
      setProfilesNote('That profile could not be applied.');
      return;
    }
    applyConfigToForm(profile.config);
    formDirty = false;
    setNote(`Defaults now use “${profile.name}”.`);
    setProfilesNote(`Defaults now use “${profile.name}”.`);
  }

  function renderProfiles(profiles) {
    const list = ui['profiles-list'];
    clearNode(list);

    if (!profiles.length) {
      const empty = makeEl('li', 'profiles-empty');
      empty.appendChild(makeEl('strong', '', 'No saved profiles yet.'));
      empty.appendChild(document.createTextNode(' Set up the form above, name it, and save it here for one-click reuse.'));
      list.appendChild(empty);
      return;
    }

    profiles.forEach((profile) => {
      const item = makeEl('li', 'profile');
      const info = makeEl('div', 'profile-info');
      info.appendChild(makeEl('span', 'profile-name', profile.name));
      const meta = [
        describeScope(profile.scope, profile.target),
        describeInterval(profile.config),
        CONDITION_TEXT[profile.config.stopCondition] || profile.config.stopCondition
      ];
      if (profile.config.keyword) meta.push(`keyword “${profile.config.keyword}”`);
      if (profile.config.selector) meta.push(`selector ${profile.config.selector}`);
      const automation = profileAutomationLabel(profile.config.actions);
      if (automation) meta.push(automation);
      if (profile.updatedAt) meta.push(`saved ${formatWhen(profile.updatedAt)}`);
      info.appendChild(makeEl('span', 'profile-meta', meta.join(' · ')));

      const actions = makeEl('div', 'profile-actions');
      const load = makeEl('button', 'btn btn-secondary btn-sm', 'Load into form');
      load.type = 'button';
      load.setAttribute('aria-label', `Load the profile ${profile.name} into the settings form`);
      load.addEventListener('click', () => {
        applyConfigToForm(profile.config);
        formDirty = false;
        setAlert(ui['defaults-alert'], '');
        setNote(`Loaded “${profile.name}” into the form. Save defaults to keep it.`);
        setProfilesNote(`Loaded “${profile.name}” into the form.`);
        ui['defaults-form'].scrollIntoView({ block: 'start' });
      });

      const useDefault = makeEl('button', 'btn btn-quiet btn-sm', 'Use as default');
      useDefault.type = 'button';
      useDefault.setAttribute('aria-label', `Use the profile ${profile.name} as the default settings`);
      useDefault.addEventListener('click', () => useProfileAsDefault(profile));

      const remove = makeEl('button', 'btn btn-danger-quiet btn-sm', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete the profile ${profile.name}`);
      remove.addEventListener('click', () => deleteProfile(profile, remove));

      actions.append(load, useDefault, remove);
      item.append(info, actions);
      list.appendChild(item);
    });
  }

  // ------------------------------------------------------ automation access

  function setPermissionsStatus(text, variant) {
    if (!ui['permissions-status']) return;
    ui['permissions-status'].textContent = text || '';
    ui['permissions-status'].className = 'status-line' + (variant ? ` ${variant}` : '');
  }

  function setPermissionsAlert(text) {
    if (!ui['permissions-alert']) return;
    ui['permissions-alert'].textContent = text || '';
    ui['permissions-alert'].hidden = !text;
  }

  function manifestHostPermissions() {
    if (!env.hasManifest) return [];
    try {
      const manifest = chrome.runtime.getManifest();
      return Array.isArray(manifest && manifest.host_permissions) ? manifest.host_permissions : [];
    } catch (error) {
      return [];
    }
  }

  function permissionsGetAll() {
    return new Promise((resolve) => {
      if (!env.hasPermissions) {
        resolve(null);
        return;
      }
      try {
        chrome.permissions.getAll((all) => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(failed ? null : (all && typeof all === 'object' ? all : null));
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function permissionsRemove(descriptor) {
    return new Promise((resolve) => {
      if (!env.hasPermissions) {
        resolve(false);
        return;
      }
      try {
        chrome.permissions.remove(descriptor, (removed) => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(!failed && removed === true);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  function permissionRow(name, meta, granted, actionLabel, onRevoke) {
    const item = makeEl('li', 'perm');
    const info = makeEl('div', 'perm-info');
    info.appendChild(makeEl('span', 'perm-name', name));
    info.appendChild(makeEl('span', 'perm-meta', meta));
    item.appendChild(info);

    item.appendChild(makeEl('span', granted ? 'perm-state is-granted' : 'perm-state', granted ? 'Granted' : 'Not granted'));

    if (granted && typeof onRevoke === 'function') {
      const actions = makeEl('div', 'perm-actions');
      const button = makeEl('button', 'btn btn-danger-quiet btn-sm', actionLabel);
      button.type = 'button';
      button.setAttribute('aria-label', `${actionLabel}: ${name}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        const removed = await onRevoke();
        button.disabled = false;
        if (!removed) {
          setPermissionsAlert('That access could not be revoked. Please try again.');
          return;
        }
        setPermissionsAlert('');
        await renderPermissions();
      });
      actions.appendChild(button);
      item.appendChild(actions);
    }
    return item;
  }

  /**
   * Lists the optional access this extension actually holds. Required host
   * permissions are left out: they belong to the extension's own tab access and
   * are not something the user granted for automation.
   */
  async function renderPermissions() {
    const list = ui['permissions-list'];
    if (!list) return;
    clearNode(list);

    if (!env.live) {
      setPermissionsStatus('Preview only — optional access cannot be read from this page.', '');
      list.appendChild(makeEl('li', 'perm-empty', 'Preview only — granted automation access appears here once the extension is loaded in your browser.'));
      return;
    }

    if (!env.hasPermissions) {
      setPermissionsStatus('This browser build does not expose chrome.permissions, so optional access cannot be listed or revoked here.', 'is-error');
      return;
    }

    setPermissionsStatus('Reading granted access…', '');
    const all = await permissionsGetAll();
    if (!all) {
      setPermissionsStatus('Granted access could not be read.', 'is-error');
      list.appendChild(makeEl('li', 'perm-empty', 'Granted access could not be read. Reload this page and try again.'));
      return;
    }

    const required = new Set(manifestHostPermissions());
    const origins = Array.isArray(all.origins)
      ? all.origins.filter((origin) => typeof origin === 'string' && !required.has(origin))
      : [];
    const hasUserScripts = Array.isArray(all.permissions) && all.permissions.indexOf('userScripts') !== -1;

    list.appendChild(permissionRow(
      'userScripts',
      'Lets an enabled JavaScript action run in an isolated world on the sites you granted. Chrome 138 and later also needs “Allow User Scripts” switched on by hand in this extension’s Details page.',
      hasUserScripts,
      'Revoke JavaScript access',
      () => permissionsRemove({ permissions: ['userScripts'] })
    ));

    origins.slice(0, MAX_PERMISSION_ROWS).forEach((origin) => {
      list.appendChild(permissionRow(
        origin,
        'Automation access for webhooks and page scripts on this hostname. Chrome ignores the port and path. Revoking this stops both kinds of hooks that use this host.',
        true,
        'Revoke hostname access',
        () => permissionsRemove({ origins: [origin] })
      ));
    });

    if (!origins.length) {
      const empty = makeEl('li', 'perm-empty');
      empty.appendChild(makeEl('strong', '', 'No automation hostnames are granted.'));
      empty.appendChild(document.createTextNode(' Connect webhook or Enable JavaScript requests one hostname.'));
      list.appendChild(empty);
    }

    const parts = [
      origins.length === 1 ? '1 granted automation hostname' : `${origins.length} granted automation hostnames`,
      hasUserScripts ? 'JavaScript access granted' : 'JavaScript access not granted'
    ];
    if (origins.length > MAX_PERMISSION_ROWS) parts.push(`showing the first ${MAX_PERMISSION_ROWS}`);
    setPermissionsStatus(`${parts.join(' · ')}.`, '');
  }

  // ----------------------------------------------------------------- events

  function wireBrandMark() {
    const image = ui['brand-icon'];
    const fallback = ui['brand-fallback'];
    if (!image || !fallback) return;
    const swap = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
    image.addEventListener('error', swap);
    if (image.complete && image.naturalWidth === 0) swap();
  }

  function wireForm() {
    ui['defaults-form'].addEventListener('submit', async (event) => {
      event.preventDefault();
      const { config, errors } = collectForm();
      if (errors.length) { showErrors(errors); return; }
      setAlert(ui['defaults-alert'], '');
      if (!env.hasStorage) { setNote(PREVIEW_NOTE); return; }
      const saved = await storageSet({ defaults: config });
      formDirty = false;
      setNote(saved ? 'Defaults saved.' : 'Defaults could not be saved.');
    });

    ui['defaults-form'].addEventListener('input', (event) => {
      formDirty = true;
      const target = event.target;
      if (target && typeof target.id === 'string' && VALIDATED_FIELDS.includes(target.id)) {
        clearFieldError(target.id);
        if (!hasVisibleFieldError()) setAlert(ui['defaults-alert'], '');
      }
    });

    ui['defaults-form'].addEventListener('change', (event) => {
      formDirty = true;
      const target = event.target;
      if (!target || !target.name) return;
      if (target.name === 'intervalPreset') {
        syncConditionalPanels();
        const preset = checkedValue('intervalPreset');
        if (preset && preset !== 'custom') el('interval-seconds').value = preset;
      }
      if (target.name === 'intervalMode') syncConditionalPanels();
    });

    ui['stop-condition'].addEventListener('change', syncConditionalPanels);

    ui['reset-defaults'].addEventListener('click', () => {
      applyConfigToForm(DEFAULT_CONFIG);
      formDirty = true;
      setAlert(ui['defaults-alert'], '');
      setNote('Built-in defaults are in the form. Choose Save defaults to keep them.');
    });

    ui['save-profile'].addEventListener('click', saveProfile);
    ui['refresh-sessions'].addEventListener('click', () => loadSessions({ announce: true }));
    ui['stop-all-tabs'].addEventListener('click', stopAll);
    ui['refresh-permissions'].addEventListener('click', () => {
      setPermissionsAlert('');
      renderPermissions();
    });

    if (env.hasPermissionEvents) {
      const onPermissionChange = () => renderPermissions();
      try {
        chrome.permissions.onAdded.addListener(onPermissionChange);
        if (chrome.permissions.onRemoved && typeof chrome.permissions.onRemoved.addListener === 'function') {
          chrome.permissions.onRemoved.addListener(onPermissionChange);
        }
      } catch (error) {
        /* No permission events here; the refresh button still works. */
      }
    }
  }

  function wireStorageSync() {
    if (!env.hasStorage || !chrome.storage.onChanged || typeof chrome.storage.onChanged.addListener !== 'function') return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.defaults) {
        const next = normalizeConfig(changes.defaults.newValue);
        if (!formDirty) {
          applyConfigToForm(next);
          setNote('Defaults were updated in another tab.');
        } else {
          setNote('Defaults changed in another tab. Save here to overwrite them.');
        }
      }
      if (changes.profiles) {
        renderProfiles(readProfiles(changes.profiles.newValue));
      }
    });
  }

  function showingPreview() {
    ui['preview-banner'].hidden = false;
    ui['preview-banner-text'].textContent = 'The extension engine is not reachable from this page, so nothing here will refresh. This is a layout preview.';
    ui['refresh-sessions'].disabled = true;
    ui['stop-all-tabs'].disabled = true;
    ui['refresh-sessions'].title = 'Preview only — needs the extension engine.';
    ui['stop-all-tabs'].title = 'Preview only — needs the extension engine.';
    ui['refresh-permissions'].disabled = true;
    ui['refresh-permissions'].title = 'Preview only — permission state cannot be read here.';
    setPermissionsStatus('Preview only — optional access cannot be read from this page.', '');
  }

  function showVersion() {
    if (!env.hasManifest) {
      ui['app-version'].textContent = 'Version information unavailable in preview.';
      return;
    }
    try {
      const manifest = chrome.runtime.getManifest();
      const version = manifest && manifest.version ? manifest.version : 'unknown';
      ui['app-version'].textContent = `Version ${version} — free and complete, with no paid tier.`;
    } catch (error) {
      ui['app-version'].textContent = 'Version information unavailable.';
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      loadSessions({});
    }, POLL_MS);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (document.hidden) return;
      tickCountdowns();
    }, TICK_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        tickCountdowns();
        loadSessions({});
      }
    });
  }

  // -------------------------------------------------------------------- init

  async function init() {
    wireBrandMark();
    wireForm();
    wireStorageSync();
    showVersion();
    syncConditionalPanels();

    if (!env.live) showingPreview();

    const stored = await storageGet(['defaults', 'profiles']);
    applyConfigToForm(stored.defaults);
    formDirty = false;
    renderProfiles(readProfiles(stored.profiles));
    await renderPermissions();

    if (!env.live) {
      await loadSessions({});
      setNote('Preview only — defaults and profiles are not saved from this page.');
      setProfilesNote('Preview only — saving is disabled because storage is unavailable.');
    } else {
      await loadSessions({ announce: true });
    }

    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
