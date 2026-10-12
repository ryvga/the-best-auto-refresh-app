/**
 * Custom JavaScript stop condition (`script-predicate`) tests.
 *
 * Four layers are covered:
 *   1. the pure planner contract in core.js,
 *   2. the config validator (required code, length ceiling, trimming),
 *   3. the runner's `{ ran, value, reason }` vocabulary in actions.js, including
 *      every failure path that must continue rather than stop, and
 *   4. the generated wrapper itself, executed in Node exactly as written.
 *
 * The last layer matters most: it is the only place that proves the source the
 * extension would inject into a page really runs the user's body, receives the
 * documented read-only context, and returns exactly one boolean.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  MAX_PREDICATE_CONTEXT_CHARS,
  MAX_PREDICATE_LENGTH,
  PREDICATE_TIMEOUT_MS,
  SCRIPT_CONDITIONS,
  STOP_CONDITIONS,
  evaluateCondition,
  normalizePredicateResult,
  normalizeSnapshot,
  planCycle,
  validateConfig
} from '../extension/core.js';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (name) => readFileSync(resolve(extensionDir, name), 'utf8');

const config = (overrides) => validateConfig({
  intervalSeconds: 10,
  stopCondition: 'script-predicate',
  predicateScript: 'return true;',
  ...overrides
}).config;

/* -------------------------------------------------------------------------- */
/* A chrome stub shaped like the calls one predicate run makes                */
/* -------------------------------------------------------------------------- */

let moduleCount = 0;

async function runner({
  permitted = true,
  originGranted = true,
  userScripts = true,
  scripting = true,
  execute = async () => [{ result: { ok: true, value: true } }]
} = {}) {
  const calls = [];
  globalThis.chrome = {
    tabs: { get: async () => ({ url: 'https://shop.example/item', title: 'Item' }) },
    permissions: {
      contains: async (query) => (query && query.permissions ? permitted : originGranted)
    },
    scripting: scripting
      ? { executeScript: async () => [{ documentId: 'doc-1', result: { origin: 'https://shop.example' } }] }
      : undefined,
    userScripts: userScripts
      ? {
          configureWorld: async () => {},
          execute: async (options) => { calls.push(options); return execute(options); }
        }
      : undefined
  };
  const mod = await import('../extension/actions.js?predicate=' + ++moduleCount);
  return { mod, calls };
}

const RECORD = {
  origin: 'https://shop.example',
  url: 'https://shop.example/item',
  title: 'Item page',
  documentId: 'doc-1',
  refreshCount: 3,
  checkCount: 4,
  config: { settleSeconds: 2 }
};

const ARGS = {
  record: RECORD,
  tabId: 1,
  documentId: 'doc-1',
  snapshot: { text: 'loading' },
  code: 'return true;'
};

/** Run the exact source the extension would hand to the page. */
async function runWrapper(code, { snapshot = { text: 'loading' }, record = RECORD } = {}) {
  const f = await runner();
  await f.mod.evaluatePredicate({ ...ARGS, record, snapshot, code });
  assert.equal(f.calls.length, 1, 'the wrapper should have reached userScripts.execute once');
  return await new Function(`return ${f.calls[0].js[0].code};`)();
}

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

test('script-predicate is part of the public stop-condition set', () => {
  assert.equal(SCRIPT_CONDITIONS.includes('script-predicate'), true);
  assert.equal(STOP_CONDITIONS.includes('script-predicate'), true);
  assert.equal(DEFAULT_CONFIG.predicateScript, '');
  assert.equal(PREDICATE_TIMEOUT_MS, 3000);
  assert.equal(MAX_PREDICATE_CONTEXT_CHARS, 20000);
});

test('the custom condition requires code and refuses an oversized body', () => {
  const missing = validateConfig({ intervalSeconds: 10, stopCondition: 'script-predicate' });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.some((entry) => entry.field === 'predicateScript'), true);

  const blank = validateConfig({ intervalSeconds: 10, stopCondition: 'script-predicate', predicateScript: '   ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.errors.some((entry) => entry.field === 'predicateScript'), true);

  const trimmed = config({ predicateScript: '  return true;  ' });
  assert.equal(trimmed.predicateScript, 'return true;');
  assert.equal(trimmed.stopCondition, 'script-predicate');

  const oversized = validateConfig({
    intervalSeconds: 10,
    stopCondition: 'script-predicate',
    predicateScript: 'x'.repeat(MAX_PREDICATE_LENGTH + 25)
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.errors.some((entry) => entry.field === 'predicateScript'), true);
  assert.equal(oversized.config.predicateScript.length, MAX_PREDICATE_LENGTH);

  // Every other condition is unaffected: no code is ever demanded or invented.
  assert.equal(validateConfig({ intervalSeconds: 10 }).config.predicateScript, '');
  assert.equal(validateConfig({ intervalSeconds: 10, stopCondition: 'never' }).ok, true);
});

/* -------------------------------------------------------------------------- */
/* Planner                                                                     */
/* -------------------------------------------------------------------------- */

test('a custom condition stops only on a truthy result', () => {
  const cfg = config();
  const yes = evaluateCondition({ baseline: null, current: { text: 'x', predicate: { ran: true, value: true } }, config: cfg });
  assert.equal(yes.status, 'matched');

  const no = evaluateCondition({ baseline: null, current: { text: 'x', predicate: { ran: true, value: false } }, config: cfg });
  assert.equal(no.status, 'continue');
  assert.match(no.reason, /returned false/);
});

test('a predicate that did not run continues and surfaces the reason verbatim', () => {
  const cfg = config();
  for (const reason of [
    'Your custom condition raised: boom',
    'Your custom condition did not finish in time, so this check continued.',
    'Custom conditions need JavaScript access granted for this website.'
  ]) {
    const result = evaluateCondition({
      baseline: null,
      current: { text: 'x', predicate: { ran: false, value: false, reason } },
      config: cfg
    });
    assert.equal(result.status, 'continue', `${reason} must never stop the session`);
    assert.equal(result.reason, reason);
  }

  // A snapshot that never carried a predicate at all is also a continue.
  const missing = evaluateCondition({ baseline: null, current: { text: 'x' }, config: cfg });
  assert.equal(missing.status, 'continue');
  assert.match(missing.reason, /not available/i);
});

test('planCycle keeps refreshing while the condition is false and matches when it is true', () => {
  const cfg = config();
  const now = 1_000_000;

  const waiting = planCycle({
    record: { config: cfg, baseline: null, refreshCount: 0, startedAt: now, nextRefreshAt: null },
    snapshot: { text: 'loading', predicate: { ran: true, value: false } },
    now,
    random: () => 0
  });
  assert.equal(waiting.kind, 'wait');
  assert.equal(waiting.lastResult.met, false);
  assert.equal(waiting.nextRefreshAt, now + 10_000);

  const hit = planCycle({
    record: { config: cfg, baseline: null, refreshCount: 1, startedAt: now, nextRefreshAt: now + 10_000 },
    snapshot: { text: 'ready', predicate: { ran: true, value: true } },
    now: now + 10_000,
    random: () => 0
  });
  assert.equal(hit.kind, 'matched');
  assert.equal(hit.lastResult.met, true);
  assert.equal(hit.refreshCount, 1, 'a match is not a refresh');
  assert.equal(hit.nextRefreshAt, null);

  // The whole point of the feature: a failing predicate keeps the session alive.
  const failed = planCycle({
    record: { config: cfg, baseline: null, refreshCount: 1, startedAt: now, nextRefreshAt: now + 10_000 },
    snapshot: { text: 'loading', predicate: { ran: false, reason: 'Your custom condition raised: boom' } },
    now: now + 20_000,
    random: () => 0
  });
  assert.equal(failed.kind, 'reload', 'a broken predicate must not end the session');
  assert.equal(failed.refreshCount, 2);
});

test('normalizePredicateResult accepts only a real ran/value pair', () => {
  assert.deepEqual(normalizePredicateResult({ ran: true, value: true }), { ran: true, value: true, reason: null });
  assert.deepEqual(normalizePredicateResult({ ran: true, value: false }), { ran: true, value: false, reason: null });

  // Only the real boolean counts, and a value without `ran` never matches.
  assert.equal(normalizePredicateResult({ ran: true, value: 1 }).value, false);
  assert.equal(normalizePredicateResult({ ran: true, value: 'yes' }).value, false);
  assert.equal(normalizePredicateResult({ value: true }).ran, false);
  assert.equal(normalizePredicateResult('true').ran, false);
  assert.equal(normalizePredicateResult(null).ran, false);
  assert.equal(normalizePredicateResult([]).ran, false);

  // A hostile or oversized reason is capped, and a default is always present.
  assert.equal(normalizePredicateResult({ ran: false, reason: 'z'.repeat(5000) }).reason.length, 300);
  assert.match(normalizePredicateResult({}).reason, /not available/i);

  // The field survives snapshot normalisation and reads as "did not run" when absent.
  assert.equal(normalizeSnapshot({ text: 'x', predicate: { ran: true, value: true } }).predicate.value, true);
  assert.equal(normalizeSnapshot({ text: 'x' }).predicate.ran, false);
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

test('evaluatePredicate reduces every execution outcome to ran/value/reason', async () => {
  const yes = await runner({ execute: async () => [{ result: { ok: true, value: true } }] });
  assert.deepEqual(await yes.mod.evaluatePredicate(ARGS), { ran: true, value: true, reason: null });

  const no = await runner({ execute: async () => [{ result: { ok: true, value: false } }] });
  assert.deepEqual(await no.mod.evaluatePredicate(ARGS), { ran: true, value: false, reason: null });

  const raised = await runner({ execute: async () => [{ result: { ok: false, message: 'boom' } }] });
  const raisedResult = await raised.mod.evaluatePredicate(ARGS);
  assert.equal(raisedResult.ran, false);
  assert.match(raisedResult.reason, /boom/);

  const injectionError = await runner({ execute: async () => [{ error: { message: 'no document' } }] });
  const injectionResult = await injectionError.mod.evaluatePredicate(ARGS);
  assert.equal(injectionResult.ran, false);
  assert.match(injectionResult.reason, /no document/, 'the injection error must reach the user');

  // A typo fails the whole injection, so Chrome's own message is all the user has.
  const rejected = await runner({
    execute: async () => { throw new Error("SyntaxError: Unexpected identifier 'is'"); }
  });
  const rejectedResult = await rejected.mod.evaluatePredicate(ARGS);
  assert.equal(rejectedResult.ran, false);
  assert.match(rejectedResult.reason, /SyntaxError/);

  const empty = await runner({ execute: async () => [] });
  assert.equal((await empty.mod.evaluatePredicate(ARGS)).ran, false);

  const nonsense = await runner({ execute: async () => 'not-an-array' });
  assert.equal((await nonsense.mod.evaluatePredicate(ARGS)).ran, false);

  const threw = await runner({ execute: async () => { throw new Error('tab closed'); } });
  const threwResult = await threw.mod.evaluatePredicate(ARGS);
  assert.equal(threwResult.ran, false);
  assert.match(threwResult.reason, /could not run/i);
});

test('evaluatePredicate continues, with a reason, whenever access is missing', async () => {
  const noApi = await runner({ userScripts: false });
  const noApiResult = await noApi.mod.evaluatePredicate(ARGS);
  assert.equal(noApiResult.ran, false);
  assert.match(noApiResult.reason, /User Scripts/);

  const noPermission = await runner({ permitted: false });
  assert.match((await noPermission.mod.evaluatePredicate(ARGS)).reason, /access/i);

  const noOrigin = await runner({ originGranted: false });
  assert.equal((await noOrigin.mod.evaluatePredicate(ARGS)).ran, false);

  const noScripting = await runner({ scripting: false });
  assert.equal((await noScripting.mod.evaluatePredicate(ARGS)).ran, false);

  const noCode = await runner();
  assert.match((await noCode.mod.evaluatePredicate({ ...ARGS, code: '   ' })).reason, /No custom condition/);
  assert.match((await noCode.mod.evaluatePredicate({ ...ARGS, code: 42 })).reason, /No custom condition/);

  // Nothing is ever injected once access is missing.
  const attempted = noApi.calls.length + noPermission.calls.length + noOrigin.calls.length
    + noScripting.calls.length + noCode.calls.length;
  assert.equal(attempted, 0);
});

test('evaluatePredicate uses only the isolated USER_SCRIPT world', async () => {
  const f = await runner();
  await f.mod.evaluatePredicate(ARGS);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].world, 'USER_SCRIPT');
  assert.equal(f.calls[0].worldId, 'abra-monitor');
  assert.deepEqual(f.calls[0].target, { tabId: 1, documentIds: ['doc-1'] });
  assert.equal(Array.isArray(f.calls[0].js), true);
  assert.equal(typeof f.calls[0].js[0].code, 'string');
});

test('a predicate that never settles is abandoned, not awaited forever', async () => {
  const hanging = await runner({ execute: () => new Promise(() => {}) });
  const result = await hanging.mod.evaluatePredicate({ ...ARGS, code: 'while (true) {}', timeoutMs: 25 });
  assert.equal(result.ran, false);
  assert.equal(result.value, false);
  assert.match(result.reason, /did not finish in time/);
});

/* -------------------------------------------------------------------------- */
/* The generated wrapper, executed for real                                    */
/* -------------------------------------------------------------------------- */

test('the generated wrapper runs the user body and reports exactly one boolean', async () => {
  assert.deepEqual(await runWrapper('return true;'), { ok: true, value: true });
  assert.deepEqual(await runWrapper('return false;'), { ok: true, value: false });

  for (const [body, expected] of [
    ['return 1;', true],
    ['return "text";', true],
    ['return [];', true],
    ['return 0;', false],
    ['return "";', false],
    ['return null;', false],
    ['return undefined;', false],
    ['return NaN;', false],
    ['return Promise.resolve(true);', true],
    ['return await Promise.resolve(false);', false]
  ]) {
    assert.deepEqual(await runWrapper(body), { ok: true, value: expected }, body);
  }
});

test('the wrapper hands the user a frozen context with the documented fields', async () => {
  assert.deepEqual(await runWrapper('return Object.isFrozen(context);'), { ok: true, value: true });
  assert.deepEqual(
    await runWrapper('return context.refreshCount === 3 && context.checkCount === 4 && context.settleSeconds === 2 && typeof context.now === "number";'),
    { ok: true, value: true }
  );
  assert.deepEqual(
    await runWrapper('return context.url === "https://shop.example/item" && context.title === "Item page" && context.text === "loading";'),
    { ok: true, value: true }
  );
  assert.deepEqual(
    await runWrapper('return context.selectorExists;', { snapshot: { text: 'x', selectorExists: true } }),
    { ok: true, value: true }
  );

  // A hostile page text cannot smuggle more than the budget into the injection.
  assert.deepEqual(
    await runWrapper(`return context.text.length === ${MAX_PREDICATE_CONTEXT_CHARS};`, {
      snapshot: { text: 'a'.repeat(MAX_PREDICATE_CONTEXT_CHARS + 5000) }
    }),
    { ok: true, value: true }
  );
});

test('the wrapper turns a throwing body into one short message and never leaks it', async () => {
  const thrown = await runWrapper('throw new Error("kaboom");');
  assert.equal(thrown.ok, false);
  assert.equal(thrown.message, 'kaboom');

  const long = await runWrapper(`throw new Error("${'z'.repeat(500)}");`);
  assert.equal(long.ok, false);
  assert.equal(long.message.length, 200, 'the message is capped before it crosses back');

  const frozenWrite = await runWrapper('context.title = "changed"; return context.title === "Item page";');
  assert.deepEqual(frozenWrite, { ok: true, value: true }, 'the frozen context is not writable');
});

/* -------------------------------------------------------------------------- */
/* Wiring and UI parity                                                        */
/* -------------------------------------------------------------------------- */

test('background runs the predicate after the settled snapshot and before the planner', () => {
  const background = read('background.js');
  const predicateAt = background.indexOf('snapshot.predicate = await evaluatePredicate');
  const plannerAt = background.indexOf('planCycle({ record, snapshot, now })');
  assert.notEqual(predicateAt, -1, 'background must attach a predicate result');
  assert.notEqual(plannerAt, -1);
  assert.ok(predicateAt < plannerAt, 'the predicate result must exist before the planner runs');
  assert.match(background, /stopCondition === 'script-predicate'/);
});

test('the predicate path never evals user code in an extension context', () => {
  const actions = read('actions.js');
  assert.match(actions, /export async function evaluatePredicate/);
  assert.match(actions, /world: 'USER_SCRIPT'/);
  assert.equal(/eval\s*\(/.test(actions), false, 'user code must never be eval-ed');
  assert.equal(/new Function/.test(actions), false, 'user code must never be compiled here');
  assert.equal(/innerHTML/.test(actions), false);
});

test('the popup and the dashboard both offer the custom condition end to end', () => {
  for (const name of ['popup', 'options']) {
    const html = read(`${name}.html`);
    const js = read(`${name}.js`);

    assert.match(html, /<option value="script-predicate">/, `${name}.html needs the option`);
    assert.match(html, /id="predicate-panel"/, `${name}.html needs the panel`);
    assert.match(html, /id="predicate-script"/, `${name}.html needs the code field`);
    // Field errors are addressed as `err-${fieldId}`, so the node must match the
    // validation id exactly or the message would have nowhere to land.
    assert.match(html, /id="err-predicate-script"/, `${name}.html needs the matching error node`);
    assert.match(html, /id="predicate-access"/, `${name}.html needs the access line`);

    assert.match(js, /'script-predicate'/, `${name}.js must know the condition`);
    assert.match(js, /SCRIPT_CONDITIONS/, `${name}.js must gate the panel`);
    assert.match(js, /predicateScript/, `${name}.js must carry the code into the config`);
    assert.match(js, /'predicate-panel', 'predicate-script', 'predicate-access'/, `${name}.js must look the nodes up`);
    assert.match(js, /'predicate-script',/, `${name}.js must validate the field`);
    assert.match(js, /ui\['predicate-script'\]\.value = config\.predicateScript;/, `${name}.js must restore the saved code`);
  }
});