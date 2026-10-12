/* The Best Auto Refresh App — popup controller.
 *
 * Engine interface (fixed contract):
 *   sendMessage({ type: 'START', tabId, config })  -> { ok:true, state } | { ok:false, error }
 *   sendMessage({ type: 'STOP' | 'PAUSE' | 'RESUME' | 'GET_STATE' | 'PICK_ELEMENT', tabId })
 *   sendMessage({ type: 'GET_ALL' })               -> { ok:true, sessions: [] }
 *   sendMessage({ type: 'ACTION_CAPABILITIES', tabId }) -> { ok:true, scriptAvailable, ... }
 *   sendMessage({ type: 'ACTION_LOG', tabId })     -> { ok:true, entries: [] }
 *
 * Everything the user types is validated here before a START message is sent;
 * the engine validates independently as well.
 *
 * Automation (webhooks and page scripts) shares its schema with the engine
 * through ./actions-core.js. This page never evaluates user code and never
 * requests a permission on its own: the two Connect/Enable buttons are the only
 * places that call chrome.permissions.request, and they do so inside the click.
 */

import {
  normalizeActions,
  validateActions,
  DEFAULT_ACTIONS,
  permissionOriginForUrl
} from './actions-core.js';

import { NTFY_DEFAULT_SERVER, describeNtfySetup } from './ntfy.js';

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

  // Automation: activity polling only ever runs while the log disclosure is
  // really open and the popup is visible, so a closed popup costs nothing.
  const ACTIVITY_POLL_MS = 2000;
  const URL_STATUS_DEBOUNCE_MS = 300;
  const MAX_CODE_LENGTH = 20000;

  // Display order and plain-language labels for the shared event list. The keys
  // match ACTION_EVENTS in actions-core.js; the labels are what the user reads.
  const ACTION_EVENT_LABELS = Object.freeze([
    ['start', 'start'],
    ['before-refresh', 'before refresh'],
    ['after-refresh', 'after refresh'],
    ['check', 'page checked'],
    ['match', 'condition matched'],
    ['limit', 'limit reached'],
    ['manual-stop', 'manually stopped'],
    ['error', 'error'],
    ['pause', 'paused'],
    ['resume', 'resumed']
  ]);
  const ACTION_EVENT_KEYS = ACTION_EVENT_LABELS.map(([key]) => key);

  // The example is plain text placed in the textarea; it is never evaluated here.
  const SCRIPT_EXAMPLE = [
    "/* Example: highlight the page when a chosen event fires.",
    " * `event` is a snapshot object passed to your code.",
    " * Fields: type, refreshCount, status, timestamp,",
    " *         and url/title/reason/keyword/selector when page details are on.",
    " */",
    "if (event.type === 'match' || event.type === 'after-refresh') {",
    "  var box = document.createElement('div');",
    "  box.textContent = 'Refresh event: ' + event.type + ' (#' + event.refreshCount + ')';",
    "  box.style.cssText = 'position:fixed;z-index:2147483647;top:12px;left:12px;padding:8px 12px;' +",
    "    'border-radius:8px;background:#102a2d;color:#32d5b0;font:600 13px system-ui,sans-serif';",
    "  document.body.appendChild(box);",
    "  setTimeout(function () { box.remove(); }, 6000);",
    "}"
  ].join('\n');

  const DEFAULT_CONFIG = Object.freeze({
    intervalMode: 'fixed',
    intervalSeconds: 30,
    minSeconds: 20,
    maxSeconds: 60,
    stopCondition: 'never',
    keyword: '',
    selector: '',
    /** Body of the user's JavaScript condition for the `script-predicate` stop. */
    predicateScript: '',
    caseSensitive: false,
    wholeWord: false,
    settleSeconds: 2,
    maxRefreshes: 0,
    maxMinutes: 0,
    preserveScroll: true,
    bypassCache: false,
    pauseWhenHidden: false,
    // Off by default. The engine pauses the run on a trusted click or keystroke
    // in the page and waits for an explicit Resume; the popup only carries it.
    pauseOnInteraction: false,
    ignoreSelector: '',
    actions: DEFAULT_ACTIONS
  });

  const STOP_CONDITIONS = Object.freeze([
    'never',
    'page-change',
    'element-change',
    'keyword-found',
    'keyword-missing',
    'element-found',
    'element-missing',
    'script-predicate'
  ]);
  const STOP_CONDITION_SET = new Set(STOP_CONDITIONS);
  const KEYWORD_CONDITIONS = new Set(['keyword-found', 'keyword-missing']);
  const SELECTOR_CONDITIONS = new Set(['element-change', 'element-found', 'element-missing']);
  const SCRIPT_CONDITIONS = new Set(['script-predicate']);
  const MAX_PREDICATE_LENGTH = 20000;

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
    'predicate-script',
    'ignore-selector',
    // Automation errors are reported through the same field machinery. Each id
    // below has a matching #err-<id> node in the Automation disclosure.
    'automation-webhook-url',
    'automation-webhook-events',
    'automation-webhook-headers',
    'automation-webhook-body',
    // The ntfy quick-setup pair reports its own inline errors; these ids have a
    // matching #err-<id> node and never block Start, because they are only a
    // generator for the webhook fields above.
    'ntfy-server',
    'ntfy-topic',
    'automation-script-code',
    'automation-script-events',
    'automation'
  ];

  const PRESET_VALUES = ['10', '30', '60'];

  // Per-tab drafts. Each tab id gets its own key in chrome.storage.session, so
  // one window's unfinished edits never leak into another tab, and drafts vanish
  // when the browser closes. Values are kept exactly as typed: raw strings,
  // radio choices, checkbox states, the Advanced disclosure state, and the raw
  // automation fields (invalid JSON included) with their event selections.
  const DRAFT_VERSION = 3;
  const DRAFT_KEY_PREFIX = 'popupDraft:';
  const DRAFT_TEXT_FIELDS = [
    'interval-seconds', 'min-seconds', 'max-seconds', 'settle-seconds',
    'max-refreshes', 'max-minutes', 'keyword', 'selector', 'ignore-selector',
    // The custom condition is raw user code: a half-typed predicate comes back
    // exactly as it was left, whitespace and all.
    'predicate-script',
    // Raw ntfy quick-setup text: a half-typed topic or server comes back exactly
    // as it was left, invalid characters included. These are draft-only fields;
    // they are never part of the stored settings schema.
    'ntfy-server', 'ntfy-topic'
  ];
  const DRAFT_CHECK_FIELDS = [
    'case-sensitive', 'whole-word', 'preserve-scroll', 'bypass-cache', 'pause-when-hidden',
    'pause-on-interaction'
  ];
  const DRAFT_PRESET_SET = new Set(PRESET_VALUES.concat('custom'));
  const DRAFT_MODE_SET = new Set(['fixed', 'random']);

  // Saved profiles. Entries are { id, name, config, updatedAt, scope, target }:
  //   scope  'global' | 'site' | 'page'  (legacy entries without a scope become
  //          'global', so older saved profiles keep working everywhere)
  //   target '' for global, the exact origin for site, origin+pathname+search
  //          for page. Fragments are dropped, and a URL's username/password is
  //          never copied into stored scope metadata.
  const PROFILE_SCOPE_SET = new Set(['page', 'site', 'global']);
  const PROFILE_SCOPE_NOUN = {
    page: 'this page only',
    site: 'this website',
    global: 'everywhere'
  };
  const MAX_PROFILES = 200;
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
      // Optional-permission APIs. On an old build, or before the manifest
      // declares optional permissions, these are simply absent: the automation
      // card explains that instead of breaking.
      hasPermissions: hasChrome && !!chrome.permissions
        && typeof chrome.permissions.contains === 'function'
        && typeof chrome.permissions.request === 'function'
        && typeof chrome.permissions.getAll === 'function',
      hasPermissionEvents: hasChrome && !!chrome.permissions
        && !!chrome.permissions.onAdded && typeof chrome.permissions.onAdded.addListener === 'function',
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
    'predicate-panel', 'predicate-script', 'predicate-access',
    'advanced', 'settle-seconds', 'max-refreshes', 'max-minutes',
    'ignore-selector', 'case-sensitive', 'whole-word', 'preserve-scroll',
    'bypass-cache', 'pause-when-hidden', 'pause-on-interaction', 'form-alert', 'primary-action',
    'stop-action', 'footer-note', 'save-default', 'stop-all',
    'link-dashboard', 'link-help',
    'profile-card', 'profile-select-field', 'profile-select', 'profile-hint',
    'profile-matched', 'profile-save', 'profile-save-form', 'profile-name',
    'profile-scope', 'hint-profile-scope', 'err-profile-name',
    'profile-save-alert', 'profile-save-action',
    'automation', 'automation-summary-hint',
    'automation-webhook', 'automation-webhook-enabled', 'automation-webhook-status',
    'automation-webhook-fields', 'automation-webhook-url', 'automation-webhook-method',
    'automation-webhook-connect', 'automation-webhook-connection', 'automation-webhook-events',
    'automation-webhook-headers', 'automation-webhook-body', 'automation-webhook-details',
    'automation-webhook-test', 'automation-webhook-test-status',
    'ntfy-setup', 'ntfy-status', 'ntfy-server', 'ntfy-topic', 'ntfy-use', 'ntfy-note',
    'automation-script', 'automation-script-enabled', 'automation-script-status',
    'automation-script-fields', 'automation-script-code', 'automation-script-count',
    'automation-script-example', 'automation-script-enable', 'automation-script-permission',
    'automation-script-events',
    'automation-activity', 'automation-activity-refresh', 'automation-activity-list',
    'automation-manage-access'
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
  let initializing = true;
  // formDirty records real user input so a late draft/default render can never
  // clobber it; draftWriteChain tracks dispatched writes before a draft is cleared.
  let formDirty = false;
  let formRevision = 0;
  let restoringForm = false;
  let draftWriteChain = Promise.resolve();
  // Saved profiles and the honest "which profile is loaded" line. currentProfile
  // is only set when a profile was actually applied to the form, never when an
  // unfinished per-tab draft was restored.
  let savedProfiles = [];
  let currentProfile = null;
  let profileBusy = false;
  // Automation status: one coalesced refresh per turn, plus a debounced URL
  // re-check, and an activity timer that only exists while the log is open.
  let automationStatusTimer = null;
  let automationUrlTimer = null;
  let activityTimer = null;
  let activityBusy = false;
  let lastFailedAt = 0;

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
      pauseOnInteraction: source.pauseOnInteraction === true,
      ignoreSelector: typeof source.ignoreSelector === 'string' ? source.ignoreSelector : '',
      // The shared schema normaliser keeps automation on every round trip:
      // defaults, drafts, profiles and the engine's own state.
      actions: normalizeActions(source.actions)
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

  // --------------------------------------------------------- profile scopes

  /**
   * Scope targets are derived from the parsed URL, never from the raw string,
   * so credentials embedded in a URL can never reach storage and fragments are
   * always dropped: site = origin, page = origin + pathname + search.
   */
  function parseHttpUrl(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return {
        origin: url.origin,
        pathname: url.pathname || '/',
        search: url.search || ''
      };
    } catch (error) {
      return null;
    }
  }

  function scopeTarget(scope, raw) {
    const parts = parseHttpUrl(raw);
    if (!parts) return '';
    if (scope === 'site') return parts.origin;
    if (scope === 'page') return `${parts.origin}${parts.pathname}${parts.search}`;
    return '';
  }

  function targetForScope(scope) {
    return scopeTarget(scope, activeTab && activeTab.url);
  }

  function scopeLabel(scope, target) {
    const noun = PROFILE_SCOPE_NOUN[scope] || PROFILE_SCOPE_NOUN.global;
    if (scope === 'global' || !target) return noun;
    const parts = parseHttpUrl(target);
    const where = parts ? (scope === 'site' ? parts.origin : `${parts.origin}${parts.pathname}${parts.search}`) : target;
    return `${noun} · ${where}`;
  }

  function normalizeScope(raw) {
    return PROFILE_SCOPE_SET.has(raw) ? raw : 'global';
  }

  function normalizeProfileTarget(scope, raw) {
    if (scope === 'global') return '';
    if (typeof raw !== 'string' || raw === '') return '';
    const parts = parseHttpUrl(raw);
    if (!parts) return '';
    return scope === 'site' ? parts.origin : `${parts.origin}${parts.pathname}${parts.search}`;
  }

  /** Reads the stored array defensively; legacy entries default to global. */
  function readProfileList(raw) {
    if (!Array.isArray(raw)) return [];
    const profiles = [];
    raw.forEach((item, index) => {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || item.name.trim() === '') return;
      const scope = normalizeScope(item.scope);
      profiles.push({
        id: typeof item.id === 'string' && item.id ? item.id : `profile-${index}`,
        name: item.name.trim().slice(0, MAX_PROFILE_NAME),
        config: normalizeConfig(item.config),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
        scope,
        target: normalizeProfileTarget(scope, item.target)
      });
    });
    return profiles;
  }

  function groupForProfile(profile, pageTarget, siteTarget) {
    if (profile.scope === 'page') return profile.target && pageTarget && profile.target === pageTarget ? 'page' : 'other';
    if (profile.scope === 'site') return profile.target && siteTarget && profile.target === siteTarget ? 'site' : 'other';
    return 'global';
  }

  function byMostRecent(a, b) {
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  }

  /**
   * Auto-match order on a first open with no draft: exact page, then exact
   * site origin, then saved defaults. Global profiles are manually selected.
   * Exact origin matching only — a suffix
   * such as evil-example.com must never match example.com. Ties and multiples
   * resolve to the most recently updated profile.
   */
  function matchProfileForTab() {
    const pageTarget = targetForScope('page');
    const siteTarget = targetForScope('site');
    const groups = { page: [], site: [], global: [] };
    savedProfiles.forEach((profile) => {
      const group = groupForProfile(profile, pageTarget, siteTarget);
      if (group !== 'other') groups[group].push(profile);
    });
    return (
      groups.page.slice().sort(byMostRecent)[0]
      || groups.site.slice().sort(byMostRecent)[0]
      || null
    );
  }

  /** Option values are data, not CSS selectors; keep the complete unique id. */
  function optionValue(profile) {
    return profile.id;
  }

  function findProfileByOptionValue(value) {
    return savedProfiles.find((profile) => optionValue(profile) === value) || null;
  }

  function newProfileId() {
    return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // ------------------------------------------------------------- profile UI

  function setProfileHint(node, profile) {
    if (!node) return;
    if (!profile || !PROFILE_SCOPE_SET.has(profile.scope)) {
      node.textContent = '';
      node.hidden = true;
      node.removeAttribute('title');
      return;
    }
    const noun = PROFILE_SCOPE_NOUN[profile.scope];
    const where = profile.scope === 'global'
      ? `“${profile.name}” applies ${noun}.`
      : `“${profile.name}” is saved for ${scopeLabel(profile.scope, profile.target)}.`;
    const automation = profileAutomationLabel(profile.config && profile.config.actions);
    node.textContent = automation ? `${where} ${automation}` : where;
    node.hidden = false;
    node.removeAttribute('title');
  }

  function updateScopeHint() {
    if (!ui['hint-profile-scope']) return;
    const scope = ui['profile-scope'] ? ui['profile-scope'].value : 'global';
    if (scope === 'global') {
      ui['hint-profile-scope'].textContent = 'Everywhere: any tab you open, whichever site it is on.';
      return;
    }
    const target = targetForScope(scope);
    if (!target) {
      ui['hint-profile-scope'].textContent = 'This tab has no web address, so only Everywhere can be saved from here.';
      return;
    }
    ui['hint-profile-scope'].textContent = `${scopeLabel(scope, target)} — matching uses the whole address, so look-alike sites are not affected.`;
  }

  /** Greys out scoped choices when this tab has no usable web address. */
  function syncScopeOptions() {
    const select = ui['profile-scope'];
    if (!select) return;
    const usable = !pageRestricted && !!targetForScope('site');
    for (const option of select.options) {
      if (option.value === 'global') continue;
      option.disabled = !usable;
    }
    if (!usable && select.value !== 'global') select.value = 'global';
    updateScopeHint();
  }

  function setProfileSelectPlaceholder(text) {
    const select = ui['profile-select'];
    if (!select || select.options.length === 0) return;
    select.options[0].textContent = text;
  }

  /** Rebuilds the grouped option list. Never changes the form or the draft. */
  function renderProfileSelect() {
    const select = ui['profile-select'];
    if (!select) return;
    const previous = select.value;
    const pageTarget = targetForScope('page');
    const siteTarget = targetForScope('site');
    const groups = { page: [], site: [], global: [], other: [] };

    savedProfiles.forEach((profile) => {
      groups[groupForProfile(profile, pageTarget, siteTarget)].push(profile);
    });

    while (select.children.length > 1) select.lastElementChild.remove();

    const headings = [
      ['page', 'This page'],
      ['site', 'This website'],
      ['global', 'Everywhere'],
      ['other', 'Other scopes']
    ];
    headings.forEach(([key, label]) => {
      const list = groups[key].slice().sort(byMostRecent);
      if (!list.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      list.forEach((profile) => group.appendChild(profileOption(profile)));
      select.appendChild(group);
    });

    const hasOptions = select.options.length > 1;
    select.disabled = !hasOptions || profileBusy;
    ui['profile-select-field'].hidden = !hasOptions;

    if (previous && findProfileByOptionValue(previous)) select.value = previous;
    else select.value = '';
  }

  function profileOption(profile) {
    const option = document.createElement('option');
    option.value = optionValue(profile);
    option.textContent = profile.name;
    option.dataset.scope = profile.scope;
    option.dataset.target = profile.target;
    option.dataset.name = profile.name;
    return option;
  }

  function renderProfilesNote() {
    if (!ui['profile-hint']) return;
    if (!savedProfiles.length) {
      ui['profile-hint'].textContent = 'Save this setup for a page, a website, or anywhere.';
      return;
    }
    ui['profile-hint'].textContent = '';
  }

  function clearProfileAlert() {
    if (!ui['profile-save-alert']) return;
    ui['profile-save-alert'].hidden = true;
    ui['profile-save-alert'].textContent = '';
    if (ui['profile-name']) ui['profile-name'].removeAttribute('aria-invalid');
    if (ui['err-profile-name']) {
      ui['err-profile-name'].hidden = true;
      ui['err-profile-name'].textContent = '';
    }
  }

  function showProfileAlert(message) {
    if (ui['err-profile-name']) {
      ui['err-profile-name'].textContent = message;
      ui['err-profile-name'].hidden = false;
    }
    if (ui['profile-name']) ui['profile-name'].setAttribute('aria-invalid', 'true');
    if (ui['profile-save-alert']) {
      ui['profile-save-alert'].textContent = message;
      ui['profile-save-alert'].hidden = false;
    }
  }

  function setProfileBusy(next) {
    profileBusy = next;
    if (ui['profile-select']) ui['profile-select'].disabled = next || ui['profile-select'].options.length <= 1;
    if (ui['profile-save-action']) {
      ui['profile-save-action'].disabled = next;
      ui['profile-save-action'].setAttribute('aria-busy', next ? 'true' : 'false');
    }
  }

  async function refreshProfiles() {
    if (!env.hasStorage) {
      savedProfiles = [];
      renderProfileSelect();
      renderProfilesNote();
      return savedProfiles;
    }
    const stored = await storageGet(['profiles']);
    savedProfiles = readProfileList(stored.profiles);
    renderProfileSelect();
    renderProfilesNote();
    return savedProfiles;
  }

  // ------------------------------------------------------ profile applying

  /**
   * Applies a profile to the form and persists it as this tab's unfinished
   * draft. It never starts refreshing, and it never touches saved defaults.
   */
  async function applyProfileToForm(profile, options) {
    const opts = options || {};
    if (!profile || (!opts.manual && formDirty)) return false;
    restoringForm = true;
    try {
      applyConfigToForm(opts.manual ? profile.config : automaticConfig(profile.config));
    } finally {
      restoringForm = false;
    }

    clearMatchedHint();
    currentProfile = profile;
    if (opts.manual) {
      formDirty = true;
      formRevision += 1;
    }

    const select = ui['profile-select'];
    if (select && !select.disabled) {
      const value = optionValue(profile);
      if (findProfileByOptionValue(value)) select.value = value;
    }

    // The matched line is written only after the form really holds the profile,
    // so it can never claim a profile that a late edit already replaced.
    setProfileHint(ui['profile-matched'], profile);
    if (opts.note) setFooterNote(opts.note);
    renderActions(currentState.status);
    // Suggestions are not unfinished user edits. Save only an explicit choice,
    // so a later update to a matching website/page profile is picked up.
    if (opts.manual) await persistDraft();
    return true;
  }

  function clearMatchedHint() {
    currentProfile = null;
    if (ui['profile-matched']) {
      ui['profile-matched'].textContent = '';
      ui['profile-matched'].hidden = true;
    }
    if (ui['profile-select']) ui['profile-select'].value = '';
  }

  function handleProfileSelection(event) {
    const value = event.target.value;
    if (!value) return;
    const profile = findProfileByOptionValue(value);
    if (!profile) return;
    // Choosing a prompt on this open is informational: the profile is loaded
    // as a draft, so nothing is claimed as auto-applied and nothing starts.
    applyProfileToForm(profile, { manual: true, note: `Loaded “${profile.name}”. Use the action below to apply these settings.` });
  }

  // -------------------------------------------------------- profile saving

  async function saveCurrentAsProfile() {
    const nameRaw = ui['profile-name'] ? ui['profile-name'].value.trim() : '';
    if (nameRaw === '') {
      showProfileAlert('Give the profile a name first.');
      if (ui['profile-name']) ui['profile-name'].focus();
      return;
    }

    const scope = normalizeScope(ui['profile-scope'] ? ui['profile-scope'].value : 'global');
    const target = scope === 'global' ? '' : targetForScope(scope);
    if (scope !== 'global' && !target) {
      showProfileAlert('This tab has no web address to scope a profile to. Choose Everywhere instead.');
      if (ui['profile-scope']) ui['profile-scope'].focus();
      return;
    }

    const { config, errors } = collectForm();
    if (errors.length) {
      showErrors(errors);
      return;
    }
    clearProfileAlert();
    updateScopeHint();

    if (!env.hasStorage) {
      previewMessage();
      return;
    }

    setProfileBusy(true);
    try {
      const stored = await storageGet(['profiles']);
      const profiles = readProfileList(stored.profiles);
      const nameKey = nameRaw.toLowerCase();
      // Same name + scope + target updates in place; a different scope or
      // target is a genuinely new profile and is saved alongside.
      const duplicate = profiles.find(
        (profile) => profile.name.toLowerCase() === nameKey && profile.scope === scope && profile.target === target
      );
      if (!duplicate && profiles.length >= MAX_PROFILES) {
        showProfileAlert('You have 200 profiles. Remove an unused profile from the dashboard before adding another.');
        return;
      }
      const entry = {
        id: duplicate ? duplicate.id : newProfileId(),
        name: nameRaw.slice(0, MAX_PROFILE_NAME),
        config,
        updatedAt: Date.now(),
        scope,
        target
      };
      const next = duplicate
        ? profiles.map((profile) => (profile.id === duplicate.id ? entry : profile))
        : profiles.concat(entry);

      const saved = await storageSet({ profiles: next });
      if (!saved) {
        showProfileAlert('That profile could not be saved.');
        return;
      }

      savedProfiles = next;
      renderProfileSelect();
      renderProfilesNote();
      const select = ui['profile-select'];
      const value = optionValue(entry);
      if (select && findProfileByOptionValue(value)) select.value = value;
      if (ui['profile-name']) ui['profile-name'].value = '';
      setFooterNote(duplicate
        ? `Updated the profile “${entry.name}” (${PROFILE_SCOPE_NOUN[scope]}).`
        : `Saved the profile “${entry.name}” (${PROFILE_SCOPE_NOUN[scope]}).`);
    } finally {
      setProfileBusy(false);
    }
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
      advancedOpen: !!(ui.advanced && ui.advanced.open),
      // Raw automation, never normalised: a half-typed header object or an
      // incomplete URL has to come back exactly as it was left.
      actions: readActionsRawFromForm(),
      automationOpen: !!(ui.automation && ui.automation.open)
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
    // Drafts written before automation existed simply leave the automation form
    // holding whatever the defaults or the matched profile put there.
    if (draft.actions && typeof draft.actions === 'object') applyActionsRawToForm(draft.actions);
    if (ui.automation) ui.automation.open = draft.automationOpen === true;

    syncConditionalPanels();
    syncAutomationPanels();
    // ntfy draft text lives outside the config schema, so its compact status is
    // refreshed here as well as on every keystroke.
    refreshNtfyIndicator();
    return true;
  }

  /**
   * Writes the whole form for the active tab immediately. Defaults are never
   * touched here; only the explicit Save as default action changes them.
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

  // Shared defaults and automatic profile suggestions never arm automation.
  // A per-tab draft/config or an explicit profile selection is the user's choice.
  function automaticConfig(raw) {
    const config = normalizeConfig(raw);
    config.actions.webhook.enabled = false;
    config.actions.script.enabled = false;
    return config;
  }

  function tabSettingsKey(tabId) { return `popupSettings:${tabId}`; }

  async function restoreTabSettings() {
    if (!activeTab || !Number.isInteger(activeTab.id) || formDirty) return false;
    const key = tabSettingsKey(activeTab.id);
    const stored = await sessionGet([key]);
    let config = stored[key];
    if (!config) {
      const response = unwrap(await sendMessage({ type: 'GET_STATE', tabId: activeTab.id }));
      config = response.ok && response.state && response.state.config;
    }
    if (!config || formDirty) return false;
    applyConfigToForm(config);
    return true;
  }

  /** Drops this tab's draft after a successful Start or Save as default. */
  async function clearDraft(expectedRevision = formRevision) {
    if (!activeTab || typeof activeTab.id !== 'number') return Promise.resolve(false);
    const key = draftKey(activeTab.id);
    await draftWriteChain;
    if (formRevision !== expectedRevision) return false;
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
    // The restored draft wins over any saved profile, so no profile may still
    // be described as the one in charge of this form.
    clearMatchedHint();
    return true;
  }

  function handleFormEdit() {
    formDirty = true;
    if (restoringForm) return;
    formRevision += 1;
    // Real typing means the form is no longer exactly the matched profile.
    clearMatchedHint();
    persistDraft();
    renderActions(currentState.status);
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
      case 'script-predicate':
        return 'It stops when your JavaScript condition returns true.';
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

  function hasPendingSettings() {
    if (!['running', 'paused'].includes(currentState.status)) return false;
    const { config, errors } = collectForm();
    if (errors.length) return false;
    const engineConfig = normalizeConfig(currentState.config);
    // A worker build that predates pauseOnInteraction cannot report it back, so
    // comparing it would leave a permanent "Apply & restart" for a setting that
    // build cannot store. The key is dropped from both sides, and only then.
    if (currentState.config && typeof currentState.config === 'object'
      && !('pauseOnInteraction' in currentState.config)) {
      delete config.pauseOnInteraction;
      delete engineConfig.pauseOnInteraction;
    }
    return JSON.stringify(config) !== JSON.stringify(engineConfig);
  }

  function renderActions(status) {
    let label = 'Start';
    if (hasPendingSettings()) label = 'Apply & restart';
    else if (status === 'running') label = 'Pause';
    else if (status === 'paused') label = 'Resume';

    ui['primary-action'].textContent = busy ? `${label}…` : label;
    ui['primary-action'].disabled = busy || pageRestricted || initializing;
    ui['primary-action'].setAttribute('aria-busy', busy ? 'true' : 'false');
    ui['primary-action'].title = label === 'Apply & restart'
      ? 'Restart this tab’s monitor with the settings shown below'
      : label === 'Start'
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
    // An automation problem must be visible rather than hidden behind a closed
    // disclosure, so the card opens before the first bad field is focused.
    if (errors.some((error) => String(error.id).startsWith('automation'))) {
      openAutomationDisclosure();
    }

    ui['form-alert'].textContent = errors.length === 1
      ? `Please fix one field: ${errors[0].message}`
      : `Please fix ${errors.length} fields before starting.`;
    ui['form-alert'].hidden = false;

    focusErrorTarget(errors[0].id);
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
    const predicateScript = ui['predicate-script'].value.trim();
    const ignoreSelector = ui['ignore-selector'].value.trim();

    if (KEYWORD_CONDITIONS.has(stopCondition) && keyword === '') {
      errors.push({ id: 'keyword', message: 'Type the keyword to watch for.' });
    }
    if (SELECTOR_CONDITIONS.has(stopCondition) && selector === '') {
      errors.push({ id: 'selector', message: 'Add a CSS selector, or use Pick element.' });
    }
    if (SCRIPT_CONDITIONS.has(stopCondition) && predicateScript === '') {
      errors.push({
        id: 'predicate-script',
        message: 'Write the condition, or pick a different way to stop.'
      });
    }
    if (predicateScript.length > MAX_PREDICATE_LENGTH) {
      errors.push({
        id: 'predicate-script',
        message: `Keep the condition under ${MAX_PREDICATE_LENGTH} characters.`
      });
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

    const rawActions = collectActionsForm();
    let validated = null;
    try {
      validated = validateActions(rawActions);
    } catch (error) {
      validated = null;
    }
    if (!validated || typeof validated !== 'object') {
      // The shared validator is unreachable. The engine validates again when
      // START arrives, so keep the form usable instead of blocking everything.
      validated = { ok: true, actions: normalizeActions(rawActions), errors: [] };
    }
    if (validated.ok !== true) {
      const actionErrors = Array.isArray(validated.errors) ? validated.errors : [];
      if (actionErrors.length) {
        actionErrors.forEach((item) => {
          errors.push({
            id: actionErrorFieldId(item && item.field),
            message: item && typeof item.message === 'string' && item.message
              ? item.message
              : 'Check this automation setting.'
          });
        });
      } else {
        errors.push({
          id: 'automation',
          message: typeof validated.error === 'string' && validated.error
            ? validated.error
            : 'Check the automation settings.'
        });
      }
    }

    const config = normalizeConfig({
      intervalMode,
      intervalSeconds,
      minSeconds,
      maxSeconds,
      stopCondition,
      keyword,
      selector,
      predicateScript,
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
      actions: validated.ok === true && validated.actions ? validated.actions : rawActions
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
    ui['predicate-script'].value = config.predicateScript;
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

    applyActionsToForm(config.actions);
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
    ui['predicate-panel'].hidden = !SCRIPT_CONDITIONS.has(condition);
    void refreshPredicateAccess(condition);
  }

  /**
   * Say up front whether a custom condition can actually run here, instead of
   * letting every single check report the same blocked reason.
   */
  async function refreshPredicateAccess(condition) {
    const node = ui['predicate-access'];
    if (!node) return;
    if (!SCRIPT_CONDITIONS.has(condition)) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    const hasChrome = typeof chrome !== 'undefined' && chrome !== null;
    const api = hasChrome ? chrome.userScripts : undefined;
    let granted = false;
    if (hasChrome && chrome.permissions && typeof chrome.permissions.contains === 'function') {
      try {
        granted = (await chrome.permissions.contains({ permissions: ['userScripts'] })) === true;
      } catch {
        granted = false;
      }
    }
    if (!hasChrome || !chrome.permissions) {
      setStatusLine(node, 'This browser build does not expose chrome.permissions, so JavaScript access cannot be checked here.', 'is-error');
    } else if (!granted) {
      setStatusLine(node, 'JavaScript access is not granted for this website yet. Until it is, refreshing continues and this condition never stops it.', 'is-error');
    } else if (!api || typeof api.execute !== 'function') {
      setStatusLine(node, 'Access is granted, but “Allow User Scripts” is off. Turn it on in this extension’s Details page, then reload the extension.', 'is-error');
    } else {
      setStatusLine(node, 'JavaScript access is ready, so this condition can run after every settle.', 'is-success');
    }
  }

  // -------------------------------------------------------------- automation
  //
  // Webhooks and page scripts share their schema with the engine through
  // ./actions-core.js. This page never evaluates user code, never fetches a
  // user URL, and never asks for a permission outside the two explicit buttons
  // below (each of which calls chrome.permissions.request synchronously inside
  // the click, before any await, so the click is the user gesture).

  function setCheck(input, value) {
    if (input) input.checked = value === true;
  }

  function asText(value, fallback) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return fallback;
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return fallback;
    }
  }

  function setPill(node, status, text) {
    if (!node) return;
    node.dataset.status = status;
    node.textContent = text;
  }

  function setStatusLine(node, text, variant) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'status-line' + (variant ? ` ${variant}` : '');
  }

  /** Builds both compact event grids from one shared order and label list. */
  function buildEventGrids() {
    [['webhook', ui['automation-webhook-events']], ['script', ui['automation-script-events']]]
      .forEach(([kind, container]) => {
        if (!container) return;
        while (container.firstChild) container.removeChild(container.firstChild);
        ACTION_EVENT_LABELS.forEach(([key, label]) => {
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.id = `automation-${kind}-event-${key}`;
          input.name = `automation-${kind}-event`;
          input.value = key;
          const row = document.createElement('label');
          row.className = 'event-check';
          row.setAttribute('for', input.id);
          const text = document.createElement('span');
          text.textContent = label;
          row.append(input, text);
          container.appendChild(row);
        });
        const defaults = DEFAULT_ACTIONS && DEFAULT_ACTIONS[kind];
        setSelectedEvents(kind, defaults && Array.isArray(defaults.events) ? defaults.events : ['match']);
      });
  }

  /** The selected event keys, always in the shared order. */
  function selectedEvents(kind) {
    return ACTION_EVENT_KEYS.filter((key) => {
      const input = el(`automation-${kind}-event-${key}`);
      return !!(input && input.checked);
    });
  }

  function setSelectedEvents(kind, list) {
    const wanted = new Set(Array.isArray(list) ? list : []);
    ACTION_EVENT_KEYS.forEach((key) => {
      const input = el(`automation-${kind}-event-${key}`);
      if (input) input.checked = wanted.has(key);
    });
  }

  /** Raw automation form values, exactly as typed (invalid JSON included). */
  function readActionsRawFromForm() {
    return {
      webhook: {
        enabled: !!(ui['automation-webhook-enabled'] && ui['automation-webhook-enabled'].checked),
        url: ui['automation-webhook-url'] ? ui['automation-webhook-url'].value : '',
        method: ui['automation-webhook-method'] ? ui['automation-webhook-method'].value : 'POST',
        headers: ui['automation-webhook-headers'] ? ui['automation-webhook-headers'].value : '{}',
        body: ui['automation-webhook-body'] ? ui['automation-webhook-body'].value : '',
        includePageDetails: !!(ui['automation-webhook-details'] && ui['automation-webhook-details'].checked),
        events: selectedEvents('webhook')
      },
      script: {
        enabled: !!(ui['automation-script-enabled'] && ui['automation-script-enabled'].checked),
        events: selectedEvents('script'),
        code: ui['automation-script-code'] ? ui['automation-script-code'].value : '',
        world: 'USER_SCRIPT'
      }
    };
  }

  /** Restores a per-tab draft's raw automation values without cleaning them. */
  function applyActionsRawToForm(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const webhook = source.webhook && typeof source.webhook === 'object' ? source.webhook : {};
    const script = source.script && typeof source.script === 'object' ? source.script : {};

    setCheck(ui['automation-webhook-enabled'], webhook.enabled === true);
    if (ui['automation-webhook-url'] && typeof webhook.url === 'string') {
      ui['automation-webhook-url'].value = webhook.url;
    }
    if (ui['automation-webhook-method'] && typeof webhook.method === 'string'
      && (webhook.method === 'GET' || webhook.method === 'POST')) {
      ui['automation-webhook-method'].value = webhook.method;
    }
    if (ui['automation-webhook-headers'] && typeof webhook.headers === 'string') {
      ui['automation-webhook-headers'].value = webhook.headers;
    }
    if (ui['automation-webhook-body'] && typeof webhook.body === 'string') {
      ui['automation-webhook-body'].value = webhook.body;
    }
    setCheck(ui['automation-webhook-details'], webhook.includePageDetails === true);
    if (Array.isArray(webhook.events)) setSelectedEvents('webhook', webhook.events);

    setCheck(ui['automation-script-enabled'], script.enabled === true);
    if (ui['automation-script-code'] && typeof script.code === 'string') {
      ui['automation-script-code'].value = script.code;
    }
    if (Array.isArray(script.events)) setSelectedEvents('script', script.events);

    syncAutomationPanels();
  }

  /** Writes shared-schema actions (defaults, profiles, engine state) into the form. */
  function applyActionsToForm(raw) {
    const actions = normalizeActions(raw);
    const webhook = actions.webhook;
    const script = actions.script;

    setCheck(ui['automation-webhook-enabled'], webhook.enabled);
    if (ui['automation-webhook-url']) ui['automation-webhook-url'].value = asText(webhook.url, '');
    if (ui['automation-webhook-method']) ui['automation-webhook-method'].value = webhook.method === 'GET' ? 'GET' : 'POST';
    if (ui['automation-webhook-headers']) ui['automation-webhook-headers'].value = asText(webhook.headers, '{}');
    if (ui['automation-webhook-body']) ui['automation-webhook-body'].value = asText(webhook.body, '');
    setCheck(ui['automation-webhook-details'], webhook.includePageDetails);
    setSelectedEvents('webhook', webhook.events);

    setCheck(ui['automation-script-enabled'], script.enabled);
    if (ui['automation-script-code']) ui['automation-script-code'].value = asText(script.code, '');
    setSelectedEvents('script', script.events);

    syncAutomationPanels();
    scheduleAutomationStatus();
  }

  /** Trimmed form values handed to the shared validator on Start/Save. */
  function collectActionsForm() {
    const raw = readActionsRawFromForm();
    raw.webhook.url = raw.webhook.url.trim();
    return raw;
  }

  function updateCodeCount() {
    if (!ui['automation-script-count'] || !ui['automation-script-code']) return;
    const length = ui['automation-script-code'].value.length;
    ui['automation-script-count'].textContent = `${length} / ${MAX_CODE_LENGTH}`;
  }

  /** Visual only: which sections are open plus the summary hint and counter. */
  function syncAutomationPanels() {
    const webhookOn = !!(ui['automation-webhook-enabled'] && ui['automation-webhook-enabled'].checked);
    const scriptOn = !!(ui['automation-script-enabled'] && ui['automation-script-enabled'].checked);

    if (ui['automation-webhook-fields']) ui['automation-webhook-fields'].hidden = !webhookOn;
    if (ui['automation-script-fields']) ui['automation-script-fields'].hidden = !scriptOn;

    const parts = [];
    if (webhookOn) parts.push('webhook');
    if (scriptOn) parts.push('script');
    if (ui['automation-summary-hint']) {
      ui['automation-summary-hint'].textContent = parts.length
        ? `${parts.join(' + ')} on`
        : 'webhooks & page scripts · off';
    }
    updateCodeCount();
  }

  function openAutomationDisclosure() {
    if (!ui.automation) return;
    ui.automation.open = true;
    syncAutomationPanels();
    scheduleAutomationStatus();
  }

  /** Short "includes automation" sentence used by profile hints. */
  function profileAutomationLabel(raw) {
    const actions = normalizeActions(raw);
    const parts = [];
    if (actions.webhook.enabled) parts.push('a webhook');
    if (actions.script.enabled) parts.push('a page script');
    if (!parts.length) return '';
    return `Includes ${parts.join(' and ')}.`;
  }

  /** Turns a shared-validator field name into a real field id in this form. */
  function actionErrorFieldId(field) {
    const raw = typeof field === 'string' ? field.toLowerCase() : '';
    const kind = raw.indexOf('script') === 0 ? 'script' : 'webhook';
    if (raw.indexOf('event') !== -1) return `automation-${kind}-events`;
    if (raw.indexOf('header') !== -1) return 'automation-webhook-headers';
    if (raw.indexOf('body') !== -1 || raw.indexOf('payload') !== -1) return 'automation-webhook-body';
    if (raw.indexOf('url') !== -1 || raw.indexOf('origin') !== -1) return 'automation-webhook-url';
    if (raw.indexOf('code') !== -1 || raw.indexOf('world') !== -1) return 'automation-script-code';
    return 'automation';
  }

  function focusErrorTarget(id) {
    if (id === 'automation') {
      const summary = ui.automation ? ui.automation.querySelector('summary') : null;
      if (summary && typeof summary.focus === 'function') {
        summary.focus();
        return;
      }
    }
    const node = el(id);
    if (node && typeof node.focus === 'function') node.focus();
  }

  // ------------------------------------------------- automation status checks

  /** One coalesced status refresh per turn, so typing never spams the engine. */
  function scheduleAutomationStatus() {
    if (automationStatusTimer) return;
    automationStatusTimer = setTimeout(() => {
      automationStatusTimer = null;
      refreshWebhookIndicator();
      refreshScriptIndicator();
    }, 0);
  }

  function scheduleAutomationUrlStatus() {
    if (automationUrlTimer) clearTimeout(automationUrlTimer);
    automationUrlTimer = setTimeout(() => {
      automationUrlTimer = null;
      refreshWebhookIndicator();
    }, URL_STATUS_DEBOUNCE_MS);
  }

  /** Parses the URL box into a permission pattern; never requests anything. */
  function webhookPattern() {
    const input = ui['automation-webhook-url'];
    if (!input) return { pattern: '', reason: 'invalid' };
    const raw = input.value.trim();
    if (raw === '') return { pattern: '', reason: 'empty' };
    let pattern = '';
    try {
      pattern = permissionOriginForUrl(raw);
    } catch (error) {
      pattern = '';
    }
    if (typeof pattern !== 'string' || pattern === '') return { pattern: '', reason: 'invalid' };
    return { pattern, reason: 'ok' };
  }

  function hostLabelOf(pattern) {
    return String(pattern).replace(/^[a-z]+:\/\//i, '').replace(/\/\*$/, '').replace(/\/$/, '');
  }

  function checkOriginPermission(pattern) {
    return new Promise((resolve) => {
      if (!env.hasPermissions) {
        resolve(null);
        return;
      }
      try {
        chrome.permissions.contains({ origins: [pattern] }, (granted) => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(failed ? null : granted === true);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function refreshWebhookIndicator() {
    const status = ui['automation-webhook-status'];
    const line = ui['automation-webhook-connection'];
    const enabled = !!(ui['automation-webhook-enabled'] && ui['automation-webhook-enabled'].checked);

    if (!enabled) {
      setPill(status, 'off', 'Off');
      setStatusLine(line, 'Webhook is off, so nothing is sent and no permission is involved in normal refreshing.', '');
      return;
    }
    if (!env.live) {
      setPill(status, 'unavailable', 'Preview');
      setStatusLine(line, 'Preview only — granted access cannot be read from this page.', '');
      return;
    }
    if (!env.hasPermissions) {
      setPill(status, 'unavailable', 'No API');
      setStatusLine(line, 'This browser build does not expose chrome.permissions, so webhook access cannot be checked or granted here.', 'is-error');
      return;
    }

    const { pattern, reason } = webhookPattern();
    if (reason === 'empty') {
      setPill(status, 'unavailable', 'Needs URL');
      setStatusLine(line, 'Add the webhook URL above, then press Connect webhook.', '');
      return;
    }
    if (reason !== 'ok') {
      setPill(status, 'error', 'Bad URL');
      setStatusLine(line, 'That is not a usable webhook address. Use http or https, remove any username or password from it, and remember that plain http is only allowed for local development hosts such as localhost or 127.0.0.1.', 'is-error');
      return;
    }

    const host = hostLabelOf(pattern);
    setPill(status, 'unavailable', 'Checking');
    checkOriginPermission(pattern).then((granted) => {
      if (granted === null) {
        setPill(status, 'unavailable', 'Unknown');
        setStatusLine(line, 'Access for this hostname could not be checked.', '');
        return;
      }
      if (granted) {
        setPill(status, 'ready', 'Connected');
        setStatusLine(line, `Access granted for ${host} (the port is ignored, so the whole hostname is allowed).`, 'is-success');
      } else {
        setPill(status, 'unavailable', 'Not connected');
        setStatusLine(line, `Press Connect webhook to allow ${host} (port ignored). That button only grants access.`, '');
      }
    });
  }

  async function loadScriptCapabilities() {
    if (!env.live || !activeTab || typeof activeTab.id !== 'number') return null;
    const response = await sendMessage({ type: 'ACTION_CAPABILITIES', tabId: activeTab.id });
    if (!response || typeof response !== 'object' || response.ok !== true) return null;
    return response;
  }

  const SCRIPT_SWITCH_HELP = 'Chrome 138 and later also needs “Allow User Scripts” switched on by hand in chrome://extensions → this extension → Details; that security switch cannot be opened for you.';

  /**
   * Kept beside the exact browser error rather than replacing it. An optional
   * hostname that a freshly updated build declares is only visible to Chrome
   * after that build is reloaded, so the honest next step is stated plainly.
   */
  const PERMISSION_RELOAD_HELP = 'If the extension was updated or reloaded after this page opened, open chrome://extensions, press Reload on The Best Auto Refresh App, reopen this popup and try again — a new optional hostname cannot be granted until the extension is reloaded.';

  function refreshScriptIndicator() {
    const status = ui['automation-script-status'];
    const line = ui['automation-script-permission'];
    const enabled = !!(ui['automation-script-enabled'] && ui['automation-script-enabled'].checked);

    if (!enabled) {
      setPill(status, 'off', 'Off');
      setStatusLine(line, 'JavaScript automation is off. No permission is involved in normal refreshing.', '');
      return;
    }
    if (!env.live) {
      setPill(status, 'unavailable', 'Preview');
      setStatusLine(line, 'Preview only — script access cannot be read from this page.', '');
      return;
    }
    if (!activeTab || typeof activeTab.id !== 'number') {
      setPill(status, 'unavailable', 'No tab');
      setStatusLine(line, 'Open a normal website tab to check script access for it.', '');
      return;
    }

    setPill(status, 'unavailable', 'Checking');
    loadScriptCapabilities().then((capabilities) => {
      if (!capabilities) {
        setPill(status, 'unavailable', 'Unknown');
        setStatusLine(line, 'Script access could not be checked. Reload the extension, then reopen this popup.', '');
        return;
      }
      const message = typeof capabilities.message === 'string' && capabilities.message ? `${capabilities.message} ` : '';
      if (capabilities.scriptPermission !== true) {
        setPill(status, 'unavailable', 'Not enabled');
        setStatusLine(line, `Press Enable JavaScript on this website to ask for the userScripts permission. ${SCRIPT_SWITCH_HELP}`, '');
        return;
      }
      if (capabilities.scriptOriginGranted !== true) {
        setPill(status, 'unavailable', 'Other site');
        setStatusLine(line, `${message}Access is granted, but not for this page’s hostname. Press Enable JavaScript on this website while this tab is in front.`, '');
        return;
      }
      if (capabilities.scriptAvailable !== true) {
        setPill(status, 'unavailable', 'Check switch');
        setStatusLine(line, `${message}${SCRIPT_SWITCH_HELP}`, '');
        return;
      }
      setPill(status, 'ready', 'Ready');
      setStatusLine(line, `${message}Ready to run on this website for the events you chose. ${SCRIPT_SWITCH_HELP}`, '');
    });
  }

  // ----------------------------------------------- explicit permission buttons

  function connectWebhook() {
    const status = ui['automation-webhook-status'];
    const line = ui['automation-webhook-connection'];

    if (!env.live) {
      setStatusLine(line, 'Preview only — the extension engine is not reachable here.', '');
      return;
    }
    if (!env.hasPermissions) {
      setStatusLine(line, 'This browser build does not expose chrome.permissions, so access cannot be requested here.', 'is-error');
      return;
    }

    const { pattern, reason } = webhookPattern();
    if (reason !== 'ok') {
      setStatusLine(line, reason === 'empty'
        ? 'Add the webhook URL first.'
        : 'Enter a complete http or https address with no username or password. Plain http is only allowed for local development hosts such as localhost or 127.0.0.1.', 'is-error');
      if (ui['automation-webhook-url'] && typeof ui['automation-webhook-url'].focus === 'function') {
        ui['automation-webhook-url'].focus();
      }
      return;
    }

    setPill(status, 'unavailable', 'Asking');
    setStatusLine(line, 'Waiting for your answer in the browser’s permission prompt…', '');

    // The request starts synchronously inside this click, before any await, so
    // the click counts as the user gesture. This button grants access only: no
    // request is ever sent to the webhook URL from here.
    try {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        const failed = chrome.runtime && chrome.runtime.lastError;
        if (failed) {
          setPill(status, 'error', 'Failed');
          // The browser's own words come first and are never summarised away;
          // the reload step is appended because a stale build cannot be granted
          // a newly declared optional hostname.
          setStatusLine(line, `${failed.message || 'The permission request failed.'} ${PERMISSION_RELOAD_HELP}`, 'is-error');
          return;
        }
        if (granted !== true) {
          setPill(status, 'unavailable', 'Not connected');
          setStatusLine(line, 'Access was not granted, so no webhook will be sent. You can try again at any time.', '');
          return;
        }
        scheduleAutomationStatus();
        setFooterNote('Webhook access granted. Nothing has been sent.');
      });
    } catch (error) {
      setPill(status, 'error', 'Failed');
      setStatusLine(line, `${(error && error.message) || 'The permission request could not be started.'} ${PERMISSION_RELOAD_HELP}`, 'is-error');
    }
  }

  // ------------------------------------------------------ ntfy quick setup
  //
  // ntfy is a convenience generator, not a second kind of automation. The two
  // text fields below are tab drafts only: pressing the button writes the plain
  // webhook fields (URL, method, headers, body, events, details) and nothing
  // else. The button never enables the webhook, never requests a permission and
  // never sends a request. The only code that sends anything is the explicit
  // "Send test notification" button further down.

  function setNtfyNote(text, variant) {
    setStatusLine(ui['ntfy-note'], text, variant);
  }

  function ntfyInput() {
    return {
      server: ui['ntfy-server'] ? ui['ntfy-server'].value : '',
      topic: ui['ntfy-topic'] ? ui['ntfy-topic'].value : ''
    };
  }

  /** Local, pure check of both boxes; used only for the compact status pill. */
  function refreshNtfyIndicator() {
    const { server, topic } = ntfyInput();
    const serverTrim = server.trim();
    const topicTrim = topic.trim();
    if (topicTrim === '') {
      // A topic is the one thing ntfy genuinely requires, and the server box
      // starts pre-filled, so an untouched pair reads as "not set" rather than
      // as an error the user did not make.
      const untouched = serverTrim === '' || serverTrim.replace(/\/+$/, '') === NTFY_DEFAULT_SERVER;
      setPill(ui['ntfy-status'], 'unavailable', untouched ? 'Not set' : 'Needs topic');
      return;
    }
    const described = describeNtfySetup({ server, topic });
    if (described.ok) {
      setPill(ui['ntfy-status'], 'ready', 'Ready');
      return;
    }
    const serverBad = described.errors.some((item) => item.field === 'ntfy-server');
    setPill(ui['ntfy-status'], 'error', serverBad ? 'Check server' : 'Check topic');
  }

  /** Explicit button: fill the webhook fields from the ntfy pair. */
  function applyNtfySettings() {
    clearFieldError('ntfy-server');
    clearFieldError('ntfy-topic');
    setNtfyNote('', '');

    const described = describeNtfySetup(ntfyInput());
    if (!described.ok) {
      described.errors.forEach((item) => setFieldError(item.field, item.message));
      const first = described.errors[0];
      setNtfyNote(first.message, 'is-error');
      const target = first.field === 'ntfy-topic' ? ui['ntfy-topic'] : ui['ntfy-server'];
      if (target && typeof target.focus === 'function') target.focus();
      return;
    }

    const patch = described.webhook;
    ui['automation-webhook-url'].value = patch.url;
    ui['automation-webhook-method'].value = patch.method;
    ui['automation-webhook-headers'].value = patch.headers;
    ui['automation-webhook-body'].value = patch.body;
    setSelectedEvents('webhook', patch.events);
    setCheck(ui['automation-webhook-details'], patch.includePageDetails === true);
    // The fields that were just replaced are known-good, so any older complaint
    // about them is cleared rather than left on screen.
    ['automation-webhook-url', 'automation-webhook-events', 'automation-webhook-headers', 'automation-webhook-body']
      .forEach(clearFieldError);
    // A Start that failed on the old body or headers must not keep its alert on
    // screen now that those fields were replaced with known-good values.
    if (!hasVisibleFieldError()) {
      ui['form-alert'].hidden = true;
      ui['form-alert'].textContent = '';
    }
    if (ui['automation-webhook-enabled'] && !ui['automation-webhook-enabled'].checked) {
      // The block is only visible when the webhook is on, so this can only
      // happen through a scripted click: say so instead of silently enabling it.
      setNtfyNote('The webhook switch is off, so these settings are saved but nothing will be sent until you switch it on.', '');
    } else {
      setNtfyNote(`Settings ready for “${described.topic}”. Connect the webhook, then send a test or start watching.`, 'is-success');
    }
    syncAutomationPanels();
    scheduleAutomationStatus();
    // A button press is real input: it marks the form dirty and writes the raw
    // ntfy fields plus the new webhook values into this tab's draft.
    handleFormEdit();
    setFooterNote('ntfy settings written to the webhook fields. Nothing has been sent.');
  }

  // ------------------------------------------------- one explicit test request

  function setTestBusy(next) {
    if (ui['automation-webhook-test']) ui['automation-webhook-test'].disabled = next === true;
  }

  /**
   * The only place in the popup that asks for a real request to be sent, and it
   * runs from an explicit click alone. The engine returns
   * `{ ok:true, message, status }` or `{ ok:false, error }`; this button never
   * starts, pauses or stops a monitor, and it never runs page code.
   */
  async function sendTestNotification() {
    const line = ui['automation-webhook-test-status'];
    if (!env.live) {
      setStatusLine(line, 'Preview only — the extension engine is not reachable here, so nothing can be sent.', 'is-error');
      return;
    }
    if (!activeTab || typeof activeTab.id !== 'number') {
      setStatusLine(line, 'No active tab is available for a test request.', 'is-error');
      return;
    }

    // Raw values exactly as typed; the engine validates and trims them. The
    // popup never sends this message anywhere except the extension worker.
    const webhook = readActionsRawFromForm().webhook;
    setTestBusy(true);
    setStatusLine(line, 'Sending one test request…', '');
    let response = null;
    try {
      response = await sendMessage({ type: 'TEST_WEBHOOK', tabId: activeTab.id, webhook });
    } catch {
      response = { ok: false, error: 'The extension could not complete the test. Reopen the popup and try again.' };
    } finally {
      setTestBusy(false);
    }

    if (response && response.ok === true) {
      const message = typeof response.message === 'string' && response.message
        ? response.message
        : 'The test request was sent.';
      // The worker already names the HTTP status in its message; the number is
      // only appended when the message does not mention it, never twice.
      const status = Number.isFinite(response.status) && !message.includes(String(response.status))
        ? ` (HTTP ${response.status})`
        : '';
      setStatusLine(line, `${message}${status}`, 'is-success');
      return;
    }
    // The engine's own wording is shown as-is, including a refused host or a
    // malformed body, so the reason is never hidden.
    const error = response && typeof response.error === 'string' && response.error
      ? response.error
      : 'The test request could not be sent, and the background worker did not say why.';
    setStatusLine(line, error, 'is-error');
  }

  function enableScriptOnSite() {
    const status = ui['automation-script-status'];
    const line = ui['automation-script-permission'];

    if (!env.live) {
      setStatusLine(line, 'Preview only — the extension engine is not reachable here.', '');
      return;
    }
    if (!env.hasPermissions) {
      setStatusLine(line, 'This browser build does not expose chrome.permissions, so access cannot be requested here.', 'is-error');
      return;
    }

    const url = activeTab && typeof activeTab.url === 'string' ? activeTab.url : '';
    let pattern = '';
    try {
      pattern = permissionOriginForUrl(url);
    } catch (error) {
      pattern = '';
    }
    if (typeof pattern !== 'string' || pattern === '') {
      setStatusLine(line, 'Put a normal http or https page in front and press again. Browser pages, the Web Store and local files cannot be scripted.', 'is-error');
      return;
    }

    setPill(status, 'unavailable', 'Asking');
    setStatusLine(line, 'Waiting for your answer in the browser’s permission prompt…', '');

    // Same gesture rule as the webhook button, and the same restraint: this
    // grants access, and the Chrome 138+ "Allow User Scripts" switch is only
    // ever described, never toggled for the user.
    try {
      chrome.permissions.request({ permissions: ['userScripts'], origins: [pattern] }, (granted) => {
        const failed = chrome.runtime && chrome.runtime.lastError;
        if (failed) {
          setPill(status, 'error', 'Failed');
          setStatusLine(line, failed.message || 'The permission request failed.', 'is-error');
          return;
        }
        if (granted !== true) {
          setPill(status, 'unavailable', 'Not enabled');
          setStatusLine(line, 'Access was not granted, so no script will run. You can try again at any time.', '');
          return;
        }
        loadScriptCapabilities().then((capabilities) => {
          const message = capabilities && typeof capabilities.message === 'string' && capabilities.message
            ? `${capabilities.message} `
            : '';
          const ready = !!(capabilities && capabilities.scriptAvailable === true
            && capabilities.scriptPermission === true
            && capabilities.scriptOriginGranted === true);
          setPill(status, ready ? 'ready' : 'unavailable', ready ? 'Ready' : 'Check switch');
          setStatusLine(line, `${message}${SCRIPT_SWITCH_HELP}`, ready ? 'is-success' : '');
        });
        setFooterNote('JavaScript access granted for this website.');
      });
    } catch (error) {
      setPill(status, 'error', 'Failed');
      setStatusLine(line, (error && error.message) || 'The permission request could not be started.', 'is-error');
    }
  }

  function insertExampleSnippet() {
    const area = ui['automation-script-code'];
    if (!area) return;
    const existing = area.value;
    area.value = existing.trim() === ''
      ? SCRIPT_EXAMPLE
      : `${existing.replace(/\s+$/, '')}\n\n${SCRIPT_EXAMPLE}`;
    updateCodeCount();
    handleFormEdit();
    if (typeof area.focus === 'function') area.focus();
    if (typeof area.setSelectionRange === 'function') {
      try {
        const end = area.value.length;
        area.setSelectionRange(end, end);
      } catch (error) {
        /* Not fatal: the snippet is already in the box. */
      }
    }
    setFooterNote('Example snippet added. Nothing runs until you press Start.');
  }

  function openAutomationAccess() {
    if (openOptions('#automation')) {
      setFooterNote('Opened the dashboard at Automation access.');
      return;
    }
    setFooterNote('The dashboard could not be opened from here.');
  }

  // -------------------------------------------------------- activity (log)

  async function fetchActivityEntries() {
    if (!env.live || !activeTab || typeof activeTab.id !== 'number') return null;
    const response = await sendMessage({ type: 'ACTION_LOG', tabId: activeTab.id });
    if (!response || typeof response !== 'object' || response.ok !== true) return null;
    return Array.isArray(response.entries) ? response.entries : [];
  }

  async function loadActivity() {
    if (activityBusy) return;
    activityBusy = true;
    try {
      const entries = await fetchActivityEntries();
      renderActivity(entries);
      announceActivityFailures(entries);
    } finally {
      activityBusy = false;
    }
  }

  /**
   * A failed hook is surfaced once instead of being swallowed, and it never
   * stops refreshing: the engine keeps the monitor running and only logs it.
   */
  function announceActivityFailures(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const failed = entries.filter((entry) => entry && entry.status === 'failed');
    if (!failed.length) return;
    const newest = failed.reduce((max, entry) => (
      Number.isFinite(entry.timestamp) && entry.timestamp > max ? entry.timestamp : max
    ), 0);
    if (newest <= lastFailedAt) return;
    lastFailedAt = newest;
    setFooterNote('An automation hook failed. Open Automation → Recent activity for the log; refreshing continues.');
  }

  function activityEventLabel(event) {
    const found = ACTION_EVENT_LABELS.find(([key]) => key === event);
    if (found) return found[1];
    return typeof event === 'string' && event ? event : 'event';
  }

  function activityKindLabel(kind) {
    if (kind === 'webhook') return 'webhook';
    if (kind === 'script') return 'JavaScript';
    return typeof kind === 'string' && kind ? kind : 'automation';
  }

  function activityStatusLabel(status) {
    if (status === 'success') return 'ok';
    if (status === 'failed') return 'failed';
    if (status === 'skipped') return 'skipped';
    return typeof status === 'string' ? status : '';
  }

  function activityItem(when, what, variant, message) {
    const item = document.createElement('li');
    item.className = 'activity-item' + (variant ? ` ${variant}` : '');
    if (when) {
      const time = document.createElement('span');
      time.className = 'activity-when';
      time.textContent = when;
      item.appendChild(time);
    }
    const label = document.createElement('span');
    label.className = 'activity-what';
    label.textContent = what;
    item.appendChild(label);
    if (message) {
      const detail = document.createElement('span');
      detail.className = 'activity-detail';
      detail.textContent = message;
      item.appendChild(detail);
    }
    return item;
  }

  /** Renders the newest ten entries using textContent only. */
  function renderActivity(entries) {
    const list = ui['automation-activity-list'];
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (entries === null) {
      list.appendChild(activityItem('', 'The automation log is unavailable here. It needs the extension engine.', 'is-empty', ''));
      return;
    }
    if (!entries.length) {
      list.appendChild(activityItem('', 'No automation activity for this tab yet.', 'is-empty', ''));
      return;
    }

    entries.slice(-10).reverse().forEach((entry) => {
      const item = entry && typeof entry === 'object' ? entry : {};
      const when = formatClock(Number.isFinite(item.timestamp) ? item.timestamp : NaN);
      const what = [
        activityEventLabel(item.event),
        activityKindLabel(item.kind),
        activityStatusLabel(item.status)
      ].filter(Boolean).join(' · ');
      const variant = item.status === 'failed'
        ? 'is-failed'
        : item.status === 'skipped'
          ? 'is-skipped'
          : item.status === 'success'
            ? 'is-success'
            : '';
      list.appendChild(activityItem(when, what, variant, typeof item.message === 'string' ? item.message : ''));
    });
  }

  function activityShouldPoll() {
    return env.live
      && !!ui.automation && ui.automation.open
      && !!ui['automation-activity'] && ui['automation-activity'].open
      && !document.hidden;
  }

  /**
   * The log is only polled — at most every two seconds — while its disclosure is
   * open and the popup is visible. Closed means no timer at all.
   */
  function syncActivityPolling() {
    const shouldPoll = activityShouldPoll();
    if (!shouldPoll) {
      if (activityTimer) {
        clearInterval(activityTimer);
        activityTimer = null;
      }
      // Opening the log without an engine explains itself instead of showing an
      // empty box. This is a single render, never a timer.
      if (!env.live
        && !!ui.automation && ui.automation.open
        && !!ui['automation-activity'] && ui['automation-activity'].open) {
        renderActivity(null);
      }
      return;
    }
    if (activityTimer) return;
    loadActivity();
    activityTimer = setInterval(() => {
      if (!activityShouldPoll()) {
        syncActivityPolling();
        return;
      }
      loadActivity();
    }, ACTIVITY_POLL_MS);
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
    const submittedRevision = formRevision;
    setBusy(true);
    const result = unwrap(await sendMessage({ type: 'START', tabId: activeTab.id, config }));
    setBusy(false);

    if (!result.ok) {
      renderEngineError(result.error, { pillToo: true });
      return;
    }
    applyState(result.state || Object.assign(idleState(), { status: 'running', config, startedAt: Date.now() }));
    const saved = await sessionSet({ [tabSettingsKey(activeTab.id)]: config });
    await clearDraft(submittedRevision);
    setFooterNote(saved ? 'Refreshing this tab. Use a saved profile to reuse these settings.' : 'Refreshing this tab. Its settings could not be remembered.');
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
    const submittedRevision = formRevision;
    const saved = await storageSet({ defaults: config });
    if (saved) {
      if (activeTab && Number.isInteger(activeTab.id)) await sessionSet({ [tabSettingsKey(activeTab.id)]: config });
      await clearDraft(submittedRevision);
    }
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

    // ---- Automation ----
    // Only the two Connect/Enable buttons ever request a permission, and each
    // one calls chrome.permissions.request synchronously inside the click.
    const disableActiveHook = (kind) => {
      if (!env.live || !activeTab) return;
      sendMessage({ type: 'DISABLE_ACTION', tabId: activeTab.id, kind }).then((response) => {
        if (response?.ok && response.state) applyState(response.state);
      });
    };
    ui['automation-webhook-enabled'].addEventListener('change', () => {
      if (!ui['automation-webhook-enabled'].checked) disableActiveHook('webhook');
      syncAutomationPanels();
      scheduleAutomationStatus();
    });
    ui['automation-script-enabled'].addEventListener('change', () => {
      if (!ui['automation-script-enabled'].checked) disableActiveHook('script');
      syncAutomationPanels();
      scheduleAutomationStatus();
    });
    ui['automation-webhook-url'].addEventListener('input', scheduleAutomationUrlStatus);
    ui['automation-webhook-url'].addEventListener('change', scheduleAutomationUrlStatus);
    ui['automation-webhook-method'].addEventListener('change', scheduleAutomationUrlStatus);
    ui['automation-webhook-details'].addEventListener('change', scheduleAutomationUrlStatus);
    ui['automation-webhook-connect'].addEventListener('click', connectWebhook);

    // ---- ntfy quick setup and the one explicit test request ----
    // These handlers never call chrome.permissions.request and never fetch
    // anything themselves; the test button hands a message to the worker.
    if (ui['ntfy-use']) ui['ntfy-use'].addEventListener('click', applyNtfySettings);
    if (ui['ntfy-server']) ui['ntfy-server'].addEventListener('input', refreshNtfyIndicator);
    if (ui['ntfy-topic']) ui['ntfy-topic'].addEventListener('input', refreshNtfyIndicator);
    if (ui['automation-webhook-test']) {
      ui['automation-webhook-test'].addEventListener('click', sendTestNotification);
    }
    ui['automation-script-enable'].addEventListener('click', enableScriptOnSite);
    ui['automation-script-example'].addEventListener('click', insertExampleSnippet);
    ui['automation-script-code'].addEventListener('input', updateCodeCount);
    ui['automation-manage-access'].addEventListener('click', openAutomationAccess);
    ui['automation-activity-refresh'].addEventListener('click', () => loadActivity());

    // The disclosure state belongs to this tab's draft, exactly like Advanced.
    if (ui.automation) {
      ui.automation.addEventListener('toggle', handleFormEdit);
      ui.automation.addEventListener('toggle', () => {
        syncAutomationPanels();
        scheduleAutomationStatus();
        syncActivityPolling();
      });
    }
    if (ui['automation-activity']) {
      ui['automation-activity'].addEventListener('toggle', syncActivityPolling);
    }

    if (env.hasPermissionEvents) {
      const onPermissionChange = () => scheduleAutomationStatus();
      try {
        chrome.permissions.onAdded.addListener(onPermissionChange);
        if (chrome.permissions.onRemoved && typeof chrome.permissions.onRemoved.addListener === 'function') {
          chrome.permissions.onRemoved.addListener(onPermissionChange);
        }
      } catch (error) {
        /* No permission events on this build; the indicators still refresh on demand. */
      }
    }

    // Profile controls live outside the settings form, so their events can
    // never write a config draft. Only these handlers read them.
    ui['profile-select'].addEventListener('change', handleProfileSelection);
    ui['profile-save-action'].addEventListener('click', saveCurrentAsProfile);
    ui['profile-name'].addEventListener('input', () => {
      clearProfileAlert();
      if (ui['profile-name'].value.trim() !== '') ui['profile-name'].removeAttribute('aria-invalid');
    });
    ui['profile-name'].addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveCurrentAsProfile();
      }
    });
    ui['profile-scope'].addEventListener('change', () => {
      clearProfileAlert();
      updateScopeHint();
    });

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
      // Activity polling exists only while its disclosure is open and visible.
      syncActivityPolling();
    });

    if (env.hasStorage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.pickedSelector) {
          const picked = changes.pickedSelector.newValue;
          if (picked) consumePickedSelector(picked, 'change');
        }
        if (changes.profiles) {
          savedProfiles = readProfileList(changes.profiles.newValue);
          renderProfileSelect();
          renderProfilesNote();
        }
      });
    }
  }

  function handlePrimary() {
    const status = currentState.status;
    if (env.live && hasPendingSettings()) { startSession(); return; }
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
    ui.controls.setAttribute('aria-busy', 'true');
    wireBrandMark();
    buildEventGrids();
    wireEvents();
    syncConditionalPanels();
    syncAutomationPanels();
    refreshNtfyIndicator();

    if (!env.live) {
      ui['preview-banner'].hidden = false;
      ui['preview-banner-text'].textContent = 'The extension engine is not reachable from this page, so nothing will refresh. This is a layout preview.';
      ui['pick-element'].disabled = true;
      ui['pick-element'].title = 'Preview only — the element picker needs the extension engine.';
      ui['automation-webhook-connect'].disabled = true;
      ui['automation-webhook-connect'].title = 'Preview only — the extension engine is not reachable.';
      ui['automation-script-enable'].disabled = true;
      ui['automation-script-enable'].title = 'Preview only — the extension engine is not reachable.';
      // "Use ntfy settings" keeps working in preview because it only fills
      // fields; the one button that asks for a real request cannot work here.
      ui['automation-webhook-test'].disabled = true;
      ui['automation-webhook-test'].title = 'Preview only — a test request needs the extension engine.';
    }

    const stored = await storageGet(['defaults']);
    lastKnownConfig = automaticConfig(stored.defaults);
    // If the user already typed while storage was loading, their input wins.
    if (!formDirty) applyConfigToForm(lastKnownConfig);

    activeTab = await queryActiveTab();
    pageRestricted = !!(activeTab && isRestrictedUrl(activeTab.url));
    renderTab();
    syncScopeOptions();
    // Automation access is per tab, so the status checks run once the active tab
    // is known (never a permission request — only chrome.permissions.contains).
    scheduleAutomationStatus();

    ui['restricted-note'].hidden = true;
    renderRestricted();

    if (!env.live) {
      applyState(null);
      await refreshProfiles();
      renderProfilesNote();
      setProfileBusy(true);
      setStateMessage('Preview only — nothing is refreshed and nothing is sent. Install and reload the extension to use these controls.', 'is-warn');
    } else {
      // Restore this tab's unfinished draft after defaults and activeTab resolve.
      // A pending picked selector is consumed last so the fresh pick wins, and
      // refreshState polling below only ever repaints the session card.
      let restored = false;
      if (formDirty) await persistDraft();
      else restored = await restoreDraft();
      if (!restored && !formDirty) restored = await restoreTabSettings();
      await refreshProfiles();
      // Auto-matching only happens on a first open with no draft: an unfinished
      // draft overrides every saved profile, and a match never starts refreshing.
      if (!restored && !formDirty && !pageRestricted) {
        const match = matchProfileForTab();
        if (match) {
          // The hint is only attached when the form was really written; a late
          // keystroke during the async work wins and is never overwritten.
          await applyProfileToForm(match, {
            note: `Loaded your “${match.name}” profile for ${PROFILE_SCOPE_NOUN[match.scope]} — review the settings below.`
          });
        }
      }
      await consumeStoredPickedSelector();
      await refreshState();
    }

    syncActivityPolling();
    initializing = false;
    ui.controls.setAttribute('aria-busy', 'false');
    document.body.dataset.ready = 'true';
    renderActions(currentState.status);
    startTicking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
