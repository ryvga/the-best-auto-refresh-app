#!/usr/bin/env node
/*
 * Capture Chrome Web Store listing assets from the real extension UI.
 *
 * Branded Google Chrome now refuses --load-extension ("--disable-extensions-except
 * is not allowed in Google Chrome, ignoring"), so this drives a Chromium build
 * that still honours it: Helium by default, or --browser / CHROME_EXECUTABLE.
 *
 * The extension is copied to a throwaway staging folder that grants ONLY the
 * loopback fixture host, so monitoring can start without a user gesture and a
 * tab URL is visible. The production manifest and the packaged zip are never
 * touched, and no listing metadata is invented: every pixel of the popup and
 * dashboard comes from the real UI driven against a local demo page.
 *
 * Usage:
 *   node scripts/capture-store-assets.mjs [--out <dir>] [--browser <exe>] [--keep]
 *
 * Output: icon-128.png, five 1280x800 screenshots, a 440x280 promo tile,
 * a 1400x560 marquee, and capture-report.json describing what was rendered.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BROWSERS = [
  path.join(os.homedir(), 'AppData', 'Local', 'imput', 'Helium', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
];
const BRANDED_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9412;

// ---------- tiny helpers ----------

function parseArgs(argv) {
  const out = { out: path.join(root, 'store-assets'), browser: process.env.CHROME_EXECUTABLE || null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--browser') out.browser = argv[++i];
    else if (a === '--keep') out.keep = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function resolveBrowser(explicit) {
  const candidates = explicit ? [explicit] : DEFAULT_BROWSERS;
  for (const c of candidates) {
    try { await fs.access(c); } catch { continue; }
    if (path.resolve(c).toLowerCase() === BRANDED_CHROME.toLowerCase()) {
      throw new Error(
        `${c} is branded Google Chrome, which ignores --load-extension. ` +
        'Point --browser at a Chromium build (Helium, Chromium, Chrome for Testing instead).');
    }
    return c;
  }
  throw new Error(`no usable Chromium build found. Tried:\n  ${candidates.join('\n  ')}`);
}

/** Browser-level CDP over the debug port, so popup windows can be screenshotted. */
class RawCDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  targets() { return this.send('Target.getTargets').then((r) => r.targetInfos); }
  attach(targetId) { return this.send('Target.attachToTarget', { targetId, flatten: true }).then((r) => r.sessionId); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture ----------

function fixturePage({ available }) {
  const badge = available
    ? '<span class="badge in">In stock</span>'
    : '<span class="badge out">Sold out</span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Demo shop — stock checker</title><style>
  body{margin:0;font:15px/1.5 "Segoe UI",system-ui,sans-serif;color:#16282b;background:#f4f7f7}
  .wrap{max-width:760px;margin:64px auto;background:#fff;border:1px solid #dfe7e7;border-radius:14px;padding:34px 38px}
  h1{margin:0 0 6px;font-size:24px} .sub{color:#63787b;margin:0 0 24px}
  .row{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #eef3f3;padding:18px 0}
  .price{font-size:22px;font-weight:600}
  .badge{padding:5px 12px;border-radius:999px;font-weight:600;font-size:13px}
  .badge.out{background:#fdeaea;color:#a52c2c} .badge.in{background:#e2f7f0;color:#0d6b52}
</style></head><body><div class="wrap">
  <h1>Wireless headphones</h1><p class="sub">Demo shop — local fixture used to drive the extension.</p>
  <div class="row"><span class="price">£129.00</span>${badge}</div>
  <div class="row"><span id="stock">Availability: ${available ? 'available now' : 'sold out'}</span></div>
</div></body></html>`;
}

// ---------- composition (store-ready 1280x800 frames) ----------

function frameHtml({ eyebrow, headline, bullets, imageUrl, popupWidth, popupHeight, cropY, displayHeight = 700 }) {
  const scale = displayHeight / popupHeight;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1280px;height:800px;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;
    background:radial-gradient(1100px 700px at 88% 10%,#17494a 0%,transparent 60%),
               linear-gradient(150deg,#0a1e21 0%,#102a2d 55%,#0c2b2c 100%);color:#eaf6f4}
  .grid{display:flex;height:100%;align-items:center;gap:54px;padding:56px 64px}
  .copy{flex:1 1 0;min-width:0}
  .eyebrow{display:inline-block;font-size:13px;letter-spacing:.16em;text-transform:uppercase;
    color:#32d5b0;font-weight:700;margin-bottom:18px}
  h2{font-size:46px;line-height:1.12;font-weight:700;letter-spacing:-.5px;margin-bottom:20px}
  ul{list-style:none;display:grid;gap:12px}
  li{position:relative;padding-left:26px;font-size:17px;line-height:1.5;color:#a9c6c4}
  li:before{content:"";position:absolute;left:0;top:9px;width:9px;height:9px;border-radius:3px;background:#32d5b0}
  .shot{flex:0 0 auto;width:${Math.round(popupWidth * scale)}px;height:${displayHeight}px}
  .window{overflow:hidden;width:${popupWidth}px;height:${popupHeight}px;border-radius:14px;
    transform:scale(${scale});transform-origin:top left;
    box-shadow:0 34px 70px rgba(0,0,0,.5),0 0 0 1px rgba(50,213,176,.28)}
  img{display:block;width:${popupWidth}px;margin-top:${-cropY}px}
  </style></head><body><div class="grid">
    <div class="copy"><div class="eyebrow">${eyebrow}</div><h2>${headline}</h2>
      <ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul></div>
    <div class="shot"><div class="window"><img src="${imageUrl}"></div></div>
  </div></body></html>`;
}

function promoHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:440px;height:280px;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;
    background:radial-gradient(420px 300px at 82% 8%,#17494a,transparent 62%),
               linear-gradient(150deg,#0a1e21,#102a2d 60%,#0c2b2c);color:#eaf6f4;
    display:flex;align-items:center;gap:20px;padding:30px 32px}
  img{width:84px;height:84px;flex:0 0 auto}
  h1{font-size:25px;line-height:1.18;font-weight:700;letter-spacing:-.3px;margin-bottom:9px}
  p{font-size:13.5px;color:#9dbcb9;line-height:1.45}
  </style></head><body>
    <img src="ICON"><div><h1>Auto Refresh</h1>
    <p>Refresh on a timer. Stop when the page, a keyword or an element changes.</p></div>
  </body></html>`;
}

function marqueeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1400px;height:560px;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;
    background:radial-gradient(1000px 620px at 90% 6%,#17494a,transparent 62%),
               linear-gradient(150deg,#0a1e21,#102a2d 58%,#0c2b2c);color:#eaf6f4;
    display:flex;flex-direction:column;justify-content:center;padding:0 96px}
  .top{display:flex;align-items:center;gap:22px;margin-bottom:26px}
  img{width:84px;height:84px}
  h1{font-size:60px;font-weight:700;letter-spacing:-1.2px;line-height:1.06}
  p{font-size:22px;color:#a9c6c4;margin-top:8px;max-width:900px}
  .tags{display:flex;gap:12px;margin-top:34px;flex-wrap:wrap}
  span{font-size:15px;padding:9px 16px;border-radius:999px;color:#32d5b0;
    border:1px solid rgba(50,213,176,.35);background:rgba(50,213,176,.07)}
  </style></head><body>
    <div class="top"><img src="ICON">
      <div><h1>The Best Auto Refresh App</h1>
      <p>Refresh on a timer, or stop automatically when the page text, a keyword or a watched element changes.</p></div></div>
    <div class="tags"><span>Fixed or random intervals</span><span>Keyword and element watch</span>
      <span>Per-site profiles</span><span>Optional webhooks and page scripts</span>
      <span>Local, no ads, no tracking</span></div>
  </body></html>`;
}

// ---------- main ----------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browserPath = await resolveBrowser(options.browser);
  const { chromium } = require('playwright-core');

  const outDir = options.out;
  await fs.mkdir(outDir, { recursive: true });
  const rawDir = path.join(outDir, '.raw');
  await fs.mkdir(rawDir, { recursive: true });

  // Disposable extension copy granting only the loopback fixture host.
  const stage = path.join(os.tmpdir(), `cws-assets-ext-${Date.now()}`);
  await fs.cp(path.join(root, 'extension'), stage, { recursive: true });
  const manifest = JSON.parse((await fs.readFile(path.join(stage, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  // The custom JavaScript stop condition is optional in production, so it would
  // photograph as "access not granted yet" on a machine that never enabled it.
  // Promote the permission in the throwaway copy only, so one frame can show the
  // panel in the state a user sees after opting in. The shipped manifest is
  // untouched, and this deviation is recorded in the capture report.
  manifest.permissions = [...new Set([...(manifest.permissions || []), 'userScripts'])];
  manifest.optional_permissions = (manifest.optional_permissions || []).filter((name) => name !== 'userScripts');
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  let available = false;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (pathname.startsWith('/assets/')) {
      // Served over http rather than file:// so the verification canvas stays
      // untainted and pixel data can actually be read back.
      const rel = decodeURIComponent(pathname.slice('/assets/'.length));
      const file = path.join(outDir, rel);
      if (!file.startsWith(outDir)) { res.writeHead(403).end(); return; }
      try {
        const body = await fs.readFile(file);
        res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
          : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
        res.end(body);
      } catch { res.writeHead(404).end('not found'); }
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(fixturePage({ available }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const assetBase = `${origin}/assets`;

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-assets-profile-'));
  const report = { browser: browserPath, origin, capturedAt: new Date().toISOString(), assets: [] };

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: false,
    // Playwright adds --disable-extensions to every launch, which would override
    // --load-extension, so that default has to go.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      // Renders the popup surface at 2x so the store screenshots stay crisp;
      // the 1280x800 frames opt back into CSS pixels via screenshot({scale:'css'}).
      '--force-device-scale-factor=2',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--disable-extensions-except=${stage}`,
      `--load-extension=${stage}`,
    ],
    viewport: { width: 1280, height: 800 },
  });

  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const extId = new URL(worker.url()).host;

    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const cdp = new RawCDP(ws);

    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${extId}/options.html`);
    const target = await context.newPage();
    await target.goto(origin);
    await target.bringToFront();

    const tabId = await worker.evaluate(
      async (o) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(o))?.id, origin);
    if (!tabId) throw new Error('fixture tab not visible to the extension');

    const findPopup = async () => (await cdp.targets()).find((t) => t.url.endsWith('/popup.html'));
    const closePopup = async () => {
      const t = await findPopup();
      if (t) { await cdp.send('Target.closeTarget', { targetId: t.targetId }); await sleep(700); }
    };
    const evalJson = async (session, expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
      return r.result.value;
    };
    const openPopup = async () => {
      await target.bringToFront();
      await worker.evaluate(() => { chrome.action.openPopup(); });
      await sleep(2600);
      const t = await findPopup();
      if (!t) throw new Error('popup target never appeared');
      // Headless opens the popup at a minimal size (~350x228), which is not how
      // the popup actually appears. Give it the real dimensions instead.
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId });
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 400, height: 600 } });
        await sleep(600);
      } catch { /* keep the natural size if the window cannot be resized */ }
      return cdp.attach(t.targetId);
    };
    /**
     * Capture the whole popup surface in one screenshot.
     *
     * Headless opens popups at roughly 350x228 and rejects both setWindowBounds
     * and setDeviceMetricsOverride, so the full content is captured with
     * captureBeyondViewport and cropped to realistic popup-sized windows when
     * the store frames are composed. Crispness comes from
     * --force-device-scale-factor=2 at launch.
     */
    const capturePopup = async (file, { expand = [], setup = '' } = {}) => {
      const session = await openPopup();
      // Sections such as Automation and Advanced start collapsed, so the frame
      // would otherwise repeat the settings above it.
      if (expand.length) {
        await cdp.send('Runtime.evaluate', {
          expression: `for (const sel of ${JSON.stringify(expand)}) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const details = el.tagName === 'DETAILS' ? el : el.closest('details');
            if (details) details.open = true;
          }`,
        }, session);
        await sleep(900);
      }
      // `setup` drives the form through its own events, so the captured frame is
      // still the real UI reacting to real input rather than a styled mock.
      if (setup) {
        await cdp.send('Runtime.evaluate', { expression: setup }, session);
        await sleep(900);
      }
      const text = await evalJson(session, 'document.body.innerText');
      const geom = JSON.parse(await evalJson(session, `JSON.stringify({
        w: innerWidth,
        h: document.documentElement.scrollHeight,
        sections: Object.fromEntries(['#session-heading','#profile-card','#interval-seconds','#stop-condition','#predicate-panel','#advanced','#automation','#primary-action','#stop-all']
          .map((s) => { const el = document.querySelector(s); return [s, el ? Math.round(el.getBoundingClientRect().top + scrollY) : null]; })),
        items: [...document.querySelectorAll('h1,h2,h3,label,button,legend,summary,p,strong')]
          .map((el) => { const r = el.getBoundingClientRect(); return { t: (el.innerText || '').trim().slice(0, 90), top: Math.round(r.top + scrollY), h: Math.round(r.height) }; })
          .filter((x) => x.t && x.h > 0),
      })`));
      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true }, session);
      const dest = path.join(rawDir, file);
      await fs.writeFile(dest, Buffer.from(shot.data, 'base64'));
      await closePopup();
      report.assets.push({ file: path.relative(outDir, dest), kind: 'raw-popup', geometry: geom, text });
      return { dest, text, ...geom };
    };

    // --- raw captures from the real UI -------------------------------------

    // Running session, waiting on a keyword stop condition.
    await controller.evaluate((m) => chrome.runtime.sendMessage(m), {
      type: 'START', tabId,
      config: { intervalSeconds: 30, stopCondition: 'keyword-found', keyword: 'available now', selector: '#stock' },
    });
    await sleep(2600);
    const popup = await capturePopup('popup-full.png', { expand: ['#automation'] });

    const dashboard = await context.newPage();
    await dashboard.setViewportSize({ width: 1280, height: 800 });
    await dashboard.goto(`chrome-extension://${extId}/options.html`);
    await sleep(1800);
    const dashText = await dashboard.innerText('body');
    const dashShot = path.join(rawDir, 'dashboard.png');
    await dashboard.screenshot({ path: dashShot, scale: 'css' });
    report.assets.push({ file: path.relative(outDir, dashShot), kind: 'dashboard',
      geometry: { w: 1280, h: 800 }, text: dashText });

    // The custom JavaScript stop condition, chosen and filled in through the
    // real form so its panel, hint, access line and code box are all genuine.
    // The condition deliberately checks for an element the demo page does not
    // have, so it keeps reporting "returned false" and the monitor stays running
    // for the frame instead of stopping the session.
    const predicateCode = [
      "const price = document.querySelector('#price');",
      'if (!price) return false;',
      "const value = parseFloat(price.textContent.replace(/[^0-9.]/g, ''));",
      'return Number.isFinite(value) && value < 100;',
    ].join(String.fromCharCode(10));
    // The keyword session above is still running; end it so START is accepted.
    await controller.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'STOP', tabId });
    await sleep(800);
    await controller.evaluate((m) => chrome.runtime.sendMessage(m), {
      type: 'START', tabId,
      config: {
        intervalSeconds: 30,
        stopCondition: 'script-predicate',
        predicateScript: `const node = document.querySelector('#price');\nif (!node) return false;\nconst value = parseFloat(node.textContent.replace(/[^0-9.]/g, ''));\nreturn Number.isFinite(value) && value < 100;`,
      },
    });
    await sleep(2600);
    const predicateSetup = `(() => {
      const select = document.getElementById('stop-condition');
      if (select) { select.value = 'script-predicate'; select.dispatchEvent(new Event('change', { bubbles: true })); }
      const code = document.getElementById('predicate-script');
      if (code) {
        code.value = ${JSON.stringify(predicateCode)};
        code.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`;
    const predicatePopup = await capturePopup('popup-predicate.png', { setup: predicateSetup });

    // --- compose store-ready frames ---------------------------------------
    const img = (p) => `${assetBase}/${path.relative(outDir, p).split(path.sep).join('/')}`;
    const compose = async (name, html, width, height) => {
      const page = await context.newPage();
      await page.setViewportSize({ width, height });
      await fs.writeFile(path.join(rawDir, `${name}.html`), html, 'utf8');
      await page.goto(`${assetBase}/.raw/${name}.html`);
      await page.waitForTimeout(600);
      const dest = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: dest, scale: 'css' });
      await page.close();
      return dest;
    };

    const POPUP_H = 600; // realistic popup window height
    const crop = (y) => Math.max(0, Math.min(popup.h - POPUP_H, Math.round(y)));
    const shot = (extra) => ({
      popupWidth: popup.w, popupHeight: POPUP_H, imageUrl: img(popup.dest), ...extra,
    });
    const at = (selector, fallback) => popup.sections[selector] ?? fallback;
    /** What a crop window actually shows, for verification without eyeballing. */
    const visibleIn = (y) => [...new Set(popup.items.filter((i) => i.top + i.h > y && i.top < y + POPUP_H).map((i) => i.t))];
    const crops = {
      top: crop(0),
      stopConditions: crop(at('#stop-condition', 420) - 200),
      automation: crop(at('#automation', 900) - 24),
    };

    // The custom condition lives on its own popup surface, so it gets its own
    // crop window rather than a window onto the first capture.
    const crop2 = (y) => Math.max(0, Math.min(predicatePopup.h - POPUP_H, Math.round(y)));
    const shot2 = (extra) => ({
      popupWidth: predicatePopup.w, popupHeight: POPUP_H, imageUrl: img(predicatePopup.dest), ...extra,
    });
    const at2 = (selector, fallback) => predicatePopup.sections[selector] ?? fallback;
    const visibleIn2 = (y) => [...new Set(predicatePopup.items
      .filter((i) => i.top + i.h > y && i.top < y + POPUP_H).map((i) => i.t))];
    const crops2 = { customCondition: crop2(at2('#predicate-panel', at2('#stop-condition', 420)) - 150) };

    await compose('screenshot-1-popup-running', frameHtml({
      eyebrow: 'Refresh on your schedule',
      headline: 'Set it, then stop<br>watching the clock',
      bullets: ['Fixed or randomized intervals, per tab', 'Live countdown in the toolbar', 'Pause, resume and count every refresh'],
      ...shot({ cropY: crops.top }),
    }), 1280, 800);

    await compose('screenshot-2-stop-conditions', frameHtml({
      eyebrow: 'Stop when it matters',
      headline: 'Wait for the change,<br>not for a timer',
      bullets: ['Page text or a watched element changes', 'A keyword appears or disappears', 'An element appears or disappears'],
      ...shot({ cropY: crops.stopConditions }),
    }), 1280, 800);

    await compose('screenshot-3-automation', frameHtml({
      eyebrow: 'Optional automation',
      headline: 'Webhooks and page scripts,<br>off by default',
      bullets: ['Each host is granted explicitly', 'Requires the optional User Scripts permission', 'Revoke access any time from the dashboard'],
      ...shot({ cropY: crops.automation }),
    }), 1280, 800);

    // Dashboard fills the frame natively, so it is used full-bleed.
    await fs.copyFile(dashShot, path.join(outDir, 'screenshot-4-dashboard.png'));

    await compose('screenshot-5-custom-condition', frameHtml({
      eyebrow: 'Anything the presets miss',
      headline: 'Describe the finish line<br>in your own code',
      bullets: ['Your JavaScript runs after every settle', 'A truthy result stops; anything else keeps refreshing', 'Errors and timeouts never end the run'],
      ...shot2({ cropY: crops2.customCondition }),
    }), 1280, 800);

    const iconDest = path.join(outDir, 'icon-128.png');
    await fs.copyFile(path.join(root, 'extension', 'icons', 'icon128.png'), iconDest);
    const iconUrl = img(iconDest);

    await compose('promo-small-440x280', promoHtml().replace('ICON', iconUrl), 440, 280);
    await compose('promo-marquee-1400x560', marqueeHtml().replace('ICON', iconUrl), 1400, 560);

    // --- verify: non-blank pixels, exact dimensions ------------------------
    const checker = await context.newPage();
    await checker.goto(origin); // same origin as the assets, or the canvas is tainted
    const probe = async (p) => {
      const url = img(p);
      return checker.evaluate(async (u) => {
        const image = new Image();
        image.src = u;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4 * 499) {
          colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        }
        return { width: image.width, height: image.height, distinctColours: colors.size };
      }, url);
    };

    const finals = ['screenshot-1-popup-running', 'screenshot-2-stop-conditions', 'screenshot-3-automation',
      'screenshot-4-dashboard', 'screenshot-5-custom-condition', 'promo-small-440x280', 'promo-marquee-1400x560'];
    const expected = {
      'screenshot-1-popup-running': [1280, 800], 'screenshot-2-stop-conditions': [1280, 800],
      'screenshot-3-automation': [1280, 800], 'screenshot-4-dashboard': [1280, 800],
      'screenshot-5-custom-condition': [1280, 800],
      'promo-small-440x280': [440, 280], 'promo-marquee-1400x560': [1400, 560],
    };
    const verification = [];
    for (const name of finals) {
      const p = path.join(outDir, `${name}.png`);
      const stats = await probe(p);
      const [ew, eh] = expected[name];
      const ok = stats.width === ew && stats.height === eh && stats.distinctColours > 20;
      verification.push({ name, ...stats, expected: `${ew}x${eh}`, ok });
      if (!ok) throw new Error(`${name}: ${JSON.stringify(stats)} failed verification`);
    }
    const iconStats = await probe(iconDest);
    verification.push({ name: 'icon-128.png', ...iconStats, expected: '128x128',
      ok: iconStats.width === 128 && iconStats.height === 128 });
    if (!verification.at(-1).ok) throw new Error('icon-128.png is not 128x128');

    report.verification = verification;
    report.popupText = popup.text;
    report.popupGeometry = { width: popup.w, fullHeight: popup.h, sections: popup.sections,
      crops: { ...crops, windowHeight: POPUP_H } };
    report.cropContents = {
      'screenshot-1-popup-running': visibleIn(crops.top),
      'screenshot-2-stop-conditions': visibleIn(crops.stopConditions),
      'screenshot-3-automation': visibleIn(crops.automation),
      'screenshot-5-custom-condition': visibleIn2(crops2.customCondition),
    };
    report.iconSource = 'extension/icons/icon128.png (unmodified copy)';
    report.note = 'Popup and dashboard pixels are the real extension UI driven against a local demo page. '
      + 'A throwaway copy added host_permissions for 127.0.0.1 only so monitoring could start without a click, '
      + 'and promoted the optional userScripts permission to required so the custom-condition panel could be '
      + 'photographed in its granted state; the shipped manifest keeps userScripts optional. '
      + 'Popup crops are windows onto full-surface captures, because headless refuses to size the popup window. '
      + 'Only the promo tiles, screenshot backgrounds and captions are composed artwork.';
    await fs.writeFile(path.join(outDir, 'capture-report.json'), JSON.stringify(report, null, 2), 'utf8');

    ws.close();
    console.log(`\nCaptured ${verification.length} assets into ${outDir}`);
    for (const v of verification) {
      console.log(`  ${v.ok ? 'OK  ' : 'FAIL'} ${v.name.padEnd(34)} ${v.width}x${v.height}  ${v.distinctColours} colours`);
    }
  } finally {
    await context.close();
    server.close();
    await fs.rm(profile, { recursive: true, force: true });
    if (!options.keep) await fs.rm(stage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});