/* Real MV3 smoke checks. A disposable copy grants ONLY the loopback fixture host.
 * Production manifest and personal browser profile are never modified.
 * Set PLAYWRIGHT_PACKAGE and CHROME_EXECUTABLE when using bundled runtimes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'output', 'browser-check');
  await fs.mkdir(out, { recursive: true });
  const ext = path.join(out, 'extension');
  await fs.cp(path.join(root, 'extension'), ext, { recursive: true });
  const manifest = JSON.parse((await fs.readFile(path.join(ext, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  let stock = 'Waiting for stock', noise = 0, includeElement = true;
  const server = http.createServer((q, r) => {
    r.setHeader('Content-Type', 'text/html');
    r.setHeader('Cache-Control', 'no-store');
    if(q.url === '/favicon.ico') { r.end(); return; }
    r.end(`<!doctype html><title>Fixture shop</title><h1>Fixture shop</h1>${includeElement ? `<p id="stock">${stock}</p>` : ''}<p id="noise">Counter ${++noise}</p><p hidden>available hidden</p><div style="visibility:hidden"><span style="visibility:visible">visible override</span></div><div style="height:1800px">Scroll area</div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  const evidence = [], errors = [];
  const record = (name, detail = '') => { evidence.push({ name, detail, result: 'PASS' }); console.log('PASS', name, detail); };
  try {
    context = await chromium.launchPersistentContext(await fs.mkdtemp(path.join(out, 'profile-')), {
      ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}), headless: true,
      args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext], viewport: { width: 1280, height: 900 }
    });
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 5000 });
    const id = worker.url().split('/')[2];
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${id}/options.html`);
    const target = await context.newPage();
    await target.goto(origin);
    await worker.evaluate(() => {
      globalThis.lifecycle = [];
      chrome.tabs.onUpdated.addListener((id, info) => lifecycle.push({id, info}));
      chrome.runtime.onMessage.addListener(m => lifecycle.push({type:m.type, generation:m.generation}));
    });
    const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
    const message = m => controller.evaluate(m => chrome.runtime.sendMessage(m), m);
    const state = async () => (await message({ type: 'GET_STATE', tabId })).state;
    async function waitState(predicate, name, timeout = 14000) {
      const start = Date.now();
      while(Date.now() - start < timeout) { const s = await state(); if(predicate(s)) return s; await new Promise(r => setTimeout(r, 100)); }
      console.log('Lifecycle', await worker.evaluate(()=>lifecycle));
      console.log('Target', await target.content());
      throw new Error(name + ': timeout. State=' + JSON.stringify(await state()));
    }
    const defaults = { intervalSeconds: 5, settleSeconds: 0, preserveScroll: false };
    async function start(config) { const r = await message({ type:'START', tabId, config: { ...defaults, ...config } }); assert.equal(r.ok, true, JSON.stringify(r)); return r; }
    record('Actual MV3 service worker loaded');
    assert.equal((await message({type:'START',tabId,config:{intervalSeconds:1}})).ok,false);
    record('Reject unsafe interval');
    await start({stopCondition:'keyword-found',keyword:'available',selector:'#stock'});
    await waitState(s => s?.lastCheckedAt, 'initial check');
    assert.equal((await state()).status,'running');
    record('Hidden keyword does not match');
    stock='Now available';
    const keyword = await waitState(s=>s?.status==='matched','keyword after reload');
    assert.ok(keyword.refreshCount >= 1);
    record('Keyword appears after reload', 'refreshCount=' + keyword.refreshCount);
    await new Promise(r=>setTimeout(r,1700));
    assert.equal((await state()).refreshCount,keyword.refreshCount);
    record('Matched session stops reloading');
    await start({stopCondition:'keyword-found',keyword:'visible override'});
    await waitState(s=>s?.status==='matched','visible descendant');
    record('Visible descendant overrides hidden parent');
    await start({stopCondition:'keyword-missing',keyword:'available',selector:'#stock'});
    await waitState(s=>s?.lastCheckedAt,'missing initial check');
    stock='Sold out';
    await waitState(s=>s?.status==='matched','keyword disappears');
    record('Keyword disappears after reload');
    await start({stopCondition:'element-change',selector:'#stock'});
    await waitState(s=>s?.lastCheckedAt,'element baseline');
    stock='Back in stock';
    await waitState(s=>s?.status==='matched','element change');
    record('Selected element text change');
    await start({stopCondition:'page-change',ignoreSelector:'#noise'});
    await waitState(s=>s?.lastCheckedAt,'page baseline');
    await waitState(s=>s?.refreshCount>=1,'ignored counter reload');
    assert.equal((await state()).status,'running');
    stock='Page changed';
    await waitState(s=>s?.status==='matched','page change');
    record('Page change ignores noisy selector');
    await start({stopCondition:'element-missing',selector:'#stock'});
    await waitState(s=>s?.lastCheckedAt,'element existence baseline');
    includeElement=false;
    await waitState(s=>s?.status==='matched','element missing');
    record('Element disappears');
    await start({stopCondition:'element-found',selector:'#stock'});
    await waitState(s=>s?.lastCheckedAt,'element absent');
    includeElement=true;
    await waitState(s=>s?.status==='matched','element appears');
    record('Element appears');
    await target.evaluate(()=>window.scrollTo(0,550));
    await start({stopCondition:'never',maxRefreshes:1,bypassCache:true,preserveScroll:true});
    await waitState(s=>s?.status==='stopped','refresh limit');
    assert.equal((await state()).refreshCount,1);
    record('Maximum refresh count with cache bypass');
    assert.ok(await target.evaluate(()=>window.scrollY>=500));
    record('Scroll position restored after reload');
    await start({stopCondition:'never',maxMinutes:0.02});
    await waitState(s=>s?.status==='stopped','duration limit');
    record('Maximum duration');
    await start({stopCondition:'never'});
    assert.equal((await message({type:'PAUSE',tabId})).state.status,'paused');
    await new Promise(r=>setTimeout(r,5500));
    assert.equal((await state()).refreshCount,0);
    assert.equal((await message({type:'RESUME',tabId})).state.status,'running');
    await waitState(s=>s?.refreshCount>=1,'resume refresh');
    assert.equal((await message({type:'STOP',tabId})).state.status,'stopped');
    record('Pause, resume, stop');
    assert.equal((await message({type:'PICK_ELEMENT',tabId})).ok,true);
    await target.locator('#stock').click();
    const picked = await worker.evaluate(async()=>{const x=await chrome.storage.local.get('pickedSelector');return x.pickedSelector;});
    assert.equal(picked.tabId,tabId);
    assert.ok(picked.selector.includes('stock'));
    record('Picker reopens after stop');
    await start({stopCondition:'never'});
    const alarmName='abra-watchdog:'+tabId;
    await worker.evaluate(name=>chrome.alarms.create(name,{when:Date.now()+100}),alarmName);
    await new Promise(r=>setTimeout(r,700));
    const stop = await Promise.race([message({type:'STOP',tabId}),new Promise((_,rej)=>setTimeout(()=>rej(Error('Watchdog blocked STOP')),3000))]);
    assert.equal(stop.ok,true);
    record('Watchdog does not deadlock STOP');
    await start({intervalMode:'random',minSeconds:5,maxSeconds:6,stopCondition:'never'});
    const random = await state();
    assert.ok(random.nextRefreshAt-random.startedAt>=4900 && random.nextRefreshAt-random.startedAt<=6100);
    record('Random interval within bounds');
    await message({type:'STOP',tabId});
    await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/popup.html`);
    await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
    await panel.reload();
    await panel.setViewportSize({width:400,height:800});
    await panel.screenshot({path:path.join(out,'popup.png'),fullPage:true});
    assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    record('Popup fits 400px');
    const dashboard=await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/options.html`);
    await dashboard.getByLabel('Profile name',{exact:true}).fill('My watch');
    await dashboard.getByRole('button',{name:'Save current settings as profile',exact:true}).click();
    await dashboard.getByText('My watch',{exact:true}).waitFor({timeout:2000});
    record('Save a reusable profile');
    await dashboard.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0)});
    await dashboard.screenshot({path:path.join(out,'dashboard.png'),fullPage:true});
    await dashboard.setViewportSize({width:390,height:844});
    assert.equal(await dashboard.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await dashboard.screenshot({path:path.join(out,'dashboard-narrow.png'),fullPage:true});
    record('Dashboard fits 390px');
    await start({stopCondition:'never'});
    await target.goto('http://localhost:'+server.address().port);
    await waitState(s=>s?.status==='error','cross-origin stop');
    record('Different origin stops monitoring');
    await target.close();
    assert.ok(!(await message({type:'GET_ALL'})).sessions.some(s=>s.tabId===tabId));
    record('Closed tabs cleaned up');
    assert.deepEqual(errors,[]);
    record('No page JavaScript errors');
  } finally {
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify({evidence,errors,note:'Disposable test copy adds loopback fixture host permission; production manifest has no host permissions.'},null,2));
    if(context) await context.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
