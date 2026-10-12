# Product and funding research

Reviewed October 12, 2026. This is a comparison of published first-party descriptions, not an installation audit or proof that competitors work reliably. Listings and pricing can change. The product name is **The Best Auto Refresh App**; an independently established “best” ranking is not claimed.

## Competitors

| Product | Published capabilities | What this means for us |
| --- | --- | --- |
| [Auto Refresh Plus](https://chromewebstore.google.com/detail/auto-refresh-plus-page-mo/hgeljhfekpckiiplhkigfehkdpldcggm) | Keyword/change monitoring, random intervals, area monitoring, profiles, webhooks, custom scripts, visual timers, interaction pause and scheduled refresh. | Webhooks and scripts are not exclusive. Compete on a clear, free workflow, open code, sensible defaults and explicit access. Do not claim every competitor charges for these features; this listing alone does not establish pricing tiers. |
| [Easy Auto Refresh](https://chromewebstore.google.com/detail/easy-auto-refresh/aabcgdmkeabbnleenpncegpcngjpnjkc) | Simple intervals, remembered page settings, scroll restoration and pausing while typing. Its listing places additional domain/page preferences, random intervals, scheduling and other advanced features behind registration. | Make interaction protection easy to discover. Keep our profiles and random intervals available without payment or registration. Registration language does not establish an exact current price. |
| [Tab Reloader by James Fray](https://addons.mozilla.org/en-US/firefox/addon/tab-reloader/) | Random periods, countdown badges, job lists, URL rules, scripts, refresh limits and policies. Open-source license and voluntary contribution link. | Free/open-source alternatives already exist. Evaluate its published Firefox edition as a reference, not evidence that every Chrome feature or permission is identical. Donation funding is an established alternative. The Chrome listing was inaccessible during this review. |

Our useful strengths are the combination of scoped page/site/global profiles, unfinished per-tab drafts, explicit Apply & restart, stop-on-found/lost/change conditions, countdown badges and optional event automation. Reliability and usability are stronger claims than the largest feature count. Existing limitations include no shadow-root/cross-origin-frame monitoring, no closed-tab monitoring and timers that can be delayed by browser sleep/throttling.

## Selected additions

- Optional pause on trusted clicking or typing, with manual Resume. Synthetic page scripts must not pause a monitor, and old documents must not affect a replacement session.
- Guided ntfy setup: server and topic produce a valid POST JSON configuration. Applying a preset never sends a request or asks for access.
- An explicit test-webhook button, separate from Connect. Connect only grants access; a test sends one request and reports its HTTP outcome. Scripts never run during a webhook test.
- A small voluntary [support link](https://ko-fi.com/mouniryuga) in the extension. Every feature remains free. No embedded payment SDK or tracking pixel.

Deferred candidates are optional native notifications, keyboard controls, schedules and a page timer. These merit focused design and testing rather than being added solely to match a list. Automatic clicks, CAPTCHA bypass, script marketplaces and broad automatic site access are not requirements of this release.

## Support payments in Morocco

[Buy Me a Coffee's official payout-country list](https://help.buymeacoffee.com/en/articles/6258038-supported-countries-for-payouts-on-buy-me-a-coffee) does not include Morocco. [Ko-fi supports connecting PayPal or Stripe](https://help.ko-fi.com/hc/en-us/articles/24482435253661-What-payment-methods-are-available-on-Ko-fi), and [PayPal lists Morocco as supporting sending, receiving and withdrawing](https://developer.paypal.com/payouts/supported-features/). Ko-fi plus an eligible Moroccan PayPal account is therefore a plausible route, not a guarantee of account approval or of any particular withdrawal method. The owner must complete verification and confirm receiving/withdrawal capabilities in their own account. The public support URL was supplied by the owner; this research browser could not inspect the Ko-fi profile.

[Ko-fi's fee page](https://help.ko-fi.com/hc/en-us/articles/360002506494-Does-Ko-fi-take-a-fee) describes its service tiers; payment-processing fees are separate. Confirm the account's actual selected tier before advertising a fee figure. Do not create an account in an unsupported country or misstate residency.

Suggested bio:

> I’m Mounir, an independent developer from Morocco building useful, free, open-source tools. I created The Best Auto Refresh App to make page monitoring simple and put powerful features within everyone’s reach. If it saves you time, your support helps me improve it and keep every feature free.

## Advertising decision

The user's advertising idea is exploratory. This release uses a voluntary support link and adds no ads. A future sponsor should be a small, clearly labeled placement inside the extension, removable through settings, with no behavioral targeting, remote executable code or effect on monitoring.

[Chrome's advertising policy](https://developer.chrome.com/docs/webstore/program-policies/policies#ads) prohibits AdSense in extensions, requires attribution/removability, and restricts ads alongside third-party websites: disclosure, source attribution, and no interference or impersonation. Affiliate links also require related user action and a tangible benefit tied to the extension's function. Store acceptance remains Google's decision.

Injecting an ad into the monitored page could change its text baseline, trigger false matches, interfere with page controls and damage trust. Do not place advertising in refreshed pages or monitoring notifications. Revisit disclosures, privacy and Store copy before introducing any future monetization behavior.

## ntfy implementation reference

[ntfy's JSON publishing documentation](https://docs.ntfy.sh/publish/#publish-as-json) requires POST to the server root and a `topic` field. [Topic names](https://docs.ntfy.sh/publish/#picking-a-topic) accept letters, digits, hyphens and underscores, up to 64 characters. Use a private, hard-to-guess topic or authenticated self-hosted service when appropriate. The setup helper does not include page URL/title unless the user later opts in.
