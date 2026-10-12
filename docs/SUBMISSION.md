# Chrome Web Store submission guide

This is the operational checklist for publishing The Best Auto Refresh App to
the Chrome Web Store. It splits the work into what this repository automates and
what only the account owner can do in a browser.

Current release: **1.3.2**. Store review and acceptance are decided by Google;
nothing here guarantees approval.

## What is automated vs. manual

| Step | Owner | Status |
| --- | --- | --- |
| Test suite and manifest validation | repository | automated (`npm test`, `node scripts/validate-manifest.mjs`) |
| Store-ready ZIP | repository | automated (`scripts/package.ps1`) |
| Upload and publish after the item exists | `scripts/publish-cws.mjs` | automated |
| Developer registration and fee | account owner | **manual, one time** |
| Creating the item (first submission) | account owner | **manual, one time** |
| Screenshots and listing artwork | account owner | **manual** |
| Privacy disclosures, distribution, review notes | account owner | **manual** |

**The API cannot create a new item.** `publish-cws.mjs` can only update an item
that already exists in the developer dashboard. The very first upload must be
done by hand.

## Step 1 — Register a developer account (one time)

1. Sign in to <https://chrome.google.com/webstore/devconsole> with the Google
   account that will own the extension.
2. Accept the developer agreement and pay the one-time registration fee
   (currently US$5; confirm the current amount at registration).
3. Complete the account details, including a verified contact email.

Registration is not instant; verification can take a day.

## Step 2 — Build the upload package

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

This writes `dist/the-best-auto-refresh-app-<version>.zip` and refuses to finish
unless `manifest.json` sits at the archive root and every entry uses `/`
separators. `dist/` is git-ignored, so the artifact is never committed.

Verify the package without contacting Google:

```bash
node scripts/publish-cws.mjs upload --dry-run
```

## Step 3 — Create the item (first submission only)

1. In the developer dashboard choose **Add new item**.
2. Upload `dist/the-best-auto-refresh-app-1.3.2.zip`.
3. Note the **extension ID** and the **publisher ID** shown in the dashboard.
   Both are needed later for automation.

The item now exists as a draft. Nothing is public until you submit it for review.

## Step 4 — Complete the listing

Listing copy is drafted in [STORE.md](STORE.md). Reuse it verbatim so the store
text matches the extension's behaviour.

Required assets:

- **Store icon** — 128×128 PNG. Present at `extension/icons/icon128.png`.
- **Screenshots** — 1280×800 or 640×400, up to five. Four are produced by
  `node scripts/capture-store-assets.mjs` (popup running, stop conditions,
  automation, dashboard) and written to the `store-assets` folder. They capture
  the real UI. Do not mock up or embellish the UI.
- **Privacy policy URL** — a stable public URL. See [Step 6](#step-6--publish-the-privacy-policy).
- **Support URL** — the repository issue tracker works:
  <https://github.com/ryvga/the-best-auto-refresh-app/issues>

Category suggestion: *Productivity*. Language: English.

## Step 5 — Privacy and permissions disclosures

Answer the dashboard privacy questions consistently with
[PRIVACY.md](PRIVACY.md) and [STORE.md](STORE.md). The justifications below are
already written to match the manifest.

**Single purpose.** User-controlled page refreshing with local content
conditions that decide when refreshing stops.

**Permission justifications**

- `activeTab` — user-triggered access to the selected page for refresh and
  monitoring; avoids broad site access.
- `scripting` — injects bundled monitoring and picker code into the selected page.
- `storage` — persists preferences and temporary per-tab monitoring state.
- `alarms` — wakes the service worker for scheduling and watchdog checks.
- `userScripts` (optional) — runs user-authored code for selected monitoring
  events and for the optional custom JavaScript stop condition, in the isolated
  `USER_SCRIPT` world, only after the user enables the feature and Chrome's Allow
  User Scripts setting.
- Optional host permissions — connect user-configured HTTPS webhook endpoints or
  script websites, plus loopback HTTP for local development. Requested per host
  from an explicit user gesture, never all at once.

**Remote code use.** Answer **No**. All executable code is bundled in the uploaded
package, nothing is fetched at runtime, and no bundled file uses `eval` or
`new Function`; a test enforces this. The only user-authored code is text the user
types into the extension's own settings — optional page scripts and the optional
custom stop condition — stored locally, never downloaded, and executed only
through `chrome.userScripts.execute` in the isolated `USER_SCRIPT` world. The
full wording is in [STORE.md](STORE.md#remote-code-use).

**Data usage.** No developer collection, no analytics, no ads, no accounts. The
extension transmits data only to endpoints the user configures. Disclose that
user-directed webhook payloads can include page address, title, keyword,
selector and stop reason when *Include page details* is enabled, and that custom
script execution is user-authored. Confirm you are not selling data or using it
for purposes unrelated to the single purpose.

## Step 6 — Publish the privacy policy

The policy must be reachable at a public URL without signing in. This repository
publishes `docs/` through GitHub Pages, which gives:

```
https://ryvga.github.io/the-best-auto-refresh-app/PRIVACY.html
```

Use that URL in the dashboard privacy-policy field. If Pages is disabled, enable
it under **Settings → Pages** with source *Deploy from a branch*, branch `main`,
folder `/docs`. Confirm the URL loads before submitting; a dead policy link is a
common review rejection.

## Step 7 — Distribution and review notes

- **Visibility** — Public, or Unlisted while you finish testing.
- **Pricing** — Free. All features are free; the voluntary Ko-fi link unlocks nothing.
- **Regions** — all regions unless you have a reason to restrict.
- **Test instructions** — reviewers cannot guess the optional features. Supply
  notes covering: how normal refreshing works; that webhooks need a test endpoint
  and a per-host grant; that custom JavaScript additionally needs the optional
  `userScripts` permission *and* Chrome's Allow User Scripts setting (Chrome
  138+); and how to revoke those grants from the dashboard. Mention that
  `minimum_chrome_version` is 106 for refreshing and monitoring; custom scripts
  require Chrome 135 or newer.

Then choose **Submit for review**.

## Step 8 — Automate future releases

Once the item exists, uploads and publishes can be fully automated.

### 8a. Create API credentials (one time)

1. In the Google Cloud console create (or reuse) a project.
2. Enable the **Chrome Web Store API**.
3. Configure the OAuth consent screen. Add the publishing Google account as a
   test user if the app is in testing mode.
4. Create an OAuth client ID of type **Desktop app**.
5. Obtain a refresh token:

   ```bash
   node scripts/cws-auth.mjs --client-id <id> --client-secret <secret>
   ```

   Open the printed URL, approve access, and copy the refresh token it returns.

### 8b. Provide the configuration

| Variable | Where to find it |
| --- | --- |
| `CWS_CLIENT_ID` | Google Cloud console → OAuth client |
| `CWS_CLIENT_SECRET` | Google Cloud console → OAuth client |
| `CWS_REFRESH_TOKEN` | output of `scripts/cws-auth.mjs` |
| `CWS_PUBLISHER_ID` | developer dashboard |
| `CWS_EXTENSION_ID` | developer dashboard item URL |

Treat the client secret and refresh token as credentials. They grant publish
rights to your extensions. Never commit them; keep them in your shell
environment or GitHub Actions secrets.

### 8c. Release

```bash
npm test
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
node scripts/publish-cws.mjs release            # upload + submit for review
node scripts/publish-cws.mjs release --staged   # upload + stage without publishing
node scripts/publish-cws.mjs status             # check review state
```

`release` uploads the ZIP and then submits it, exiting non-zero on rejection or
upload failure. `--dry-run` validates the package and configuration locally
without contacting Google.

The optional workflow at `.github/workflows/publish-cws.yml` runs the same script
on a tag or on demand. Add the five values above as repository secrets first.

### 8d. Version bumps

Update `version` in `extension/manifest.json`, keep `package.json` in step, and
re-run the commands in 8c. The store only accepts a version higher than the
currently published one.

## Blockers before this can be submitted

1. **No developer account yet** — Step 1 must be completed first.
2. **No screenshots** — at least one 1280×800 or 640×400 image of the real UI.
3. **Privacy policy URL must be live** — confirm
   <https://ryvga.github.io/the-best-auto-refresh-app/PRIVACY.html> returns the
   policy before submitting.

## Official references

- Policies — <https://developer.chrome.com/docs/webstore/program-policies/policies>
- Publish — <https://developer.chrome.com/docs/webstore/publish>
- Register — <https://developer.chrome.com/docs/webstore/register>
- Privacy fields — <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- Programmatic publishing — <https://developer.chrome.com/docs/webstore/using-api>
- API v2 reference — <https://developer.chrome.com/docs/webstore/api/reference/rest>
