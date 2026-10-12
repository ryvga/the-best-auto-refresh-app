/* Actual MV3 regression checks with a disposable profile and loopback receiver. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

(async () => {
  const out = path.resolve(__dirname, '../output/playwright/interaction-webhook');
  await fs.mkdir(out, { recursive: true });
  const run = await fs.mkdtemp(path.join(out, 'run-'));
  const ext = path.join(run, 'extension');
  await fs.cp(path.resolve(__dirname, '../extension'), ext, { recursive: true });
  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*']; // Disposable copy only.
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const requests = [], evidence = [], errors = [];
  let loads = 0, context;
  const pass = name => { evidence.push(name); console.log('PASS', name); };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/hook') || req.url.startsWith('/fail') || req.url.startsWith('/slow') || req.url.startsWith('/redirect')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ path: req.url, headers: req.headers, body });
        if (req.url.startsWith('/slow')) { setTimeout(() => res.end('late'), 7000); return; }
        if (req.url === '/redirect') res.writeHead(302, { Location: '/hook-target' });
        else res.statusCode = req.url.startsWith('/fail') ? 500 : 200;
        res.end('Response contents must never appear in activity');
      });
      return;
    }
    if (req.url === '/favicon.ico') { res.end(); return; }
    loads++;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><title>Interaction fixture</title><h1>Waiting</h1><button id="click">Click</button><input id="typing"><div contenteditable="true" id="editable"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wait = async (predicate, label, ms = 9000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
    throw Error(label + ' timed out');
  };
  try {
    context = await chromium.launchPersistentContext(path.join(run, 'profile'), {
      executablePath: process.env.CHROME_EXECUTABLE, headless: true,
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext], viewport: { width: 800, height: 900 }
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const control = await context.newPage();
    await control.goto(`chrome-extension://${id}/options.html`);
    const page = await context.newPage();
    await page.goto(origin + '/page');
    const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, origin);
    const send = msg => control.evaluate(msg => chrome.runtime.sendMessage(msg), msg);
    const state = async () => (await send({ type: 'GET_STATE', tabId })).state;
    const start = async (extra = {}) => {
      const result = await send({ type: 'START', tabId, config: { stopCondition: 'never', intervalSeconds: 5, settleSeconds: 0, ...extra } });
      assert.equal(result.ok, true, result.error);
      await wait(async () => (await state())?.nextRefreshAt > Date.now(), 'initial countdown');
    };
    await start({ pauseOnInteraction: true });
    await page.evaluate(() => document.querySelector('#click').click());
    assert.equal((await state()).status, 'running');
    await page.locator('#click').click();
    await wait(async () => (await state()).status === 'paused', 'trusted click pause');
    const beforePause = loads;
    await new Promise(resolve => setTimeout(resolve, 5400));
    assert.equal(loads, beforePause);
    assert.equal((await state()).status, 'paused');
    assert.equal(await worker.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId), 'II');
    pass('Trusted click pauses countdown until manual Resume; synthetic clicks do not');
    assert.equal((await send({ type: 'RESUME', tabId })).ok, true);
    await wait(async () => (await state()).nextRefreshAt > Date.now(), 'resumed countdown');
    await page.locator('#typing').press('a');
    await wait(async () => (await state()).status === 'paused', 'trusted typing pause');
    pass('Keyboard typing pauses independently of pointer input');
    await start({ pauseOnInteraction: false });
    await page.locator('#click').click();
    await page.locator('#typing').press('b');
    assert.equal((await state()).status, 'running');
    pass('Interaction protection remains opt-in and disabled sessions continue');
    await send({ type: 'STOP', tabId });

    const delayedStart = await send({ type: 'START', tabId, config: {
      stopCondition: 'never', intervalSeconds: 5, settleSeconds: 0, pauseOnInteraction: true,
      actions: { webhook: { enabled: true, events: ['before-refresh'], url: origin + '/slow-boundary', method: 'POST', headers: '{}', body: '' } }
    } });
    assert.equal(delayedStart.ok, true);
    await wait(() => requests.some(req => req.path === '/slow-boundary'), 'before-refresh pending', 12000);
    const boundaryLoads = loads;
    await page.locator('#click').click();
    await wait(async () => (await state()).status === 'paused', 'pause while hook pending', 12000);
    assert.equal(loads, boundaryLoads);
    pass('Interaction during a pending before-refresh hook cancels the queued reload');
    await send({ type: 'STOP', tabId });

    // Delay only the persistence immediately before navigation, after the
    // content helper has acknowledged preparation. Exercise a real gesture.
    await worker.evaluate(() => {
      globalThis.originalSessionSet = chrome.storage.session.set;
      globalThis.reloadPersistencePending = false;
      chrome.storage.session.set = async values => {
        const pending = Object.values(values).some(value => value && typeof value === 'object'
          && Object.values(value).some(record => record && record.reloadPendingAt != null));
        if (pending) {
          globalThis.reloadPersistencePending = true;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return globalThis.originalSessionSet.call(chrome.storage.session, values);
      };
    });
    await start({ pauseOnInteraction: true });
    await wait(() => worker.evaluate(() => globalThis.reloadPersistencePending), 'pending reload persistence', 12000);
    const persistenceLoads = loads;
    await page.locator('#click').click();
    await wait(async () => (await state()).status === 'paused', 'pause during reload persistence');
    assert.equal(loads, persistenceLoads);
    await worker.evaluate(() => { chrome.storage.session.set = globalThis.originalSessionSet; });
    pass('Interaction after reload preparation still cancels navigation during persistence');
    await send({ type: 'STOP', tabId });

    const webhook = (url = origin + '/hook', extra = {}) => ({ enabled: true, events: ['match'], url, method: 'POST', headers: '{}', body: '', includePageDetails: false, ...extra });
    const testHook = hook => send({ type: 'TEST_WEBHOOK', tabId, webhook: hook });
    await start({ intervalSeconds: 60 });
    const unchanged = await state();
    let count = requests.length;
    const result = await testHook(webhook());
    assert.equal(result.ok, true, result.error);
    assert.equal(result.status, 200);
    assert.equal(requests.length, count + 1);
    assert.equal(JSON.parse(requests.at(-1).body).event, 'test');
    assert.equal(requests.at(-1).headers.cookie, undefined);
    assert.deepEqual(await state(), unchanged);
    pass('Explicit webhook test sends one private payload without altering a monitor');
    count = requests.length;
    assert.equal((await testHook(webhook(origin + '/hook', { enabled: false }))).ok, false);
    assert.equal((await testHook(webhook(origin + '/hook', { body: '{invalid' }))).ok, false);
    assert.equal((await testHook(webhook('http://localhost:1/hook'))).ok, false);
    assert.equal(requests.length, count);
    pass('Disabled, invalid and ungranted webhook tests send nothing');
    assert.equal((await send({ type: 'TEST_WEBHOOK', tabId: -1, webhook: webhook() })).ok, false);
    const rejectedSender = await worker.evaluate(async ({ tabId, webhook }) => {
      const results = await chrome.scripting.executeScript({ target: { tabId }, func: async (tabId, webhook) => chrome.runtime.sendMessage({ type: 'TEST_WEBHOOK', tabId, webhook }), args: [tabId, webhook] });
      return results[0].result;
    }, { tabId, webhook: webhook() });
    assert.equal(rejectedSender.ok, false);
    assert.equal(requests.length, count);
    pass('Closed/invalid tabs and content-script senders cannot dispatch test webhooks');
    const bad = await testHook(webhook(origin + '/fail'));
    assert.equal(bad.ok, false);
    count = requests.length;
    assert.equal((await testHook(webhook(origin + '/redirect'))).ok, false);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).path, '/redirect');
    pass('HTTP failures are reported and redirects are never followed');
    count = requests.length;
    const first = testHook(webhook(origin + '/slow'));
    await wait(() => requests.length > count, 'slow receiver');
    assert.equal((await testHook(webhook(origin + '/hook'))).ok, false);
    assert.equal((await first).ok, false);
    assert.equal(requests.length, count + 1);
    pass('In-flight guard rejects duplicate test sends and timeout does not retry');
    await testHook(webhook(origin + '/hook', { body: '{"topic":"fixture-topic","message":"{{event}} / {{url}}"}' }));
    assert.deepEqual(JSON.parse(requests.at(-1).body), { topic: 'fixture-topic', message: 'test / ' });
    const logs = await send({ type: 'ACTION_LOG', tabId });
    assert.ok(!JSON.stringify(logs).includes('Response contents'));
    pass('Test supports custom ntfy JSON and activity excludes response contents');

    const popupUrl = `chrome-extension://${id}/popup.html`;
    const openPopup = async targetId => {
      const popup = await context.newPage();
      await popup.goto(popupUrl);
      await popup.waitForFunction(() => document.body.dataset.ready === 'true');
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), targetId);
      await popup.reload();
      await popup.waitForFunction(() => document.body.dataset.ready === 'true');
      return popup;
    };
    const savedDefaults = { intervalSeconds: 12, stopCondition: 'never', actions: { webhook: webhook(), script: { enabled: true, events: ['match'], code: 'void 0;', world: 'USER_SCRIPT' } } };
    await worker.evaluate(defaults => chrome.storage.local.set({ defaults }), savedDefaults);
    const other = await context.newPage();
    await other.goto(origin + '/other');
    const otherId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, origin + '/other');
    let popup = await openPopup(otherId);
    assert.equal(await popup.locator('#automation-webhook-enabled').isChecked(), false);
    assert.equal(await popup.locator('#automation-script-enabled').isChecked(), false);
    pass('New tabs never enable webhook or custom scripts from shared defaults');
    await popup.locator('#automation > summary').click();
    await popup.locator('#automation-webhook-enabled').check();
    await popup.locator('#ntfy-server').fill(origin);
    await popup.locator('#ntfy-topic').fill('fixture-topic');
    count = requests.length;
    await popup.locator('#ntfy-use').click();
    assert.equal(requests.length, count);
    assert.equal(new URL(await popup.locator('#automation-webhook-url').inputValue()).pathname, '/');
    assert.equal(JSON.parse(await popup.locator('#automation-webhook-body').inputValue()).topic, 'fixture-topic');
    // For the test receiver route, edit the generated endpoint explicitly.
    await popup.locator('#automation-webhook-url').fill(origin + '/hook');
    await popup.locator('#automation-webhook-test').click();
    await wait(() => requests.length > count, 'popup test notification');
    await popup.waitForFunction(() => /200|sent|success/i.test(document.querySelector('#automation-webhook-test-status').textContent));
    pass('ntfy setup fills valid JSON without sending; separate explicit test button sends');
    await popup.locator('#ntfy-topic').fill('unfinished topic');
    await popup.close();
    popup = await openPopup(otherId);
    assert.equal(await popup.locator('#ntfy-server').inputValue(), origin);
    assert.equal(await popup.locator('#ntfy-topic').inputValue(), 'unfinished topic');
    await popup.locator('#ntfy-topic').fill('fixture-topic');
    pass('Raw unfinished ntfy setup is preserved only in this tab draft');
    await popup.locator('label[for="preset-custom"]').click();
    await popup.locator('label[for="mode-fixed"]').click();
    await popup.locator('#interval-seconds').fill('40');
    await popup.locator('#stop-condition').selectOption('never');
    await popup.locator('#primary-action').click();
    await wait(async () => (await send({ type: 'GET_STATE', tabId: otherId })).state?.status === 'running', 'popup start');
    await popup.waitForFunction(() => /this tab|Refreshing/.test(document.querySelector('#footer-note').textContent));
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('defaults')).defaults), savedDefaults);
    await popup.close();
    popup = await openPopup(otherId);
    assert.equal(await popup.locator('#automation-webhook-enabled').isChecked(), true);
    assert.equal(await popup.locator('#interval-seconds').inputValue(), '40');
    pass('Start keeps settings only on its tab and reopening preserves enabled webhook');
    if (!await popup.locator('#automation').evaluate(node => node.open)) await popup.locator('#automation > summary').click();
    await popup.locator('#automation-webhook-url').fill(origin + '/slow-start');
    await popup.locator('#automation-webhook-events input[value="start"]').check();
    const beforeSlowStart = requests.length;
    await popup.locator('#primary-action').click();
    await wait(() => requests.length > beforeSlowStart && requests.at(-1).path === '/slow-start', 'start hook receiver');
    await popup.locator('#interval-seconds').fill('41');
    await popup.waitForFunction(() => !document.querySelector('#primary-action').disabled, null, { timeout: 10000 });
    await popup.close();
    popup = await openPopup(otherId);
    assert.equal(await popup.locator('#interval-seconds').inputValue(), '41');
    assert.equal((await send({ type: 'GET_STATE', tabId: otherId })).state.config.intervalSeconds, 40);
    assert.equal(await popup.locator('#primary-action').textContent(), 'Apply & restart');
    pass('Edits made during a slow Start hook remain an independent unfinished draft');
    const duringStartProfile = {
      id: 'during-start-profile', name: 'Profile selected during Start', scope: 'global', target: '',
      updatedAt: Date.now(), config: { ...savedDefaults, intervalSeconds: 43 }
    };
    await worker.evaluate(profile => chrome.storage.local.set({ profiles: [profile] }), duringStartProfile);
    await popup.locator('#profile-select option[value="during-start-profile"]').waitFor({ state: 'attached' });
    if (!await popup.locator('#automation').evaluate(node => node.open)) await popup.locator('#automation > summary').click();
    await popup.locator('#automation-webhook-url').fill(origin + '/slow-profile');
    await popup.locator('#automation-webhook-events input[value="start"]').check();
    const beforeProfileStart = requests.length;
    await popup.locator('#primary-action').click();
    await wait(() => requests.length > beforeProfileStart && requests.at(-1).path === '/slow-profile', 'profile start hook receiver');
    await popup.locator('#profile-select').selectOption('during-start-profile');
    await popup.waitForFunction(() => !document.querySelector('#primary-action').disabled, null, { timeout: 10000 });
    await popup.close();
    popup = await openPopup(otherId);
    assert.equal(await popup.locator('#interval-seconds').inputValue(), '43');
    assert.equal((await send({ type: 'GET_STATE', tabId: otherId })).state.config.intervalSeconds, 41);
    assert.equal(await popup.locator('#primary-action').textContent(), 'Apply & restart');
    pass('Selecting a profile during a slow Start preserves the newly selected draft');
    await popup.close();
    const third = await context.newPage();
    await third.goto(origin + '/third');
    const thirdId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, origin + '/third');
    popup = await openPopup(thirdId);
    assert.equal(await popup.locator('#automation-webhook-enabled').isChecked(), false);
    assert.equal(await popup.locator('#interval-seconds').inputValue(), '12');
    const profile = { id: 'reuse-explicit', name: 'Reusable notifications', scope: 'global', target: '', updatedAt: Date.now(), config: savedDefaults };
    await worker.evaluate(profile => chrome.storage.local.set({ profiles: [profile] }), profile);
    await popup.locator('#profile-select option[value="reuse-explicit"]').waitFor({ state: 'attached' });
    await popup.locator('#profile-select').selectOption('reuse-explicit');
    assert.equal(await popup.locator('#automation-webhook-enabled').isChecked(), true);
    assert.equal(await popup.locator('#automation-script-enabled').isChecked(), true);
    assert.equal((await send({ type: 'GET_STATE', tabId: thirdId })).state, null);
    pass('Other tabs remain independent; explicit saved-profile selection restores hooks without starting');
    const siteProfile = { ...profile, id: 'site-notifications', scope: 'site', target: origin };
    await worker.evaluate(profile => chrome.storage.local.set({ profiles: [profile] }), siteProfile);
    const fourth = await context.newPage();
    await fourth.goto(origin + '/fourth');
    const fourthId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, origin + '/fourth');
    const sitePopup = await openPopup(fourthId);
    assert.equal(await sitePopup.locator('#automation-webhook-enabled').isChecked(), false);
    assert.equal(await sitePopup.locator('#automation-script-enabled').isChecked(), false);
    await sitePopup.locator('#profile-select').selectOption('site-notifications');
    assert.equal(await sitePopup.locator('#automation-webhook-enabled').isChecked(), true);
    await sitePopup.close();
    pass('Automatic site-profile suggestions leave hooks off; explicit selection restores them');
    for (const width of [360, 400]) {
      await popup.setViewportSize({ width, height: 900 });
      if (!await popup.locator('#automation').evaluate(node => node.open)) await popup.locator('#automation > summary').click();
      assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      await popup.screenshot({ path: path.join(out, `popup-${width}.png`), fullPage: true });
    }
    assert.equal(await popup.locator('a[href="https://ko-fi.com/mouniryuga"]').count(), 1);
    pass('360/400px popup layout and voluntary support link are present');
    await send({ type: 'STOP', tabId: otherId });
    await send({ type: 'STOP', tabId });
    await other.close();
    await wait(async () => await worker.evaluate(async id => {
      const values = await chrome.storage.session.get([`popupDraft:${id}`, `popupSettings:${id}`]);
      return Object.keys(values).length === 0;
    }, otherId), 'closed-tab temporary settings cleanup');
    pass('Closing a tab clears its temporary settings and draft');
    assert.equal(errors.length, 0, errors.join('\n'));
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ evidence, errors }, null, 2));
    console.log(`${evidence.length} interaction/webhook checks passed`);
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
