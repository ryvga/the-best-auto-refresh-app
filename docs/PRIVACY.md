# Privacy policy

Effective date: October 12, 2026.

The Best Auto Refresh App monitors pages locally in your browser. The developer does not collect your information. It has no analytics, advertising, accounts, or third-party tracking services. Optional webhooks send event data to the endpoint you configure and enable; custom scripts can read or change the page and perform the operations you write.

## Local data

The extension stores your settings and saved profiles in the browser's local extension storage. Unfinished popup settings, including any typed keywords and selectors, are saved per tab in temporary browser session storage so closing the popup does not discard your work. Active monitoring sessions also store the tab identifier, URL/title, monitoring rules, normalized page text needed for comparison, timing, and results in browser session storage. Temporary drafts and sessions are cleared when the browser session ends. Local saved settings remain until removed or the extension is uninstalled. Do not put secrets in saved keyword profiles on shared devices.

Scoped profiles also store the selected website origin or page address (path and query, excluding the fragment and URL credentials) locally to suggest the appropriate settings. Countdown messages stay inside the extension and contain only session identifiers, not page text.

Started settings remain independent per tab in temporary session storage. Opening a new tab does not enable automation from defaults or automatic profile suggestions. Choosing a saved profile explicitly can restore its automation settings. Optional interaction protection observes trusted clicks/typing locally, reports session identity and a trusted-gesture flag, and never reports typed keys, text or input values. Closing a tab clears its temporary settings and drafts.

Automation settings can include webhook addresses, custom headers, JSON body templates, and JavaScript code. These remain in local settings/profiles and temporary drafts. Local storage is not encrypted. The hook activity log is stored temporarily in browser session storage, contains generic outcomes rather than request/response bodies or code, and is capped at 100 entries.

## Permissions

- **activeTab:** Temporary access to the tab you explicitly activate through the extension. It does not grant blanket access to all websites.
- **scripting:** Injects the local monitoring script and optional element picker into that tab.
- **storage:** Saves local preferences/profiles and temporary monitoring state.
- **alarms:** Wakes the extension to check refresh scheduling when its background worker sleeps.

Normal refreshing does not request access to all sites, browsing history, notifications, clipboard, downloads, passwords, or contacts. The optional automation features request access to only the website hostname you explicitly connect. Chrome's host grants cover the hostname rather than an individual endpoint path or port. Optional `userScripts` permission and Chrome's Allow User Scripts setting are required only for custom JavaScript. You can revoke optional grants from the dashboard.

## Network activity

Refreshing a tab makes the website's normal network requests, handled under that website's privacy policy. If you enable a webhook, the extension also sends requests to your configured endpoint. Default payloads contain event type, time, refresh count, and monitor status. Page address, title, keyword, selector and stop reason are excluded unless you enable Include page details. Custom body templates and headers are sent as you configure them. The extension does not automatically send page text, browser cookies, or credentials; webhook redirects are not followed and failed requests are not automatically retried. Any custom JavaScript network operations are defined by your code. The endpoint provider's privacy policy applies to data you send there.

The ntfy helper only fills webhook fields locally. Connect only requests hostname access. Send test notification sends one request to the endpoint shown in the form; its event is `test`, its refresh count is zero, and it never runs JavaScript or changes monitoring. Page details remain opt-in. A timeout is not proof that the receiver did not process the request; tests and normal hooks are not automatically retried.

Support development links open the owner's public Ko-fi page only when clicked. The extension embeds no Ko-fi code or payment SDK and sends no monitoring data to Ko-fi. The external website and payment processor apply their own privacy policies. Donations are voluntary and all extension features remain free.

## Control and contact

Pause or stop a monitor from the popup or dashboard. Uninstalling the extension removes its browser-managed local storage. For privacy questions, open an issue in this repository. Do not include sensitive page contents or private URLs in public issues.
