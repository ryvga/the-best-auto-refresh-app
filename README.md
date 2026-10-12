# The Best Auto Refresh App

**Refresh smarter. Stop when it matters.** A free, open-source Chrome and Chromium extension that refreshes a tab until the thing you care about happens.

No account. No ads. No paywalls. No analytics. All monitoring happens on your device.

## Features

- Fixed intervals or random intervals within a range.
- Stop on page text changes, changes to a chosen element, a keyword appearing or disappearing, or an element appearing or disappearing.
- Scope keyword checks to a CSS selector; case-sensitive and whole-word matching.
- Point-and-click element picker; ignore noisy areas with a CSS selector.
- Set a maximum refresh count or duration, pause/resume, preserve scroll, or bypass the cache.
- Saved profiles and a dashboard for monitored tabs.
- Unfinished popup settings are remembered per tab during the browser session, so you can close the popup to copy a keyword and continue where you left off.
- Explicit per-tab access using `activeTab`, with no all-websites permission request.

## Install locally in Chrome or Helium

1. Download this repository or clone it.
2. Open `chrome://extensions` in your browser.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the **extension** directory (the directory containing `manifest.json`).
5. Pin the extension from the browser's Extensions menu.
6. Open a normal website, click the extension, choose an interval and stop condition, then click Start.

Keep the extension directory in place. After pulling an update, click Reload on its extension card.

## How it works

Page text monitoring compares normalized visible text against the initial baseline. Dynamic clocks, ads, and counters can trigger page-change detection; use a selected element or ignored selector to narrow the watch. A keyword already matching your condition can stop immediately after the settling delay.

Monitoring requires an open tab and running browser. Background tabs, browser suspension, and computer sleep can delay checks; this is not an exact timing service. Refreshing reloads the page, so save any form edits first. Browser-internal pages, the Chrome Web Store, other extensions, and inaccessible frames cannot be monitored. Same-origin reloads retain the user-granted access; moving to another origin ends monitoring. Browser restart clears active sessions rather than silently restarting them.

## Privacy and permissions

See [Privacy policy](docs/PRIVACY.md). Required permissions are `activeTab`, `scripting`, `storage`, and `alarms`. There are no broad host permissions, tracking libraries, remote scripts, or external monitoring services.

## Development

Use Node.js 20 or later. Run `npm test` for engine checks. The extension needs no build step or runtime dependencies. Run `powershell -ExecutionPolicy Bypass -File scripts/package.ps1` to create a store-upload ZIP containing only extension files.

For real browser checks, install Playwright as a development tool and run `node scripts/browser-check.cjs`. `PLAYWRIGHT_PACKAGE` can point to an existing Playwright installation and `CHROME_EXECUTABLE` to your Chromium browser. The suite uses disposable profiles and a test-only loopback permission; it does not alter the production manifest or your personal profile. See [validation notes](docs/VALIDATION.md).

## Publishing

Store publication is a separate later step. See [store preparation](docs/STORE.md) for draft listing copy and permission explanations. Store acceptance is determined by Google review. The extension is free to users; Google may charge a developer registration fee.

## License

MIT. Contributions and reproducible bug reports are welcome. “The Best Auto Refresh App” is the product name, not a claim of an independently verified ranking.
