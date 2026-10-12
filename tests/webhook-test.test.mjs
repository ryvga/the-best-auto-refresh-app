import test from 'node:test';
import assert from 'node:assert/strict';

let moduleCount = 0;
async function fixture({ permitted = true, fetchImpl } = {}) {
  const saved = {}, requests = [];
  globalThis.chrome = {
    storage: { session: { get: async key => ({ [key]: saved[key] }), set: async values => Object.assign(saved, structuredClone(values)) } },
    permissions: { contains: async () => permitted, getAll: async () => ({ permissions: [], origins: [] }) },
    tabs: { get: async () => ({ url: 'https://private.example/page', title: 'Private page title' }) }
  };
  globalThis.fetch = fetchImpl || (async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, text: () => { throw Error('Response body must never be read'); } };
  });
  const runner = await import('../extension/actions.js?webhook-test=' + ++moduleCount);
  const webhook = overrides => ({
    enabled: true, events: ['match'], url: 'https://notify.example/hook', method: 'POST',
    headers: '{}', body: '', includePageDetails: false, ...overrides
  });
  return { runner, saved, requests, webhook };
}

test('test webhook validates before dispatch and requires an existing hostname grant', async () => {
  const f = await fixture();
  assert.equal((await f.runner.testWebhook({ tabId: 1 })).ok, false);
  assert.equal((await f.runner.testWebhook({ tabId: 1, webhook: f.webhook({ enabled: false }) })).ok, false);
  assert.equal((await f.runner.testWebhook({ tabId: 1, webhook: f.webhook({ body: '{bad' }) })).ok, false);
  assert.equal(f.requests.length, 0);
  const g = await fixture({ permitted: false });
  assert.equal((await g.runner.testWebhook({ tabId: 1, webhook: g.webhook() })).ok, false);
  assert.equal(g.requests.length, 0);
});

test('test webhook substitutes only test fields and keeps page data out unless explicitly requested', async () => {
  const f = await fixture();
  const result = await f.runner.testWebhook({ tabId: 1, webhook: f.webhook({ body: '{"event":"{{event}}","count":"{{refreshCount}}","url":"{{url}}"}' }) });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { event: 'test', count: '0', url: '' });
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.equal(f.requests[0].options.method, 'POST');
  assert.equal((await f.runner.getActionLog(1)).entries[0].event, 'test');

  const g = await fixture();
  await g.runner.testWebhook({ tabId: 1, webhook: g.webhook({ includePageDetails: true, body: '{"url":"{{url}}","title":"{{title}}"}' }) });
  assert.deepEqual(JSON.parse(g.requests[0].options.body), { url: 'https://private.example/page', title: 'Private page title' });
});

test('GET sends no body and permits Bearer Authorization while rejecting browser-managed headers', async () => {
  const f = await fixture();
  const result = await f.runner.testWebhook({ tabId: 1, webhook: f.webhook({ method: 'GET', headers: '{"Authorization":"Bearer secret"}' }) });
  assert.equal(result.ok, true);
  assert.equal(f.requests[0].options.body, undefined);
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer secret');
  for (const name of ['Cookie', 'Host']) {
    const g = await fixture();
    assert.equal((await g.runner.testWebhook({ tabId: 1, webhook: g.webhook({ headers: JSON.stringify({ [name]: 'private' }) }) })).ok, false);
    assert.equal(g.requests.length, 0);
  }
});

test('test webhook never reads responses, refuses redirects and does not log payload secrets', async () => {
  let textCalls = 0;
  const f = await fixture({ fetchImpl: async (url, options) => {
    const request = { url, options }; f.requests.push(request);
    return { ok: true, status: 200, text: () => { textCalls += 1; throw Error('private response'); } };
  } });
  const secret = 'unique-private-token';
  assert.equal((await f.runner.testWebhook({ tabId: 1, webhook: f.webhook({ headers: JSON.stringify({ Authorization: `Bearer ${secret}` }), body: JSON.stringify({ message: secret }) }) })).ok, true);
  assert.equal(textCalls, 0);
  const log = JSON.stringify((await f.runner.getActionLog(1)).entries);
  assert.equal(log.includes(secret), false);

  const g = await fixture({ fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect rejected');
  } });
  assert.equal((await g.runner.testWebhook({ tabId: 1, webhook: g.webhook() })).ok, false);
});

test('duplicate in-flight test sends are rejected without a retry', async () => {
  let release;
  const f = await fixture({ fetchImpl: async (url, options) => {
    f.requests.push({ url, options });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 200 };
  } });
  const first = f.runner.testWebhook({ tabId: 1, webhook: f.webhook() });
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const second = await f.runner.testWebhook({ tabId: 1, webhook: f.webhook() });
  assert.equal(second.ok, false);
  assert.equal(f.requests.length, 1);
  release();
  assert.equal((await first).ok, true);
});
