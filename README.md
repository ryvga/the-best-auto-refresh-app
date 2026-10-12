# The Best Auto Refresh App

**Refresh smarter. Stop when it matters.** A free, open-source Chrome and Chromium extension that refreshes a tab until the thing you care about happens.

No account. No ads. No paywalls. No analytics. Monitoring happens on your device; optional webhooks send only the data you configure to your chosen endpoint.

## Features

- Fixed intervals or random intervals within a range.
- Stop on page text changes, changes to a chosen element, a keyword appearing or disappearing, or an element appearing or disappearing.
- Scope keyword checks to a CSS selector; case-sensitive and whole-word matching.
- Point-and-click element picker; ignore noisy areas with a CSS selector.
- Set a maximum refresh count or duration, pause/resume, preserve scroll, or bypass the cache.
- Live toolbar countdown while monitoring, even with the popup closed.
- Quick profiles in the popup: save settings for this page, this website, or everywhere. Page profiles take priority over website profiles; unfinished edits always win. Choosing a profile loads settings without starting a monitor.
- A dashboard for monitored tabs and saved profile management.
- Optional pause when you click or type on the monitored page; continue with Resume when you are ready.
- Optional automation hooks: webhooks and custom JavaScript on refreshes, checks, matches, limits, errors, start/stop, pause and resume. See [automation guide](docs/AUTOMATION.md).
- Guided ntfy notification setup and a separate button to send one test webhook, without starting or changing a monitor.
- Unfinished popup settings are remembered per tab during the browser session, so you can close the popup to copy a keyword and continue where you left off.
- Start remembers settings only for the current tab. Shared defaults change only when explicitly saved. New tabs keep automation off, including automatic profile suggestions; explicitly choose a saved profile to reuse its webhook/script settings.
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

See [Privacy policy](docs/PRIVACY.md). Required permissions are `activeTab`, `scripting`, `storage`, and `alarms`. JavaScript and host access for automation are optional, requested only from explicit Connect/Enable buttons. No host access is required for normal refreshing. There are no tracking libraries or developer monitoring services. Chrome/Chromium 106 or newer is required for refreshing and monitoring, which covers current Chromium-based browsers; custom scripts additionally need Chrome 135 or newer and Chrome's Allow User Scripts setting.

## Development

Use Node.js 20 or later. Run `npm test` for engine checks. The extension needs no build step or runtime dependencies. Run `powershell -ExecutionPolicy Bypass -File scripts/package.ps1` to create a store-upload ZIP containing only extension files.

For real browser checks, install Playwright as a development tool and run `node scripts/browser-check.cjs`. `PLAYWRIGHT_PACKAGE` can point to an existing Playwright installation and `CHROME_EXECUTABLE` to your Chromium browser. The suite uses disposable profiles and a test-only loopback permission; it does not alter the production manifest or your personal profile. See [validation notes](docs/VALIDATION.md).

## Publishing

See the [Chrome Web Store submission guide](docs/SUBMISSION.md) for the full checklist, and [store preparation](docs/STORE.md) for the draft listing copy and permission explanations. The published privacy policy is at <https://ryvga.github.io/the-best-auto-refresh-app/PRIVACY.html>.

Build the upload package with `powershell -ExecutionPolicy Bypass -File scripts/package.ps1`, then either upload it from the developer dashboard or automate it with `node scripts/publish-cws.mjs release` once the item exists and API credentials are configured. Store acceptance is determined by Google review. The extension is free to users; Google charges a one-time developer registration fee.

## Support development

Every feature is free. If the extension saves you time, you can [support Mounir on Ko-fi](https://ko-fi.com/mouniryuga). Support is voluntary and unlocks no features. The extension embeds no payment scripts or tracking pixels; clicking the link opens the external Ko-fi site.

## License

MIT. Contributions and reproducible bug reports are welcome. “The Best Auto Refresh App” is the product name, not a claim of an independently verified ranking.
