/* The Best Auto Refresh App — popup controller.
 *
 * Engine interface (fixed contract):
 *   sendMessage({ type: 'START', tabId, config })  -> { ok:true, state } | { ok:false, error }
 *   sendMessage({ type: 'STOP' | 'PAUSE' | 'RESUME' | 'GET_STATE' | 'PICK_ELEMENT', tabId })
 *   sendMessage({ type: 'GET_ALL' })               -> { ok:true, sessions: [] }
 *
 * Everything the user types is validated here before a START message is sent;
 * the engine validates independently as well.
 */

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
  const TICK_MS = 1000;
  const NOTE_TIMEOUT_MS = 8000;

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
    ignoreSelector: ''
  });

  const STOP_CONDITIONS = Object.freeze([
    'never',
    'page-change',
    'element-change',
    'keyword-found',
    'keyword-missing',
    'element-found',
    'element-missing'
  ]);
  const STOP_CONDITION_SET = new Set(STOP_CONDITIONS);
  const KEYWORD_CONDITIONS = new Set(['keyword-found', 'keyword-missing']);
  const SELECTOR_CONDITIONS = new Set(['element-change', 'element-found', 'element-missing']);

  const STATUS_TEXT = {
    idle: 'Idle',
    running: 'Refreshing',
    paused: 'Paused',
    matched: 'Matched',
    stopped: 'Idle',
    error: 'Error',
    unavailable: 'Unavailable'
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

  // Per-tab drafts. Each tab id gets its own key in chrome.storage.session, so
  // one window's unfinished edits never leak into another tab, and drafts vanish
  // when the browser closes. Values are kept exactly as typed: raw strings,
  // radio choices, checkbox states and the Advanced disclosure state.
  const DRAFT_VERSION = 1;
  const DRAFT_KEY_PREFIX = 'popupDraft:';
  const DRAFT_TEXT_FIELDS = [
    'interval-seconds', 'min-seconds', 'max-seconds', 'settle-seconds',
    'max-refreshes', 'max-minutes', 'keyword', 'selector', 'ignore-selector'
  ];
  const DRAFT_CHECK_FIELDS = [
    'case-sensitive', 'whole-word', 'preserve-scroll', 'bypass-cache', 'pause-when-hidden'
  ];
  const DRAFT_PRESET_SET = new Set(PRESET_VALUES.concat('custom'));
  const DRAFT_MODE_SET = new Set(['fixed', 'random']);

  // ------------------------------------------------------------ environment

  const env = (() => {
    const hasChrome = typeof chrome !== 'undefined' && chrome !== null;
    const hasRuntime = hasChrome && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
    const extensionId = hasRuntime && typeof chrome.runtime.id === 'string' ? chrome.runtime.id : '';
    return {
      hasChrome,
      hasRuntime,
      extensionId,
      hasTabs: hasChrome && !!chrome.tabs && typeof chrome.tabs.query === 'function',
      hasStorage: hasChrome && !!chrome.storage && !!chrome.storage.local,
      // Trusted extension context only; drafts live and die with the browser session.
      hasSessionStorage: hasChrome && !!chrome.storage && !!chrome.storage.session
        && typeof chrome.storage.session.get === 'function'
        && typeof chrome.storage.session.set === 'function'
        && typeof chrome.storage.session.remove === 'function',
      hasTabsCreate: hasChrome && !!chrome.tabs && typeof chrome.tabs.create === 'function',
      hasOpenOptions:
        hasRuntime && typeof chrome.runtime.openOptionsPage === 'function',
      hasOptionsUrl: hasRuntime && typeof chrome.runtime.getURL === 'function',
      // Live means we can actually talk to the extension engine.
      live: hasRuntime && extensionId !== '' && hasChrome && !!chrome.tabs
    };
  })();

  // -------------------------------------------------------------- dom lookup

  const ui = {};
  const ids = [
    'preview-banner', 'preview-banner-text', 'brand-icon', 'brand-fallback',
    'tab-title', 'tab-url', 'status-pill', 'countdown', 'countdown-note',
    'refresh-count', 'last-checked', 'state-message', 'restricted-note',
    'controls', 'custom-panel', 'fixed-field', 'random-fields',
    'interval-seconds', 'min-seconds', 'max-seconds', 'stop-condition',
    'keyword-panel', 'keyword', 'selector-panel', 'selector', 'pick-element',
    'advanced', 'settle-seconds', 'max-refreshes', 'max-minutes',
    'ignore-selector', 'case-sensitive', 'whole-word', 'preserve-scroll',
    'bypass-cache', 'pause-when-hidden', 'form-alert', 'primary-action',
    'stop-action', 'footer-note', 'save-default', 'stop-all',
    'link-dashboard', 'link-help'
  ];
  ids.forEach((id) => { ui[id] = document.getElementById(id); });

  // ------------------------------------------------------------------ state

  const memoryStore = Object.create(null);
  const sessionMemoryStore = Object.create(null);
  let activeTab = null;
  let pageRestricted = false;
  let currentState = idleState();
  let lastKnownConfig = DEFAULT_CONFIG;
  let tickTimer = null;
  let noteTimer = null;
  let inFlight = false;
  let busy = false;
  // formDirty records real user input so a late draft/default render can never
  // clobber it; draftWriteChain tracks dispatched writes before a draft is cleared.
  let formDirty = false;
  let restoringForm = false;
  let draftWriteChain = Promise.resolve();

  // ------------------------------------------------------------ small utils

  function el(id) { return document.getElementById(id); }

  function clampNumber(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(value, min, max, fallback) {
    const n = clampNumber(value, min, max, fallback);
    return Math.round(n);
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    if (s < 60) return `${s}s`;
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }

  function formatClock(timestamp) {
    if (!Number.isFinite(timestamp)) return '—';
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (error) {
      return '—';
    }
  }

  function readReason(lastResult) {
    if (!lastResult) return '';
    if (typeof lastResult === 'string') return lastResult.trim();
    if (typeof lastResult !== 'object') return '';
    const candidates = [lastResult.reason, lastResult.message, lastResult.detail];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    if (typeof lastResult.condition === 'string' && lastResult.condition.trim() !== '') {
      return `your stop condition (${lastResult.condition.trim()}) was met.`;
    }
    if (typeof lastResult.matched === 'string' && lastResult.matched.trim() !== '') {
      return `“${lastResult.matched.trim()}” was found.`;
    }
    return '';
  }

  function idleState() {
    return {
      tabId: activeTab && typeof activeTab.id === 'number' ? activeTab.id : null,
      url: (activeTab && activeTab.url) || '',
      title: (activeTab && activeTab.title) || '',
      status: 'stopped',
      config: DEFAULT_CONFIG,
      refreshCount: 0,
      nextRefreshAt: null,
      startedAt: null,
      lastCheckedAt: null,
      lastResult: null,
      error: null
    };
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const intervalMode = source.intervalMode === 'random' ? 'random' : 'fixed';
    const minSeconds = clampInt(source.minSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.minSeconds);
    const maxSeconds = Math.max(
      minSeconds,
      clampInt(source.maxSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.maxSeconds)
    );
    const stopCondition = STOP_CONDITION_SET.has(source.stopCondition)
      ? source.stopCondition
      : DEFAULT_CONFIG.stopCondition;

    return {
      intervalMode,
      intervalSeconds: clampInt(source.intervalSeconds, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, DEFAULT_CONFIG.intervalSeconds),
      minSeconds,
      maxSeconds,
      stopCondition,
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
      ignoreSelector: typeof source.ignoreSelector === 'string' ? source.ignoreSelector : ''
    };
  }

  function isRestrictedUrl(url) {
    if (typeof url !== 'string' || url === '') return false;
    const lower = url.toLowerCase();
    if (/^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension|chrome-untrusted|chrome-search|data|blob|filesystem|javascript):/.test(lower)) {
      return true;
    }
    if (lower.startsWith('https://chrome.google.com/webstore')) return true;
    if (lower.startsWith('https://chromewebstore.google.com')) return true;
    return false;
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
      return { ok: true, state: response.state || null, sessions: Array.isArray(response.sessions) ? response.sessions : [] };
    }
    if (response.ok === false) {
      return { ok: false, error: typeof response.error === 'string' && response.error ? response.error : 'The engine reported an unknown error.' };
    }
    if (response.state) return { ok: true, state: response.state, sessions: [] };
    if (Array.isArray(response.sessions)) return { ok: true, state: null, sessions: response.sessions };
    return { ok: false, error: 'The extension engine sent an unrecognised response.' };
  }

  function looksLikeNoSession(message) {
    if (typeof message !== 'string') return false;
    return /no (active )?(session|monitor)|not (currently )?(monitored|running)|no state|unknown tab|nothing to stop|not found/i.test(message);
  }

  // ---------------------------------------------------------------- storage

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!env.hasStorage) {
        const result = {};
        keys.forEach((key) => { if (key in memoryStore) result[key] = memoryStore[key]; });
        resolve(result);
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
        Object.assign(memoryStore, items);
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

  function storageRemove(keys) {
    return new Promise((resolve) => {
      if (!env.hasStorage) {
        keys.forEach((key) => { delete memoryStore[key]; });
        resolve(true);
        return;
      }
      try {
        chrome.storage.local.remove(keys, () => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(!failed);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  // ------------------------------------------------------------ session drafts

  function draftKey(tabId) { return `${DRAFT_KEY_PREFIX}${tabId}`; }

  function sessionGet(keys) {
    return new Promise((resolve) => {
      if (!env.hasSessionStorage) {
        const result = {};
        keys.forEach((key) => { if (key in sessionMemoryStore) result[key] = sessionMemoryStore[key]; });
        resolve(result);
        return;
      }
      try {
        chrome.storage.session.get(keys, (items) => {
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

  function sessionSet(items) {
    return new Promise((resolve) => {
      if (!env.hasSessionStorage) {
        Object.assign(sessionMemoryStore, items);
        resolve(true);
        return;
      }
      try {
        chrome.storage.session.set(items, () => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(!failed);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  function sessionRemove(keys) {
    return new Promise((resolve) => {
      if (!env.hasSessionStorage) {
        keys.forEach((key) => { delete sessionMemoryStore[key]; });
        resolve(true);
        return;
      }
      try {
        chrome.storage.session.remove(keys, () => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(!failed);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  /** Snapshot of everything the user can change, kept raw (no trim, no clamp). */
  function readDraftFromForm() {
    const values = {};
    DRAFT_TEXT_FIELDS.forEach((fieldId) => {
      const input = el(fieldId);
      if (input) values[fieldId] = input.value;
    });
    const checks = {};
    DRAFT_CHECK_FIELDS.forEach((fieldId) => {
      const input = el(fieldId);
      if (input) checks[fieldId] = input.checked;
    });
    return {
      v: DRAFT_VERSION,
      preset: checkedValue('intervalPreset'),
      mode: checkedValue('intervalMode'),
      stopCondition: ui['stop-condition'] ? ui['stop-condition'].value : null,
      values,
      checks,
      advancedOpen: !!(ui.advanced && ui.advanced.open)
    };
  }

  /** Puts a stored draft back exactly as it was, including unfinished values. */
  function applyDraftToForm(draft) {
    if (!draft || typeof draft !== 'object') return false;
    const values = draft.values && typeof draft.values === 'object' ? draft.values : {};
    DRAFT_TEXT_FIELDS.forEach((fieldId) => {
      const input = el(fieldId);
      if (input && typeof values[fieldId] === 'string') input.value = values[fieldId];
    });

    const checks = draft.checks && typeof draft.checks === 'object' ? draft.checks : {};
    DRAFT_CHECK_FIELDS.forEach((fieldId) => {
      const input = el(fieldId);
      if (input && typeof checks[fieldId] === 'boolean') input.checked = checks[fieldId];
    });

    if (typeof draft.preset === 'string' && DRAFT_PRESET_SET.has(draft.preset)) {
      setChecked('intervalPreset', draft.preset);
    }
    if (typeof draft.mode === 'string' && DRAFT_MODE_SET.has(draft.mode)) {
      setChecked('intervalMode', draft.mode);
    }
    if (typeof draft.stopCondition === 'string' && STOP_CONDITION_SET.has(draft.stopCondition)) {
      ui['stop-condition'].value = draft.stopCondition;
    }
    if (ui.advanced) ui.advanced.open = draft.advancedOpen === true;

    syncConditionalPanels();
    return true;
  }

  /**
   * Writes the whole form for the active tab immediately. Defaults are never
   * touched here; only Start and Save as default change saved defaults.
   */
  function persistDraft() {
    if (!activeTab || typeof activeTab.id !== 'number') return Promise.resolve(false);
    const tabId = activeTab.id;
    const draft = readDraftFromForm();
    draft.tabId = tabId;
    draft.updatedAt = Date.now();
    const items = { [draftKey(tabId)]: draft };
    // Dispatch every update in its input event. Waiting for an earlier callback
    // would leave newer edits in this popup's memory when the popup is destroyed.
    const write = sessionSet(items);
    draftWriteChain = Promise.all([draftWriteChain, write]).then(() => undefined);
    return write;
  }

  /** Drops this tab's draft after a successful Start or Save as default. */
  async function clearDraft() {
    if (!activeTab || typeof activeTab.id !== 'number') return Promise.resolve(false);
    const key = draftKey(activeTab.id);
    await draftWriteChain;
    return sessionRemove([key]);
  }

  /** Restores this tab's draft, if any. Runs after defaults and activeTab resolve. */
  async function restoreDraft() {
    if (!activeTab || typeof activeTab.id !== 'number') return false;
    const key = draftKey(activeTab.id);
    const items = await sessionGet([key]);
    if (formDirty) return false;
    const draft = items[key];
    if (!draft || typeof draft !== 'object') return false;
    restoringForm = true;
    try {
      applyDraftToForm(draft);
    } finally {
      restoringForm = false;
    }
    return true;
  }

  function handleFormEdit() {
    formDirty = true;
    if (restoringForm) return;
    persistDraft();
  }

  // ------------------------------------------------------------------ render

  function setStateMessage(text, variant) {
    ui['state-message'].textContent = text;
    ui['state-message'].className = 'state-message' + (variant ? ` ${variant}` : '');
  }

  function setFooterNote(text) {
    ui['footer-note'].textContent = text || '';
    if (noteTimer) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    if (text) {
      noteTimer = setTimeout(() => {
        ui['footer-note'].textContent = '';
        noteTimer = null;
      }, NOTE_TIMEOUT_MS);
    }
  }

  function previewMessage() {
    setFooterNote('Preview only — no extension engine is reachable here.');
    setStateMessage('Preview only — nothing is refreshed and nothing is sent. Install and reload the extension to use these controls.', 'is-warn');
  }

  function watchSentence(config) {
    const selector = config.selector ? `“${config.selector}”` : 'the chosen element';
    const keyword = config.keyword ? `“${config.keyword}”` : 'the keyword';
    switch (config.stopCondition) {
      case 'page-change':
        return 'It stops when the page text changes.';
      case 'element-change':
        return `It stops when ${selector} changes.`;
      case 'keyword-found':
        return `It stops when ${keyword} appears.`;
      case 'keyword-missing':
        return `It stops when ${keyword} disappears.`;
      case 'element-found':
        return `It stops when ${selector} appears.`;
      case 'element-missing':
        return `It stops when ${selector} disappears.`;
      default:
        return 'It keeps refreshing until you stop it.';
    }
  }

  function lastReason() {
    return readReason(currentState.lastResult);
  }

  function describeState(config, status) {
    const every = config.intervalMode === 'random'
      ? `every ${config.minSeconds}–${config.maxSeconds} seconds (random)`
      : `every ${config.intervalSeconds} seconds`;
    switch (status) {
      case 'running': {
        const plan = `Refreshing ${every}. ${watchSentence(config)}`;
        const reason = lastReason();
        return reason ? `${plan} Last check: ${reason}` : plan;
      }
      case 'paused':
        return 'Paused by you. Nothing is being checked until you resume.';
      case 'matched': {
        const reason = lastReason();
        return reason
          ? `Match found, so refreshing stopped: ${reason}`
          : 'Match found, so refreshing stopped because your stop condition was met.';
      }
      case 'error': {
        const detail = typeof currentState.error === 'string' && currentState.error
          ? currentState.error
          : 'The last check did not complete.';
        return `Something went wrong: ${detail}`;
      }
      case 'stopped': {
        const reason = lastReason();
        if (reason && !/^(stopped|paused) by the user\.?$/i.test(reason)) return `Stopped: ${reason}`;
        return 'Stopped. Press Start to watch this tab again.';
      }
      default:
        return 'Not running in this tab. Choose your options, then press Start.';
    }
  }

  function updateCountdown() {
    const config = currentState.config;
    const status = currentState.status;
    if (status !== 'running' || !Number.isFinite(currentState.nextRefreshAt)) {
      ui.countdown.textContent = '—';
      ui['countdown-note'].textContent = '';
      return;
    }
    const remaining = Math.max(0, Math.round((currentState.nextRefreshAt - Date.now()) / 1000));
    ui.countdown.textContent = remaining === 0 ? 'any moment' : formatDuration(remaining);
    ui['countdown-note'].textContent = config.intervalMode === 'random' ? 'estimated, random' : 'estimated';
  }

  function renderActions(status) {
    let label = 'Start';
    if (status === 'running') label = 'Pause';
    else if (status === 'paused') label = 'Resume';

    ui['primary-action'].textContent = busy ? `${label}…` : label;
    ui['primary-action'].disabled = busy || pageRestricted;
    ui['primary-action'].setAttribute('aria-busy', busy ? 'true' : 'false');
    ui['primary-action'].title = label === 'Start'
      ? 'Start refreshing this tab'
      : label === 'Pause'
        ? 'Pause refreshing this tab'
        : 'Resume refreshing this tab';

    const showStop = !pageRestricted && (status === 'running' || status === 'paused' || status === 'matched');
    ui['stop-action'].hidden = !showStop;
    ui['stop-action'].disabled = !showStop || busy;
  }

  function renderSession() {
    const config = currentState.config;
    const status = pageRestricted ? 'unavailable' : (currentState.status || 'stopped');

    ui['status-pill'].dataset.status = status;
    ui['status-pill'].textContent = STATUS_TEXT[status] || 'Idle';

    ui['refresh-count'].textContent = String(Number.isFinite(currentState.refreshCount) ? currentState.refreshCount : 0);
    ui['last-checked'].textContent = formatClock(currentState.lastCheckedAt);
    updateCountdown();

    if (pageRestricted) {
      setStateMessage('This page cannot be refreshed by an extension. Open a normal website tab to use the app.', 'is-warn');
    } else {
      setStateMessage(describeState(config, currentState.status || 'stopped'), currentState.status === 'error'
        ? 'is-error'
        : currentState.status === 'matched'
          ? 'is-success'
          : '');
    }

    renderActions(status);
  }

  function renderEngineError(message, options) {
    const opts = options || {};
    setStateMessage(`Something went wrong: ${message}`, 'is-error');
    if (opts.pillToo) {
      ui['status-pill'].dataset.status = 'error';
      ui['status-pill'].textContent = STATUS_TEXT.error;
    }
  }

  function applyState(state) {
    const base = idleState();
    currentState = state && typeof state === 'object' ? Object.assign(base, state) : base;
    currentState.config = normalizeConfig(state && state.config ? state.config : lastKnownConfig);
    renderSession();
  }

  function renderTab() {
    if (!activeTab) {
      ui['tab-title'].textContent = env.live ? 'No accessible tab found' : 'Preview — no tab information available';
      ui['tab-url'].textContent = '';
      ui['tab-url'].removeAttribute('title');
      return;
    }
    const title = typeof activeTab.title === 'string' && activeTab.title.trim() ? activeTab.title.trim() : 'Untitled tab';
    const url = typeof activeTab.url === 'string' ? activeTab.url : '';
    ui['tab-title'].textContent = title;
    ui['tab-url'].textContent = url;
    if (url) ui['tab-url'].title = url;
    else ui['tab-url'].removeAttribute('title');
  }

  function renderRestricted() {
    if (!pageRestricted) {
      ui['restricted-note'].hidden = true;
      ui['restricted-note'].textContent = '';
      return;
    }
    ui['restricted-note'].textContent = 'Browser-internal pages, the Chrome Web Store, and other extensions cannot be refreshed.';
    ui['restricted-note'].hidden = false;
  }

  function setBusy(next) {
    busy = next;
    renderActions(pageRestricted ? 'unavailable' : (currentState.status || 'stopped'));
  }

  // ------------------------------------------------------- form validation

  function checkedValue(name) {
    const input = ui.controls.querySelector(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  }

  function setChecked(name, value) {
    const input = ui.controls.querySelector(`input[name="${name}"][value="${value}"]`);
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
    ui['form-alert'].hidden = true;
    ui['form-alert'].textContent = '';
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

    const first = el(errors[0].id);
    if (first && ui.advanced.contains(first)) ui.advanced.open = true;

    ui['form-alert'].textContent = errors.length === 1
      ? `Please fix one field: ${errors[0].message}`
      : `Please fix ${errors.length} fields before starting.`;
    ui['form-alert'].hidden = false;

    if (first && typeof first.focus === 'function') first.focus();
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

  function isValidCssSelector(selector) {
    if (!selector) return true;
    try {
      document.querySelector(selector);
      return true;
    } catch (error) {
      return false;
    }
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
      errors.push({ id: 'selector', message: 'Add a CSS selector, or use Pick element.' });
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
      ignoreSelector
    });

    return { config, errors };
  }

  function applyConfigToForm(raw) {
    const config = normalizeConfig(raw);
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
    ui['ignore-selector'].value = config.ignoreSelector;

    syncConditionalPanels();
  }

  function syncConditionalPanels() {
    const preset = checkedValue('intervalPreset');
    const isCustom = preset === 'custom';
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

  // ------------------------------------------------------------------ engine

  async function queryActiveTab() {
    if (!env.hasTabs) return null;
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async function refreshState() {
    if (!env.live || !activeTab || typeof activeTab.id !== 'number' || inFlight) return;
    inFlight = true;
    try {
      const result = unwrap(await sendMessage({ type: 'GET_STATE', tabId: activeTab.id }));
      if (!result.ok) {
        if (looksLikeNoSession(result.error)) showIdle();
        else renderEngineError(result.error);
        return;
      }
      // The engine answers { ok: true, state: null } when this tab has no session.
      if (result.state) applyState(result.state);
      else showIdle();
    } finally {
      inFlight = false;
    }
  }

  /**
   * No session for this tab: fall back to the idle display. renderSession() then
   * picks the right wording, including the restricted-page message when needed.
   */
  function showIdle() {
    applyState(null);
  }

  async function sendAction(type, confirmation) {
    if (!env.live) { previewMessage(); return; }
    if (!activeTab || typeof activeTab.id !== 'number') {
      renderEngineError('No active tab is available to control.');
      return;
    }
    setBusy(true);
    const result = unwrap(await sendMessage({ type, tabId: activeTab.id }));
    setBusy(false);
    if (!result.ok) {
      if (looksLikeNoSession(result.error)) {
        showIdle();
        setFooterNote('That session had already ended.');
        return;
      }
      renderEngineError(result.error, { pillToo: true });
      return;
    }
    if (result.state) applyState(result.state);
    else await refreshState();
    if (confirmation) setFooterNote(confirmation);
  }

  async function startSession() {
    const { config, errors } = collectForm();
    if (errors.length) {
      showErrors(errors);
      return;
    }
    ui['form-alert'].hidden = true;

    if (!env.live) {
      previewMessage();
      return;
    }
    if (pageRestricted) {
      renderSession();
      setStateMessage('This page cannot be refreshed by an extension. Open a normal website tab to use the app.', 'is-warn');
      return;
    }
    if (!activeTab || typeof activeTab.id !== 'number') {
      renderEngineError('No active tab is available to refresh.');
      return;
    }

    lastKnownConfig = config;
    setBusy(true);
    const result = unwrap(await sendMessage({ type: 'START', tabId: activeTab.id, config }));
    setBusy(false);

    if (!result.ok) {
      renderEngineError(result.error, { pillToo: true });
      return;
    }
    applyState(result.state || Object.assign(idleState(), { status: 'running', config, startedAt: Date.now() }));
    const saved = await storageSet({ defaults: config });
    await clearDraft();
    setFooterNote(saved ? 'Refreshing and saved as your default settings.' : 'Refreshing. Defaults could not be saved.');
  }

  async function stopAllTabs() {
    if (!env.live) { previewMessage(); return; }
    setBusy(true);
    const list = unwrap(await sendMessage({ type: 'GET_ALL' }));
    if (!list.ok) {
      setBusy(false);
      renderEngineError(list.error);
      return;
    }
    const targets = list.sessions.filter((session) => session && session.status && session.status !== 'stopped');
    let stopped = 0;
    for (const session of targets) {
      if (typeof session.tabId !== 'number') continue;
      const result = unwrap(await sendMessage({ type: 'STOP', tabId: session.tabId }));
      if (result.ok) stopped += 1;
    }
    setBusy(false);
    await refreshState();
    if (targets.length === 0) setFooterNote('No monitored tabs needed stopping.');
    else setFooterNote(`Stopped ${stopped} of ${targets.length} monitored tab${targets.length === 1 ? '' : 's'}.`);
  }

  async function saveDefaultsFromForm() {
    const { config, errors } = collectForm();
    if (errors.length) {
      showErrors(errors);
      return;
    }
    if (!env.hasStorage) {
      previewMessage();
      return;
    }
    const saved = await storageSet({ defaults: config });
    if (saved) await clearDraft();
    setFooterNote(saved ? 'Saved as your default settings.' : 'Defaults could not be saved.');
  }

  async function pickElement() {
    if (!env.live) { previewMessage(); return; }
    if (!activeTab || typeof activeTab.id !== 'number') {
      renderEngineError('No active tab is available for the element picker.');
      return;
    }
    if (pageRestricted) {
      setStateMessage('The element picker cannot run on this page. Open a normal website tab and try again.', 'is-warn');
      return;
    }
    // Persist the unfinished form before the picker takes over and this popup closes.
    await persistDraft();
    setBusy(true);
    const result = unwrap(await sendMessage({ type: 'PICK_ELEMENT', tabId: activeTab.id }));
    setBusy(false);
    if (!result.ok) {
      renderEngineError(result.error);
      return;
    }
    // Picking continues on the page, so the popup steps out of the way.
    window.close();
  }

  // ----------------------------------------------------------- picked element

  async function applyPickedSelector(picked, source) {
    if (!picked || typeof picked.selector !== 'string' || picked.selector.trim() === '') return false;
    if (!activeTab || picked.tabId !== activeTab.id) return false;

    // A fresh pick always wins over a restored draft or a saved default, and the
    // draft is refreshed so reopening the popup keeps showing the picked selector.
    ui.selector.value = picked.selector.trim();
    syncConditionalPanels();

    if (!SELECTOR_CONDITIONS.has(ui['stop-condition'].value)) {
      setFooterNote('Element picked. Choose a stop condition that watches an element to use it.');
    }
    // Flush the refreshed draft before the picker hands control back, and only
    // then step out of the way once the selector has landed.
    await persistDraft();
    if (source === 'change' && !document.hidden) window.close();
    return true;
  }

  /** Applies a pick and then clears it, so a stored selector is always single-use. */
  async function consumePickedSelector(picked, source) {
    const applied = await applyPickedSelector(picked, source);
    if (picked && activeTab && picked.tabId === activeTab.id) {
      await storageRemove(['pickedSelector']);
    }
    return applied;
  }

  async function consumeStoredPickedSelector() {
    if (!env.hasStorage || !activeTab || typeof activeTab.id !== 'number') return;
    const items = await storageGet(['pickedSelector']);
    const picked = items.pickedSelector;
    // Only this tab's pending pick is read, and it is consumed immediately, so a
    // stored selector can never override later edits.
    if (!picked || typeof picked !== 'object' || picked.tabId !== activeTab.id) return;
    await consumePickedSelector(picked, 'startup');
  }

  // ------------------------------------------------------------------ events

  function openOptions(hash) {
    const suffix = hash || '';
    if (env.hasOptionsUrl && suffix) {
      const url = chrome.runtime.getURL(`options.html${suffix}`);
      if (env.hasTabsCreate) {
        try {
          chrome.tabs.create({ url });
          return true;
        } catch (error) {
          /* fall through to openOptionsPage */
        }
      }
    }
    if (env.hasOpenOptions) {
      try {
        chrome.runtime.openOptionsPage();
        return true;
      } catch (error) {
        return false;
      }
    }
    return false;
  }

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

  function wireEvents() {
    ui.controls.addEventListener('submit', (event) => {
      event.preventDefault();
      if (pageRestricted) {
        renderSession();
        return;
      }
      handlePrimary();
    });

    ui.controls.addEventListener('change', (event) => {
      const target = event.target;
      if (!target || !target.name) return;
      if (target.name === 'intervalPreset' || target.name === 'intervalMode') syncConditionalPanels();
      if (target.name === 'intervalPreset') {
        const preset = checkedValue('intervalPreset');
        if (preset && preset !== 'custom') el('interval-seconds').value = preset;
      }
    });

    ui['stop-condition'].addEventListener('change', syncConditionalPanels);

    // Every keystroke, radio/checkbox change and Advanced toggle is written to
    // this tab's draft straight away. Registered after the handlers above so the
    // snapshot always reflects their side effects (for example preset timing).
    ui.controls.addEventListener('input', handleFormEdit);
    ui.controls.addEventListener('change', handleFormEdit);
    if (ui.advanced) ui.advanced.addEventListener('toggle', handleFormEdit);

    VALIDATED_FIELDS.forEach((fieldId) => {
      const input = el(fieldId);
      if (!input) return;
      input.addEventListener('input', () => {
        clearFieldError(fieldId);
        if (!hasVisibleFieldError()) {
          ui['form-alert'].hidden = true;
          ui['form-alert'].textContent = '';
        }
      });
    });

    ui['stop-action'].addEventListener('click', () => sendAction('STOP', 'Stopped.'));
    ui['pick-element'].addEventListener('click', pickElement);
    ui['save-default'].addEventListener('click', saveDefaultsFromForm);
    ui['stop-all'].addEventListener('click', stopAllTabs);

    ui['link-dashboard'].addEventListener('click', (event) => {
      if (openOptions('')) event.preventDefault();
    });
    ui['link-help'].addEventListener('click', (event) => {
      if (openOptions('#help')) event.preventDefault();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshState();
        updateCountdown();
      }
    });

    if (env.hasStorage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.pickedSelector) return;
        const picked = changes.pickedSelector.newValue;
        if (!picked) return;
        consumePickedSelector(picked, 'change');
      });
    }
  }

  function handlePrimary() {
    const status = currentState.status;
    if (env.live && status === 'running') { sendAction('PAUSE', 'Paused.'); return; }
    if (env.live && status === 'paused') { sendAction('RESUME', 'Resumed.'); return; }
    startSession();
  }

  function startTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (document.hidden) return;
      updateCountdown();
      refreshState();
    }, TICK_MS);
  }

  // -------------------------------------------------------------------- init

  async function init() {
    wireBrandMark();
    wireEvents();
    syncConditionalPanels();

    if (!env.live) {
      ui['preview-banner'].hidden = false;
      ui['preview-banner-text'].textContent = 'The extension engine is not reachable from this page, so nothing will refresh. This is a layout preview.';
      ui['pick-element'].disabled = true;
      ui['pick-element'].title = 'Preview only — the element picker needs the extension engine.';
    }

    const stored = await storageGet(['defaults']);
    lastKnownConfig = normalizeConfig(stored.defaults);
    // If the user already typed while storage was loading, their input wins.
    if (!formDirty) applyConfigToForm(lastKnownConfig);

    activeTab = await queryActiveTab();
    pageRestricted = !!(activeTab && isRestrictedUrl(activeTab.url));
    renderTab();

    ui['restricted-note'].hidden = true;
    renderRestricted();

    if (!env.live) {
      applyState(null);
      setStateMessage('Preview only — nothing is refreshed and nothing is sent. Install and reload the extension to use these controls.', 'is-warn');
    } else {
      // Restore this tab's unfinished draft after defaults and activeTab resolve.
      // A pending picked selector is consumed last so the fresh pick wins, and
      // refreshState polling below only ever repaints the session card.
      if (formDirty) await persistDraft();
      else await restoreDraft();
      await consumeStoredPickedSelector();
      await refreshState();
    }

    startTicking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
