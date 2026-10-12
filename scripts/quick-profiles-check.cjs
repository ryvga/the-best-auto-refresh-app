/*
 * Real MV3 quick-profile and toolbar-badge regression checks. The extension is
 * copied into a disposable directory and run in a fresh Helium profile. The
 * copy receives loopback-only host access for the local fixture.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

const TIMEOUT = 6000;
const CONFIG = (intervalSeconds, extra = {}) => ({
  intervalMode: 'fixed', intervalSeconds, minSeconds: 5, maxSeconds: 60,
  stopCondition: 'never', keyword: '', selector: '', caseSensitive: false,
  wholeWord: false, settleSeconds: 0, maxRefreshes: 0, maxMinutes: 0,
  preserveScroll: true, bypassCache: false, pauseWhenHidden: false,
  ignoreSelector: '', ...extra
});

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'quick-profiles-check');
  await fs.mkdir(out, { recursive: true });
  const temp = await fs.mkdtemp(path.join(out, 'run-'));
  const ext = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  let requests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.end(); return; }
    requests += 1;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`<!doctype html><title>Profile fixture</title><h1>Profile fixture</h1><p>Request ${requests}</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pathA = '/product?id=alpha';
  const pathB = '/product?id=beta';
  let context;
  const evidence = [], errors = [], failures = [];
  const record = (name, detail = '') => {
    evidence.push({ name, detail, result: 'PASS' });
    console.log('PASS', name, detail);
  };
  const profile = (id, name, intervalSeconds, scope, target = '') => ({
    id, name, config: CONFIG(intervalSeconds), updatedAt: Date.now(), scope, target
  });

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
    const pageA = await context.newPage();
    await pageA.goto(`${origin}${pathA}#first`, { timeout: TIMEOUT });
    const pageB = await context.newPage();
    await pageB.goto(`${origin}${pathB}`, { timeout: TIMEOUT });
    const tabIds = await worker.evaluate(async origin => (await chrome.tabs.query({}))
      .filter(tab => tab.url?.startsWith(origin)).map(tab => tab.id), origin);
    assert.equal(tabIds.length, 2, 'fixture tabs should be discoverable');

    async function send(message) {
      return options.evaluate(message => chrome.runtime.sendMessage(message), message);
    }
    async function state(tabId) {
      const response = await send({ type: 'GET_STATE', tabId });
      assert.equal(response.ok, true, JSON.stringify(response));
      return response.state;
    }
    async function openPopup(tabId) {
      const popup = await context.newPage();
      await popup.goto(popupUrl, { timeout: TIMEOUT });
      await popup.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: TIMEOUT });
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
      await popup.reload({ timeout: TIMEOUT });
      await popup.locator('#controls').waitFor({ state: 'visible', timeout: TIMEOUT });
      await popup.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: TIMEOUT });
      return popup;
    }
    async function selectFixed(popup, seconds) {
      const preset = String(seconds);
      if (['10', '30', '60'].includes(preset)) {
        await popup.locator(`label[for="preset-${preset}"]`).click({ timeout: TIMEOUT });
      } else {
        await popup.locator('label[for="preset-custom"]').click({ timeout: TIMEOUT });
        await popup.locator('label[for="mode-fixed"]').click({ timeout: TIMEOUT });
        await popup.locator('#interval-seconds').fill(preset, { timeout: TIMEOUT });
      }
    }
    async function showProfileSave(popup, name, scope) {
      if (!await popup.locator('#profile-save').evaluate(node => node.open)) {
        await popup.locator('#profile-save > summary').click({ timeout: TIMEOUT });
      }
      await popup.locator('#profile-name').fill(name, { timeout: TIMEOUT });
      await popup.locator('#profile-scope').selectOption(scope, { timeout: TIMEOUT });
      await popup.locator('#profile-save-action').click({ timeout: TIMEOUT });
      await popup.waitForFunction(name => document.querySelector('#footer-note').textContent.includes(name), name, { timeout: TIMEOUT });
    }
    async function getLocal(key) {
      return worker.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
    }
    async function putLocal(values) {
      await worker.evaluate(values => chrome.storage.local.set(values), values);
    }
    async function readInterval(popup) {
      return popup.evaluate(() => {
        const preset = document.querySelector('input[name="intervalPreset"]:checked')?.value;
        return preset === 'custom' ? Number(document.querySelector('#interval-seconds').value) : Number(preset);
      });
    }

    // Real user flow: create each scope from the current popup form.
    let popup = await openPopup(tabIds[0]);
    await selectFixed(popup, 17);
    await showProfileSave(popup, 'QA shared', 'global');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await selectFixed(popup, 19);
    await showProfileSave(popup, 'QA shared', 'global');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await selectFixed(popup, 23);
    await showProfileSave(popup, 'QA shared', 'site');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    await selectFixed(popup, 27);
    await showProfileSave(popup, 'QA shared', 'page');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    const saved = await getLocal('profiles');
    const quickProfiles = saved.filter(item => item.name === 'QA shared').sort((a, b) => ['global', 'site', 'page'].indexOf(a.scope) - ['global', 'site', 'page'].indexOf(b.scope));
    assert.deepEqual(quickProfiles.map(item => [item.scope, item.target]), [
      ['global', ''], ['site', origin], ['page', `${origin}${pathA}`]
    ], 'quick profile save should store normalized scope targets without fragments');
    assert.deepEqual(quickProfiles.map(item => item.config.intervalSeconds), [19, 23, 27], 'same-scope save updates the existing profile while other scopes remain separate');
    record('Same-scope saves update in place; same-name global, site, and page profiles remain separate');

    // Remove the drafts created by the save flows so these opens exercise
    // first-open matching. Page wins over site; site wins over defaults.
    await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith('popupDraft:'));
      if (keys.length) await chrome.storage.session.remove(keys);
    });
    // Seed predictable competing matches. Global remains manually selectable;
    // automatic scope matching is exact page, then exact site, then defaults.
    await putLocal({ profiles: [
      { ...profile('global', 'Global candidate', 10, 'global', ''), updatedAt: 100 },
      { ...profile('site-old', 'Site older', 13, 'site', origin), updatedAt: 200 },
      { ...profile('site-new', 'Site newest', 15, 'site', origin), updatedAt: 300 },
      { ...profile('page', 'Page candidate', 17, 'page', `${origin}${pathA}`), updatedAt: 400 }
    ], defaults: CONFIG(11) });
    popup = await openPopup(tabIds[0]);
    assert.equal(await readInterval(popup), 17, 'page profile wins for matching path and search, ignoring fragment');
    await popup.waitForFunction(() => document.querySelector('#footer-note').textContent.includes('Page candidate'), null, { timeout: TIMEOUT });
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Exact page profile beats site and global profiles; fragments are ignored');

    // A page URL with another query must not match the saved page profile.
    await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith('popupDraft:'));
      if (keys.length) await chrome.storage.session.remove(keys);
    });
    await pageA.goto(`${origin}${pathB}#other`, { timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    assert.equal(await readInterval(popup), 15, 'query mismatch should fall back to newest site profile');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Page matching includes the query string and falls back to the site profile');

    // A different port is a different origin even when the page and host match.
    const alternateOriginUrl = new URL(origin);
    alternateOriginUrl.port = String(Number(alternateOriginUrl.port) + 1);
    await putLocal({ profiles: [
      { ...profile('wrong-site', 'Wrong site candidate', 15, 'site', alternateOriginUrl.origin), updatedAt: 300 }
    ] });
    await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith('popupDraft:'));
      if (keys.length) await chrome.storage.session.remove(keys);
    });
    popup = await openPopup(tabIds[0]);
    assert.equal(await readInterval(popup), 11, 'different port should not match the current site profile');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Site profile matching requires the exact origin');

    await putLocal({ profiles: [
      { ...profile('global', 'Global candidate', 10, 'global', ''), updatedAt: 100 },
      { ...profile('site-old', 'Site older', 13, 'site', origin), updatedAt: 200 },
      { ...profile('site-new', 'Site newest', 15, 'site', origin), updatedAt: 300 },
      { ...profile('page', 'Page candidate', 17, 'page', `${origin}${pathA}`), updatedAt: 400 }
    ] });

    // The unfinished tab draft has precedence over profile auto-selection.
    popup = await openPopup(tabIds[0]);
    await selectFixed(popup, 21);
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[0]);
    assert.equal(await readInterval(popup), 21, 'per-tab draft should override matching profile');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    popup = await openPopup(tabIds[1]);
    assert.equal(await readInterval(popup), 15, 'another tab should independently receive site match');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Per-tab draft takes precedence and does not leak when switching tabs');

    // Legacy entries without scope remain available manually but do not override
    // saved defaults during first-open auto matching.
    await putLocal({ profiles: [
      { id: 'legacy', name: 'Legacy profile', config: CONFIG(27), updatedAt: 1 },
      { id: 'p_foo', name: 'Twin profile', config: CONFIG(29), updatedAt: 2 },
      { id: 'p_zoo', name: 'Twin profile', config: CONFIG(33), updatedAt: 3 }
    ], defaults: CONFIG(11) });
    await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith('popupDraft:'));
      if (keys.length) await chrome.storage.session.remove(keys);
    });
    popup = await openPopup(tabIds[1]);
    assert.equal(await readInterval(popup), 11, 'legacy global profile should not replace defaults automatically');
    record('Legacy profile without scope remains compatible while defaults stay first-open settings');

    // Manually choosing a profile replaces edits already typed in this popup.
    const beforeSwitch = await state(tabIds[1]);
    assert.equal(beforeSwitch, null, 'no session should exist before profile selection');
    await selectFixed(popup, 21);
    const legacyOption = await popup.locator('#profile-select option').evaluateAll(options => options.find(option => option.textContent.includes('Legacy profile'))?.value);
    assert.ok(legacyOption, 'legacy profile should appear in the selector');
    await popup.locator('#profile-select').selectOption(legacyOption, { timeout: TIMEOUT });
    await popup.waitForFunction(() => Number(document.querySelector('#interval-seconds').value) === 27, null, { timeout: TIMEOUT });
    assert.equal(await state(tabIds[1]), null, 'loading profile must not send START');
    const twins = await popup.locator('#profile-select option').evaluateAll(options => options.filter(option => option.textContent === 'Twin profile').map(option => option.value));
    assert.equal(new Set(twins).size, 2, 'same-name profiles with distinct IDs should have distinct option values');
    assert.ok(twins.includes('p_foo') && twins.includes('p_zoo'));
    await popup.locator('#profile-select').selectOption('p_zoo', { timeout: TIMEOUT });
    await popup.waitForFunction(() => Number(document.querySelector('#interval-seconds').value) === 33, null, { timeout: TIMEOUT });
    assert.equal(await state(tabIds[1]), null, 'switching profiles must not start a session');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    record('Manual profile switching overrides typed edits, handles colliding legacy IDs, and never starts monitoring');

    // With a live monitor, selection edits the pending form only. Explicitly
    // pressing Apply & restart is the point at which the running config changes.
    popup = await openPopup(tabIds[1]);
    const startedForProfileSwitch = await send({ type: 'START', tabId: tabIds[1], config: CONFIG(30) });
    assert.equal(startedForProfileSwitch.ok, true, JSON.stringify(startedForProfileSwitch));
    await popup.waitForFunction(async tabId => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId });
      return response?.state?.status === 'running' && response.state.config.intervalSeconds === 30;
    }, tabIds[1], { timeout: TIMEOUT });
    const runningBeforeSelection = await state(tabIds[1]);
    assert.equal(runningBeforeSelection?.config.intervalSeconds, 30, `test monitor should remain active before loading another profile; GET_ALL=${JSON.stringify(await send({ type: 'GET_ALL' }))}`);
    const legacyProfileOption = await popup.locator('#profile-select option').evaluateAll(options => options.find(option => option.textContent.includes('Legacy profile'))?.value);
    await popup.locator('#profile-select').selectOption(legacyProfileOption, { timeout: TIMEOUT });
    await popup.waitForFunction(() => Number(document.querySelector('#interval-seconds').value) === 27, null, { timeout: TIMEOUT });
    const liveAfterSelection = await state(tabIds[1]);
    assert.ok(liveAfterSelection, `profile selection must leave the running session alive: ${JSON.stringify(await send({ type: 'GET_STATE', tabId: tabIds[1] }))}`);
    assert.equal(liveAfterSelection.config.intervalSeconds, 30, 'profile selection must leave running settings unchanged until explicit apply');
    await popup.waitForFunction(() => document.querySelector('#status-pill').dataset.status === 'running', null, { timeout: TIMEOUT });
    assert.equal((await popup.locator('#primary-action').textContent()).trim(), 'Apply & restart');
    await popup.locator('#primary-action').click({ timeout: TIMEOUT });
    await popup.waitForFunction(async tabId => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE', tabId });
      return response?.state?.status === 'running' && response.state.config.intervalSeconds === 27;
    }, tabIds[1], { timeout: TIMEOUT });
    const pausedResponse = await send({ type: 'PAUSE', tabId: tabIds[1] });
    assert.equal(pausedResponse.state.status, 'paused');
    await popup.waitForFunction(() => document.querySelector('#primary-action').textContent.trim() === 'Resume', null, { timeout: TIMEOUT });
    assert.equal(await state(tabIds[1]).then(session => session.config.intervalSeconds), 27, 'pausing with unchanged settings should preserve config');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });
    await send({ type: 'STOP', tabId: tabIds[1] });
    record('Running profile changes require explicit Apply & restart; same-config pause keeps the session config');

    // The Options page saves global profiles. A scoped entry with the same name
    // must remain separate and retain its target metadata.
    const metadataProfile = profile('meta', 'Metadata preserved', 31, 'page', `${origin}${pathB}`);
    await putLocal({ profiles: [metadataProfile] });
    await options.reload({ timeout: TIMEOUT });
    await options.locator('#profile-name').fill('Metadata preserved', { timeout: TIMEOUT });
    await options.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await options.locator('#save-profile').scrollIntoViewIfNeeded({ timeout: TIMEOUT });
    await options.locator('#save-profile').click({ timeout: TIMEOUT });
    await options.waitForFunction(() => document.querySelector('#profiles-note').textContent.includes('Saved'), null, { timeout: TIMEOUT });
    const afterOptionsSave = await getLocal('profiles');
    const retained = afterOptionsSave.find(item => item.id === 'meta');
    assert.equal(retained.scope, 'page');
    assert.equal(retained.target, `${origin}${pathB}`);
    assert.ok(afterOptionsSave.some(item => item.name === 'Metadata preserved' && item.scope === 'global'));
    record('Options global save preserves a scoped same-name profile and its target');

    // Repeated storage.onChanged renders should keep only non-empty groups.
    popup = await openPopup(tabIds[1]);
    const alternateOrigin = new URL(origin);
    alternateOrigin.port = String(Number(alternateOrigin.port) + 1);
    const groupProfiles = [
      profile('group-page', 'Page group', 10, 'page', `${origin}${pathB}`),
      profile('group-site', 'Site group', 12, 'site', origin),
      profile('group-global', 'Global group', 14, 'global', ''),
      profile('group-other', 'Other group', 16, 'site', alternateOrigin.origin)
    ];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await putLocal({ profiles: cycle % 2 ? groupProfiles.slice(0, 2) : groupProfiles });
      const expected = cycle % 2 ? 2 : 4;
      await popup.waitForFunction(count => document.querySelectorAll('#profile-select optgroup').length === count, expected, { timeout: TIMEOUT });
      const emptyGroups = await popup.locator('#profile-select optgroup').evaluateAll(groups => groups.filter(group => !group.children.length).map(group => group.label));
      assert.deepEqual(emptyGroups, [], 'profile list should not render empty groups');
    }
    await putLocal({ profiles: [] });
    await popup.waitForFunction(() => document.querySelectorAll('#profile-select optgroup').length === 0, null, { timeout: TIMEOUT });
    assert.equal(await popup.locator('#profile-select').isDisabled(), true);
    record('Repeated storage changes render only non-empty profile groups');
    await putLocal({ profiles: groupProfiles });
    await popup.waitForFunction(() => document.querySelectorAll('#profile-select optgroup').length === 4, null, { timeout: TIMEOUT });

    // Capture the real popup at both requested widths with the save controls
    // closed and open. Verify overflow, keyboard focus visibility, and reduced
    // motion in the rendered page.
    for (const width of [360, 400]) {
      await popup.setViewportSize({ width, height: 900 });
      await popup.locator('#profile-save').evaluate(node => { node.open = false; });
      await popup.screenshot({ path: path.join(out, `popup-${width}-profiles-closed.png`), fullPage: true, timeout: TIMEOUT });
      const closedOverflow = await popup.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth, innerWidth,
        bodyWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth,
        mediaNarrow: matchMedia('(max-width: 370px)').matches
      }));
      if (closedOverflow.documentWidth > closedOverflow.innerWidth) failures.push(`closed profile editor overflow at ${width}px: ${JSON.stringify(closedOverflow)}`);
      await popup.locator('#profile-save > summary').focus();
      await popup.locator('#profile-save > summary').press('Enter');
      await popup.keyboard.press('Tab');
      await popup.waitForFunction(() => getComputedStyle(document.querySelector('#profile-name')).boxShadow.includes('3px'), null, { timeout: TIMEOUT });
      const focus = await popup.locator('#profile-name').evaluate(node => ({
        visible: node.matches(':focus-visible'),
        outlineStyle: getComputedStyle(node).outlineStyle,
        outlineWidth: getComputedStyle(node).outlineWidth,
        boxShadow: getComputedStyle(node).boxShadow
      }));
      assert.equal(focus.visible, true, `profile name input should show keyboard focus at ${width}px`);
      assert.notEqual(focus.boxShadow, 'none', `profile name input should show a visible focus ring: ${JSON.stringify(focus)}`);
      assert.match(focus.boxShadow, /3px/, `focus ring should have a clear 3px spread: ${JSON.stringify(focus)}`);
      await popup.screenshot({ path: path.join(out, `popup-${width}-profiles-open.png`), fullPage: true, timeout: TIMEOUT });
      const openOverflow = await popup.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, innerWidth, bodyWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth }));
      if (openOverflow.documentWidth > openOverflow.innerWidth) failures.push(`open profile editor overflow at ${width}px: ${JSON.stringify(openOverflow)}`);
    }
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotion = await popup.locator('#profile-save-action').evaluate(node => ({
      transitionSeconds: parseFloat(getComputedStyle(node).transitionDuration),
      animationSeconds: parseFloat(getComputedStyle(node).animationDuration)
    }));
    assert.ok(reducedMotion.transitionSeconds <= 0.001, `transition should respect reduced motion: ${JSON.stringify(reducedMotion)}`);
    assert.ok(reducedMotion.animationSeconds <= 0.001, `animation should respect reduced motion: ${JSON.stringify(reducedMotion)}`);
    record('Popup fits at 360px and 400px with profile save closed/open; focus ring and reduced motion verified');
    await popup.close({ runBeforeUnload: false, timeout: TIMEOUT });

    // Verify action badge while the popup is closed. One-second checks should
    // produce changing remaining-time text; paused/stopped statuses should use
    // stable status badges. No popup is open during these observations.
    await send({ type: 'START', tabId: tabIds[1], config: CONFIG(5) });
    const badge = async tabId => worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);
    const firstBadge = await badge(tabIds[1]);
    assert.ok(firstBadge, 'running watch should have a non-empty toolbar badge');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const secondBadge = await badge(tabIds[1]);
    assert.notEqual(secondBadge, firstBadge, `running badge should tick while popup closed (${firstBadge} -> ${secondBadge})`);
    record('Toolbar badge updates each second while popup is closed', `${firstBadge} -> ${secondBadge}`);
    const paused = await send({ type: 'PAUSE', tabId: tabIds[1] });
    assert.equal(paused.state.status, 'paused');
    const pausedBadge = await badge(tabIds[1]);
    assert.ok(pausedBadge, 'paused watch should retain a status badge');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await badge(tabIds[1]), pausedBadge, 'paused badge should not count down');
    record('Paused badge is stable and does not count down');
    const stopped = await send({ type: 'STOP', tabId: tabIds[1] });
    assert.equal(stopped.state.status, 'stopped');
    const stoppedBadge = await badge(tabIds[1]);
    assert.equal(stoppedBadge, '', 'stopped watch should clear the active countdown badge');
    record('Stopped watch clears the active countdown badge', stoppedBadge);

    assert.deepEqual(failures, [], 'responsive popup should have no horizontal overflow');
    assert.deepEqual(errors, [], 'extension pages should not report JavaScript or console errors');
    record('No extension page JavaScript or console errors');
  } finally {
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({
      evidence, errors, failures,
      note: 'Disposable extension copy adds loopback-only host permission; fresh temporary Helium profile.'
    }, null, 2));
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
