# Chrome Web Store preparation

Status: development build; not submitted. Verify the release in current stable Chrome before submission.

For the operational, step-by-step submission process — including developer registration, credentials, and automated releases — see [SUBMISSION.md](SUBMISSION.md). This page holds the listing copy and disclosure wording.

## Draft listing

Name: The Best Auto Refresh App

Short description: Refresh tabs on a timer or until page content, keywords, or selected elements change. Free, local, and open source.

Description:
Refresh smarter. Stop when it matters.

Choose a steady interval or randomize the delay. Watch the whole page or a selected element, and stop when text changes, a keyword appears or disappears, or an element appears or disappears. For anything the presets miss, write your own JavaScript condition; refreshing stops when it returns true, and a condition that errors or is blocked just keeps refreshing. Save settings per page, site, or general use and switch profiles from the popup. See the countdown on the toolbar. Pause, resume, and manage tabs in one dashboard.

Optional automation sends webhooks or runs your custom JavaScript on chosen events. Webhooks request access to the configured hostname; scripts need Chrome's optional User Scripts permission, site access, and Allow User Scripts. Both are off by default. Logs show outcomes; access can be revoked in the dashboard.

Use guided ntfy setup to send a test notification before watching a page. Optional pause-on-interaction protects your workflow while clicking or typing. Settings stay independent per tab; reuse them through saved profiles. Starting a tab never silently changes shared defaults or enables automation elsewhere.

All features are free. No account, ads, subscriptions, analytics, or developer data collection. Monitoring runs on your device. Optional webhooks send the data you configure to your endpoint; page details are excluded by default.

A voluntary link opens the developer's Ko-fi page. Supporting is optional and unlocks nothing. No payment code or tracking is embedded.

Timing can be delayed in background tabs or during sleep. Browser-internal and protected pages cannot be monitored.

## Single purpose

User-controlled page refreshing with local content conditions that determine when refreshing stops. Profiles, the picker, the dashboard, and event automation support this same purpose. Stop conditions are evaluated locally on the page: built-in comparisons plus, optionally, a JavaScript condition the user writes in the extension's own settings. No remote code is executed in extension contexts.

## Permission justifications

activeTab: User-triggered access to the selected page for refresh and monitoring; avoids broad site access.
scripting: Inject bundled monitoring/picker code into the selected page.
storage: Persist preferences and temporary per-tab monitoring state.
alarms: Wake the service worker for scheduling and watchdog checks.

Optional userScripts: Execute user-authored code for selected monitoring events and for the optional custom JavaScript stop condition, in the isolated USER_SCRIPT context. Only after the user enables the feature and the browser setting. No dynamic registration across unrelated pages.
Optional host access: Connect user-configured HTTPS webhook endpoints or script websites, and loopback HTTP endpoints for local development. Request a specific host from an explicit user gesture; never request all optional hosts in one call. Disclose that Chrome host grants cover paths/ports on that hostname.

## Remote code use

Answer: No remote code. All executable code ships inside the uploaded package — the engine, the content script, the popup, the dashboard and the automation runner included. Nothing is fetched from a server at runtime, and no bundled file uses `eval` or `new Function`; a test enforces that.

The only executable text that is not bundled is code the user types into the extension's own settings UI: optional page scripts, and the optional JavaScript stop condition. That text is entered by the user, stored locally with `chrome.storage`, never downloaded, and never evaluated in an extension context. It runs only through the documented `chrome.userScripts.execute` API, in the isolated `USER_SCRIPT` world, only after the user grants the optional `userScripts` permission and turns on the browser's own Allow User Scripts setting. Without both, the feature reports that it is unavailable and refreshing continues unchanged. A syntax error or a runtime error in user-authored code is reported to the user and never reaches an extension context.

## Submission checklist

- Publish the repository privacy policy at a stable accessible URL and enter it in the developer dashboard.
- Complete privacy disclosures accurately: no developer collection; user-directed webhook transmission and optional script execution must be disclosed. Describe payload fields and opt-in page details.
- Upload the ZIP generated by scripts/package.ps1, not the whole repository.
- Capture actual 1280x800 or 640x400 screenshots showing popup, stop conditions, and dashboard; use actual UI only.
- Review icon and manifest version; test installation from the ZIP contents.
- Confirm current Chrome policies and registration requirements at submission time.
- Include review instructions and a controlled example for optional webhooks, User Scripts, and the custom JavaScript stop condition, including the Chrome 138+ Allow User Scripts toggle. Verify permission revocation and unsupported/disabled API handling.
- Keep claims factual. No fake ratings, badges, rankings, or approval promises. The requested product name may require adjustment if Google flags promotional metadata.
- Register a developer account if required; registration fees are separate from offering the extension free to users.

Official references:
https://developer.chrome.com/docs/webstore/program-policies/policies
https://developer.chrome.com/docs/webstore/publish
https://developer.chrome.com/docs/webstore/register
