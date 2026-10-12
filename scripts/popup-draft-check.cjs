/*
 * Real MV3 popup draft-retention regression checks. Runs only against a
 * disposable extension copy and a fresh Helium profile; no personal profile is
 * opened. The copy receives only loopback fixture host access.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const TIMEOUT = 4000;

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'popup-draft-check');
  await fs.mkdir(out, { recursive: true });
  const temp = await fs.mkdtemp(path.join(out, 'run-'));
  const ext = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const server = http.createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end('<!doctype html><title>Draft fixture</title><h1>Draft fixture</h1><button id="pick-target">Pick target</button><p id="fixture">Fixture content</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  const evidence = [];
  const errors = [];
  const record = name => { evidence.push({ name, result: 'PASS' }); console.log('PASS', name); };
  const value = (page, id) => page.locator(`#${id}`).inputValue({ timeout: TIMEOUT });

  try {
    context = await chromium.launchPersistentContext(path.join(temp, 'helium-profile'), {
      ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
      headless: true,
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext],
      viewport: { width: 760, height: 950 }
    });
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: TIMEOUT });
    const extensionId = worker.url().split('/')[2];
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const options = await context.newPage();
    await options.goto(optionsUrl, { timeout: TIMEOUT });
    const first = await context.newPage();
    await first.goto(origin, { timeout: TIMEOUT });
    const second = await context.newPage();
    await second.goto(origin, { timeout: TIMEOUT });
    const tabIds = await worker.evaluate(async origin => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter(tab => tab.url?.startsWith(origin)).map(tab => tab.id);
    }, origin);
    assert.equal(tabIds.length, 2, 'fixture target tabs should be discoverable');

    const defaultsBefore = await worker.evaluate(async () => (await chrome.storage.local.get('defaults')).defaults);
    const sessionsBefore = await worker.evaluate(async () => {
      if (!chrome.storage.session) return null;
      return (await chrome.storage.session.get('abraSessions')).abraSessions ?? null;
    });

    async function openPopup(targetId) {
      const page = await context.newPage();
      await page.goto(popupUrl, { timeout: TIMEOUT });
      // The extension's popup controller binds to the active tab at startup.
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), targetId);
      await page.reload({ timeout: TIMEOUT });
      await page.locator('#controls').waitFor({ state: 'visible', timeout: TIMEOUT });
      return page;
    }
    async function chooseCustomRandom(page) {
      await page.locator('label[for="preset-custom"]').click({ timeout: TIMEOUT });
      await page.locator('label[for="mode-random"]').click({ timeout: TIMEOUT });
    }
    async function readConfig(page) {
      return page.evaluate(() => ({
        preset: document.querySelector('input[name="intervalPreset"]:checked')?.value || null,
        mode: document.querySelector('input[name="intervalMode"]:checked')?.value || null,
        minSeconds: document.querySelector('#min-seconds').value,
        maxSeconds: document.querySelector('#max-seconds').value,
        intervalSeconds: document.querySelector('#interval-seconds').value,
        stopCondition: document.querySelector('#stop-condition').value,
        keyword: document.querySelector('#keyword').value,
        settleSeconds: document.querySelector('#settle-seconds').value,
        maxRefreshes: document.querySelector('#max-refreshes').value,
        caseSensitive: document.querySelector('#case-sensitive').checked,
        wholeWord: document.querySelector('#whole-word').checked,
        preserveScroll: document.querySelector('#preserve-scroll').checked,
        bypassCache: document.querySelector('#bypass-cache').checked,
        pauseWhenHidden: document.querySelector('#pause-when-hidden').checked,
        advancedOpen: document.querySelector('#advanced').open
      }));
    }
    async function expectConfig(page, expected) {
      const actual = await readConfig(page);
      for (const [key, expectedValue] of Object.entries(expected)) assert.equal(actual[key], expectedValue, `${key} draft value`);
      return actual;
    }

    let popup = await openPopup(tabIds[0]);
    await chooseCustomRandom(popup);
    await popup.locator('#min-seconds').fill('17', { timeout: TIMEOUT });
    await popup.locator('#max-seconds').fill('47', { timeout: TIMEOUT });
    await popup.locator('#stop-condition').selectOption('keyword-found', { timeout: TIMEOUT });
    await popup.locator('#keyword').fill('', { timeout: TIMEOUT });
    await popup.locator('#advanced > summary').click({ timeout: TIMEOUT });
    await popup.locator('#case-sensitive').check({ timeout: TIMEOUT });
    await popup.locator('#whole-word').check({ timeout: TIMEOUT });
    await popup.locator('#bypass-cache').check({ timeout: TIMEOUT });
    await popup.locator('#pause-when-hidden').check({ timeout: TIMEOUT });
    await popup.locator('#settle-seconds').fill('3.5', { timeout: TIMEOUT });
    // The fixed interval control is hidden while Random range is selected;
    // set an empty raw value and emit the same events a partially edited field
    // produces, without changing the visible mode.
    await popup.locator('#interval-seconds').evaluate(input => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Close immediately after the final edit so the test covers unload-time
    // draft persistence instead of allowing a later UI operation to flush it.
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, {
      preset: 'custom', mode: 'random', minSeconds: '17', maxSeconds: '47', intervalSeconds: '',
      stopCondition: 'keyword-found', keyword: '', settleSeconds: '3.5', caseSensitive: true,
      wholeWord: true, bypassCache: true, pauseWhenHidden: true, advancedOpen: true
    });
    await popup.screenshot({ path: path.join(out, 'draft-restored.png'), fullPage: true, timeout: TIMEOUT });
    record('Popup draft restores random bounds, empty keyword, advanced toggles, and raw incomplete value');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    const defaultsAfterDraft = await worker.evaluate(async () => (await chrome.storage.local.get('defaults')).defaults);
    assert.deepEqual(defaultsAfterDraft, defaultsBefore, 'editing a draft must not change saved defaults');
    record('Editing and reopening a draft leaves defaults unchanged');

    popup = await openPopup(tabIds[1]);
    await expectConfig(popup, { preset: '30', mode: 'fixed', minSeconds: '20', maxSeconds: '60', stopCondition: 'never' });
    await popup.screenshot({ path: path.join(out, 'second-tab-defaults.png'), fullPage: true, timeout: TIMEOUT });
    record('A different target tab starts with its own defaults');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, { minSeconds: '17', maxSeconds: '47', intervalSeconds: '', stopCondition: 'keyword-found', keyword: '' });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Returning to the first tab restores its isolated draft');

    // Dashboard defaults update globally while the unfinished first-tab draft
    // remains intact. The untouched second tab follows the new defaults.
    await options.locator('label[for="preset-custom"]').click({ timeout: TIMEOUT });
    await options.locator('label[for="mode-random"]').click({ timeout: TIMEOUT });
    await options.locator('#min-seconds').fill('23', { timeout: TIMEOUT });
    await options.locator('#max-seconds').fill('53', { timeout: TIMEOUT });
    await options.locator('#stop-condition').selectOption('never', { timeout: TIMEOUT });
    await options.locator('#settle-seconds').fill('4', { timeout: TIMEOUT });
    await options.locator('#save-defaults').click({ timeout: TIMEOUT });
    await options.waitForFunction(() => document.querySelector('#defaults-note').textContent.trim() !== '', null, { timeout: TIMEOUT });
    const savedDefaults = await worker.evaluate(async () => (await chrome.storage.local.get('defaults')).defaults);
    assert.ok(savedDefaults, 'defaults should be readable from extension storage');
    popup = await openPopup(tabIds[1]);
    await expectConfig(popup, { preset: 'custom', mode: 'random', minSeconds: '23', maxSeconds: '53', stopCondition: 'never', settleSeconds: '4' });
    await popup.screenshot({ path: path.join(out, 'updated-defaults.png'), fullPage: true, timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, {
      preset: 'custom', mode: 'random', minSeconds: '17', maxSeconds: '47', intervalSeconds: '',
      stopCondition: 'keyword-found', keyword: '', settleSeconds: '3.5', caseSensitive: true,
      wholeWord: true, bypassCache: true, pauseWhenHidden: true, advancedOpen: true
    });
    await popup.screenshot({ path: path.join(out, 'draft-survives-default-change.png'), fullPage: true, timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Dashboard defaults update the second tab while preserving the first tab unfinished draft');

    // An explicit popup Save as default commits a valid current config and
    // clears only this tab's stale draft. A subsequent dashboard change proves
    // that this tab keeps its own settings while an untouched tab follows defaults.
    popup = await openPopup(tabIds[0]);
    await popup.locator('label[for="mode-fixed"]').click({ timeout: TIMEOUT });
    await popup.locator('#interval-seconds').fill('5', { timeout: TIMEOUT });
    await popup.locator('#stop-condition').selectOption('keyword-found', { timeout: TIMEOUT });
    await popup.locator('#keyword').fill('Fixture content', { timeout: TIMEOUT });
    await popup.locator('#save-default').click({ timeout: TIMEOUT });
    await popup.waitForFunction(() => document.querySelector('#footer-note').textContent.trim() !== '', null, { timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    await options.locator('label[for="preset-custom"]').click({ timeout: TIMEOUT });
    await options.locator('label[for="mode-random"]').click({ timeout: TIMEOUT });
    await options.locator('#min-seconds').fill('23', { timeout: TIMEOUT });
    await options.locator('#max-seconds').fill('53', { timeout: TIMEOUT });
    await options.locator('#stop-condition').selectOption('never', { timeout: TIMEOUT });
    await options.locator('#settle-seconds').fill('4', { timeout: TIMEOUT });
    await options.locator('#save-defaults').click({ timeout: TIMEOUT });
    await options.waitForFunction(() => document.querySelector('#defaults-note').textContent.trim() !== '', null, { timeout: TIMEOUT });
    popup = await openPopup(tabIds[1]);
    await expectConfig(popup, { preset: 'custom', mode: 'random', minSeconds: '23', maxSeconds: '53', stopCondition: 'never', settleSeconds: '4' });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, { preset: 'custom', mode: 'fixed', intervalSeconds: '5', stopCondition: 'keyword-found', keyword: 'Fixture content' });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Popup Save as default clears its draft and keeps this tab independent of later dashboard defaults');

    // Configure a distinct draft and enter the real popup picker flow. The
    // selected selector should replace the prior value while every other
    // unsaved configuration value survives the popup closing and reopening.
    popup = await openPopup(tabIds[0]);
    await chooseCustomRandom(popup);
    await popup.locator('#min-seconds').fill('29', { timeout: TIMEOUT });
    await popup.locator('#max-seconds').fill('59', { timeout: TIMEOUT });
    await popup.locator('#stop-condition').selectOption('element-found', { timeout: TIMEOUT });
    await popup.locator('#selector').fill('#fixture', { timeout: TIMEOUT });
    const pickerReady = await popup.locator('#pick-element').isEnabled({ timeout: TIMEOUT });
    assert.equal(pickerReady, true, 'popup element picker should be available for the fixture tab');
    await popup.locator('#pick-element').click({ timeout: TIMEOUT });
    await popup.waitForEvent('close', { timeout: TIMEOUT });
    await first.locator('#pick-target').click({ timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    const selector = await value(popup, 'selector');
    assert.ok(selector && selector.includes('pick-target'), `picked selector should replace prior selector, got ${selector}`);
    await expectConfig(popup, { preset: 'custom', mode: 'random', minSeconds: '29', maxSeconds: '59', stopCondition: 'element-found' });
    await popup.screenshot({ path: path.join(out, 'picker-retained-draft.png'), fullPage: true, timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Real picker replaces the old selector and retains the unfinished configuration');

    const sessionsAfter = await worker.evaluate(async () => {
      if (!chrome.storage.session) return null;
      return (await chrome.storage.session.get('abraSessions')).abraSessions ?? null;
    });
    if (sessionsBefore && sessionsAfter) {
      assert.deepEqual(sessionsAfter, sessionsBefore, 'draft UI interactions should not create monitoring sessions');
      record('Draft UI interactions do not create monitoring sessions');
    }

    // Stress the serialized storage path with a burst of edits in one renderer
    // turn. Closing immediately ensures no subsequent UI action gives pending
    // writes extra time to finish before unload.
    popup = await openPopup(tabIds[0]);
    await popup.locator('#stop-condition').selectOption('keyword-found', { timeout: TIMEOUT });
    await popup.evaluate(() => {
      const keyword = document.querySelector('#keyword');
      for (let index = 0; index < 20; index += 1) {
        keyword.value = `rapid-edit-${index}`;
        keyword.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, { stopCondition: 'keyword-found', keyword: 'rapid-edit-19' });
    await popup.screenshot({ path: path.join(out, 'rapid-edits-restored.png'), fullPage: true, timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Twenty synchronous keyword edits persist the final value after immediate close');

    // A successful Start clears the tab draft. The fixture already contains
    // this keyword, so the engine can match promptly; changing defaults after
    // the popup closes then verifies this tab keeps its own started settings.
    popup = await openPopup(tabIds[0]);
    await popup.locator('label[for="mode-fixed"]').click({ timeout: TIMEOUT });
    await popup.locator('#interval-seconds').fill('5', { timeout: TIMEOUT });
    await popup.locator('#stop-condition').selectOption('keyword-found', { timeout: TIMEOUT });
    await popup.locator('#keyword').fill('Fixture content', { timeout: TIMEOUT });
    await popup.locator('#selector').evaluate(input => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (!await popup.locator('#advanced').evaluate(el=>el.open)) await popup.locator('#advanced > summary').click({timeout:TIMEOUT});
    await popup.locator('#settle-seconds').fill('0',{timeout:TIMEOUT});
    await popup.locator('#primary-action').click({ timeout: TIMEOUT });
    await popup.waitForFunction(() => document.querySelector('#status-pill').dataset.status === 'matched', null, { timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    await options.locator('label[for="preset-custom"]').click({ timeout: TIMEOUT });
    await options.locator('label[for="mode-random"]').click({ timeout: TIMEOUT });
    await options.locator('#min-seconds').fill('31', { timeout: TIMEOUT });
    await options.locator('#max-seconds').fill('61', { timeout: TIMEOUT });
    await options.locator('#stop-condition').selectOption('never', { timeout: TIMEOUT });
    await options.locator('#save-defaults').click({ timeout: TIMEOUT });
    await options.waitForFunction(() => document.querySelector('#defaults-note').textContent.trim() !== '', null, { timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await expectConfig(popup, { preset: 'custom', mode: 'fixed', intervalSeconds: '5', stopCondition: 'keyword-found', keyword: 'Fixture content' });
    await popup.screenshot({ path: path.join(out, 'start-cleared-draft.png'), fullPage: true, timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Successful Start clears its draft and preserves this tab settings independently of later defaults');

    assert.deepEqual(errors, [], 'extension pages should not report JavaScript or console errors');
    record('No extension page JavaScript or console errors');
  } finally {
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ evidence, errors, note: 'Disposable extension copy has only loopback fixture host permission; fresh temporary Helium profile.' }, null, 2));
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
