/**
 * Engine tests for The Best Auto Refresh App.
 * Run with `npm test` (node --test tests/). No dependencies, no browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BADGE_PENDING_TEXT,
  COUNTDOWN_MIN_GAP_MS,
  DEFAULT_CONFIG,
  MIN_INTERVAL_SECONDS,
  STOP_CONDITIONS,
  UI_MESSAGE_TYPES,
  alarmNameForTab,
  attributeSelector,
  badgeColorFor,
  badgeCountdownText,
  badgeTextFor,
  buildSelectorFromParts,
  bumpGeneration,
  clampIntervalSeconds,
  compactCountdownText,
  countdownSecondsUntil,
  createBaseline,
  createSessionRecord,
  describeRestrictedTarget,
  escapeCssIdentifier,
  escapeCssString,
  evaluateCondition,
  evaluateLimits,
  intervalMsFor,
  isRestrictedUrl,
  looksLikeValidSelector,
  matchText,
  normalizeSnapshot,
  normalizeText,
  normalizeWhitespace,
  originOf,
  pickIntervalSeconds,
  planCycle,
  publicSessionState,
  sameOrigin,
  sessionBadgeText,
  shouldAcceptCountdown,
  shouldAcceptTick,
  tabIdFromAlarmName,
  truncateText,
  usesPageTimer,
  validateConfig,
  validateContentMessage,
  validateCountdownMessage,
  validatePickMessage,
  validateUiMessage,
  watchdogDelayMs,
  withDefaults
} from '../extension/core.js';

/* -------------------------------------------------------------------------- */
/* Text normalization                                                         */
/* -------------------------------------------------------------------------- */

test('normalizeWhitespace collapses runs, strips zero-width chars and trims', () => {
  assert.equal(normalizeWhitespace('  a\t\tb\n c  '), 'a b c');
  assert.equal(normalizeWhitespace('a\u00a0\u00a0b'), 'a b');
  assert.equal(normalizeWhitespace('\u200bhello\u200b \u200fworld'), 'hello world');
  assert.equal(normalizeWhitespace('a\u0000b'), 'a b');
  assert.equal(normalizeWhitespace('   '), '');
  assert.equal(normalizeWhitespace(null), '');
  assert.equal(normalizeWhitespace(undefined), '');
  assert.equal(normalizeWhitespace(42), '42');
});

test('normalizeText folds case only when asked', () => {
  assert.equal(normalizeText('Hello   World'), 'hello world');
  assert.equal(normalizeText('Hello   World', { caseSensitive: true }), 'Hello World');
  assert.equal(normalizeText(undefined), '');
});

test('truncateText caps oversized snapshots', () => {
  assert.deepEqual(truncateText('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(truncateText('abc', 3), { text: 'abc', truncated: false });
});

test('matchText handles case and whole-word matching', () => {
  assert.equal(matchText('The PORT is open', 'port'), true);
  assert.equal(matchText('The Port is open', 'port', { caseSensitive: true }), false);
  assert.equal(matchText('The Port is open', 'Port', { caseSensitive: true }), true);
  assert.equal(matchText('important', 'port', { wholeWord: true }), false);
  assert.equal(matchText('port 80 open', 'port', { wholeWord: true }), true);
  assert.equal(matchText('error: bad gateway', 'error', { wholeWord: true }), true);
  assert.equal(matchText('terror', 'error', { wholeWord: true }), false);
  assert.equal(matchText('a\tb', 'a b'), true);
  assert.equal(matchText('anything at all', ''), false);
  assert.equal(matchText('', 'anything'), false);
  assert.equal(matchText('Out_of_stock', 'Out_of_stock', { wholeWord: true }), true);
  assert.equal(matchText('Out_of_stock!', 'stock', { wholeWord: true }), false);
});

test('normalizeSnapshot keeps only the comparable fields', () => {
  const snapshot = normalizeSnapshot({
    text: '  hello \n world ',
    selectorText: 5,
    selectorExists: 'yes',
    url: 'https://example.com/'
  });
  assert.deepEqual(snapshot, {
    text: 'hello world',
    selectorText: '',
    selectorExists: false,
    url: 'https://example.com/'
  });
});

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

const fixed = (overrides) => validateConfig({ intervalSeconds: 10, ...overrides }).config;

test('page-change captures a baseline and matches only on real text change', () => {
  const config = fixed({ stopCondition: 'page-change' });

  const empty = evaluateCondition({ baseline: null, current: { text: '   ' }, config });
  assert.equal(empty.status, 'baseline');
  assert.equal(empty.baseline, null, 'empty page text must not become a baseline');

  const first = evaluateCondition({ baseline: null, current: { text: 'Queue: 3' }, config });
  assert.equal(first.status, 'baseline');
  assert.ok(first.baseline);
  assert.equal(first.baseline.hasText, true);

  const same = evaluateCondition({ baseline: first.baseline, current: { text: 'Queue:   3' }, config });
  assert.equal(same.status, 'continue', 'whitespace-only differences are not changes');

  const changed = evaluateCondition({ baseline: first.baseline, current: { text: 'Queue: 4' }, config });
  assert.equal(changed.status, 'matched');
  assert.match(changed.reason, /changed/i);
});

test('element-change never treats a missing selector as a baseline', () => {
  const config = fixed({ stopCondition: 'element-change', selector: '.status' });

  const missing = evaluateCondition({
    baseline: null,
    current: { text: 'body text', selectorExists: false, selectorText: '' },
    config
  });
  assert.equal(missing.status, 'baseline');
  assert.equal(missing.baseline, null);

  // The element appearing later establishes the baseline, it is not a "change".
  const appeared = evaluateCondition({
    baseline: missing.baseline,
    current: { text: 'body text', selectorExists: true, selectorText: 'Loading' },
    config
  });
  assert.equal(appeared.status, 'baseline');
  assert.ok(appeared.baseline);
  assert.equal(appeared.baseline.hasSelector, true);

  const unchanged = evaluateCondition({
    baseline: appeared.baseline,
    current: { text: 'body text', selectorExists: true, selectorText: 'Loading' },
    config
  });
  assert.equal(unchanged.status, 'continue');

  const changed = evaluateCondition({
    baseline: appeared.baseline,
    current: { text: 'body text', selectorExists: true, selectorText: 'Ready' },
    config
  });
  assert.equal(changed.status, 'matched');

  const removed = evaluateCondition({
    baseline: appeared.baseline,
    current: { text: 'body text', selectorExists: false, selectorText: '' },
    config
  });
  assert.equal(removed.status, 'matched');
  assert.match(removed.reason, /disappeared/i);
});

test('createBaseline records validity flags', () => {
  const baseline = createBaseline({ text: '', selectorExists: true, selectorText: 'x' }, 1234);
  assert.equal(baseline.hasText, false);
  assert.equal(baseline.hasSelector, true);
  assert.equal(baseline.capturedAt, 1234);
});

test('keyword-found and keyword-missing respect case and whole word', () => {
  const found = fixed({ stopCondition: 'keyword-found', keyword: 'sold out' });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'Now SOLD OUT' }, config: found }).status, 'matched');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'in stock' }, config: found }).status, 'continue');

  const caseSensitive = fixed({ stopCondition: 'keyword-found', keyword: 'sold out', caseSensitive: true });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'Now SOLD OUT' }, config: caseSensitive }).status, 'continue');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'all sold out now' }, config: caseSensitive }).status, 'matched');

  const wholeWord = fixed({ stopCondition: 'keyword-found', keyword: 'ok', wholeWord: true });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'tokens' }, config: wholeWord }).status, 'continue');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'ok!' }, config: wholeWord }).status, 'matched');

  const missing = fixed({ stopCondition: 'keyword-missing', keyword: 'loading' });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'all done' }, config: missing }).status, 'matched');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'Loading…' }, config: missing }).status, 'continue');
});

test('keyword conditions are scoped to the selector and wait while it is absent', () => {
  const found = fixed({ stopCondition: 'keyword-found', keyword: 'sold out', selector: '#stock' });
  assert.equal(
    evaluateCondition({ baseline: null, current: { text: 'rest of page says sold out', selectorExists: true, selectorText: 'in stock' }, config: found }).status,
    'continue',
    'page text outside the scope must not satisfy a scoped keyword'
  );
  assert.equal(
    evaluateCondition({ baseline: null, current: { text: 'rest of page says sold out', selectorExists: true, selectorText: 'sold out' }, config: found }).status,
    'matched'
  );
  const scopeGone = evaluateCondition({ baseline: null, current: { text: 'sold out', selectorExists: false }, config: found });
  assert.equal(scopeGone.status, 'continue');
  assert.equal(scopeGone.keywordFound, false);

  const missing = fixed({ stopCondition: 'keyword-missing', keyword: 'sold out', selector: '#stock' });
  assert.equal(
    evaluateCondition({ baseline: null, current: { text: 'sold out', selectorExists: true, selectorText: 'in stock' }, config: missing }).status,
    'matched'
  );
  assert.equal(
    evaluateCondition({ baseline: null, current: { text: 'plain page', selectorExists: false }, config: missing }).status,
    'continue',
    'a missing scope must not be reported as "keyword missing"'
  );
});

test('element-found and element-missing report existence', () => {
  const found = fixed({ stopCondition: 'element-found', selector: '.done' });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'x', selectorExists: true }, config: found }).status, 'matched');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'x', selectorExists: false }, config: found }).status, 'continue');

  const missing = fixed({ stopCondition: 'element-missing', selector: '.spinner' });
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'x', selectorExists: false }, config: missing }).status, 'matched');
  assert.equal(evaluateCondition({ baseline: null, current: { text: 'x', selectorExists: true }, config: missing }).status, 'continue');
});

test('never keeps refreshing and keeps a reporting baseline', () => {
  const config = fixed({ stopCondition: 'never' });
  const result = evaluateCondition({ baseline: null, current: { text: 'page' }, config, now: 500 });
  assert.equal(result.status, 'continue');
  assert.equal(result.baseline.text, 'page');
  assert.equal(result.baseline.capturedAt, 500);
});

test('evaluateLimits stops on refresh and duration budgets', () => {
  const now = 1_000_000;
  assert.equal(evaluateLimits({ config: { maxRefreshes: 0 }, refreshCount: 999, startedAt: 0 }, now).stopped, false);
  assert.equal(evaluateLimits({ config: { maxRefreshes: 3 }, refreshCount: 2, startedAt: now }, now).stopped, false);
  const refreshes = evaluateLimits({ config: { maxRefreshes: 3 }, refreshCount: 3, startedAt: now }, now);
  assert.equal(refreshes.stopped, true);
  assert.equal(refreshes.status, 'stopped');
  assert.match(refreshes.reason, /maximum of 3 refreshes/);

  const minutes = evaluateLimits({ config: { maxMinutes: 1 }, refreshCount: 0, startedAt: now - 61_000 }, now);
  assert.equal(minutes.stopped, true);
  assert.match(minutes.reason, /maximum duration/);
  assert.equal(evaluateLimits({ config: { maxMinutes: 1 }, refreshCount: 0, startedAt: now - 30_000 }, now).stopped, false);
  assert.equal(evaluateLimits({ config: { maxMinutes: 0 }, refreshCount: 0, startedAt: 0 }, now).stopped, false);
});

/* -------------------------------------------------------------------------- */
/* Configuration and bounds                                                   */
/* -------------------------------------------------------------------------- */

test('validateConfig fills defaults for an empty request', () => {
  const result = validateConfig(undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { ...DEFAULT_CONFIG });
});

test('validateConfig enforces the 5 second interval floor', () => {
  const tooFast = validateConfig({ intervalSeconds: 3 });
  assert.equal(tooFast.ok, false);
  assert.equal(tooFast.errors[0].field, 'intervalSeconds');
  assert.match(tooFast.error, /intervalSeconds must be between 5s and 86400s/);

  assert.equal(validateConfig({ intervalSeconds: 5 }).ok, true);
  assert.equal(validateConfig({ intervalSeconds: MIN_INTERVAL_SECONDS }).config.intervalSeconds, 5);

  const randomTooFast = validateConfig({ intervalMode: 'random', minSeconds: 2, maxSeconds: 30 });
  assert.equal(randomTooFast.ok, false);
  assert.ok(randomTooFast.errors.some((entry) => entry.field === 'minSeconds'));
});

test('validateConfig rejects inverted and out-of-range numbers', () => {
  const inverted = validateConfig({ intervalMode: 'random', minSeconds: 60, maxSeconds: 20 });
  assert.equal(inverted.ok, false);
  assert.ok(inverted.errors.some((entry) => entry.field === 'maxSeconds'));

  assert.equal(validateConfig({ intervalSeconds: 'abc' }).ok, false);
  assert.equal(validateConfig({ settleSeconds: 61 }).ok, false);
  assert.equal(validateConfig({ settleSeconds: 0 }).ok, true);
  assert.equal(validateConfig({ maxRefreshes: -1 }).ok, false);
  assert.equal(validateConfig({ maxMinutes: -5 }).ok, false);
  assert.equal(validateConfig({ maxRefreshes: 12, maxMinutes: 90 }).ok, true);
  assert.equal(validateConfig({ intervalMode: 'sometimes' }).ok, false);
  assert.equal(validateConfig({ intervalSeconds: 90000 }).ok, false);
});

test('validateConfig requires keyword and selector where the condition needs them', () => {
  for (const condition of ['keyword-found', 'keyword-missing']) {
    const missing = validateConfig({ stopCondition: condition });
    assert.equal(missing.ok, false, `${condition} needs a keyword`);
    assert.ok(missing.errors.some((entry) => entry.field === 'keyword'));
  }
  for (const condition of ['element-change', 'element-found', 'element-missing']) {
    const missing = validateConfig({ stopCondition: condition });
    assert.equal(missing.ok, false, `${condition} needs a selector`);
    assert.ok(missing.errors.some((entry) => entry.field === 'selector'));
  }
  assert.equal(validateConfig({ stopCondition: 'element-found', selector: '#done .badge' }).ok, true);
  assert.equal(validateConfig({ stopCondition: 'keyword-found', keyword: 'sold out' }).ok, true);
  assert.equal(validateConfig({ stopCondition: 'page-change' }).ok, true);
  assert.equal(validateConfig({ stopCondition: 'bogus' }).ok, false);
});

test('validateConfig rejects malformed selectors and coerces booleans', () => {
  const badSelector = validateConfig({ selector: 'div { color: red }' });
  assert.equal(badSelector.ok, false);
  assert.ok(badSelector.errors.some((entry) => entry.field === 'selector'));

  const unbalanced = validateConfig({ ignoreSelector: 'div[data-x=' });
  assert.equal(unbalanced.ok, false);
  assert.ok(unbalanced.errors.some((entry) => entry.field === 'ignoreSelector'));

  const coerced = validateConfig({ caseSensitive: 'true', wholeWord: false, preserveScroll: 'false', pauseWhenHidden: true });
  assert.equal(coerced.ok, true);
  assert.equal(coerced.config.caseSensitive, true);
  assert.equal(coerced.config.wholeWord, false);
  assert.equal(coerced.config.preserveScroll, false);
  assert.equal(coerced.config.pauseWhenHidden, true);

  assert.equal(validateConfig({ caseSensitive: 'yes' }).ok, false);
  assert.equal(validateConfig({ keyword: 'x'.repeat(501), stopCondition: 'keyword-found' }).ok, false);
  assert.equal(validateConfig({ selector: 'x'.repeat(1001) }).ok, false);
});

test('invalid config still returns a safe, complete shape', () => {
  const result = validateConfig({ intervalSeconds: 1, stopCondition: 'element-change' });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.equal(typeof result.error, 'string');
  assert.equal(result.config.intervalSeconds, 5, 'out-of-range values are clamped in the draft config');
  assert.equal(typeof result.config.settleSeconds, 'number');
});

test('withDefaults merges partial configuration', () => {
  const merged = withDefaults({ intervalSeconds: 45 });
  assert.equal(merged.intervalSeconds, 45);
  assert.equal(merged.settleSeconds, DEFAULT_CONFIG.settleSeconds);
  assert.equal(merged.stopCondition, 'never');
});

/* -------------------------------------------------------------------------- */
/* Cycle planning (timing model)                                              */
/* -------------------------------------------------------------------------- */

test('planCycle never reloads before the interval has elapsed', () => {
  const config = validateConfig({ intervalSeconds: 10, stopCondition: 'never' }).config;
  const now = 1_000_000;

  const first = planCycle({
    record: { config, baseline: null, refreshCount: 0, startedAt: now, nextRefreshAt: null },
    snapshot: { text: 'Queue: 3' },
    now,
    random: () => 0
  });
  assert.equal(first.kind, 'wait', 'the first cycle only arms the interval');
  assert.equal(first.nextRefreshAt, now + 10_000);
  assert.equal(first.delayMs, 10_000);
  assert.equal(first.baseline.hasText, true);

  const early = planCycle({
    record: { config, baseline: first.baseline, refreshCount: 0, startedAt: now, nextRefreshAt: first.nextRefreshAt },
    snapshot: { text: 'Queue: 3' },
    now: now + 5_000,
    random: () => 0
  });
  assert.equal(early.kind, 'wait');
  assert.equal(early.delayMs, 5_000);
  assert.equal(early.nextRefreshAt, now + 10_000);

  const due = planCycle({
    record: { config, baseline: first.baseline, refreshCount: 0, startedAt: now, nextRefreshAt: first.nextRefreshAt },
    snapshot: { text: 'Queue: 3' },
    now: now + 10_000,
    random: () => 0
  });
  assert.equal(due.kind, 'reload');
  assert.equal(due.refreshCount, 1);
  assert.equal(due.nextRefreshAt, now + 20_000);
});

test('planCycle reports matched, stopped and error endings precisely', () => {
  const config = validateConfig({ intervalSeconds: 10, stopCondition: 'keyword-found', keyword: 'done' }).config;
  const now = 5_000;

  const matched = planCycle({
    record: { config, refreshCount: 3, startedAt: now - 1_000, nextRefreshAt: now + 9_000 },
    snapshot: { text: 'all done' },
    now
  });
  assert.equal(matched.kind, 'matched');
  assert.equal(matched.lastResult.met, true);
  assert.equal(matched.refreshCount, 3, 'a match is not a refresh');
  assert.equal(matched.nextRefreshAt, null);

  const maxed = planCycle({
    record: { config: { ...config, maxRefreshes: 2 }, refreshCount: 2, startedAt: now - 1_000, nextRefreshAt: now + 9_000 },
    snapshot: { text: 'not yet' },
    now
  });
  assert.equal(maxed.kind, 'stopped');
  assert.match(maxed.reason, /maximum of 2 refreshes/);

  const aged = planCycle({
    record: { config: { ...config, maxMinutes: 1 }, refreshCount: 0, startedAt: now - 61_000, nextRefreshAt: now },
    snapshot: { text: 'not yet' },
    now
  });
  assert.equal(aged.kind, 'stopped');
  assert.match(aged.reason, /maximum duration/);

  const broken = planCycle({
    record: { config, refreshCount: 0, startedAt: now, nextRefreshAt: now },
    snapshot: { text: '', selectorError: 'not a valid selector' },
    now
  });
  assert.equal(broken.kind, 'error');
  assert.match(broken.reason, /not a valid selector/);
});

test('planCycle keeps pending element baselines and honors random intervals', () => {
  const config = validateConfig({ intervalSeconds: 10, stopCondition: 'element-change', selector: '.status' }).config;
  const now = 10_000;

  const missing = planCycle({
    record: { config, baseline: null, refreshCount: 0, startedAt: now, nextRefreshAt: now + 10_000 },
    snapshot: { text: 'body text', selectorExists: false },
    now
  });
  assert.equal(missing.kind, 'wait');
  assert.equal(missing.baseline, null, 'a missing selector is never a baseline');

  const randomConfig = validateConfig({ intervalMode: 'random', minSeconds: 20, maxSeconds: 60 }).config;
  const lowest = planCycle({
    record: { config: randomConfig, baseline: null, refreshCount: 0, startedAt: now, nextRefreshAt: null },
    snapshot: { text: 'x' },
    now,
    random: () => 0
  });
  assert.equal(lowest.nextRefreshAt, now + 20_000);
  const highest = planCycle({
    record: { config: randomConfig, baseline: null, refreshCount: 0, startedAt: now, nextRefreshAt: null },
    snapshot: { text: 'x' },
    now,
    random: () => 0.9999999
  });
  assert.equal(highest.nextRefreshAt, now + 60_000);
});

test('intervalMsFor respects the 5 second floor', () => {
  assert.equal(intervalMsFor({ intervalMode: 'fixed', intervalSeconds: 3 }), 5000);
  assert.equal(intervalMsFor({ intervalMode: 'fixed', intervalSeconds: 30 }), 30000);
  assert.equal(intervalMsFor({ intervalMode: 'random', minSeconds: 1, maxSeconds: 2 }, () => 0), 5000);
});

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

test('pickIntervalSeconds honors fixed, random and the 5s floor', () => {
  assert.equal(clampIntervalSeconds(1), 5);
  assert.equal(clampIntervalSeconds(75), 75);
  assert.equal(pickIntervalSeconds({ intervalMode: 'fixed', intervalSeconds: 3 }), 5);
  assert.equal(pickIntervalSeconds({ intervalMode: 'fixed', intervalSeconds: 30 }), 30);
  assert.equal(pickIntervalSeconds({ intervalMode: 'random', minSeconds: 10, maxSeconds: 20 }, () => 0), 10);
  assert.equal(pickIntervalSeconds({ intervalMode: 'random', minSeconds: 10, maxSeconds: 20 }, () => 0.999999), 20);
  assert.equal(pickIntervalSeconds({ intervalMode: 'random', minSeconds: 10, maxSeconds: 20 }, () => 0.5), 15);
  assert.equal(pickIntervalSeconds({ intervalMode: 'random', minSeconds: 10, maxSeconds: 20 }, () => 5), 20);
  assert.equal(pickIntervalSeconds({ intervalMode: 'random', minSeconds: 2, maxSeconds: 3 }, () => 0), 5);
});

test('alarm helpers keep the 30 second alarm floor', () => {
  assert.equal(usesPageTimer(29_999), true);
  assert.equal(usesPageTimer(30_000), false);
  assert.equal(usesPageTimer(0), true);
  assert.equal(watchdogDelayMs(0), 30_000);
  assert.equal(watchdogDelayMs(5_000), 30_000);
  assert.equal(watchdogDelayMs(30_000), 45_000);
  assert.equal(watchdogDelayMs(60_000), 75_000);

  assert.equal(alarmNameForTab(42), 'abra-watchdog:42');
  assert.equal(tabIdFromAlarmName('abra-watchdog:42'), 42);
  assert.equal(tabIdFromAlarmName('abra-watchdog:abc'), null);
  assert.equal(tabIdFromAlarmName(null), null);
});

/* -------------------------------------------------------------------------- */
/* Sessions and message validation                                            */
/* -------------------------------------------------------------------------- */

const makeRecord = (overrides = {}) =>
  Object.assign(createSessionRecord({ tabId: 7, token: 'token-abc', config: { intervalSeconds: 10 }, now: 1_000 }), overrides);

test('publicSessionState exposes exactly the UI contract and no secrets', () => {
  const record = makeRecord({ url: 'https://example.com/', title: 'Example', baseline: { text: 'secret-ish' } });
  const state = publicSessionState(record);
  assert.deepEqual(Object.keys(state).sort(), [
    'config',
    'error',
    'lastCheckedAt',
    'lastResult',
    'nextRefreshAt',
    'refreshCount',
    'startedAt',
    'status',
    'tabId',
    'title',
    'url'
  ]);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('token-abc'), false);
  assert.equal(serialized.includes('baseline'), false);
  assert.equal(state.tabId, 7);
  assert.equal(state.status, 'running');
  assert.equal(state.nextRefreshAt, null);
  assert.equal(state.startedAt, 1_000);
  assert.equal(state.error, null);
  assert.equal(publicSessionState(null), null);
});

test('bumpGeneration invalidates messages from the previous generation', () => {
  const record = makeRecord();
  const sender = { tab: { id: 7 }, url: 'https://example.com/' };
  const message = { type: 'ABRA_REPORT', tabId: 7, token: 'token-abc', generation: 1 };
  assert.equal(validateContentMessage(record, sender, message).ok, true);

  bumpGeneration(record);
  assert.equal(record.generation, 2);
  const stale = validateContentMessage(record, sender, message);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /stale session generation/i);
});

test('validateContentMessage rejects forged, stale and unsupported messages', () => {
  const record = makeRecord();
  const goodSender = { tab: { id: 7 }, url: 'https://example.com/' };
  const base = { type: 'ABRA_REPORT', tabId: 7, token: 'token-abc', generation: 1 };

  assert.equal(validateContentMessage(record, goodSender, { ...base }).ok, true);
  assert.equal(validateContentMessage(record, { tab: { id: 8 } }, { ...base }).ok, false, 'forged sender tab');
  assert.equal(validateContentMessage(record, goodSender, { ...base, tabId: 8 }).ok, false, 'payload tab mismatch');
  assert.equal(validateContentMessage(record, goodSender, { ...base, token: 'other' }).ok, false, 'forged token');
  assert.equal(validateContentMessage(record, goodSender, { ...base, token: '' }).ok, false, 'empty token');
  assert.equal(validateContentMessage(record, goodSender, { ...base, generation: 0 }).ok, false, 'stale generation');
  assert.equal(validateContentMessage(record, goodSender, { ...base, type: 'START' }).ok, false, 'UI type from a page');
  assert.equal(validateContentMessage(record, goodSender, null).ok, false, 'malformed payload');
  assert.equal(validateContentMessage(null, goodSender, { ...base }).ok, false, 'no session for tab');
  assert.equal(validateContentMessage(record, { url: 'https://example.com/' }, { ...base }).ok, false, 'no sender.tab');
  assert.equal(validateContentMessage(record, goodSender, { ...base, generation: '2' }).ok, false, 'string generation mismatch');
  assert.equal(validateContentMessage(record, goodSender, { ...base, generation: '1' }).ok, true, 'numeric strings are accepted');

  const finished = makeRecord({ status: 'matched' });
  assert.equal(validateContentMessage(finished, goodSender, { ...base }).ok, false, 'finished session');
});

test('validateUiMessage only accepts extension pages with contract types', () => {
  const context = { extensionId: 'abc', extensionOrigin: 'chrome-extension://abc/' };
  const popup = { id: 'abc', url: 'chrome-extension://abc/popup.html' };
  const optionsTab = { id: 'abc', url: 'chrome-extension://abc/options.html', tab: { id: 3 } };
  const page = { id: 'abc', url: 'https://example.com/', tab: { id: 3 } };

  assert.equal(validateUiMessage(popup, { type: 'START', tabId: 1, config: {} }, context).ok, true);
  assert.equal(validateUiMessage(optionsTab, { type: 'GET_ALL' }, context).ok, true);
  assert.equal(validateUiMessage(popup, { type: 'GET_ALL' }, { ...context, extensionOrigin: '' }).ok, false);
  assert.equal(validateUiMessage(page, { type: 'START', tabId: 1 }, context).ok, false);
  assert.equal(validateUiMessage({ id: 'evil', url: 'chrome-extension://abc/popup.html' }, { type: 'STOP' }, context).ok, false);
  assert.equal(validateUiMessage(popup, { type: 'ABRA_REPORT', tabId: 1 }, context).ok, false);
  assert.equal(validateUiMessage(popup, null, context).ok, false);
  assert.equal(validateUiMessage(null, { type: 'STOP' }, context).ok, false);
});

test('validatePickMessage authorizes by one-time token with a TTL', () => {
  const sender = { tab: { id: 3 }, url: 'https://example.com/' };
  const pending = { tabId: 3, token: 'pick-1', expiresAt: 2_000 };
  const message = { type: 'ABRA_PICKED', tabId: 3, pickToken: 'pick-1', selector: '.price' };

  assert.equal(validatePickMessage(pending, null, sender, message, 1_000).ok, true);
  assert.equal(validatePickMessage(pending, null, sender, message, 2_001).ok, false, 'expired request');
  assert.equal(validatePickMessage(pending, null, sender, { ...message, pickToken: 'nope' }, 1_000).ok, false);
  assert.equal(validatePickMessage(pending, null, sender, { ...message, tabId: 4 }, 1_000).ok, false);
  assert.equal(validatePickMessage(pending, null, { tab: { id: 4 } }, message, 1_000).ok, false);
  assert.equal(validatePickMessage(null, null, sender, message, 1_000).ok, false);
  assert.equal(validatePickMessage(pending, null, sender, { ...message, type: 'ABRA_REPORT' }, 1_000).ok, false);
  assert.equal(
    validatePickMessage(pending, null, sender, { type: 'ABRA_PICK_CANCELLED', tabId: 3, pickToken: 'pick-1' }, 1_000).ok,
    true
  );

  const record = makeRecord({ tabId: 3 });
  assert.equal(validatePickMessage(pending, record, sender, { ...message, token: record.token, generation: 1 }, 1_000).ok, true);
  assert.equal(validatePickMessage(pending, record, sender, { ...message, token: 'other', generation: 1 }, 1_000).ok, false);
  assert.equal(validatePickMessage(pending, record, sender, { ...message, token: record.token, generation: 9 }, 1_000).ok, false);
});

test('shouldAcceptTick ignores early or duplicate reload drivers', () => {
  const record = makeRecord({ scheduledFor: 10_000 });
  assert.equal(shouldAcceptTick(record, 8_000).ok, false);
  assert.equal(shouldAcceptTick(record, 9_000).ok, true, 'the 1s tolerance window starts here');
  assert.equal(shouldAcceptTick(record, 9_500).ok, true);
  assert.equal(shouldAcceptTick(record, 10_000).ok, true);
  assert.equal(shouldAcceptTick(record, 12_000).ok, true);
  assert.equal(shouldAcceptTick(makeRecord({ scheduledFor: null }), 5).ok, true);
  assert.equal(shouldAcceptTick(makeRecord({ status: 'paused', scheduledFor: 10_000 }), 20_000).ok, false);
  assert.equal(shouldAcceptTick(null, 1).ok, false);
});

/* -------------------------------------------------------------------------- */
/* CSS and URL helpers                                                        */
/* -------------------------------------------------------------------------- */

test('escapeCssIdentifier escapes unsafe identifier characters', () => {
  assert.equal(escapeCssIdentifier('a b'), 'a\\ b');
  assert.equal(escapeCssIdentifier('1abc'), '\\31 abc');
  assert.equal(escapeCssIdentifier('-1x'), '-\\31 x');
  assert.equal(escapeCssIdentifier('a-b_c'), 'a-b_c');
  assert.equal(escapeCssIdentifier('a"b'), 'a\\"b');
  assert.equal(escapeCssIdentifier('a.b#c'), 'a\\.b\\#c');
  assert.equal(escapeCssIdentifier('café'), 'café');
  assert.equal(escapeCssIdentifier(''), '');
  assert.equal(escapeCssIdentifier(null), '');
});

test('escapeCssString and attributeSelector build safe selectors', () => {
  assert.equal(escapeCssString('plain'), 'plain');
  assert.equal(escapeCssString('a"b\\c'), 'a\\"b\\\\c');
  assert.equal(escapeCssString('line\nbreak'), 'line\\a break');
  assert.equal(attributeSelector('data-id', 'a"b'), '[data-id="a\\"b"]');
  assert.equal(attributeSelector('data id', 'x'), '[data\\ id="x"]');
});

test('buildSelectorFromParts and looksLikeValidSelector sanity checks', () => {
  assert.equal(buildSelectorFromParts(['div', '', '  ', '#main > span']), 'div > #main > span');
  assert.equal(buildSelectorFromParts(null), '');
  assert.equal(buildSelectorFromParts(['span']), 'span');

  assert.equal(looksLikeValidSelector('#main .item'), true);
  assert.equal(looksLikeValidSelector(':not(.hidden)'), true);
  assert.equal(looksLikeValidSelector('div[data-x="a]b"]'), true);
  assert.equal(looksLikeValidSelector('div['), false);
  assert.equal(looksLikeValidSelector('div]'), false);
  assert.equal(looksLikeValidSelector("div[data='x"), false);
  assert.equal(looksLikeValidSelector('div:nth-child(2'), false);
  assert.equal(looksLikeValidSelector('div { color: red }'), false);
  assert.equal(looksLikeValidSelector('div;color'), false);
  assert.equal(looksLikeValidSelector('   '), false);
  assert.equal(looksLikeValidSelector(null), false);
});

test('describeRestrictedTarget classifies browser pages and web store pages', () => {
  assert.equal(describeRestrictedTarget('https://example.com/page'), null);
  assert.equal(describeRestrictedTarget('http://localhost:3000/'), null);
  assert.match(describeRestrictedTarget('file:///C:/tmp/report.html'), /Local files/);
  assert.match(describeRestrictedTarget('chrome://extensions'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('chrome-extension://abc/popup.html'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('about:blank'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('devtools://devtools/bundled/x.html'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('view-source:https://example.com'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('data:text/html,hi'), /cannot be monitored/);
  assert.match(describeRestrictedTarget('https://chromewebstore.google.com/detail/x'), /Web Store/);
  assert.match(describeRestrictedTarget('https://chrome.google.com/webstore/detail/x'), /Web Store/);
  assert.equal(describeRestrictedTarget('https://chrome.google.com/other/page'), null);
  assert.equal(describeRestrictedTarget('https://chrome.google.com/webstore-news'), null);
  assert.match(describeRestrictedTarget('not a url'), /cannot be monitored/);
  assert.match(describeRestrictedTarget(''), /web address/);
  assert.equal(isRestrictedUrl('https://example.com'), false);
  assert.equal(isRestrictedUrl('chrome://newtab'), true);
});

test('sameOrigin and originOf compare pages for cross-origin stops', () => {
  assert.equal(sameOrigin('https://a.com/x', 'https://a.com/y?z=1'), true);
  assert.equal(sameOrigin('https://a.com/x', 'https://b.com/x'), false);
  assert.equal(sameOrigin('https://a.com/x', 'http://a.com/x'), false);
  assert.equal(sameOrigin('garbage', 'https://a.com'), false);
  assert.equal(sameOrigin('file:///C:/a.html', 'file:///C:/b.html'), false);
  assert.equal(sameOrigin('data:text/html,a', 'data:text/html,b'), false);
  assert.equal(originOf('https://a.com/x'), 'https://a.com');
  assert.equal(originOf('garbage'), '');
});

test('badge text and colors cover every status', () => {
  assert.equal(badgeTextFor('matched'), 'DONE');
  assert.equal(badgeTextFor('running'), BADGE_PENDING_TEXT, 'running without a deadline is pending, never 0');
  assert.equal(badgeTextFor('paused'), 'II');
  assert.equal(badgeTextFor('stopped'), '');
  assert.equal(badgeTextFor('error'), 'ERR');
  assert.equal(badgeTextFor('nonsense'), '');
  assert.equal(badgeColorFor('error'), '#b91c1c');
  assert.equal(badgeColorFor('running'), '#0f766e');
  assert.equal(badgeColorFor(undefined), '#94a3b8');
});

test('the badge countdown shows exact seconds, then compact minutes and hours', () => {
  const now = 1_000_000;

  assert.equal(countdownSecondsUntil(null, now), null, 'no deadline means pending, not zero');
  assert.equal(countdownSecondsUntil(undefined, now), null);
  assert.equal(countdownSecondsUntil(now, now), 0);
  assert.equal(countdownSecondsUntil(now + 1, now), 1);
  assert.equal(countdownSecondsUntil(now + 1_500, now), 2, 'seconds round up');
  assert.equal(countdownSecondsUntil(now + 999_000, now), 999);
  assert.equal(countdownSecondsUntil(now - 5_000, now), -5, 'past deadlines are reported as negative');

  assert.equal(compactCountdownText(0), '0');
  assert.equal(compactCountdownText(1), '1');
  assert.equal(compactCountdownText(999), '999');
  assert.equal(compactCountdownText(1000), '16m', '1000s is 16.7 minutes rounded down');
  assert.equal(compactCountdownText(3599), '59m');
  assert.equal(compactCountdownText(3600), '1h');
  assert.equal(compactCountdownText(86_400), '24h');
  assert.equal(compactCountdownText(-10), '0', 'a past deadline never shows a negative badge');
  assert.equal(compactCountdownText(null), '0');

  assert.equal(badgeCountdownText(null, now), BADGE_PENDING_TEXT);
  assert.equal(badgeCountdownText(now + 1_500, now), '2');
  assert.equal(badgeCountdownText(now + 999_000, now), '999');
  assert.equal(badgeCountdownText(now + 1_000_000, now), '16m');
  assert.equal(badgeCountdownText(now - 1_000, now), '0');
});

test('sessionBadgeText maps every session status to the toolbar text', () => {
  const now = 1_000_000;
  assert.equal(sessionBadgeText(null, now), '');
  assert.equal(
    sessionBadgeText({ status: 'running', nextRefreshAt: now + 42_000 }, now),
    '42'
  );
  assert.equal(
    sessionBadgeText({ status: 'running', nextRefreshAt: null }, now),
    BADGE_PENDING_TEXT,
    'loading, settling and checking must not show a misleading 0'
  );
  assert.equal(sessionBadgeText({ status: 'paused', nextRefreshAt: now + 42_000 }, now), 'II');
  assert.equal(sessionBadgeText({ status: 'matched', nextRefreshAt: null }, now), 'DONE');
  assert.equal(sessionBadgeText({ status: 'stopped', nextRefreshAt: null }, now), '');
  assert.equal(sessionBadgeText({ status: 'error', nextRefreshAt: null }, now), 'ERR');
});

test('validateCountdownMessage requires the top frame, identity and origin', () => {
  const record = makeRecord({
    tabId: 7,
    token: 'token-abc',
    origin: 'https://example.com',
    status: 'running',
    nextRefreshAt: 50_000
  });
  const sender = { tab: { id: 7 }, frameId: 0, origin: 'https://example.com' };
  const base = { type: 'ABRA_COUNTDOWN', tabId: 7, token: 'token-abc', generation: 1 };

  assert.equal(validateCountdownMessage(record, sender, { ...base }).ok, true);
  assert.equal(
    validateCountdownMessage(record, { ...sender, frameId: 4 }, { ...base }).ok,
    false,
    'subframes may not drive the countdown'
  );
  assert.equal(validateCountdownMessage(record, { tab: { id: 7 } }, { ...base }).ok, false, 'missing frameId');
  assert.equal(validateCountdownMessage(record, sender, { ...base, type: 'ABRA_REPORT' }).ok, false);
  assert.equal(validateCountdownMessage(record, sender, { ...base, tabId: 8 }).ok, false);
  assert.equal(validateCountdownMessage(record, { tab: { id: 8 }, frameId: 0 }, { ...base }).ok, false);
  assert.equal(validateCountdownMessage(record, sender, { ...base, token: 'other' }).ok, false);
  assert.equal(validateCountdownMessage(record, sender, { ...base, token: '' }).ok, false);
  assert.equal(validateCountdownMessage(record, sender, { ...base, generation: 2 }).ok, false);
  assert.equal(validateCountdownMessage(record, sender, { ...base, generation: '1' }).ok, true);
  assert.equal(validateCountdownMessage(null, sender, { ...base }).ok, false);
  assert.equal(validateCountdownMessage(record, { frameId: 0 }, { ...base }).ok, false, 'no sender.tab');
  assert.equal(validateCountdownMessage(record, sender, null).ok, false);

  // A changed page origin is refused once the session knows its origin.
  assert.equal(
    validateCountdownMessage(record, { tab: { id: 7 }, frameId: 0, origin: 'https://evil.example' }, { ...base }).ok,
    false
  );
  assert.equal(
    validateCountdownMessage(record, { tab: { id: 7 }, frameId: 0, url: 'https://example.com/x' }, { ...base }).ok,
    true,
    'sender.url is used when origin is absent'
  );
  const unknownOrigin = makeRecord({ tabId: 7, token: 'token-abc', origin: '', status: 'running' });
  assert.equal(
    validateCountdownMessage(unknownOrigin, { tab: { id: 7 }, frameId: 0, origin: 'https://other.example' }, { ...base }).ok,
    true,
    'an upgraded record without a stored origin still accepts the tab'
  );

  const paused = makeRecord({ tabId: 7, token: 'token-abc', origin: 'https://example.com', status: 'paused' });
  assert.equal(validateCountdownMessage(paused, sender, { ...base }).ok, true, 'paused is tolerated, then ignored');
  const matched = makeRecord({ tabId: 7, token: 'token-abc', origin: 'https://example.com', status: 'matched' });
  assert.equal(validateCountdownMessage(matched, sender, { ...base }).ok, false, 'a finished session stops the beat');
});

test('shouldAcceptCountdown rate-gates flooding heartbeats', () => {
  assert.equal(shouldAcceptCountdown(null, 1_000), true);
  assert.equal(shouldAcceptCountdown(0, 1_000), true);
  assert.equal(shouldAcceptCountdown(1_000, 1_000), false, 'a same-millisecond duplicate is refused');
  assert.equal(shouldAcceptCountdown(1_000, 1_000 + COUNTDOWN_MIN_GAP_MS - 1), false);
  assert.equal(shouldAcceptCountdown(1_000, 1_000 + COUNTDOWN_MIN_GAP_MS), true);
  assert.equal(shouldAcceptCountdown(1_000, 2_000), true);
  assert.equal(shouldAcceptCountdown(1_000, 1_399, 400), false);
  assert.equal(shouldAcceptCountdown(1_000, 1_400, 400), true);
  assert.equal(shouldAcceptCountdown(5, Number.NaN), false);
  assert.equal(COUNTDOWN_MIN_GAP_MS, 250);
});

/* -------------------------------------------------------------------------- */
/* Frozen contract (what the popup/options UI and the manifest rely on)        */
/* -------------------------------------------------------------------------- */

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const manifest = JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'));

test('the runtime message contract is exactly the documented set', () => {
  assert.deepEqual([...UI_MESSAGE_TYPES], ['START', 'STOP', 'PAUSE', 'RESUME', 'GET_STATE', 'GET_ALL', 'PICK_ELEMENT', 'ACTION_CAPABILITIES', 'ACTION_LOG', 'DISABLE_ACTION']);
  assert.deepEqual([...STOP_CONDITIONS], [
    'never',
    'page-change',
    'element-change',
    'keyword-found',
    'keyword-missing',
    'element-found',
    'element-missing'
  ]);
});

test('the default config keeps the exact keys and values the UI sends', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), [
    'actions',
    'bypassCache',
    'caseSensitive',
    'ignoreSelector',
    'intervalMode',
    'intervalSeconds',
    'keyword',
    'maxMinutes',
    'maxRefreshes',
    'maxSeconds',
    'minSeconds',
    'pauseWhenHidden',
    'preserveScroll',
    'selector',
    'settleSeconds',
    'stopCondition',
    'wholeWord'
  ]);
  assert.equal(DEFAULT_CONFIG.intervalSeconds, 30);
  assert.equal(DEFAULT_CONFIG.minSeconds, 20);
  assert.equal(DEFAULT_CONFIG.maxSeconds, 60);
  assert.equal(DEFAULT_CONFIG.settleSeconds, 2);
  assert.equal(DEFAULT_CONFIG.preserveScroll, true);
  assert.equal(DEFAULT_CONFIG.bypassCache, false);
  assert.equal(MIN_INTERVAL_SECONDS, 5);
});

test('manifest requests only activeTab, scripting, storage and alarms', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_permissions, ['userScripts']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module');
  for (const banned of ['tabs', 'notifications', 'webRequest', 'cookies', 'history', 'downloads']) {
    assert.equal(manifest.permissions.includes(banned), false, `"${banned}" must not be requested`);
  }
});

test('manifest references files that exist in the extension folder', () => {
  const references = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];
  for (const reference of references) {
    assert.ok(existsSync(resolve(extensionDir, reference)), `manifest references a missing file: ${reference}`);
  }
});

test('engine sources contain no remote code, eval or HTML injection', () => {
  for (const file of ['core.js', 'background.js', 'content.js']) {
    const source = readFileSync(resolve(extensionDir, file), 'utf8');
    assert.equal(/https?:\/\//.test(source), false, `${file} must not contain absolute URLs`);
    assert.equal(/XMLHttpRequest/.test(source), false, `${file} must not use XMLHttpRequest`);
    assert.equal(/\beval\s*\(/.test(source), false, `${file} must not use eval`);
    assert.equal(/new Function\s*\(/.test(source), false, `${file} must not use the Function constructor`);
    assert.equal(/importScripts\s*\(/.test(source), false, `${file} must not use importScripts`);
    assert.equal(/\.innerHTML\s*=/.test(source), false, `${file} must not assign innerHTML`);
  }
});

test('background uses the service worker safe scheduling path', () => {
  const source = readFileSync(resolve(extensionDir, 'background.js'), 'utf8');
  assert.equal(/setInterval\s*\(/.test(source), false, 'no long-lived background timers');
  assert.match(source, /chrome\.alarms\.create/, 'the watchdog alarm drives long waits');
  assert.match(source, /chrome\.storage\.session/, 'sessions stay in durable session storage');
  assert.match(source, /sessionBadgeText/, 'the running badge uses the shared countdown formatter');
  assert.match(source, /refreshBadge\(record\)/, 'hydration reapplies the badge after a worker restart');
  assert.match(source, /validateCountdownMessage/, 'heartbeats are authenticated before the badge moves');
  assert.match(source, /shouldAcceptCountdown/, 'heartbeat flooding is rate gated');
  const countdownBody = /function handleCountdown[\s\S]*?\n}/.exec(source);
  assert.ok(countdownBody, 'the countdown handler exists');
  assert.equal(
    /persistSessions|withTabLock|chrome\.storage/.test(countdownBody[0]),
    false,
    'a heartbeat never persists sessions, takes the tab lock or touches storage'
  );
});

test('content script owns page timers and re-injection guard', () => {
  const source = readFileSync(resolve(extensionDir, 'content.js'), 'utf8');
  assert.match(source, /setTimeout/, 'sub-30s waits are page timers');
  assert.match(source, /__ABRA_ENGINE__/, 're-injection must be idempotent');
  assert.match(source, /data-abra-picker/, 'the picker overlay is excluded from text collection');
  assert.match(source, /ABRA_COUNTDOWN/, 'the page sends the authenticated countdown heartbeat');
  assert.equal(/\bsetInterval\s*\(/.test(source), false, 'the heartbeat is a single chained timeout');
  assert.match(source, /pagehide[\s\S]{0,300}?stopCountdown\(\)/, 'unload clears the heartbeat');
});
