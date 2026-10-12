import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeActions, validateActions, DEFAULT_ACTIONS, permissionOriginForUrl } from '../extension/actions-core.js';

test('legacy configs keep automation disabled and independent default copies', () => {
  assert.deepEqual(normalizeActions(), DEFAULT_ACTIONS);
  const first = normalizeActions(), second = normalizeActions();
  first.webhook.events.push('start');
  assert.deepEqual(second.webhook.events, ['match']);
});
test('enabled hooks reject empty event selections and invalid settings', () => {
  assert.equal(validateActions({ webhook: { enabled: true, events: [], url: 'https://example.com/hook' } }).ok, false);
  assert.equal(validateActions({ script: { enabled: true, events: [], code: 'void 0;' } }).ok, false);
  for (const headers of ['{unfinished', '{"Cookie":"secret"}', '{"Sec-Test":"value"}', '{"Host":"example.com"}']) {
    assert.equal(validateActions({ webhook: { enabled: true, url: 'https://example.com/hook', headers } }).ok, false);
  }
  assert.equal(validateActions({ webhook: { enabled: false, headers: '{unfinished' } }).ok, true);
});
test('endpoint permissions exclude credentials and insecure external hosts', () => {
  assert.equal(permissionOriginForUrl('https://user:password@example.com/hook'), '');
  assert.equal(permissionOriginForUrl('http://example.com/hook'), '');
  assert.equal(permissionOriginForUrl('http://localhost.evil.test/hook'), '');
  assert.equal(permissionOriginForUrl('https://*/hook'), '');
  assert.equal(permissionOriginForUrl('https://*.example.com/hook'), '');
  assert.equal(permissionOriginForUrl('http://127.0.0.1:8100/hook'), 'http://127.0.0.1/*');
  assert.equal(permissionOriginForUrl('https://example.com:8100/hook'), 'https://example.com/*');
});

// Controlled runner tests use a fresh module instance and fake browser APIs.
let moduleCount = 0;
async function fixture({ permitted = true, scriptApi = true, documentId = 'document-A' } = {}) {
  const saved = {}, requests = [], executions = [];
  globalThis.chrome = {
    storage: { session: { get: async key => ({ [key]: saved[key] }), set: async values => Object.assign(saved, structuredClone(values)) } },
    permissions: { contains: async () => permitted, getAll: async () => ({ permissions: [], origins: [] }) },
    tabs: { get: async () => ({ url: 'https://example.com/page' }) },
    scripting: { executeScript: async () => [{ frameId: 0, documentId, result: { origin: 'https://example.com', url: 'https://example.com/page' } }] },
    ...(scriptApi ? { userScripts: {
      configureWorld: async config => assert.equal(config.messaging, false),
      execute: async injection => {
        executions.push(injection);
        const result = await vm.runInNewContext(injection.js[0].code, { document: { body: { dataset: {} } }, setTimeout });
        return [{ frameId: 0, documentId, result }];
      }
    } } : {})
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, text: () => { throw Error('Response body must not be read'); } };
  };
  const runner = await import('../extension/actions.js?test=' + ++moduleCount);
  const record = hooks => ({ tabId: 1, origin: 'https://example.com', url: 'https://example.com/page?secret=local', title: 'Private title', status: 'running', refreshCount: 2,
    config: { keyword: 'quoted " {{url}}', selector: '#private', actions: hooks }, lastResult: { reason: 'Private keyword reason' } });
  return { runner, saved, requests, executions, record };
}

test('runner skips revoked permissions without dispatching external actions', async () => {
  const f = await fixture({ permitted: false });
  await f.runner.runActions(f.record({ webhook: { enabled: true, url: 'https://example.com/hook' }, script: { enabled: true, code: 'void 0;' } }), 'match', { documentId: 'document-A' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.executions.length, 0);
  assert.equal((await f.runner.getActionLog(1)).entries.filter(entry => entry.status === 'skipped').length, 2);
});
test('custom payload replaces tokens once and excludes page fields until opted in', async () => {
  const f = await fixture();
  const webhook = { enabled: true, url: 'https://example.com/hook', body: '{"event":"{{event}}","private":"{{keyword}}"}' };
  await f.runner.runActions(f.record({ webhook }), 'match');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { event: 'match', private: '' });
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.redirect, 'error');
  await f.runner.runActions(f.record({ webhook: { ...webhook, includePageDetails: true } }), 'match');
  assert.equal(JSON.parse(f.requests[1].options.body).private, 'quoted " {{url}}');
});
test('scripts target the exact document, await promises and report private errors generically', async () => {
  const f = await fixture();
  const script = { enabled: true, code: "await new Promise(resolve => setTimeout(resolve, 5)); throw Error('private message');" };
  await f.runner.runActions(f.record({ script }), 'match', { documentId: 'document-A' });
  assert.deepEqual(f.executions[0].target, { tabId: 1, documentIds: ['document-A'] });
  assert.equal(f.executions[0].world, 'USER_SCRIPT');
  const entries = (await f.runner.getActionLog(1)).entries;
  assert.equal(entries[0].status, 'failed');
  assert.ok(!JSON.stringify(entries).includes('private message'));
});
test('replacement documents and unavailable userScripts never receive code', async () => {
  const f = await fixture({ documentId: 'document-B' });
  await f.runner.runActions(f.record({ script: { enabled: true, code: 'void 0;' } }), 'match', { documentId: 'document-A' });
  assert.equal(f.executions.length, 0);
  const g = await fixture({ scriptApi: false });
  await g.runner.runActions(g.record({ script: { enabled: true, code: 'void 0;' } }), 'match');
  assert.equal(g.executions.length, 0);
  assert.equal((await g.runner.getActionLog(1)).entries[0].status, 'skipped');
});
test('activity survives module restart without payloads or secrets', async () => {
  const f = await fixture();
  await f.runner.runActions(f.record({ webhook: { enabled: true, url: 'https://example.com/hook?token=private-token', headers: '{"Authorization":"private-header"}' } }), 'match');
  const restarted = await import('../extension/actions.js?restart=' + ++moduleCount);
  const entries = (await restarted.getActionLog(1)).entries;
  assert.equal(entries.length, 1);
  for (const secret of ['private-token', 'private-header', 'Private title', 'Private keyword']) assert.ok(!JSON.stringify(f.saved).includes(secret));
});
