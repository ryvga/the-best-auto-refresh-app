#!/usr/bin/env node
/**
 * One-time helper that obtains a Chrome Web Store API refresh token.
 *
 * Usage:
 *   node scripts/cws-auth.mjs --client-id <id> --client-secret <secret> [--port 8765]
 *
 * Or set CWS_CLIENT_ID and CWS_CLIENT_SECRET in the environment.
 *
 * Before running, create an OAuth client in the Google Cloud console:
 *   1. Enable the "Chrome Web Store API" for your project.
 *   2. Create an OAuth client ID of type "Desktop app".
 *   3. Add http://127.0.0.1:<port>/ as an authorized redirect URI.
 *
 * The refresh token is printed once. Store it as the CWS_REFRESH_TOKEN secret;
 * it is long-lived and grants publish rights to your extensions.
 */

import http from 'node:http';
import process from 'node:process';
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function parseArgs(argv) {
  const options = { clientId: process.env.CWS_CLIENT_ID, clientSecret: process.env.CWS_CLIENT_SECRET, port: 8765 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--client-id') options.clientId = argv[++i];
    else if (argv[i] === '--client-secret') options.clientSecret = argv[++i];
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node scripts/cws-auth.mjs [--client-id <id>] [--client-secret <secret>] [--port 8765]\n');
      process.exit(0);
    } else {
      process.stderr.write(`error: unknown argument "${argv[i]}"\n`);
      process.exit(1);
    }
  }
  if (!options.clientId || !options.clientSecret) {
    process.stderr.write('error: --client-id and --client-secret are required (or set CWS_CLIENT_ID / CWS_CLIENT_SECRET)\n');
    process.exit(1);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const redirectUri = `http://127.0.0.1:${options.port}/`;
const state = crypto.randomBytes(16).toString('hex');

const consentUrl =
  `${AUTH_URL}?` +
  new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

/**
 * Shut down cleanly after answering the browser.
 *
 * `process.exit()` while an undici connection is closing crashes Node with a
 * libuv assertion, and a lingering keep-alive socket would hold the event loop
 * open, so pending connections are closed and the exit code is set instead.
 */
function finish(code) {
  process.exitCode = code;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/') {
    res.writeHead(404).end('Not found');
    return;
  }
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorization failed: ${error}`);
    process.stderr.write(`error: authorization failed: ${error}\n`);
    finish(1);
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch.');
    process.stderr.write('error: state mismatch; the response did not match this request\n');
    finish(1);
    return;
  }
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing authorization code.');
    return;
  }

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.refresh_token) {
      const reason = payload.error_description || payload.error || 'no refresh_token returned';
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Token exchange failed.');
      process.stderr.write(`error: ${reason}\n`);
      if (response.ok && !payload.refresh_token) {
        process.stderr.write('Revoke the app\'s access in your Google account and retry so a refresh token is issued.\n');
      }
      finish(1);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization complete. You can close this tab.');
    process.stdout.write('\nAuthorization complete.\n\n');
    process.stdout.write('Set this as the CWS_REFRESH_TOKEN secret (store it privately):\n\n');
    process.stdout.write(`${payload.refresh_token}\n\n`);
    finish(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Token exchange failed.');
    process.stderr.write(`error: ${err.message}\n`);
    finish(1);
  }
});

server.listen(options.port, '127.0.0.1', () => {
  process.stdout.write('Open this URL in your browser and approve access:\n\n');
  process.stdout.write(`${consentUrl}\n\n`);
  process.stdout.write(`Waiting for the redirect to ${redirectUri} ...\n`);
});
