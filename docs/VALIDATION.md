# Validation — version 1.0.0

Validated on October 12, 2026 using Node.js 25 and the installed Helium executable.

- 45 engine unit tests passed, including matching, configuration bounds, schedule decisions, message authorization, selectors, origins and packaging.
- Real Manifest V3 browser checks passed: keyword appearance/disappearance after reload, page/element changes, element appearance/disappearance, hidden text and visible overrides, count/duration limits, native cache-bypass reload, scroll restoration, pause/resume/stop, picker after stop, watchdog recovery, random bounds, profiles, cross-origin stop and closed-tab cleanup.
- No page JavaScript errors in the browser suite. Popup and dashboard overflow checks passed at 400px and 390px respectively. Additional 360px popup inspection and keyboard focus/reduced-motion checks completed during development.
- All extension JavaScript passed syntax checks. Manifest and icon references passed validation; production permissions are exactly activeTab, scripting, storage and alarms, with no host permissions.

The browser suite copies the extension into an ignored output directory and adds access to its controlled loopback fixture in that disposable copy only. Production activeTab access is granted by clicking the action in your own browser. The production extension was installed and pinned in the user's Helium profile. Its normal popup started a 5-second keyword monitor on a controlled local page, survived native reloads, and automatically stopped with MATCHED when the server began returning the watched text. The test defaults were reset and saved afterward. Stable Google Chrome testing remains a separate check before Store submission.

Implementation contributions: two Alibaba bailian-tpp DeepSeek V4.1 Flash workers supplied the engine and UI. The UI worker completed successfully; the engine worker was stopped after its files and tests were delivered, and its integration was completed and verified by the orchestrator. A native GPT-6 Luna worker independently reviewed the lifecycle and permission-sensitive code; identified fixes were integrated and retested. An AI-generated icon supplies the branding.

Known practical limits: timers can be delayed by background throttling or sleep; monitoring requires an open tab and browser. Text comparisons cover the top-level page's light DOM visible text, capped at 200,000 characters. They do not inspect cross-origin frames or shadow-root content. Local files and protected browser pages are unsupported. Store publication has not been requested or performed.
