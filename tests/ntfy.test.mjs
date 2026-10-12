import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NTFY_DEFAULT_EVENTS,
  NTFY_DEFAULT_MESSAGE,
  NTFY_DEFAULT_SERVER,
  NTFY_DEFAULT_TITLE,
  NTFY_MAX_TOPIC_LENGTH,
  buildNtfyBody,
  describeNtfyServer,
  describeNtfySetup,
  describeNtfyTopic
} from '../extension/ntfy.js';

test('the ntfy defaults are the documented safe ones', () => {
  assert.equal(NTFY_DEFAULT_SERVER, 'https://ntfy.sh');
  assert.equal(NTFY_MAX_TOPIC_LENGTH, 64);
  assert.deepEqual([...NTFY_DEFAULT_EVENTS], ['match', 'limit', 'manual-stop', 'error']);
  assert.ok(NTFY_DEFAULT_MESSAGE.includes('{{event}}'));
  assert.ok(NTFY_DEFAULT_MESSAGE.includes('{{refreshCount}}'));
  // The default heading never asks for page details, so a notification cannot
  // carry a page title unless the user explicitly turns that on afterwards.
  assert.equal(NTFY_DEFAULT_TITLE.includes('{{'), false);
});

test('the server accepts https anywhere and plain http only on loopback', () => {
  assert.deepEqual(describeNtfyServer('https://ntfy.sh'), { ok: true, server: 'https://ntfy.sh' });
  assert.deepEqual(describeNtfyServer('  https://ntfy.sh/  '), { ok: true, server: 'https://ntfy.sh' });
  assert.deepEqual(describeNtfyServer('https://example.com/ntfy/'), { ok: true, server: 'https://example.com/ntfy' });
  assert.deepEqual(describeNtfyServer('http://127.0.0.1:8080/'), { ok: true, server: 'http://127.0.0.1:8080' });
  assert.deepEqual(describeNtfyServer('http://localhost'), { ok: true, server: 'http://localhost' });

  for (const raw of ['', '   ', 'ntfy.sh', 'ftp://ntfy.sh', 'http://example.com', 'http://localhost.evil.test',
    'https://user:pass@ntfy.sh', 'https://*/hook', 'javascript:alert(1)']) {
    const result = describeNtfyServer(raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw)} must be rejected`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, 'a rejection must keep a readable reason');
  }
  // The shared reason survives; it is never replaced by a vague message.
  assert.match(describeNtfyServer('http://example.com').error, /loopback|local development/i);
});

test('the topic follows the ntfy character rules', () => {
  assert.deepEqual(describeNtfyTopic(' aa-kc_9 '), { ok: true, topic: 'aa-kc_9' });
  assert.equal(describeNtfyTopic('a'.repeat(NTFY_MAX_TOPIC_LENGTH)).ok, true);
  assert.equal(describeNtfyTopic('a'.repeat(NTFY_MAX_TOPIC_LENGTH + 1)).ok, false);
  for (const bad of ['', '  ', 'has space', 'has/slash', 'has.dot', 'emoji🙂', 'ümlaut', 'quote"d', 'plus+name', 'colon:name']) {
    assert.equal(describeNtfyTopic(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('the body is exactly topic/title/message JSON with the shared tokens', () => {
  assert.throws(() => buildNtfyBody({ topic: '' }), TypeError);
  const body = buildNtfyBody({ topic: 'my-topic' });
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed).sort(), ['message', 'title', 'topic']);
  assert.equal(parsed.topic, 'my-topic');
  assert.equal(parsed.title, NTFY_DEFAULT_TITLE);
  assert.equal(parsed.message, NTFY_DEFAULT_MESSAGE);
  assert.ok(body.includes('{{event}}'));
  assert.ok(body.includes('{{refreshCount}}'));
});

test('a hostile message stays one JSON string and adds no field', () => {
  const message = '"},"topic":"stolen","x":"{{url}} \\ end';
  const body = buildNtfyBody({ topic: 'safe-topic', message });
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed).sort(), ['message', 'title', 'topic']);
  assert.equal(parsed.topic, 'safe-topic');
  assert.equal(parsed.message, message);
  assert.equal(parsed.x, undefined);
  // The injected text is escaped inside the message value; the first two
  // top-level keys are still the topic and the title this module wrote.
  assert.ok(body.startsWith('{"topic":"safe-topic","title":'));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
});

test('a blank or unusable title falls back instead of sending an empty heading', () => {
  assert.equal(JSON.parse(buildNtfyBody({ topic: 't', title: '   ' })).title, NTFY_DEFAULT_TITLE);
  assert.equal(JSON.parse(buildNtfyBody({ topic: 't', message: '' })).message, NTFY_DEFAULT_MESSAGE);
  const long = buildNtfyBody({ topic: 't', title: 'x'.repeat(5000) });
  assert.ok(long.length < 10000);
});

test('the generated webhook patch is the exact root-POST shape', () => {
  const result = describeNtfySetup({ server: 'https://ntfy.sh', topic: 'my-topic' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.server, 'https://ntfy.sh');
  assert.equal(result.topic, 'my-topic');
  assert.deepEqual(result.webhook, {
    url: 'https://ntfy.sh',
    method: 'POST',
    headers: '{}',
    body: '{"topic":"my-topic","title":"The Best Auto Refresh App","message":"Refresh monitor: {{event}} ({{refreshCount}} refreshes)"}',
    events: ['match', 'limit', 'manual-stop', 'error'],
    includePageDetails: false
  });
  assert.equal('enabled' in result.webhook, false, 'generating settings must never switch the webhook on or off');
  assert.equal(result.webhook.body.includes('{{url}}'), false);
  assert.equal(result.webhook.body.includes('{{title}}'), false);
});

test('invalid setup reports both fields and never produces a patch', () => {
  const both = describeNtfySetup({ server: 'http://example.com', topic: 'bad topic' });
  assert.equal(both.ok, false);
  assert.equal(both.webhook, null);
  assert.deepEqual(both.errors.map((entry) => entry.field), ['ntfy-server', 'ntfy-topic']);
  const empty = describeNtfySetup({});
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.errors.map((entry) => entry.field), ['ntfy-server', 'ntfy-topic']);
  assert.equal(describeNtfySetup(null).ok, false);
});

test('helpers are pure: no shared state and no input mutation', () => {
  const input = { server: 'https://ntfy.sh', topic: 'my-topic' };
  const snapshot = JSON.stringify(input);
  const first = describeNtfySetup(input);
  const second = describeNtfySetup(input);
  assert.equal(JSON.stringify(input), snapshot, 'the input object is never modified');
  assert.deepEqual(first, second);
  first.webhook.events.push('start');
  first.webhook.url = 'https://changed.example';
  assert.deepEqual(describeNtfySetup(input).webhook.events, [...NTFY_DEFAULT_EVENTS]);
  assert.equal(describeNtfySetup(input).webhook.url, 'https://ntfy.sh');
  assert.equal(JSON.stringify([...NTFY_DEFAULT_EVENTS]), JSON.stringify(['match', 'limit', 'manual-stop', 'error']));
});
