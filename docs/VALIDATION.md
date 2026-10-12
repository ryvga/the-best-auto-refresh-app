# Validation

## Version 1.3.4 — the condition panel can ask for its own permission

`userScripts` is declared as an optional permission so that people who never write a
condition are not asked for it. That choice had a consequence nobody had checked:
Chromium renders the **Allow User Scripts** switch on the extension's Details page
*only once the extension already holds the grant*. With the permission unrequested,
the row was not drawn at all, so the popup's status line told the user to switch on
something that was not on the page. The only code path that requested the grant was
the automation section's page-script button — a different feature, in a different
part of the popup.

Both condition panels now carry a grant button next to the status line, shown only
while the grant is genuinely missing:

- The popup asks for `userScripts` **and the current site's hostname**, because the
  condition has to execute in the page after every settle. It reuses the same
  `permissionOriginForUrl` guard as the other permission buttons: on a browser page,
  the Web Store or a local file it explains why there is nothing to grant instead of
  raising a request Chrome would reject.
- The dashboard asks for `userScripts` alone. It has no page of its own to name, and
  per-site access still comes from the popup.
- Both requests run synchronously inside the click, before any `await`, so the click
  is the user gesture Chrome requires. Neither one toggles the browser's own switch,
  which no page is permitted to press; both explain that step instead.
- Once the grant is held the button hides itself and the status line moves to the
  "Allow User Scripts is off" instruction, then to "JavaScript access is ready".

- 110 unit tests pass. The parity test now requires the button markup, the lookup,
  and a `chrome.permissions.request({ permissions: ['userScripts'] … })` call in each
  UI file, so a status line can no longer be shipped without a way to act on it.
- The button is disabled with an explanatory title in the popup's preview mode, where
  no extension engine is reachable.
- Syntax, manifest and least-privilege validation pass. `manifest.json` and
  `package.json` are at 1.3.4.

Not verified in a real browser: that Helium and Chrome render the **Allow User
Scripts** row immediately after the grant is accepted. The behaviour the button
depends on — the row appearing only while the permission is held — was established by
reading Chromium's own UI strings and the profile's granted-permission state, not by
driving a browser.

## Version 1.3.3 — the custom condition actually reaches the engine, and profiles stop losing changes

This release fixes a defect that made 1.3.2's headline feature unusable, and closes
a long-standing data-loss race between the popup and the dashboard.

**The custom stop condition never started a monitor.** Both UI files keep their own
`normalizeConfig`, and each one built an explicit object listing every field it
carried. `predicateScript` was not in either list, so the code the user typed was
dropped between the form and the `START` message. `core.validateConfig` then refused
the config for missing required code, and the popup reported an engine error. The
feature was correct in `core.js`, `actions.js` and `background.js` and unreachable
from the interface. `applyConfigToForm` had the matching fault: it assigned
`config.predicateScript` unconditionally, so repopulating the form painted the
literal word `undefined` into the code box.

- Both normalisers now carry the field, guarded to a string.
- Both restore sites are guarded too, so no config can write `undefined` into the box.
- `tests/predicate.test.mjs` previously asserted that the token `predicateScript`
  appeared *somewhere* in each UI file, which is exactly how this shipped. It now
  extracts the `normalizeConfig` body itself, requires the guarded assignment inside
  that function, and pins the dashboard's restore site. A companion assertion proves
  the engine agrees with the normaliser: the carried shape validates, and the same
  shape with the field deleted is refused.

**Saved profiles are now written by one owner.** Reading the whole `profiles` array,
editing it in the page, and writing it back meant a popup save and a dashboard save
racing each other silently discarded one of the two. `extension/profiles-store.js`
moves every mutation into the service worker behind `SAVE_PROFILE` and
`DELETE_PROFILE`. Operations are serialised through a promise chain, so a rejected
operation cannot break the queue; each one re-reads storage inside the critical
section; `expectedUpdatedAt` is an optimistic version check that refuses a stale
update or delete instead of overwriting newer work; and `createOnly` means a "new
profile" save cannot clobber an entry that appeared while the user was typing.
`updatedAt` is `max(now, current + 1)` so two saves in the same millisecond still
order correctly. Both pages now send messages instead of writing the array, and
`tests/profiles-store.test.mjs` asserts that neither file writes `profiles` again —
the guard matters more than the port, because the port is easy to undo by accident.

**Unfinished profile work survives the popup closing.** The name, scope and open/closed
state of the save section are part of the tab draft now (`DRAFT_VERSION` 4), alongside
the half-typed settings that were already preserved. Old version-3 drafts still restore:
`applyDraftToForm` reads fields individually and never version-gates the whole record.

- 110 unit tests pass, up from 96 at 1.3.2. New: 11 in `tests/profiles-store.test.mjs`
  (serialisation under concurrent saves and deletes, scope coexistence, stale
  update/delete rejection, malformed id/target/scope/config rejection, storage-failure
  safety, `createOnly` collision, the profile ceiling, and a custom-condition round trip),
  and one more in `tests/predicate.test.mjs` for the normaliser parity above.
- The runtime message contract in `tests/engine.test.mjs` gained `SAVE_PROFILE` and
  `DELETE_PROFILE`, so `validateUiMessage` still rejects anything outside the documented
  set — page content cannot reach the profile library.
- The dashboard note that claimed "Pressing Start in the popup also saves them as your
  defaults" was false: Start applies a config to one tab. It now says so.
- Syntax, manifest and least-privilege validation pass, and the package still contains
  only extension files. `manifest.json` and `package.json` are at 1.3.3.
- `extension/manifest.json` keeps `minimum_chrome_version` at 106 and the version at
  1.3.3; the divergent local 1.4.0 line was read as a source of fixes only, and its
  version and Chrome floor were deliberately not adopted.

Not verified in a real browser: the browser-driven save-race scenarios on the other
line depend on copy and markup this release does not adopt, so they were not ported and
no automated run covers the two pages racing each other end to end. The store's
behaviour under concurrency is covered by unit tests against a fake storage adapter
that injects read and write delays; the real `chrome.storage.local` round trip is not.
A manual pass on the custom condition (type a predicate, start, reopen the popup, see
the code rather than `undefined`) is the one check worth repeating by hand.

## Version 1.3.2 — custom JavaScript stop condition

Adds a new stop condition, `script-predicate`, for logic the built-in comparisons
cannot express: the user writes the body of a function, it runs in the page after
the settling delay on every cycle, and refreshing stops when it returns a truthy
value. Failures are deliberately non-fatal — a predicate that throws, times out,
is blocked by permissions, or reports anything other than a clean `true` continues
the run and surfaces the reason. That is the flaky-content case the feature exists
for, so a broken predicate can never end a session by accident.

- 96 unit tests pass (80 before this change, 16 new in `tests/predicate.test.mjs`).
- The new suite exercises four layers: the pure planner (`evaluateCondition`,
  `planCycle`), the config validator (required code, 20,000-character ceiling,
  trimming, and no effect on other conditions), the runner's
  `{ ran, value, reason }` vocabulary across every failure path, and the generated
  wrapper source itself, executed in Node exactly as written, to prove the boolean
  contract, the frozen `context`, and the capped error message.
- Non-stopping on failure is asserted directly: a `ran: false` predicate, a missing
  predicate, and an over-budget snapshot all produce `continue`, and `planCycle`
  returns `reload` rather than `matched` for a broken predicate with an elapsed
  interval.
- UI parity is asserted mechanically: both `popup.html`/`popup.js` and
  `options.html`/`options.js` must offer the option, look up the panel and code
  field, validate the field, and restore the saved code. The error node is named
  `err-predicate-script` because field errors are addressed as `err-${fieldId}`;
  that mismatch was caught and fixed during development.
- Syntax, manifest and asset validation pass, and the package still contains only
  extension files. `manifest.json` and `package.json` are at 1.3.2.

Not verified in a real browser: that `chrome.userScripts.execute()` returns the
wrapper's resolved value. The call shape, the isolated `USER_SCRIPT` world, and
reading `result.ok` from the first injection result are the same code path the
shipped page-scripts feature already uses, and `tests/predicate.test.mjs` pins that
shape, but a real-browser run of the custom condition is still outstanding. The
popup's new code box and access line have not been inspected in a browser either;
only their wiring is covered by tests.

## Version 1.3.1 — supported Chrome range

The manifest previously declared `minimum_chrome_version` 135, which excluded every
Chromium browser older than that even though only the optional custom-script feature
needs it. The floor is now 106, which is the real requirement for refreshing:

- `InjectionResult.documentId` is Chrome 106+. `record.documentId` is read from it in
  `captureDocument`, and `isCurrentDocument()` gates every refresh cycle on that value.
  Below 106 the extension installs but never refreshes, so 106 is a functional floor
  rather than a preference.
- `chrome.storage.session` and `storage.session.setAccessLevel` are Chrome 102+.
- `chrome.scripting.executeScript` is Chrome 88+ and `InjectionResult.frameId` is
  Chrome 90+; the extension targets `frameIds`, not `documentIds`.
- `chrome.userScripts.execute()` is Chrome 135+. It stays optional and off by default.
  `resolveUserScriptAccess` already requires `typeof api.execute === 'function'`, and
  `runScript` returns `unsupported` before calling `configureWorld`, so Chrome 120–134
  (where the `userScripts` namespace exists without `execute`) reports the limitation
  instead of throwing.

Only Helium 141 has been exercised in a real browser. Versions 106–140 are supported by
documented API requirements, not by browser runs; verify that range before relying on
it. `scripts/validate-manifest.mjs` now fails if the declared minimum drops below 106.

## Version 1.3.0 — independent tabs and notification setup

Validated with Node.js 25 and Helium 141 in fresh disposable profiles. Required and optional permissions are unchanged. No external webhook, payment, advertising injection or Store submission occurred.

- 74 unit tests passed, covering the engine, interaction message validation, ntfy JSON generation, existing host grants, private test payloads, denied redirects, browser-managed headers and duplicate test requests.
- 21 new real MV3 checks passed: trusted interaction pause and synthetic-event rejection; cancellation during slow before-refresh hooks and delayed pre-navigation persistence; webhook test outcomes, authorization, timeout/no retry, private logs and unchanged monitoring; ntfy setup and unfinished drafts; independent tab settings; explicit versus automatic profile automation; input edits and profile changes during a slow Start; closed-tab cleanup and 360/400px layout.
- Existing browser suites passed: 24 refresh checks, 15 profile/countdown checks, 11 popup-draft checks and 14 automation checks. A popup-draft run under concurrent browser load hit a click timeout; its isolated rerun passed. These checks do not prove behavior in every browser/site.

The production package contains only extension assets. Syntax, manifest/assets and diff checks pass. Google Chrome testing remains a separate pre-submission check. Personal Helium reload is still required to activate this build; tests used disposable profiles, without changing the user's browser settings.

Workers: two bailian-tpp DeepSeek V4.1 Flash runs delivered UI/ntfy and engine/webhook changes. The orchestrator stopped their extended runs after code delivery (exit 1), reviewed and integrated the changes. Native GPT-6 Luna supplied additional unit tests and read-only review. Native GPT-6.1 Sol independently reviewed security and found the manual-profile draft race and interaction-listener timing gap; both were repaired and covered by browser regressions. A bailian-tpp Qwen3.8 Max review attempt delivered no result and was stopped; it is not counted as completed review.

Every feature remains free; no ads were added.

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
