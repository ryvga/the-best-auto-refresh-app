/* Controlled MV3 automation QA: only disposable profiles and loopback requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

(async () => {
  const out = path.resolve(__dirname, '../output/playwright/automation');
  await fs.mkdir(out, { recursive: true });
  const run = await fs.mkdtemp(path.join(out, 'run-'));
  const ext = path.join(run, 'extension');
  await fs.cp(path.resolve(__dirname, '../extension'), ext, { recursive: true });
  const manifestFile = path.join(ext, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.permissions.push('userScripts'); // Test copy only: production remains optional.
  manifest.optional_permissions = [];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const requests = [], evidence = [], errors = [];
  const pass = name => { evidence.push(name); console.log('PASS', name); };
  let stock = 'Waiting', context, scriptsAvailable = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/hook') || req.url.startsWith('/fail') || req.url.startsWith('/redirect') || req.url.startsWith('/slow')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ path: req.url, headers: req.headers, body });
        if (req.url.startsWith('/slow')) {
          setTimeout(() => { if (!res.destroyed) res.end('Late result'); }, 7000);
          return;
        }
        if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/redirect-target' }); }
        else res.statusCode = req.url.startsWith('/fail') ? 500 : 200;
        res.end('A response body that must never appear in activity');
      });
      return;
    }
    if (req.url === '/favicon.ico') { res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><title>Automation fixture</title><h1 id="stock">${stock}</h1>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    context = await chromium.launchPersistentContext(path.join(run, 'profile'), {
      executablePath: process.env.CHROME_EXECUTABLE, headless: true,
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext],
      viewport: { width: 800, height: 900 }
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const control = await context.newPage();
    await control.goto(`chrome-extension://${id}/options.html`);
    const target = await context.newPage();
    await target.goto(origin + '/page');
    const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, origin);
    const send = msg => control.evaluate(msg => chrome.runtime.sendMessage(msg), msg);
    const state = async () => (await send({ type: 'GET_STATE', tabId })).state;
    const wait = async (predicate, label, timeout = 15000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
      throw Error(label + ' timed out');
    };
    const actions = (url, events, extra = {}) => ({ webhook: { enabled: true, url, events, headers: '{}', body: '', method: 'POST', includePageDetails: false, ...extra } });
    const start = async (hooks, config = {}) => {
      const result = await send({ type: 'START', tabId, config: { intervalSeconds: 5, settleSeconds: 0, stopCondition: 'never', actions: hooks, ...config } });
      assert.equal(result.ok, true, result.error);
    };
    await start(actions(origin + '/hook', ['start', 'check', 'before-refresh', 'after-refresh', 'limit']), { maxRefreshes: 1 });
    await wait(async () => (await state())?.status === 'stopped', 'refresh limit');
    await wait(() => requests.some(req => { try { return JSON.parse(req.body).event === 'limit'; } catch { return false; } }), 'limit delivery');
    const delivered = requests.map(req => JSON.parse(req.body).event);
    for (const event of ['start', 'check', 'before-refresh', 'after-refresh', 'limit']) assert.ok(delivered.includes(event), event);
    assert.equal(delivered.filter(event => event === 'after-refresh').length, 1);
    for (const req of requests) {
      assert.deepEqual(Object.keys(JSON.parse(req.body)).sort(), ['event', 'refreshCount', 'status', 'timestamp']);
      assert.equal(req.headers.cookie, undefined);
    }
    pass('Real refresh lifecycle sends selected events once and omits page details/cookies by default');
    const initial = requests.length;
    await target.reload();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(requests.length, initial);
    pass('Manual reload of a stopped monitor produces no after-refresh delivery');

    const keyword = 'Waiting';
    await start(actions(origin + '/hook', ['match'], { body: '{"text":"{{event}} / {{keyword}} / {{url}}"}' }), { stopCondition: 'keyword-found', keyword });
    await wait(async () => (await state())?.status === 'matched', 'match');
    await wait(() => requests.some(req => { try { return JSON.parse(req.body).text === 'match /  / '; } catch { return false; } }), 'match delivery');
    assert.deepEqual(JSON.parse(requests.at(-1).body), { text: 'match /  / ' });
    pass('Custom JSON templates work without enabling page details');
    stock = 'Waiting';
    const quoted = 'Waiting "quoted" {{url}}';
    await start(actions(origin + '/hook', ['start'], { includePageDetails: true, body: '{"value":"{{keyword}}","nested":{"value":"{{event}}"}}', headers: '{"X-Example":"local-test"}' }), { keyword: quoted });
    assert.equal(JSON.parse(requests.at(-1).body).value, quoted);
    assert.equal(requests.at(-1).headers['x-example'], 'local-test');
    pass('Opt-in details and headers preserve quotes and literal nested tokens');
    await send({ type: 'PAUSE', tabId });
    await start(actions(origin + '/hook', ['pause', 'resume', 'manual-stop']));
    await send({ type: 'PAUSE', tabId });
    await send({ type: 'RESUME', tabId });
    await send({ type: 'STOP', tabId });
    for (const event of ['pause', 'resume', 'manual-stop']) assert.ok(requests.some(req => JSON.parse(req.body).event === event));
    pass('Pause, resume and manual stop have separate event hooks');

    await start(actions(origin + '/fail', ['start']));
    assert.equal((await state()).status, 'running');
    assert.ok((await send({ type: 'ACTION_LOG', tabId })).entries.some(entry => entry.status === 'failed'));
    await send({ type: 'STOP', tabId });
    const redirections = requests.length;
    await start(actions(origin + '/redirect', ['start']));
    assert.equal(requests.length, redirections + 1);
    assert.equal(requests.at(-1).path, '/redirect');
    await send({ type: 'STOP', tabId });
    pass('HTTP errors and redirects are logged without stopping the monitor or following redirects');

    const beforeDenied = requests.length;
    await start(actions(origin.replace('127.0.0.1', 'localhost') + '/hook', ['start']));
    assert.equal(requests.length, beforeDenied);
    assert.equal((await state()).status, 'running');
    assert.ok((await send({ type: 'ACTION_LOG', tabId })).entries.some(entry => entry.status === 'skipped'));
    await send({ type: 'STOP', tabId });
    pass('A hostname without a grant sends nothing and leaves refreshing available');

    await start(actions(origin + '/hook', ['error']));
    await send({ type: 'PAUSE', tabId });
    await worker.evaluate(() => {
      globalThis.originalSendMessage = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = function(id, message, options, callback) {
        if (message.type === 'ABRA_SESSION') { callback({ ok: false, error: 'Controlled attach failure' }); return; }
        return originalSendMessage.call(chrome.tabs, id, message, options, callback);
      };
    });
    const failedResume = await send({ type: 'RESUME', tabId });
    await worker.evaluate(() => { chrome.tabs.sendMessage = originalSendMessage; });
    assert.equal(failedResume.ok, false);
    assert.equal((await state()).status, 'error');
    assert.equal(JSON.parse(requests.at(-1).body).event, 'error');
    pass('Resume attach failure emits the selected terminal error hook');

    await start(actions(origin + '/hook', ['manual-stop']));
    await send({ type: 'DISABLE_ACTION', tabId, kind: 'webhook' });
    assert.equal((await state()).status, 'running');
    const beforeDisabled = requests.length;
    await send({ type: 'STOP', tabId });
    assert.equal(requests.length, beforeDisabled);
    pass('Turning a hook off immediately suppresses future calls without stopping refreshing');

    // This toggle belongs only to the throwaway test profile, never the user browser.
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/?id=' + id);
    const scriptToggle = manager.locator('#allow-user-scripts cr-toggle, cr-toggle#allow-user-scripts, #allowUserScripts');
    if (await scriptToggle.count()) {
      const toggle = scriptToggle.first();
      if (!await toggle.evaluate(node => node.checked === true)) await toggle.click();
    }
    await manager.close();
    const capabilities = await send({ type: 'ACTION_CAPABILITIES', tabId });
    scriptsAvailable = capabilities.scriptAvailable;
    if (scriptsAvailable) {
      await start({ script: { enabled: true, events: ['start'], code: "await new Promise(resolve => setTimeout(resolve, 40)); document.body.dataset.hook = event.type + ':' + event.keyword;", world: 'USER_SCRIPT' } }, { keyword: 'local-value' });
      assert.equal(await target.evaluate(() => document.body.dataset.hook), 'start:local-value');
      await send({ type: 'STOP', tabId });
      await start({ script: { enabled: true, events: ['start'], code: "throw Error('private-code-error');", world: 'USER_SCRIPT' } });
      const log = (await send({ type: 'ACTION_LOG', tabId })).entries;
      assert.ok(log.some(entry => entry.kind === 'script' && entry.status === 'failed'));
      assert.ok(!JSON.stringify(log).includes('private-code-error'));
      await send({ type: 'STOP', tabId });
      pass('Real isolated user script awaits async DOM changes and logs errors without code details');
      const beforeSlow = requests.length, startedSlow = Date.now();
      const slowStart = start({
        ...actions(origin + '/slow', ['start']),
        script: { enabled: true, events: ['start'], code: "document.body.dataset.parallelHook = 'ran';", world: 'USER_SCRIPT' }
      });
      await target.waitForFunction(() => document.body.dataset.parallelHook === 'ran', null, { timeout: 1500 });
      await slowStart;
      assert.ok(Date.now() - startedSlow < 6500, 'webhook timeout must bound waiting');
      assert.equal((await state()).status, 'running');
      assert.equal(requests.length, beforeSlow + 1, 'timeouts must not retry');
      assert.ok((await send({ type: 'ACTION_LOG', tabId })).entries.some(entry => entry.kind === 'webhook' && entry.message.includes('finish within')));
      await send({ type: 'STOP', tabId });
      pass('Five-second webhook timeout does not block an independent script, stop monitoring or retry');
    } else {
      await start({ script: { enabled: true, events: ['start'], code: "document.body.dataset.hook = 'unavailable';", world: 'USER_SCRIPT' } });
      assert.ok((await send({ type: 'ACTION_LOG', tabId })).entries.some(entry => entry.kind === 'script' && entry.status === 'skipped'));
      await send({ type: 'STOP', tabId });
      pass('Disabled User Scripts API skips code and preserves monitoring (real execution unavailable)');
    }
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    await popup.reload();
    await popup.locator('#automation > summary').click();
    await popup.locator('#automation-webhook-enabled').check();
    await popup.locator('#automation-webhook-url').fill(origin + '/hook');
    await popup.locator('#automation-webhook-body').fill('{unfinished');
    await popup.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    await reopened.reload();
    await wait(async () => (await reopened.locator('#automation-webhook-body').inputValue()) === '{unfinished', 'raw automation draft');
    await reopened.locator('#automation-webhook-body').fill('{"text":"{{event}}"}');
    await reopened.locator('#automation-script-enabled').check();
    await reopened.locator('#automation-script-code').fill("document.body.style.outline = '4px solid #0e6b62';");
    await reopened.locator('#profile-save > summary').click();
    await reopened.locator('#profile-name').fill('Automation QA');
    await reopened.locator('#profile-save-action').click();
    await wait(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('profiles')).profiles || [])).some(profile => profile.name === 'Automation QA'), 'save automation profile');
    const savedProfile = await worker.evaluate(async () => (await chrome.storage.local.get('profiles')).profiles.find(profile => profile.name === 'Automation QA'));
    assert.equal(savedProfile.config.actions.webhook.body, '{"text":"{{event}}"}');
    assert.equal(savedProfile.config.actions.script.enabled, true);
    await control.reload();
    await control.locator('.profile').filter({ hasText: 'Automation QA' }).locator('button').filter({ hasText: 'Load into form' }).click();
    await control.locator('#defaults-form button[type="submit"]').click();
    await wait(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('defaults')).defaults))?.actions?.script?.enabled === true, 'dashboard preserving hooks');
    pass('Page profiles and dashboard defaults preserve webhook and script configuration');
    for (const width of [360, 400]) {
      await reopened.setViewportSize({ width, height: 750 });
      await reopened.screenshot({ path: path.join(out, 'automation-' + width + '.png'), fullPage: true });
      const overflow = await reopened.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 10).map(node => ({ id: node.id, class: node.className, width: node.getBoundingClientRect().width })) }));
      assert.ok(overflow.document <= overflow.width, JSON.stringify(overflow));
    }
    pass('Unfinished automation draft restores raw JSON and UI fits 360/400px');
    const allLog = JSON.stringify((await send({ type: 'ACTION_LOG', tabId })).entries);
    for (const value of [origin, 'private-code-error', 'A response body', 'X-Example', 'local-value']) assert.ok(!allLog.includes(value), value);
    assert.deepEqual(errors, []);
    pass('Activity contains no webhook addresses, payload/header values, response bodies or script errors');
  } finally {
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ evidence, errors, scriptsAvailable }, null, 2));
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
