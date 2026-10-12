# Validation

## Version 1.2.0 — event automation

Validated in the installed Helium 141 executable using fresh disposable profiles. The production manifest retains the four required permissions and declares userScripts and specific-host access as optional. Custom scripts use the documented Chrome 135+ one-shot API; stable Google Chrome remains a separate pre-submission check.

- 57 engine/automation tests passed: configuration and endpoint validation, revoked/missing permissions, precise document targeting, asynchronous script results, private errors, single-pass JSON templates and log restoration after module restart.
- 14 real MV3 automation checks passed: selected lifecycle events, after-refresh deduplication, default payload privacy and omitted cookies, custom templates with literal quotes/tokens, optional page details/headers, pause/resume/manual-stop, HTTP failures, redirects, missing host grants, resume attach errors, immediate hook disable, real isolated asynchronous JavaScript, five-second timeout with an independent script, profile/dashboard round trips, raw unfinished drafts, and 360/400px layout.
- Existing suites passed: 24 refresh flow checks, 15 quick-profile/countdown checks, and 11 per-tab popup draft checks. Syntax, manifest/assets, and diff checks pass.

The JavaScript test enabled Allow User Scripts only in a disposable test profile and verified real userScripts.execute execution; it did not change the user's browser setting. All test webhooks used a controlled loopback receiver. No third-party webhook, Store submission, or publication occurred.

Workers: bailian-tpp DeepSeek V4.1 Flash supplied the automation UI and runner/schema; the orchestrator stopped extended worker runs after code delivery, integrated lifecycle hooks, repaired validation/template/script-result/log issues, and performed final testing. A GLM-5.3 attempt was stopped after extended analysis without code delivery. Native Luna follow-ups could not run because of the account usage limit. A bailian-tpp Qwen3.8 Flash read-only reviewer completed successfully; its resume error-hook and shared-host permission-label findings were fixed. Its Chrome 135–137 incompatibility claim was rejected against the official API documentation (worldId supports Chrome 133+, execute and document targeting support Chrome 135+); real async script completion was verified in Helium 141.

Personal Helium reload is pending because Windows Computer Use could not verify the browser URL. The unpacked extension folder is ready; click Reload on its extension card to use this version. Custom JavaScript additionally requires the user's Allow User Scripts toggle.

## Version 1.1.0 — countdown and scoped quick profiles

Added toolbar seconds countdown, exact page/site profile matching, manual global profiles, per-tab draft priority, and explicit Apply & restart when settings differ from an active monitor. DeepSeek V4.1 Flash supplied UI and countdown changes; native Luna supplied the 15-check profile regression suite and read-only countdown review. The orchestrator integrated and verified them. These features are included in 1.2.0.

## Version 1.0.1 — popup drafts

Added per-tab temporary drafts so unfinished settings survive popup dismissal without saving defaults. Eleven real MV3 popup checks pass, including immediate close after 20 synchronous input events, raw incomplete fields, Advanced state, independent tabs, defaults remaining separate, successful Save/Start clearing stale drafts, and picker return replacing the selector while retaining settings. The 45 engine tests and manifest/syntax checks also pass. No permissions or external endpoints were added.

A bailian-tpp DeepSeek V4.1 Flash worker supplied the popup changes; the orchestrator completed the rapid-close dispatch fix and integration after stopping the worker's extended verification. Native GPT-6 Luna supplied the regression script and independently reproduced the queued-write loss before the final fix.

## Initial release checks

Validated on October 12, 2026 using Node.js 25 and the installed Helium executable.

- 45 engine unit tests passed, including matching, configuration bounds, schedule decisions, message authorization, selectors, origins and packaging.
- Real Manifest V3 browser checks passed: keyword appearance/disappearance after reload, page/element changes, element appearance/disappearance, hidden text and visible overrides, count/duration limits, native cache-bypass reload, scroll restoration, pause/resume/stop, picker after stop, watchdog recovery, random bounds, profiles, cross-origin stop and closed-tab cleanup.
- No page JavaScript errors in the browser suite. Popup and dashboard overflow checks passed at 400px and 390px respectively. Additional 360px popup inspection and keyboard focus/reduced-motion checks completed during development.
- All extension JavaScript passed syntax checks. Manifest and icon references passed validation; production permissions are exactly activeTab, scripting, storage and alarms, with no host permissions.

The browser suite copies the extension into an ignored output directory and adds access to its controlled loopback fixture in that disposable copy only. Production activeTab access is granted by clicking the action in your own browser. The production extension was installed and pinned in the user's Helium profile. Its normal popup started a 5-second keyword monitor on a controlled local page, survived native reloads, and automatically stopped with MATCHED when the server began returning the watched text. The test defaults were reset and saved afterward. Stable Google Chrome testing remains a separate check before Store submission.

Implementation contributions: two Alibaba bailian-tpp DeepSeek V4.1 Flash workers supplied the engine and UI. The UI worker completed successfully; the engine worker was stopped after its files and tests were delivered, and its integration was completed and verified by the orchestrator. A native GPT-6 Luna worker independently reviewed the lifecycle and permission-sensitive code; identified fixes were integrated and retested. An AI-generated icon supplies the branding.

Known practical limits: timers can be delayed by background throttling or sleep; monitoring requires an open tab and browser. Text comparisons cover the top-level page's light DOM visible text, capped at 200,000 characters. They do not inspect cross-origin frames or shadow-root content. Local files and protected browser pages are unsupported. Store publication has not been requested or performed.
