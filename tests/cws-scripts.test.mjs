/**
 * Offline checks for the Chrome Web Store publishing tooling.
 *
 * These never contact Google and need no credentials. They cover the CLI
 * contract and the failure paths, including the two bugs found while building
 * the scripts: exiting while an undici connection is closing crashed Node, and
 * replacing `process.exit()` with a non-terminating shutdown let the auth error
 * branches fall through and write HTTP headers twice.
 *
 * The dry-run checks build their own ZIP fixture instead of relying on
 * `dist/`, which is git-ignored. Depending on a local build made `npm test`
 * fail on every fresh checkout — and therefore in CI — until someone happened
 * to package the current version locally.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishScript = path.join(root, 'scripts', 'publish-cws.mjs');
const authScript = path.join(root, 'scripts', 'cws-auth.mjs');

/** Environment without any CWS_* configuration, so "missing" is deterministic. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CWS_')) delete env[key];
  }
  return { ...env, ...extra };
}

function run(file, args, env = cleanEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Build a genuine stored-compression ZIP, so the fixture exercises the real
 * archive shape rather than a hand-placed signature.
 */
function makeZip(entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);        // stored, no compression
    local.writeUInt16LE(0x21, 12);    // 1980-01-01, the ZIP epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, ...centralParts, end]);
}

/** Write a ZIP fixture into a temp directory that is cleaned up afterwards. */
async function zipFixture(t, entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cws-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'package.zip');
  await writeFile(zipPath, makeZip(entries));
  return zipPath;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('publish-cws: --help exits 0 and documents the commands', async () => {
  const result = await run(publishScript, ['--help']);
  assert.equal(result.code, 0);
  for (const command of ['status', 'upload', 'publish', 'release']) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test('publish-cws: missing credentials fails informatively', async () => {
  const result = await run(publishScript, ['status']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CWS_CLIENT_ID/);
  assert.match(result.stderr, /dry-run/);
});

test('publish-cws: an unknown command fails', async () => {
  const result = await run(publishScript, ['frobnicate']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command/);
});

test('publish-cws: --dry-run validates the package without credentials', async (t) => {
  const zipPath = await zipFixture(t, [
    ['manifest.json', '{"manifest_version":3}'],
    ['background.js', '// bundled, no remote code']
  ]);

  const result = await run(publishScript, ['upload', '--dry-run', '--zip', zipPath]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Dry run/);
  assert.match(result.stdout, /first entry "manifest\.json"/);
});

test('publish-cws: the default package path is derived from the manifest version', async () => {
  // `dist/` is git-ignored, so this test must hold with or without a local
  // build: either the versioned archive is found, or the error names it.
  const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const basename = `the-best-auto-refresh-app-${manifest.version}.zip`;

  const result = await run(publishScript, ['upload', '--dry-run']);
  if (result.code === 0) {
    assert.match(result.stdout, new RegExp(`${basename.replace(/\./g, '\\.')}`));
  } else {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /package not found/);
    assert.match(result.stderr, new RegExp(basename.replace(/\./g, '\\.')));
  }
});

test('publish-cws: a backslash-separated archive is rejected', async (t) => {
  const zipPath = await zipFixture(t, [['extension\\manifest.json', '{}']]);
  const result = await run(publishScript, ['upload', '--dry-run', '--zip', zipPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /backslash separators/);
});

test('publish-cws: a missing package is rejected before any network use', async () => {
  const result = await run(publishScript, ['upload', '--dry-run', '--zip', 'dist/definitely-not-here.zip']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /package not found/);
});

test('cws-auth: a state mismatch answers 400, exits 1, and does not crash', async () => {
  const port = await freePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(
    process.execPath,
    [authScript, '--client-id', 'dummy.apps.googleusercontent.com', '--client-secret', 'dummy', '--port', String(port)],
    { cwd: root, env: cleanEnv() },
  );
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    assert.ok(await waitFor(() => stdout.includes('Waiting for the redirect')), 'auth server should start');
    const state = /state=([A-Za-z0-9]+)/.exec(stdout)?.[1];
    assert.ok(state, 'the consent URL should carry a state value');

    const response = await fetch(`http://127.0.0.1:${port}/?code=fake&state=not-the-state`);
    assert.equal(response.status, 400);

    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 1, 'a failed authorization must exit non-zero');
    assert.match(stderr, /state mismatch/);
    // Regression guards: no double writeHead fall-through, no exit-time crash.
    assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT/);
    assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING/);
  } finally {
    if (!child.killed) child.kill();
  }
});