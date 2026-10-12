/**
 * The Best Auto Refresh App — content script (classic script, injected with
 * chrome.scripting.executeScript on activeTab).
 *
 * Responsibilities:
 *   - own the sub-30s timers (the background cannot schedule those reliably);
 *   - collect the visible, normalized text snapshot the background evaluates;
 *   - execute validated reload / stop decisions coming from the background;
 *   - preserve scroll position across reloads;
 *   - keep the toolbar countdown alive after the popup closes with a one-per-
 *     second ABRA_COUNTDOWN heartbeat (identity only, no page content);
 *   - pause a running session on a real user gesture when pauseOnInteraction
 *     is on (identity-only ABRA_INTERACTION, never synthetic events);
 *   - render the element picker overlay.
 *
 * It never decides on its own whether a condition matched: it reports a
 * snapshot and acts only on the background's answer, so a stale page (wrong
 * token/generation) cannot trigger reloads.
 *
 * This file must stay a dependency-free classic script: content scripts cannot
 * import ES modules. The small helpers duplicated from core.js are marked.
 */
(() => {
  'use strict';

  const VERSION = 3;
  const PICKER_ATTR = 'data-abra-picker';
  const SCROLL_KEY = '__abra_scroll_v1';
  const MAX_TEXT_CHARS = 200000;
  /** One badge heartbeat per second; the background rate-gates faster senders. */
  const COUNTDOWN_INTERVAL_MS = 1000;
  const NOISE_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'IFRAME',
    'FRAME',
    'OBJECT',
    'EMBED',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'HEAD',
    'META',
    'LINK',
    'TITLE'
  ]);

  if (globalThis.__ABRA_ENGINE__ && globalThis.__ABRA_ENGINE__.version === VERSION) {
    // Already injected into this document. Do nothing: the background always
    // follows an injection with an explicit ABRA_HANDSHAKE, which re-attaches
    // the session without installing a second message listener.
    return;
  }
  if (typeof globalThis.__ABRA_ENGINE__?.dispose === 'function') globalThis.__ABRA_ENGINE__.dispose();

  /* ---------------------------------------------------------------------- */
  /* Duplicated pure helpers (mirror extension/core.js)                      */
  /* ---------------------------------------------------------------------- */

  const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060]/g;
  const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

  function normalizeWhitespace(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(ZERO_WIDTH_RE, '')
      .replace(CONTROL_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeCssIdentifier(value) {
    const str = String(value === null || value === undefined ? '' : value);
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

  function escapeCssString(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ')
      .replace(/\r/g, '\\d ')
      .replace(/\f/g, '\\c ');
  }

  /**
   * Interaction classification (mirror of core.js). The page only ever builds
   * the tiny plain-object shape these helpers expect; no event, key or text
   * data is ever placed in the message to the background.
   */
  const NON_TEXT_INPUT_TYPES = new Set([
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

  function isEditableInteractionTarget(info) {
    if (info.isContentEditable === true) return true;
    const tag = typeof info.tagName === 'string' ? info.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = typeof info.inputType === 'string' && info.inputType.trim() !== ''
      ? info.inputType.trim().toLowerCase()
      : 'text';
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  function isInteractionControl(info) {
    const tag = typeof info.tagName === 'string' ? info.tagName.toUpperCase() : '';
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'SUMMARY') return true;
    if (tag === 'A') return info.hasHref === true;
    if (tag === 'INPUT') return !isEditableInteractionTarget(info);
    const role = typeof info.role === 'string' ? info.role.toLowerCase() : '';
    return INTERACTION_CONTROL_ROLES.has(role);
  }

  function isMeaningfulInteraction(info) {
    if (!info || typeof info !== 'object') return false;
    if (!['pointer', 'key', 'input'].includes(info.kind)) return false;
    if (info.kind === 'pointer') return true;
    if (isEditableInteractionTarget(info)) return true;
    if (info.kind === 'input') return false;
    if (info.kind === 'key') {
      const key = typeof info.key === 'string' ? info.key : '';
      return (key === 'Enter' || key === ' ' || key === 'Spacebar') && isInteractionControl(info);
    }
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Page state                                                             */
  /* ---------------------------------------------------------------------- */

  /** @type {{tabId:number, token:string, generation:number, config:object, status:string, baseline:object|null}|null} */
  let session = null;
  let timerId = 0;
  let settleTimerId = 0;
  let cycleSeq = 0;
  let needsSettle = true;
  let picker = null;
  let countdownTimerId = 0;
  let countdownSeq = 0;
  let interactionWatchBound = false;
  let interactionPending = false;

  const engine = { version: VERSION };
  engine.dispose = () => {
    abortCycle();
    stopCountdown();
    stopInteractionWatch();
    stopPicker();
    session = null;
    engine.disposed = true;
  };

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = 0;
    }
    if (settleTimerId) {
      clearTimeout(settleTimerId);
      settleTimerId = 0;
    }
  }

  function abortCycle() {
    cycleSeq += 1;
    clearTimer();
  }

  /* ---------------------------------------------------------------------- */
  /* Countdown heartbeat                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * The popup may be closed, and a service-worker timer is never assumed to
   * live, so the page itself nudges the background once per second while a
   * session runs. The payload is identity only: the background recomputes the
   * number from its own deadline. Exactly one chained timeout exists at a time.
   */
  function stopCountdown() {
    countdownSeq += 1;
    if (countdownTimerId) {
      clearTimeout(countdownTimerId);
      countdownTimerId = 0;
    }
  }

  function scheduleCountdown(seq) {
    if (seq !== countdownSeq || !session || session.status !== 'running') return;
    countdownTimerId = setTimeout(() => {
      countdownTimerId = 0;
      countdownTick(seq);
    }, COUNTDOWN_INTERVAL_MS);
  }

  function countdownTick(seq) {
    if (seq !== countdownSeq) return;
    if (!session || session.status !== 'running') {
      stopCountdown();
      return;
    }
    sendMessage({
      type: 'ABRA_COUNTDOWN',
      tabId: session.tabId,
      token: session.token,
      generation: session.generation
    }).then((response) => {
      if (seq !== countdownSeq) return;
      if (!session || session.status !== 'running') {
        stopCountdown();
        return;
      }
      if (!response || response.ok !== true) {
        // Refused (stale session) or the worker is restarting. Stop the fast
        // heartbeat instead of hammering; the engine timer and the background
        // watchdog keep their own cadence and the next attach restarts this.
        stopCountdown();
        return;
      }
      scheduleCountdown(seq);
    });
  }

  function startCountdown() {
    stopCountdown();
    if (!session || session.status !== 'running') return;
    scheduleCountdown(countdownSeq);
  }

  /* ---------------------------------------------------------------------- */
  /* Pause on interaction                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Pause-on-interaction listeners only exist while the session runs with the
   * option enabled. They observe gestures and send identity only; the decision
   * to pause is the background's.
   */

  function stopInteractionWatch() {
    if (!interactionWatchBound) return;
    interactionWatchBound = false;
    document.removeEventListener('pointerdown', onInteractionPointer, true);
    document.removeEventListener('keydown', onInteractionKey, true);
    document.removeEventListener('beforeinput', onInteractionInput, true);
  }

  function startInteractionWatch() {
    if (!session || session.status !== 'running' || session.config.pauseOnInteraction !== true) {
      stopInteractionWatch();
      return;
    }
    if (interactionWatchBound) return;
    interactionWatchBound = true;
    document.addEventListener('pointerdown', onInteractionPointer, true);
    document.addEventListener('keydown', onInteractionKey, true);
    document.addEventListener('beforeinput', onInteractionInput, true);
  }

  /**
   * Only a real user gesture may pause: synthetic events (`isTrusted` false)
   * are ignored, an open picker owns the click, and our own picker overlay is
   * never treated as page interaction.
   */
  function interactionAllowed(event) {
    if (!session || session.status !== 'running') return false;
    if (session.config.pauseOnInteraction !== true) return false;
    if (picker) return false;
    if (!event || event.isTrusted !== true) return false;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest(`[${PICKER_ATTR}]`)) return false;
    return true;
  }

  /** Build the tiny identity-free classification object for one event target. */
  function interactionInfoFor(event) {
    const info = { kind: '', tagName: '', inputType: '', role: '', hasHref: false, isContentEditable: false };
    let element = event.target;
    if (element && element.nodeType !== 1) element = element.parentElement;
    if (element && element.nodeType === 1) {
      info.tagName = element.tagName;
      if (element.tagName === 'INPUT') {
        try {
          info.inputType = element.getAttribute('type') || '';
        } catch {
          info.inputType = '';
        }
      }
      try {
        info.role = element.getAttribute('role') || '';
      } catch {
        info.role = '';
      }
      if (element.tagName === 'A') {
        try {
          info.hasHref = Boolean(element.getAttribute('href'));
        } catch {
          info.hasHref = false;
        }
      }
      let node = element;
      while (node && node.nodeType === 1 && node.isContentEditable !== true) node = node.parentElement;
      info.isContentEditable = document.designMode === 'on' || Boolean(node && node.isContentEditable === true);
    }
    return info;
  }

  function onInteractionPointer(event) {
    if (!interactionAllowed(event)) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    if (event.isPrimary === false) return;
    requestInteractionPause();
  }

  function onInteractionKey(event) {
    if (!interactionAllowed(event)) return;
    const key = typeof event.key === 'string' ? event.key : '';
    if (key === 'Alt' || key === 'CapsLock' || key === 'Control' || key === 'Meta' || key === 'Shift') return;
    const info = interactionInfoFor(event);
    info.kind = 'key';
    info.key = key;
    if (!isMeaningfulInteraction(info)) return;
    requestInteractionPause();
  }

  function onInteractionInput(event) {
    if (!interactionAllowed(event)) return;
    const info = interactionInfoFor(event);
    info.kind = 'input';
    if (!isMeaningfulInteraction(info)) return;
    requestInteractionPause();
  }

  /**
   * Ask the background to pause the current session. The page timers are
   * stopped *before* the message is awaited, so a gesture that lands near the
   * deadline cannot race a reload that was already due. The payload is identity
   * only; the frame, document id and origin are added by the browser's sender.
   */
  function requestInteractionPause() {
    if (!session || session.status !== 'running') return;
    if (session.config.pauseOnInteraction !== true) return;
    if (interactionPending) return;
    interactionPending = true;
    abortCycle();
    stopCountdown();
    stopInteractionWatch();
    const tabId = session.tabId;
    const token = session.token;
    const generation = session.generation;
    sendMessage({
      type: 'ABRA_INTERACTION',
      tabId,
      token,
      generation,
      trusted: true
    }).then((response) => {
      interactionPending = false;
      if (!session || session.tabId !== tabId || session.token !== token) return;
      if (response && response.ok === true) {
        abortCycle();
        session.status = 'paused';
        stopCountdown();
        stopInteractionWatch();
        return;
      }
      // Refused (stale identity, a stopped session, or the option is off):
      // never resume on our own and never act on an unvalidated answer.
      if (session.status === 'running') stopForStaleAnswer(response);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Messaging                                                              */
  /* ---------------------------------------------------------------------- */

  function sendMessage(payload) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          let lastError = null;
          try {
            lastError = chrome.runtime.lastError;
          } catch {
            lastError = null;
          }
          if (lastError) {
            finish({ ok: false, error: lastError.message || 'The extension could not be reached.' });
            return;
          }
          finish(response || { ok: false, error: 'The extension did not answer.' });
        });
      } catch (error) {
        finish({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Visible text collection                                                */
  /* ---------------------------------------------------------------------- */

  function makeTreeWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  }

  function isSkippedTag(element) {
    return NOISE_TAGS.has(element.tagName);
  }

  function computeOwnVisibility(element, cache) {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    let visible = true;
    // display:none suppresses descendants; visibility:hidden can be overridden.
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || isSkippedTag(ancestor) || getComputedStyle(ancestor).display === 'none') {
        visible = false;
        break;
      }
    }
    const visibility = getComputedStyle(element).visibility;
    visible = visible && visibility !== 'hidden' && visibility !== 'collapse';
    cache.set(element, visible);
    return visible;
  }

  function isInsideAny(element, roots, cache) {
    if (!roots || roots.length === 0) return false;
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    let inside = false;
    for (let i = 0; i < roots.length; i += 1) {
      if (roots[i] === element || roots[i].contains(element)) {
        inside = true;
        break;
      }
    }
    cache.set(element, inside);
    return inside;
  }

  function safeQueryAll(root, selector) {
    if (!selector) return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function safeQuery(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (error) {
      return { __abraError: error && error.message ? error.message : 'Invalid selector' };
    }
  }

  /**
   * Normalized visible text of `root`, skipping script/style/hidden nodes, the
   * user's ignored selector and our own picker overlay.
   */
  function collectVisibleText(root, ignoreSelector) {
    if (!root) return '';
    const visibilityCache = new WeakMap();
    const ignoredCache = new WeakMap();
    const ignoredRoots = safeQueryAll(root === document.body || root === document.documentElement ? document : root, ignoreSelector);
    const parts = [];
    let total = 0;
    const walker = makeTreeWalker(root);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !isInsideAny(parent, ignoredRoots, ignoredCache) && computeOwnVisibility(parent, visibilityCache)) {
        const value = node.nodeValue;
        if (value && value.trim() !== '') {
          parts.push(value);
          total += value.length;
          if (total >= MAX_TEXT_CHARS) break;
        }
      }
      node = walker.nextNode();
    }
    return normalizeWhitespace(parts.join(' ')).slice(0, MAX_TEXT_CHARS);
  }

  function collectSnapshot(config) {
    const root = document.body || document.documentElement;
    const snapshot = {
      url: location.href,
      text: '',
      selectorText: '',
      selectorExists: false,
      selectorError: null
    };
    if (!root) return snapshot;
    snapshot.text = collectVisibleText(root, config.ignoreSelector || '');
    if (config.selector) {
      const found = safeQuery(config.selector);
      if (found && found.__abraError) {
        snapshot.selectorError = found.__abraError;
      } else if (found) {
        snapshot.selectorExists = true;
        snapshot.selectorText = collectVisibleText(found, config.ignoreSelector || '');
      }
    }
    return snapshot;
  }

  /* ---------------------------------------------------------------------- */
  /* Scroll preservation                                                    */
  /* ---------------------------------------------------------------------- */

  function scrollPosition() {
    const doc = document.documentElement;
    return {
      y: window.scrollY || (doc && doc.scrollTop) || (document.body && document.body.scrollTop) || 0,
      x: window.scrollX || (doc && doc.scrollLeft) || (document.body && document.body.scrollLeft) || 0
    };
  }

  function rememberScroll() {
    if (!session || !session.config.preserveScroll) return;
    try {
      sessionStorage.setItem(
        SCROLL_KEY,
        JSON.stringify({
          token: session.token,
          url: location.href,
          y: scrollPosition().y,
          x: scrollPosition().x
        })
      );
    } catch {
      /* storage may be blocked on some pages; scroll preservation is optional */
    }
  }

  function restoreScroll() {
    if (!session || !session.config.preserveScroll) return;
    let data = null;
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (!raw) return;
      sessionStorage.removeItem(SCROLL_KEY);
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.token !== session.token || data.url !== location.href) return;
    const y = Number(data.y);
    const x = Number(data.x);
    if (!Number.isFinite(y) || (y <= 0 && (!Number.isFinite(x) || x <= 0))) return;
    try {
      history.scrollRestoration = 'manual';
    } catch {
      /* ignore */
    }
    const apply = () => {
      try {
        window.scrollTo({ top: y || 0, left: x || 0, behavior: 'instant' });
      } catch {
        try {
          window.scrollTo(x || 0, y || 0);
        } catch {
          /* ignore */
        }
      }
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      try {
        history.scrollRestoration = 'auto';
      } catch {
        /* ignore */
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Reload                                                                 */
  /* ---------------------------------------------------------------------- */

  function delay(ms, kind) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        if (kind === 'settle') settleTimerId = 0;
        resolve();
      }, Math.max(0, ms));
      if (kind === 'settle') settleTimerId = id;
    });
  }

  function prepareReload() {
    rememberScroll();
    abortCycle();
    // Keep gestures observable until navigation actually replaces this document.
    stopCountdown();
    return { ok: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Cycle                                                                  */
  /* ---------------------------------------------------------------------- */

  function report(kind, snapshot, trigger) {
    if (!session) return Promise.resolve({ ok: false, error: 'no session' });
    return sendMessage({
      type: 'ABRA_REPORT',
      tabId: session.tabId,
      token: session.token,
      generation: session.generation,
      kind,
      trigger: trigger || 'timer',
      url: location.href,
      title: document.title || '',
      hidden: document.hidden === true,
      snapshot: snapshot || null
    });
  }

  function stopForStaleAnswer(response) {
    // The background refused this report (stale generation/token or a stopped
    // session). Never reload on an unvalidated answer.
    abortCycle();
    stopCountdown();
    stopInteractionWatch();
    if (session) session.status = 'stopped';
    if (response && response.error) {
      try {
        console.debug('[Auto Refresh] stopped:', response.error);
      } catch {
        /* ignore */
      }
    }
  }

  async function applyAction(response) {
    if (!response || response.ok !== true) {
      stopForStaleAnswer(response);
      return;
    }
    const action = response.action;
    if (action === 'stop' || action === 'pause') {
      abortCycle();
      stopCountdown();
      stopInteractionWatch();
      if (session) session.status = action === 'stop' ? 'stopped' : 'paused';
      return;
    }
    if (action === 'schedule') {
      const delayMs = Math.max(0, Number(response.delayMs) || 0);
      clearTimer();
      const seq = cycleSeq;
      timerId = setTimeout(() => {
        timerId = 0;
        if (seq !== cycleSeq) return;
        runCycle('timer');
      }, delayMs);
      return;
    }
    if (action === 'wait') {
      clearTimer();
      return;
    }
  }

  async function runCycle(trigger) {
    if (!session || session.status !== 'running') return;
    if (document.hidden && session.config.pauseWhenHidden) {
      await report('hidden');
      return;
    }
    const seq = cycleSeq;
    if (needsSettle) {
      const settleSeconds = Number(session.config.settleSeconds) || 0;
      if (settleSeconds > 0) {
        await delay(settleSeconds * 1000, 'settle');
      }
      if (seq !== cycleSeq || !session || session.status !== 'running') return;
      needsSettle = false;
    }
    if (seq !== cycleSeq || !session || session.status !== 'running') return;
    const snapshot = collectSnapshot(session.config);
    const response = await report('tick', snapshot, trigger);
    if (seq !== cycleSeq || !session) return;
    await applyAction(response);
  }

  /** The background nudges the page when its own alarm fires. */
  async function tickNow() {
    clearTimer();
    if (!session || session.status !== 'running') return { ok: true };
    if (document.hidden && session.config.pauseWhenHidden) {
      await report('hidden');
      return { ok: true };
    }
    // A watchdog nudge may arrive while the page timer is already counting
    // down; the background rejects ticks that arrive before their schedule.
    await runCycle('watchdog');
    return { ok: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Element picker                                                         */
  /* ---------------------------------------------------------------------- */

  const UNIQUE_ATTRIBUTES = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'name', 'aria-label', 'data-id'];

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function nthOfType(element) {
    const parent = element.parentElement;
    if (!parent) return 0;
    const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === element.tagName);
    if (siblings.length < 2) return 0;
    return siblings.indexOf(element) + 1;
  }

  function safeClasses(element) {
    const list = element.classList ? Array.prototype.slice.call(element.classList) : [];
    return list.filter((name) => name.length > 0 && name.length <= 60 && !/^\d/.test(name)).slice(0, 2);
  }

  function uniqueAttributeFor(element) {
    for (let i = 0; i < UNIQUE_ATTRIBUTES.length; i += 1) {
      const name = UNIQUE_ATTRIBUTES[i];
      let value = null;
      try {
        value = element.getAttribute(name);
      } catch {
        value = null;
      }
      if (!value || value.length > 100) continue;
      const candidate = `${element.tagName.toLowerCase()}[${name}="${escapeCssString(value)}"]`;
      if (isUniqueSelector(candidate)) return candidate;
    }
    return '';
  }

  function describeNode(element) {
    const tag = element.tagName.toLowerCase();
    let id = '';
    try {
      id = element.id || '';
    } catch {
      id = '';
    }
    if (id) {
      const byId = '#' + escapeCssIdentifier(id);
      if (isUniqueSelector(byId)) return byId;
    }
    const byAttribute = uniqueAttributeFor(element);
    if (byAttribute) return byAttribute;
    let part = tag;
    const classes = safeClasses(element);
    if (classes.length > 0) part += '.' + classes.map(escapeCssIdentifier).join('.');
    const index = nthOfType(element);
    if (index > 0) part += `:nth-of-type(${index})`;
    return part;
  }

  function selectorForElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    let node = element;
    const parts = [];
    let depth = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 8) {
      parts.unshift(describeNode(node));
      const candidate = parts.join(' > ');
      if (candidate.length <= 400 && isUniqueSelector(candidate)) return candidate;
      node = node.parentElement;
      depth += 1;
    }
    const fallback = parts.join(' > ');
    return fallback.length <= 400 ? fallback : parts.slice(-3).join(' > ').slice(0, 400);
  }

  function pickerElements() {
    const overlay = document.createElement('div');
    overlay.setAttribute(PICKER_ATTR, '1');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:transparent;';
    const highlight = document.createElement('div');
    highlight.setAttribute(PICKER_ATTR, '1');
    highlight.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid #0f766e;' +
      'background:rgba(15,118,110,0.12);border-radius:4px;box-shadow:0 0 0 1px rgba(15,23,42,0.25);';
    const label = document.createElement('div');
    label.setAttribute(PICKER_ATTR, '1');
    label.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;' +
      'background:#0f172a;color:#f8fafc;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;' +
      'padding:8px 14px;border-radius:999px;box-shadow:0 10px 30px rgba(15,23,42,0.35);max-width:80vw;text-align:center;';
    label.textContent = 'Click the element to watch. Press Escape to cancel.';
    return { overlay, highlight, label };
  }

  function stopPicker() {
    if (!picker) return;
    const active = picker;
    picker = null;
    document.removeEventListener('mousemove', active.onMove, true);
    document.removeEventListener('click', active.onClick, true);
    document.removeEventListener('keydown', active.onKey, true);
    window.removeEventListener('scroll', active.onMove, true);
    [active.overlay, active.highlight, active.label].forEach((node) => {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    if (active.previousCursor !== null) {
      try {
        document.documentElement.style.cursor = active.previousCursor;
      } catch {
        /* ignore */
      }
    }
  }

  function startPicker(pickToken, tabId) {
    stopPicker();
    const nodes = pickerElements();
    const active = {
      pickToken,
      tabId: Number(tabId),
      active: true,
      hover: null,
      previousCursor: null,
      overlay: nodes.overlay,
      highlight: nodes.highlight,
      label: nodes.label
    };

    const hideHighlight = () => {
      active.highlight.style.display = 'none';
      active.hover = null;
    };

    const drawHighlight = (element) => {
      if (!element || !element.isConnected) {
        hideHighlight();
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) {
        hideHighlight();
        return;
      }
      active.highlight.style.display = 'block';
      active.highlight.style.top = `${Math.max(rect.top, 0)}px`;
      active.highlight.style.left = `${Math.max(rect.left, 0)}px`;
      active.highlight.style.width = `${Math.max(rect.width, 0)}px`;
      active.highlight.style.height = `${Math.max(rect.height, 0)}px`;
    };

    const elementAt = (x, y) => {
      let target = null;
      try {
        target = document.elementFromPoint(x, y);
      } catch {
        target = null;
      }
      if (!target) return null;
      if (target.closest && target.closest(`[${PICKER_ATTR}]`)) return null;
      if (target === document.documentElement || target === document.body) return null;
      return target;
    };

    active.onMove = (event) => {
      const x = event.clientX;
      const y = event.clientY;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const target = elementAt(x, y);
      if (!target) {
        hideHighlight();
        return;
      }
      active.hover = target;
      drawHighlight(target);
    };

    active.onClick = (event) => {
      const target = elementAt(event.clientX, event.clientY) || active.hover;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (!target) return;
      const selector = selectorForElement(target);
      const tabId = session ? session.tabId : active.tabId;
      stopPicker();
      sendMessage({
        type: 'ABRA_PICKED',
        tabId,
        pickToken,
        token: session ? session.token : undefined,
        generation: session ? session.generation : undefined,
        selector,
        url: location.href
      });
    };

    active.onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      const tabId = session ? session.tabId : active.tabId;
      stopPicker();
      sendMessage({
        type: 'ABRA_PICK_CANCELLED',
        tabId,
        pickToken,
        token: session ? session.token : undefined,
        generation: session ? session.generation : undefined
      });
    };

    picker = active;
    const root = document.body || document.documentElement;
    root.appendChild(nodes.overlay);
    root.appendChild(nodes.highlight);
    root.appendChild(nodes.label);
    try {
      active.previousCursor = document.documentElement.style.cursor || '';
      document.documentElement.style.cursor = 'crosshair';
    } catch {
      active.previousCursor = null;
    }
    document.addEventListener('mousemove', active.onMove, true);
    document.addEventListener('click', active.onClick, true);
    document.addEventListener('keydown', active.onKey, true);
    window.addEventListener('scroll', active.onMove, true);
  }

  /* ---------------------------------------------------------------------- */
  /* Background -> page messages                                            */
  /* ---------------------------------------------------------------------- */

  function identityMatches(msg) {
    if (!session) return false;
    if (Number(msg.tabId) !== session.tabId) return false;
    if (typeof msg.token !== 'string' || msg.token !== session.token) return false;
    if (Number(msg.generation) !== session.generation) return false;
    return true;
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;

    if (msg.type === 'ABRA_HANDSHAKE') {
      return Promise.resolve({
        ok: true,
        ready: true,
        version: VERSION,
        url: location.href,
        title: document.title || '',
        hasSession: Boolean(session) && session.status !== 'stopped'
      });
    }

    if (msg.type === 'ABRA_SESSION') {
      const previous = session;
      session = {
        tabId: Number(msg.tabId),
        token: String(msg.token || ''),
        generation: Number(msg.generation) || 1,
        config: msg.config && typeof msg.config === 'object' ? msg.config : {},
        status: typeof msg.status === 'string' ? msg.status : 'running',
        baseline: msg.baseline || null
      };
      abortCycle();
      needsSettle = true;
      stopPicker();
      restoreScroll();
      // Re-injection or a re-attach resets the heartbeat instead of stacking a
      // second timer, and stops it when the attached status is not running.
      startCountdown();
      startInteractionWatch();
      if (session.status === 'running') {
        const delayMs = Math.max(0, Number(msg.delayMs) || 0);
        const seq = cycleSeq;
        timerId = setTimeout(() => {
          timerId = 0;
          if (seq !== cycleSeq) return;
          runCycle('session');
        }, delayMs);
      }
      return Promise.resolve({
        ok: true,
        ready: true,
        url: location.href,
        title: document.title || '',
        replacedStale: Boolean(previous && previous.token !== session.token)
      });
    }

    if (msg.type === 'ABRA_TICK') {
      if (!identityMatches(msg)) {
        return Promise.resolve({ ok: false, error: 'stale session identity' });
      }
      return tickNow().then(() => ({ ok: true }));
    }

    if (msg.type === 'ABRA_PREPARE_RELOAD') {
      if (!identityMatches(msg)) return Promise.resolve({ ok: false, error: 'stale session identity' });
      if (interactionPending) return Promise.resolve({ ok: false, error: 'interaction pause pending' });
      return Promise.resolve(prepareReload());
    }

    if (msg.type === 'ABRA_STATUS') {
      // Lifecycle changes advance generation; accept only this token and a
      // current or newer generation, so an old session cannot stop a new one.
      if (!session || Number(msg.tabId) !== session.tabId || msg.token !== session.token ||
          !Number.isInteger(msg.generation) || msg.generation < session.generation) {
        return Promise.resolve({ ok: false, error: 'stale session identity' });
      }
      session.generation = msg.generation;
      const status = String(msg.status || 'stopped');
      abortCycle();
      if (session) session.status = status;
      if (status === 'running') {
        startCountdown();
        startInteractionWatch();
      } else {
        stopCountdown();
        stopInteractionWatch();
      }
      if (status !== 'running') stopPicker();
      return Promise.resolve({ ok: true, status });
    }

    if (msg.type === 'ABRA_PICK') {
      if (msg.active === false || !msg.pickToken) {
        stopPicker();
        return Promise.resolve({ ok: true, picker: false });
      }
      startPicker(String(msg.pickToken), msg.tabId);
      return Promise.resolve({ ok: true, picker: true });
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (engine.disposed) return false;
    let result = null;
    try {
      result = handleMessage(msg);
    } catch (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      return false;
    }
    if (!result) return false;
    Promise.resolve(result)
      .then((value) => sendResponse(value))
      .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }));
    return true;
  });

  /* ---------------------------------------------------------------------- */
  /* Visibility                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * The tab came back to the foreground (or was restored from the bfcache).
   * Report it so the engine cadence resumes and restart the badge heartbeat.
   */
  function resumeVisible() {
    if (!session || session.status !== 'running') return;
    abortCycle();
    report('visible').then((response) => {
      if (response && response.ok === true && response.action === 'schedule') {
        applyAction(response);
        startCountdown();
        return;
      }
      if (!response || response.ok !== true) stopCountdown();
    });
  }

  document.addEventListener(
    'visibilitychange',
    () => {
      if (!session || session.status !== 'running') return;
      if (document.hidden && session.config.pauseWhenHidden) {
        abortCycle();
        stopCountdown();
        report('hidden');
        return;
      }
      if (!document.hidden) resumeVisible();
    },
    true
  );

  window.addEventListener(
    'pageshow',
    () => {
      // bfcache restore: the document is alive again but its timers were
      // stopped on pagehide, so bring the heartbeat back.
      if (!document.hidden) startCountdown();
    },
    true
  );

  window.addEventListener(
    'pagehide',
    () => {
      abortCycle();
      stopCountdown();
      stopInteractionWatch();
      stopPicker();
    },
    true
  );

  globalThis.__ABRA_ENGINE__ = engine;
})();
