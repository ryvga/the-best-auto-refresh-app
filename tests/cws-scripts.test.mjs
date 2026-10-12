/**
 * Offline checks for the Chrome Web Store publishing tooling.
 *
 * These never contact Google and need no credentials. They cover the CLI
 * contract and the failure paths, including the two bugs found while building
 * the scripts: exiting while an undici connection is closing crashed Node, and
 * replacing `process.exit()` with a non-terminating shutdown let the auth error
 * branches fall through and write HTTP headers twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import net from 'node:net';
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

function freePort() {
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

test('publish-cws: --dry-run validates the package without credentials', async () => {
  const result = await run(publishScript, ['upload', '--dry-run']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Dry run/);
  assert.match(result.stdout, /manifest\.json|first entry/);
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