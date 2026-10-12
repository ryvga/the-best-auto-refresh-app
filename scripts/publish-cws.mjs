#!/usr/bin/env node
/**
 * Publish this extension to the Chrome Web Store through the Chrome Web Store
 * API v2. No dependencies; uses the global fetch available in Node 20+.
 *
 * Usage:
 *   node scripts/publish-cws.mjs status
 *   node scripts/publish-cws.mjs upload   [--zip <path>]
 *   node scripts/publish-cws.mjs publish  [--staged] [--skip-review]
 *   node scripts/publish-cws.mjs release  [--zip <path>] [--staged] [--skip-review]
 *
 * Global flags:
 *   --dry-run   Validate configuration and the package without calling Google.
 *
 * Required environment variables:
 *   CWS_CLIENT_ID       OAuth client ID     (Google Cloud console)
 *   CWS_CLIENT_SECRET   OAuth client secret
 *   CWS_REFRESH_TOKEN   Refresh token from scripts/cws-auth.mjs
 *   CWS_PUBLISHER_ID    Developer dashboard publisher ID
 *   CWS_EXTENSION_ID    The item's extension ID (32 lowercase letters)
 *
 * The Chrome Web Store API can only update an item that already exists. The
 * very first submission must be uploaded once in the developer dashboard.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const ENV_KEYS = [
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'CWS_PUBLISHER_ID',
  'CWS_EXTENSION_ID',
];

const ITEM_STATES = new Set([
  'ITEM_STATE_UNSPECIFIED',
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED',
]);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    command: null,
    zip: null,
    staged: false,
    skipReview: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--zip') {
      options.zip = argv[i + 1];
      if (!options.zip) fail('--zip requires a path');
      i += 1;
    } else if (arg === '--staged') {
      options.staged = true;
    } else if (arg === '--skip-review') {
      options.skipReview = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else if (arg.startsWith('-')) {
      fail(`unknown argument "${arg}" (try --help)`);
    } else if (options.command) {
      fail(`unexpected argument "${arg}" (try --help)`);
    } else {
      options.command = arg;
    }
  }
  return options;
}

function readConfig({ requireCredentials = true } = {}) {
  const config = {
    clientId: process.env.CWS_CLIENT_ID,
    clientSecret: process.env.CWS_CLIENT_SECRET,
    refreshToken: process.env.CWS_REFRESH_TOKEN,
    publisherId: process.env.CWS_PUBLISHER_ID,
    extensionId: process.env.CWS_EXTENSION_ID,
  };
  const missing = ENV_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0 && requireCredentials) {
    fail(
      `missing environment variable(s): ${missing.join(', ')}\n` +
        'See docs/SUBMISSION.md for how to create these values, ' +
        'or run with --dry-run to check the package only.',
    );
  }
  return config;
}

async function accessToken(config) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await jsonOrText(response);
  if (!response.ok) {
    // Never echo the response verbatim: it can contain credential material.
    const reason = payload?.error_description || payload?.error || response.statusText;
    fail(`could not obtain an access token (HTTP ${response.status}): ${reason}`);
  }
  if (!payload?.access_token) fail('token endpoint returned no access_token');
  return payload.access_token;
}

async function jsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function apiError(payload, response) {
  const message = payload?.error?.message || payload?.raw || response.statusText;
  return `HTTP ${response.status}: ${message}`;
}

async function authedFetch(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const payload = await jsonOrText(response);
  if (!response.ok) fail(`${init.method || 'GET'} ${url}\n  ${apiError(payload, response)}`);
  return payload;
}

function itemUrl(config, suffix) {
  const publisher = encodeURIComponent(config.publisherId);
  const item = encodeURIComponent(config.extensionId);
  return `${API_ROOT}/v2/publishers/${publisher}/items/${item}${suffix}`;
}

function uploadUrl(config) {
  const publisher = encodeURIComponent(config.publisherId);
  const item = encodeURIComponent(config.extensionId);
  return `${API_ROOT}/upload/v2/publishers/${publisher}/items/${item}:upload`;
}

async function resolveZipPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const manifest = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'),
  );
  return path.join(PROJECT_ROOT, 'dist', `the-best-auto-refresh-app-${manifest.version}.zip`);
}

async function checkPackage(zipPath) {
  let info;
  try {
    info = await stat(zipPath);
  } catch {
    fail(
      `package not found: ${zipPath}\n` +
        'Build it first: powershell -ExecutionPolicy Bypass -File scripts/package.ps1',
    );
  }
  if (!info.isFile() || info.size === 0) fail(`package is empty: ${zipPath}`);
  const bytes = await readFile(zipPath);
  // A ZIP's entry names are UTF-8 with "/" separators; the first entry name
  // starts 30 bytes into the local file header.
  if (bytes.readUInt32LE(0) !== 0x04034b50) fail(`not a ZIP archive: ${zipPath}`);
  const nameLength = bytes.readUInt16LE(26);
  const firstName = bytes.subarray(30, 30 + nameLength).toString('utf8');
  if (firstName.includes('\\')) {
    fail(
      `archive uses backslash separators (first entry "${firstName}").\n` +
        'Rebuild it with scripts/package.ps1.',
    );
  }
  return { size: info.size, firstName };
}

async function pollUploadState(config, token, { attempts = 20, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = await authedFetch(itemUrl(config, ':fetchStatus'), token);
    const state = status?.lastAsyncUploadState;
    if (state && state !== 'IN_PROGRESS') return { status, state };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { status: null, state: 'IN_PROGRESS' };
}

async function doUpload(config, token, zipPath) {
  const bytes = await readFile(zipPath);
  process.stdout.write(`Uploading ${path.basename(zipPath)} (${bytes.length} bytes)...\n`);
  const result = await authedFetch(uploadUrl(config), token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: bytes,
  });

  let state = result?.uploadState;
  const version = result?.crxVersion;
  if (version) process.stdout.write(`Uploaded manifest version: ${version}\n`);

  if (state === 'IN_PROGRESS') {
    process.stdout.write('Upload is processing; polling status...\n');
    const polled = await pollUploadState(config, token);
    state = polled.state;
  }
  if (state !== 'SUCCEEDED') fail(`upload did not succeed (uploadState: ${state || 'unknown'})`);
  process.stdout.write('Upload succeeded.\n');
  return result;
}

async function doPublish(config, token, { staged, skipReview }) {
  const body = {
    publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
    skipReview: Boolean(skipReview),
    blockOnWarnings: true,
  };
  process.stdout.write(`Submitting with publishType=${body.publishType}...\n`);
  const result = await authedFetch(itemUrl(config, ':publish'), token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const state = result?.state;
  if (!ITEM_STATES.has(state)) {
    process.stdout.write(`Submission accepted (state: ${state || 'unknown'}).\n`);
  } else {
    process.stdout.write(`Submission state: ${state}\n`);
    if (state === 'REJECTED') fail('the submission was rejected by the store');
  }
  const warnings = result?.warningInfo?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    process.stdout.write(`Warnings (${warnings.length}):\n`);
    for (const warning of warnings) {
      process.stdout.write(`  - ${warning.description || JSON.stringify(warning)}\n`);
    }
  }
  if (state === 'PENDING_REVIEW') {
    process.stdout.write('The item is now pending Google review.\n');
  }
  return result;
}

async function doStatus(config, token) {
  const status = await authedFetch(itemUrl(config, ':fetchStatus'), token);
  const published = status?.publishedItemRevisionStatus?.state;
  const submitted = status?.submittedItemRevisionStatus?.state;
  process.stdout.write(`Item: ${status?.itemId || config.extensionId}\n`);
  process.stdout.write(`Published revision: ${published || '(none)'}\n`);
  process.stdout.write(`Submitted revision: ${submitted || '(none)'}\n`);
  process.stdout.write(`Last async upload: ${status?.lastAsyncUploadState || '(none)'}\n`);
  if (status?.takenDown) process.stdout.write('WARNING: the item has been taken down.\n');
  if (status?.warned) process.stdout.write('WARNING: the item has an unresolved policy warning.\n');
  return status;
}

const HELP = `Publish the extension to the Chrome Web Store (API v2).

  node scripts/publish-cws.mjs status
  node scripts/publish-cws.mjs upload   [--zip <path>] [--dry-run]
  node scripts/publish-cws.mjs publish  [--staged] [--skip-review] [--dry-run]
  node scripts/publish-cws.mjs release  [--zip <path>] [--staged] [--skip-review] [--dry-run]

Requires CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN,
CWS_PUBLISHER_ID and CWS_EXTENSION_ID. See docs/SUBMISSION.md.
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const valid = new Set(['status', 'upload', 'publish', 'release']);
  if (!valid.has(options.command)) fail(`unknown command "${options.command}" (try --help)`);

  const config = readConfig({ requireCredentials: !options.dryRun });
  const zipPath = await resolveZipPath(options.zip);

  if (options.command === 'status') {
    if (options.dryRun) {
      process.stdout.write('Dry run: configuration present, status not fetched.\n');
      return;
    }
    await doStatus(config, await accessToken(config));
    return;
  }

  const info = await checkPackage(zipPath);
  process.stdout.write(`Package: ${zipPath}\n  ${info.size} bytes, first entry "${info.firstName}"\n`);

  if (options.dryRun) {
    process.stdout.write('Dry run: package looks uploadable; nothing was sent to Google.\n');
    return;
  }

  const token = await accessToken(config);
  if (options.command === 'upload' || options.command === 'release') {
    await doUpload(config, token, zipPath);
  }
  if (options.command === 'publish' || options.command === 'release') {
    await doPublish(config, token, {
      staged: options.staged,
      skipReview: options.skipReview,
    });
  }
}

main().catch((error) => {
  fail(error?.stack || String(error));
});
