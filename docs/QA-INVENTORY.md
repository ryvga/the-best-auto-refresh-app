# Acceptance inventory

- Fixed and random interval validation; reject <5 seconds and reversed ranges.
- Page-change baseline, ignore selector and selected-element baseline.
- Keyword found/missing, case sensitivity and whole-word semantics.
- Element found/missing and invalid/missing selectors.
- Stop immediately when initially true, stop after later reload when true.
- Pause/resume/stop, maximum refresh count and duration.
- Same-origin reinjection across reload; cross-origin stop and restricted page errors.
- Worker suspension, tab closure cleanup, browser restart behavior.
- Element picker selection and Escape cancellation.
- Defaults, save/load/delete profiles, dashboard stop all.
- Actual popup 400px and narrow 360px; dashboard desktop and 390px.
- Keyboard focus, labels, touch targets, reduced motion, overflow and contrast.
- No broad hosts, telemetry, remote scripts or unsafe HTML.

Evidence: engine unit tests plus a controlled browser fixture with changing #stock and #noise, screenshots and browser console errors. Automated browser checks run the actual MV3 extension in a disposable Helium profile. Personal-profile installation is a separate manual Load unpacked step and is not yet verified.
