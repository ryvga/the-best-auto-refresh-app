import test from 'node:test';
import assert from 'node:assert/strict';
import { isMeaningfulInteraction, validateConfig, validateInteractionMessage } from '../extension/core.js';

const record = (overrides = {}) => ({
  tabId: 7,
  token: 'session-token',
  generation: 3,
  origin: 'https://example.test',
  status: 'running',
  config: { pauseOnInteraction: true },
  ...overrides
});
const sender = (overrides = {}) => ({
  tab: { id: 7 }, frameId: 0, documentId: 'doc-1',
  origin: 'https://example.test', url: 'https://example.test/page', ...overrides
});
const message = (overrides = {}) => ({
  type: 'ABRA_INTERACTION', tabId: 7, token: 'session-token', generation: 3, trusted: true, ...overrides
});

test('interaction validation accepts only opted-in, trusted identity from the current top document', () => {
  assert.deepEqual(validateInteractionMessage(record(), sender(), message()), { ok: true });
  assert.equal(validateConfig({ pauseOnInteraction: true }).config.pauseOnInteraction, true);
  assert.equal(validateConfig({}).config.pauseOnInteraction, false);
});

test('interaction validation rejects synthetic, disabled, stale, foreign and data-bearing messages', () => {
  const cases = [
    [record(), sender(), message({ trusted: false })],
    [record({ config: { pauseOnInteraction: false } }), sender(), message()],
    [record({ generation: 4 }), sender(), message()],
    [record(), sender(), message({ token: 'other-token' })],
    [record(), sender({ origin: 'https://other.test' }), message()],
    [record(), sender({ frameId: 2 }), message()],
    [record({ documentId: 'doc-2' }), sender(), message()],
    [record(), sender(), message({ value: 'private text' })],
    [record(), sender(), message({ url: 'https://private.test' })],
    [record(), sender(), message({ key: 'secret' })]
  ];
  for (const [session, from, payload] of cases) {
    assert.equal(validateInteractionMessage(session, from, payload).ok, false);
  }
});

test('interaction classification covers pointer, editable fields and control activation without pausing for noise', () => {
  assert.equal(isMeaningfulInteraction({ kind: 'pointer', tagName: 'DIV' }), true);
  assert.equal(isMeaningfulInteraction({ kind: 'input', tagName: 'INPUT', inputType: 'text' }), true);
  assert.equal(isMeaningfulInteraction({ kind: 'input', tagName: 'TEXTAREA' }), true);
  assert.equal(isMeaningfulInteraction({ kind: 'input', isContentEditable: true }), true);
  assert.equal(isMeaningfulInteraction({ kind: 'key', key: 'Enter', tagName: 'BUTTON' }), true);
  assert.equal(isMeaningfulInteraction({ kind: 'key', key: 'x', tagName: 'BUTTON' }), false);
  assert.equal(isMeaningfulInteraction({ kind: 'input', tagName: 'DIV' }), false);
  assert.equal(isMeaningfulInteraction({ kind: 'input', tagName: 'INPUT', inputType: 'checkbox' }), false);
  assert.equal(isMeaningfulInteraction({ kind: 'noise', tagName: 'TEXTAREA' }), false);
});
