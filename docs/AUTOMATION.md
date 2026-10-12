# Automation hooks

Automation is optional. Event hooks run only with a monitor you explicitly start; the separate Send test notification button sends one webhook on your explicit click. Normal refreshing needs no additional permission. Hooks are part of a saved profile, and unfinished hook settings stay in the tab's popup draft. Start affects only that tab and does not overwrite shared defaults. New tabs leave automation off even when defaults or automatic profile suggestions contain enabled hooks; explicitly choose a saved profile to reuse them.

## Events

| Event | When it runs |
| --- | --- |
| Start | A monitor starts successfully. |
| Before refresh | Just before the extension reloads the page. |
| After refresh | A reload initiated by the monitor finishes loading. |
| Page checked | A page snapshot is checked, including the initial check. |
| Condition matched | Your stop condition is met. |
| Limit reached | The refresh count or duration limit ends monitoring. |
| Manually stopped | You stop a running or paused monitor. |
| Error | A monitoring error ends the session. |
| Paused / Resumed | You pause or resume the monitor. |

A manually reloaded page can be checked, but does not produce the monitor's After refresh event. Replacing a monitor with new settings does not trigger Manually stopped. A hook failure is logged separately and does not recursively trigger Error hooks or stop normal monitoring.

## Webhooks

Enter an HTTPS endpoint, select events, and click Connect webhook. Local development endpoints can use HTTP on localhost or 127.0.0.1. Chrome asks for access to that hostname; its grant covers the host, not just a URL path or port. Only explicitly configured URLs are used. Merely saving or connecting a webhook does not send a test request.

POST sends JSON; GET is also available. Blank body uses event metadata: event, timestamp, refresh count, and status. Page address, title, keyword, selector and reason are excluded unless you turn on Include page details. Page text is never included automatically.

Custom headers are a JSON object. Bearer Authorization headers and tokens in endpoint query strings are allowed; username/password credentials embedded in a URL are rejected. These values are stored locally in saved settings/profiles and temporary drafts. They are not copied to page scripts, activity logs, or this repository. Saved extension data is not encrypted.

A custom body must be valid JSON. Template variables can be placed inside strings: `{{event}}`, `{{timestamp}}`, `{{refreshCount}}`, `{{status}}`, `{{url}}`, `{{title}}`, `{{reason}}`, `{{keyword}}`, `{{selector}}`. Page-related variables are empty unless Include page details is enabled. Replacements are escaped through JSON serialization.

For example, a chat service accepting a `text` field can receive:

```json
{"text":"Refresh monitor: {{event}} ({{refreshCount}} refreshes)"}
```

Requests omit browser credentials/cookies, do not follow redirects, and time out after five seconds. They are not automatically retried, because retrying a webhook can duplicate an external action. The activity log records success, failure, or missing access without storing request bodies, headers, URLs, or response bodies.

### ntfy quick setup

Turn on Webhook, enter your ntfy server (default `https://ntfy.sh`) and topic, then click Use ntfy settings. This fills a POST request to the server root with valid JSON containing the topic, title and message. It selects Condition matched, Limit reached, Manually stopped and Error. It replaces URL/method/headers/body/events and leaves page details off; re-enter any Authorization header required by a private server after applying the preset. The setup button sends nothing and never grants access. Subscribe to the same topic and server in your ntfy app.

Click Connect webhook to grant the hostname, then Send test notification to send one real request. A test uses event `test` and refreshCount `0`; it does not start or change monitoring, does not run custom scripts, and does not depend on your selected monitoring events. Duplicate test clicks are blocked while a test is in flight. HTTP success means the receiver accepted the request, not a guarantee that your phone displayed it. A timeout may occur after a receiver processed a request, so retry manually only when appropriate.

If Connect fails after an unpacked extension update, open `chrome://extensions`, reload the extension card, reopen the popup and retry. Preserve the exact error message for troubleshooting if it still fails. An updated popup can be visible before the browser reloads new manifest declarations.

[ntfy JSON publishing reference](https://docs.ntfy.sh/publish/#publish-as-json).

### Pause while using the page

Advanced settings includes Pause when I interact with the page. This is off by default. With it enabled, trusted clicking or typing in the monitored top-level page pauses the monitor; Resume continues manually. Programmatic clicks and synthetic keyboard events do not pause. Picker gestures are excluded. A pause during a slow before-refresh hook cancels the pending reload once the interaction is received; a navigation already issued by the browser cannot be undone. No typed text or keys are sent in interaction messages.

## Custom JavaScript

Scripts run through Chrome's documented User Scripts API in its isolated USER_SCRIPT world. They can inspect or change the monitored page's DOM, but are not given extension APIs or webhook secrets. No script registration is left running across unrelated tabs.

Enable JavaScript on this website to request the optional permission and website access. In Chrome 138 and newer, turn on Allow User Scripts in the extension's Details page yourself. The app reports when this capability is unavailable; it does not bypass the browser setting. One-shot scripts require Chrome 135 or newer.

Write the body of an async function. The provided `event` object contains `type`, `timestamp`, `refreshCount`, `status`, `url`, `title`, `reason`, `keyword`, and `selector`. A harmless example highlights the page after a match:

```js
if (event.type === 'match') {
  document.body.style.outline = '4px solid #0e6b62';
  console.info('Refresh condition matched', event.refreshCount);
}
```

Use Before refresh for DOM work that must happen before navigation and After refresh for work on the newly loaded document. Script errors and an execution timeout appear in the activity log. A timeout stops the monitor waiting for the script; it cannot interrupt an infinite loop in page JavaScript or undo a script's changes. Only use code you understand.

## Access and activity

The popup's Activity section shows recent hook outcomes. Turning a hook off stops future calls while leaving refreshing running; a request or script that has already started may finish. The dashboard's Automation access controls revoke an optional hostname grant or JavaScript permission. Host grants are shared between webhooks and scripts. After revocation, hooks requiring that access are skipped and logged. Active monitoring and normal refreshing remain separate from these optional permissions.

Selected hooks can delay a monitoring step while awaiting completion, for up to five seconds per event. The refresh countdown remains an estimate. Scripts are supported on HTTPS websites and loopback HTTP pages in this release.

Official references: [User Scripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [Manifest V3 store requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). Chrome Web Store review remains a separate future step.
