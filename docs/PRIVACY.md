# Privacy policy

Effective date: October 12, 2026.

The Best Auto Refresh App runs locally in your browser. It does not collect or transmit personal information, browsing history, page contents, keywords, or monitoring results to the developer or any server. It has no analytics, advertising, accounts, or third-party tracking services.

## Local data

The extension stores your settings and saved profiles in the browser's local extension storage. Unfinished popup settings, including any typed keywords and selectors, are saved per tab in temporary browser session storage so closing the popup does not discard your work. Active monitoring sessions also store the tab identifier, URL/title, monitoring rules, normalized page text needed for comparison, timing, and results in browser session storage. Temporary drafts and sessions are cleared when the browser session ends. Local saved settings remain until removed or the extension is uninstalled. Do not put secrets in saved keyword profiles on shared devices.

## Permissions

- **activeTab:** Temporary access to the tab you explicitly activate through the extension. It does not grant blanket access to all websites.
- **scripting:** Injects the local monitoring script and optional element picker into that tab.
- **storage:** Saves local preferences/profiles and temporary monitoring state.
- **alarms:** Wakes the extension to check refresh scheduling when its background worker sleeps.

The extension does not request access to all sites, your browsing history, notifications, clipboard, downloads, passwords, or contacts.

## Network activity

Refreshing a tab makes the website's normal network requests. Those requests are handled by that website under its own privacy policy. The extension itself has no external data transmission endpoints.

## Control and contact

Pause or stop a monitor from the popup or dashboard. Uninstalling the extension removes its browser-managed local storage. For privacy questions, open an issue in this repository. Do not include sensitive page contents or private URLs in public issues.
