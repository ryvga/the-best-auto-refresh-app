/**
 * The profiles store exists to stop two documents from clobbering each other's
 * saves, so most of these cases are deliberately concurrent: they resolve only
 * if mutations are queued and applied against freshly read state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfilesStore } from '../extension/profiles-store.js';
import { DEFAULT_CONFIG } from '../extension/core.js';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const readExtensionFile = (name) => readFileSync(resolve(extensionDir, name), 'utf8');

function makeStore(initial = [], overrides = {}) {
  const state = { profiles: structuredClone(initial) };
  const storage = {
    async getProfiles() {
      if (overrides.failRead) throw new Error('storage read failed');
      if (overrides.readDelay) await new Promise(resolve => setTimeout(resolve, overrides.readDelay));
      return structuredClone(state.profiles);
    },
    async setProfiles(profiles) {
      if (overrides.failWrite) throw new Error('storage write failed');
      if (overrides.writeDelay) await new Promise(resolve => setTimeout(resolve, overrides.writeDelay));
      state.profiles = structuredClone(profiles);
    }
  };
  let id = 0;
  let timestamp = 100;
  const store = createProfilesStore({ storage, idFactory: () => `new_${++id}`, now: () => ++timestamp });
  return { store, state };
}

function profile(name, scope = 'global', target = '') {
  return { name, scope, target, config: structuredClone(DEFAULT_CONFIG) };
}

test('serialized concurrent distinct saves and delete preserve all mutations', async () => {
  const { store, state } = makeStore([], { readDelay: 2, writeDelay: 2 });
  const [a, b] = await Promise.all([
    store.save({ profile: profile('A') }),
    store.save({ profile: profile('B') })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(state.profiles.map(item => item.name).sort(), ['A', 'B']);

  const [deleted, added] = await Promise.all([
    store.remove({ id: a.profile.id }),
    store.save({ profile: profile('C') })
  ]);
  assert.equal(deleted.ok, true);
  assert.equal(added.ok, true);
  assert.deepEqual(state.profiles.map(item => item.name).sort(), ['B', 'C']);
});

test('same name may coexist across scopes, while same scope and target updates in place', async () => {
  const { store, state } = makeStore();
  const first = await store.save({ profile: profile('Queue', 'site', 'https://example.com') });
  const otherScope = await store.save({ profile: profile('Queue') });
  const updated = await store.save({ profile: { ...profile('Queue', 'site', 'https://example.com'), config: { ...DEFAULT_CONFIG, intervalSeconds: 60 } } });
  assert.equal(first.ok, true);
  assert.equal(otherScope.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(updated.created, false);
  assert.equal(state.profiles.length, 2);
  assert.equal(state.profiles.find(item => item.id === first.profile.id).config.intervalSeconds, 60);
});

test('stale profile updates and deletes are rejected', async () => {
  const { store } = makeStore();
  const created = await store.save({ profile: profile('Versioned') });
  const update = await store.save({
    profile: { ...profile('Renamed'), id: created.profile.id },
    expectedUpdatedAt: created.profile.updatedAt
  });
  assert.equal(update.ok, true);
  assert.equal((await store.save({
    profile: { ...profile('Lost update'), id: created.profile.id },
    expectedUpdatedAt: created.profile.updatedAt
  })).ok, false);
  assert.equal((await store.remove({ id: created.profile.id, expectedUpdatedAt: created.profile.updatedAt })).ok, false);
  assert.equal((await store.remove({ id: created.profile.id, expectedUpdatedAt: update.profile.updatedAt })).ok, true);
});

test('malformed identifiers, targets, scopes and configs are rejected', async () => {
  const { store } = makeStore();
  assert.equal((await store.save({ profile: { ...profile('Bad id'), id: '../foreign' } })).ok, false);
  assert.equal((await store.remove({ id: '../foreign' })).ok, false);
  assert.equal((await store.save({ profile: profile('Bad scope', 'wat', '') })).ok, false);
  assert.equal((await store.save({ profile: profile('Bad target', 'site', 'https://example.com/path') })).ok, false);
  assert.equal((await store.save({ profile: { ...profile('Bad config'), config: { ...DEFAULT_CONFIG, intervalSeconds: 0 } } })).ok, false);
  assert.equal((await store.save({ profile: { ...profile('Missing entry'), id: 'unknown' } })).ok, false);
  assert.equal((await store.save({ profile: profile('x'.repeat(61)) })).ok, false);
  assert.equal((await store.save({ profile: profile('Credentials', 'page', 'https://user:pass@example.com/') })).ok, false);
});

test('storage failures are returned as safe errors and do not break the queue', async () => {
  const failedRead = makeStore([], { failRead: true });
  assert.match((await failedRead.store.save({ profile: profile('A') })).error, /could not be read/i);

  const failures = { failWrite: true };
  const failedWrite = makeStore([], failures);
  assert.match((await failedWrite.store.save({ profile: profile('A') })).error, /could not be written/i);
  failures.failWrite = false;
  assert.equal((await failedWrite.store.save({ profile: profile('B') })).ok, true);
});

test('create-only saves never overwrite a profile that appeared concurrently', async () => {
  const { store, state } = makeStore();
  const first = await store.save({ profile: profile('Queue'), createOnly: true });
  const collision = await store.save({ profile: { ...profile('Queue'), config: { ...DEFAULT_CONFIG, intervalSeconds: 55 } }, createOnly: true });
  assert.equal(first.ok, true);
  assert.equal(collision.ok, false);
  assert.equal(state.profiles[0].config.intervalSeconds, DEFAULT_CONFIG.intervalSeconds);
});

test('profile limit refuses new entries but permits updating an existing one', async () => {
  let profiles = [];
  const store = createProfilesStore({
    maxProfiles: 1, idFactory: () => 'only', now: () => 100,
    storage: { getProfiles: async () => structuredClone(profiles), setProfiles: async next => { profiles = structuredClone(next); } }
  });
  assert.equal((await store.save({ profile: profile('One') })).ok, true);
  assert.equal((await store.save({ profile: profile('Two') })).ok, false);
  const updated = await store.save({ profile: { ...profile('One'), config: { ...DEFAULT_CONFIG, intervalSeconds: 60 } } });
  assert.equal(updated.ok, true);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].config.intervalSeconds, 60);
});

test('neither UI page writes the saved-profiles array itself any more', () => {
  for (const page of ['popup.js', 'options.js']) {
    const source = readExtensionFile(page);
    // The whole point of the store: no document may read-modify-write the list.
    assert.equal(/storageSet\(\{\s*profiles/.test(source), false, `${page} still writes the profiles array directly`);
    assert.equal(/\bpersistProfiles\b/.test(source), false, `${page} still persists profiles on its own`);
  }
});

test('the service worker owns both profile mutations', () => {
  const background = readExtensionFile('background.js');
  assert.match(background, /case 'SAVE_PROFILE':\s*\n\s*return profilesStore\.save\(msg\);/);
  assert.match(background, /case 'DELETE_PROFILE':\s*\n\s*return profilesStore\.remove\(msg\);/);
  assert.match(background, /createProfilesStore\(/);
  // The store must be fed the real key, or a rename would silently orphan it.
  assert.match(background, /chrome\.storage\.local\.get\('profiles'\)/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ profiles \}\)/);
});

test('both pages go through the service worker, with staleness guards', () => {
  const popup = readExtensionFile('popup.js');
  const options = readExtensionFile('options.js');
  assert.match(popup, /type: 'SAVE_PROFILE'/);
  assert.match(popup, /createOnly: !existing/);
  assert.match(popup, /message\.expectedUpdatedAt = existing\.updatedAt/);
  assert.match(options, /type: 'SAVE_PROFILE'/);
  assert.match(options, /type: 'DELETE_PROFILE'/);
  assert.match(options, /message\.expectedUpdatedAt = duplicate\.updatedAt/);
  assert.match(options, /message\.expectedUpdatedAt = profile\.updatedAt/);
});

test('a custom stop condition survives a save and reload round trip', async () => {
  const { store, state } = makeStore();
  const saved = await store.save({ profile: profile('Watching a price') });
  assert.equal(saved.ok, true);
  const withPredicate = await store.save({
    profile: {
      ...profile('Watching a price'),
      config: { ...DEFAULT_CONFIG, stopCondition: 'script-predicate', predicateScript: 'return false;' }
    }
  });
  assert.equal(withPredicate.ok, true);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].config.stopCondition, 'script-predicate');
  assert.equal(state.profiles[0].config.predicateScript, 'return false;');
  assert.equal((await store.save({
    profile: { ...profile('Broken'), config: { ...DEFAULT_CONFIG, stopCondition: 'script-predicate', predicateScript: '' } }
  })).ok, false);
});