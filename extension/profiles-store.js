/**
 * Serialized mutations for the shared saved-profiles array.
 *
 * The popup and the dashboard are separate documents, and both used to read the
 * whole `profiles` array out of local storage and write the whole array back.
 * Two saves that overlap therefore both start from the same snapshot, and the
 * later write silently discards the earlier one. This module moves every
 * mutation behind one queue in the service worker, so saves and deletes are
 * applied one at a time against freshly read state.
 *
 * Callers may also send `expectedUpdatedAt`, the `updatedAt` they last saw. A
 * mutation is rejected when the stored profile has moved on, which turns a
 * silent overwrite into an error the user can act on. `createOnly` does the
 * same for creation: it never adopts a profile that appeared while the user was
 * typing.
 *
 * The module is pure: it never touches chrome.* itself. The caller supplies
 * `storage.getProfiles()` and `storage.setProfiles(array)`, both of which must
 * reject when the underlying storage fails.
 */

import { validateConfig } from './core.js';

export const MAX_PROFILES = 200;
export const MAX_PROFILE_NAME = 60;

/** Identifiers reach the DOM as option values, so keep them boring. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPES = new Set(['global', 'site', 'page']);

function failure(error) {
  return { ok: false, error };
}

/**
 * A profile target is a whole origin for `site` scope and origin plus path and
 * query for `page` scope. Credentials and fragments are refused rather than
 * stored, because the target is shown back to the user and used for matching.
 */
function targetIsValid(scope, target) {
  if (scope === 'global') return target === '';
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096) return false;
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false;
  if (scope === 'site') return target === url.origin;
  return target === `${url.origin}${url.pathname}${url.search}`;
}

function validTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function idFromFactory(profiles, idFactory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = idFactory();
    if (typeof id === 'string' && ID_PATTERN.test(id) && !profiles.some(profile => profile.id === id)) return id;
  }
  return null;
}

/**
 * Storage is not a trusted input: it can hold entries written by an older
 * version, or edited by hand. Drop what cannot be salvaged and repair the rest
 * so one bad entry cannot break the list.
 */
function sanitizeStoredProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim())
    .map((item, index) => {
      const scope = SCOPES.has(item.scope) ? item.scope : 'global';
      const rawTarget = typeof item.target === 'string' ? item.target : '';
      const target = targetIsValid(scope, rawTarget) ? rawTarget : '';
      return {
        id: typeof item.id === 'string' && ID_PATTERN.test(item.id) ? item.id : `profile-${index}`,
        name: item.name.trim().slice(0, MAX_PROFILE_NAME),
        config: item.config && typeof item.config === 'object' ? item.config : {},
        updatedAt: validTimestamp(item.updatedAt) ? item.updatedAt : null,
        scope: scope === 'global' || target ? scope : 'global',
        target: scope === 'global' || target ? target : ''
      };
    });
}

export function createProfilesStore({ storage, now = Date.now, idFactory = defaultIdFactory, maxProfiles = MAX_PROFILES }) {
  /**
   * The queue tail. Each operation waits for the previous one to settle, so a
   * failed mutation never stalls the ones behind it.
   */
  let tail = Promise.resolve();
  const serialize = operation => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  async function read() {
    return sanitizeStoredProfiles(await storage.getProfiles());
  }

  async function save(message) {
    return serialize(async () => {
      const profile = message && message.profile;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return failure('Profile data is invalid.');
      if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > MAX_PROFILE_NAME) {
        return failure(`Profile name must be 1 to ${MAX_PROFILE_NAME} characters.`);
      }
      if (!SCOPES.has(profile.scope) || !targetIsValid(profile.scope, profile.target)) return failure('Profile scope or target is invalid.');
      const checkedConfig = validateConfig(profile.config);
      if (!checkedConfig.ok) return failure('Profile settings are invalid.');
      if (profile.id !== undefined && (typeof profile.id !== 'string' || !ID_PATTERN.test(profile.id))) return failure('Profile identifier is invalid.');
      if (message.expectedUpdatedAt !== undefined && (!profile.id || !validTimestamp(message.expectedUpdatedAt))) {
        return failure('Profile version is invalid.');
      }

      let profiles;
      try { profiles = await read(); } catch { return failure('Saved profiles could not be read.'); }
      const requested = profile.id ? profiles.find(item => item.id === profile.id) : null;
      const duplicate = profiles.find(item => item.name.toLowerCase() === profile.name.trim().toLowerCase()
        && item.scope === profile.scope && item.target === profile.target);

      if (message.createOnly === true && (requested || duplicate)) {
        return failure('A profile with that name and scope already exists. Review it before updating.');
      }

      if (profile.id && !requested) return failure('That profile no longer exists. Reload profiles and try again.');
      if (requested && message.expectedUpdatedAt !== undefined && requested.updatedAt !== message.expectedUpdatedAt) {
        return failure('That profile has changed. Reload profiles and try again.');
      }
      if (requested && duplicate && duplicate.id !== requested.id) return failure('A profile with that name and scope already exists.');
      if (!requested && duplicate && profile.id && duplicate.id !== profile.id) return failure('A profile with that name and scope already exists.');

      const current = requested || duplicate;
      if (!current && profiles.length >= maxProfiles) return failure(`You can save up to ${maxProfiles} profiles.`);
      const id = current ? current.id : (profile.id || idFromFactory(profiles, idFactory));
      if (!id) return failure('A profile identifier could not be created.');
      if (!current && profiles.some(item => item.id === id)) return failure('Profile identifier is already in use.');
      const saved = {
        id,
        name: profile.name.trim(),
        scope: profile.scope,
        target: profile.target,
        config: checkedConfig.config,
        // Strictly increasing, so an unchanged timestamp can never be mistaken
        // for a successful concurrent write.
        updatedAt: Math.max(now(), (current && validTimestamp(current.updatedAt) ? current.updatedAt + 1 : 0))
      };
      const next = current ? profiles.map(item => item.id === current.id ? saved : item) : [...profiles, saved];
      try { await storage.setProfiles(next); } catch { return failure('Saved profiles could not be written.'); }
      return { ok: true, profile: saved, profiles: next, created: !current };
    });
  }

  async function remove(message) {
    return serialize(async () => {
      if (!message || typeof message.id !== 'string' || !ID_PATTERN.test(message.id)) return failure('Profile identifier is invalid.');
      if (message.expectedUpdatedAt !== undefined && !validTimestamp(message.expectedUpdatedAt)) return failure('Profile version is invalid.');
      let profiles;
      try { profiles = await read(); } catch { return failure('Saved profiles could not be read.'); }
      const current = profiles.find(item => item.id === message.id);
      if (!current) return failure('That profile no longer exists.');
      if (message.expectedUpdatedAt !== undefined && current.updatedAt !== message.expectedUpdatedAt) return failure('That profile has changed. Reload profiles and try again.');
      const next = profiles.filter(item => item.id !== message.id);
      try { await storage.setProfiles(next); } catch { return failure('Saved profiles could not be written.'); }
      return { ok: true, profiles: next };
    });
  }

  return { save, remove };
}

function defaultIdFactory() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}