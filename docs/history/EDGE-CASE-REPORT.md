# Marketr Edge-Case & Error-Handling Report

**Date:** 2026-09-21 · **Scope:** full platform (`lib/`, `app/api/`) · **Constraint:** no live DB, no network — everything against mocks/pure functions
**Rule honored:** read-only on source; no fixes applied; nothing committed.

## Day-1 remediation status (2026-09-22)

All 16 🔴/🟠 items (the day-1 must-fix list: items 1–16) were remediated and re-verified. Baseline was commit `af93d50`; remediation landed in `fix(day1): security hardening + critical edge-case fixes`.

| # | Issue | Fix |
|---|---|---|
| 1 🔴 | Autopilot kill-switch DB write missed active rows | Kill-switch scope repaired; fixture re-verified |
| 2 🔴 | Domain double-charge (confirm vs reprice race) | Atomic claim; `edge-studio-connectors.mts` asserts exactly one provider charge under sequential + concurrent confirms |
| 3 🟠 | NaN spend caps | Gates reject NaN/negative (`checkLocalBudget`, `checkPullBudget`); estimators clamped finite; tests updated |
| 4 🟠 | Webhook fail-open | Extracted `lib/newsletter/webhook-auth.ts`; 401 without secret and without opt-in; messaging webhook 3/3 |
| 5 🟠 | `javascript:` URLs in newsletter HTML | Sanitizer; newsletter 80/80 |
| 6 🟠 | Social partial dispatch | Atomic claim; tested |
| 7 🟠 | Social claim race | Atomic dispatch claim; tested |
| 8 🟠 | Newsletter double-send | Atomic claims; 80/80 |
| 9 🟠 | Newsletter batch crash loses progress | Resumable chunking; 55-recipient fixture |
| 10 🟠 | Stuck broadcast never recovers | 15-min stale-claim reclamation |
| 11 🟠 | Ads double-submit | Atomic submission claim; tested |
| 12 🟠 | Ads job ID lost on crash | Provider-job-ID recovery framework |
| 13 🟠 | Domain post-charge audit ordering | stderr-first audit log survives DB outage; DB writes individually best-effort |
| 14 🟠 | Cloudflare manifest drops duplicate-content files | Manifest corrected to path→hash (both paths present, blob deduped) |
| 15 🟠 | WordPress >2MB silent truncation | Fail-closed: throws with size guidance; oversize content never posted |
| 16 🟠 | Webflow collection ID ignored in push classification | `classifyPush` now compares target collection; cross-collection re-push blocked |

**Final fixture counts (2026-09-22, two identical deterministic runs):**

| Suite | Checks | Passed | Failed | Remaining failures |
|---|---|---|---|---|
| edge-platform-core | 360 | 354 | 6 | All 🟡/⚪ (alerts escaping, malformed JSON typing, NaN cost edges) |
| edge-messaging | 324 | 314 | 10 | All 🟡/⚪ (invalid-date/email handling, Higgsfield mock scripting) |
| edge-studio-connectors | 311 | 303 | 8 | All 🟡 (GitHub/WordPress/Webflow JSON typing, Cloudflare status normalization) |
| edge-seo-growth | 405 | 397 | 8 | All 🟡/⚪ (kill-switch edge accounting, URL normalization) |
| **Total** | **1400** | **1368** | **32** | No 🔴/🟠 remain |

Items 17+ (🟡/⚪) are documented residuals — deferred post-beta, not beta-blockers.

---

## Summary

| Suite | File | Checks | Passed | Failed (bug demos) | 3× deterministic |
|---|---|---|---|---|---|
| A — messaging (newsletter/social/ads) | `scripts/edge-messaging.mts` | 304 | 287 | 17 | ✅ |
| B — studio + connectors + deploy | `scripts/edge-studio-connectors.mts` | 291 | 279 | 12 | ✅ |
| C — SEO growth (programmatic/autopilot/backlinks/retention/local) | `scripts/edge-seo-growth.mts` | 400 | 388 | 12 | ✅ |
| D — platform core (alerts/authz/sitefiles/secrets/usage/llm) | `scripts/edge-platform-core.mts` | 329 | 319 | 10 | ✅ |
| E — static error-handling audit | (manual, no harness) | — | — | 20 findings | — |
| **Total** | | **1324** | **1273** | **44 bug demos + 20 static** | ✅ |

**Distinct issues filed: 65** (45 dynamic bugs + 20 static findings).
Coordinator re-ran all four fixture suites a 4th time after receiving the reports — counts matched exactly (A 287/17, B 279/12, C 388/12, D 319/10).
Severity key: 🔴 critical (safety control dead / money / data loss) · 🟠 high (wrong behavior with real consequences) · 🟡 medium · ⚪ low/cosmetic.

## Must-fix before day 1 (🔴 critical / 🟠 high)

| # | Location | Issue | Repro |
|---|---|---|---|
| 1 🔴 | `lib/seo/autopilot-service.ts:189` | Kill-switch lookup never matches its rows — Prisma ANDs `workspaceId` + `OR:[{projectId}]` while kill rows set exactly one ID (other is `null`). UI reports "engaged" via the correct `scopeKey` path while runs keep generating. | Seed `{workspaceId:null, projectId:"p1", scopeKey:"project:p1", killed:true}`; `isAutopilotKilled(db,"w1","p1")` → `false` |
| 2 🔴 | `lib/studio/service.ts:734` | Double charge on domain purchase — `confirmDomainPurchase` re-checks availability/price but never checks local registered status before `port.createDomain`. Two single-use tokens (two previews) → `createDomain` 2×, one local row. | Two previews + confirm each → charge ×2 |
| 3 🟠 | `lib/seo/backlinks-cost.ts:65` / `lib/seo/local-cost.ts:80` | `NaN` bypasses spend/row caps — `NaN > cap` is false, so the gate opens. Reachable via API: `POST /api/backlinks/pull` with `{"limit":"abc"}` → `Math.floor("abc")` → `NaN` → paid DataForSEO call proceeds ungated. Feeders: `estimateListPullCost(NaN)`→`NaN` (`:41`), `estimateGridRunCost(NaN)`→`NaN` (`local-cost.ts:49`). | `checkPullBudget(NaN, 0, 25)` → `{ok:true}` |
| 4 🟠 | `app/api/newsletter/webhooks/resend/route.ts:36-42` | Fail-open webhook — when `RESEND_WEBHOOK_SECRET` is unset, unsigned payloads are accepted (warn only) and fed to `handleResendWebhook`, which mutates subscriber status. Spoofed `email.bounced`/`email.complained` could mass-unsubscribe. All cron routes fail closed; this is the outlier. | POST unsigned webhook JSON, no secret set → accepted |
| 5 🟠 | `lib/newsletter/render.tsx:61,221` | `javascript:` URLs rendered raw into email HTML — text-link `href` and button `href` get no scheme sanitization. Output contains `<a href="javascript:…">` verbatim. | Doc with link mark `href:"javascript:alert(1)"` → rendered output contains it |
| 6 🟠 | `lib/social/service.ts:404-412` | `dispatchPost` throws on a channel failure *before* persisting `bufferUpdateIds` — partial progress lost, retry re-creates channel 1's update → **duplicate public posts**. | 2 channels, provider fails on 2nd `createUpdate` → retry → `created=3` |
| 7 🟠 | `lib/social/service.ts:597` | `runDueSocialPosts` has no claim/lock — two concurrent sweeps both dispatch. | `Promise.all([runDueSocialPosts,…])` → `created=2` |
| 8 🟠 | `lib/newsletter/service.ts:552-574` | `sendBroadcast` check-then-act race — status checked at `:552-553`, set to `"sending"` at `:574` with awaits between. Two overlapping cron ticks double-send. | `Promise.all([sendBroadcast,…])` → `batchSends=2` |
| 9 🟠 | `lib/newsletter/service.ts:594` | Batch partial failure → duplicate resend: `sendBatch` chunks of 100; if chunk 3 of 5 throws, 200 already delivered; retry resends to *all* recipients. | Resend 5xx mid-batch on large list |
| 10 🟠 | `lib/newsletter/service.ts:551-556` | Broadcast stuck forever: if the process dies while status is `"sending"`, `runDueBroadcasts` only selects `"scheduled"` and `sendBroadcast` throws on `"sending"` — needs manual DB repair. | Container restart mid-send |
| 11 🟠 | `lib/ads/service.ts:556` | Concurrent `runDueAdJobs` sweeps double-submit — both read no `providerJobId`, both call the provider, loser's `requestId` overwrites the winner's → orphaned job burning credits, never polled. | Two concurrent sweeps → `submitted=2` |
| 12 🟠 | `lib/ads/service.ts:405-417` | `port.submitJob()` succeeds (money committed), then `db.adCreative.update` throws → job ID lost, creative stuck `"queued"`, spend never recorded. | Transient DB error right after Higgsfield submit |
| 13 🟠 | `lib/studio/service.ts:778/791` | Charged but no failure audit: catch block's `db.studioDomain.upsert` (`:778`) runs *before* the `studio_domain_purchase_failed` audit (`:791`). Upsert throw → money moved, no audit trail, raw error propagates. | DB outage after `createDomain` succeeded |
| 14 🟠 | `lib/deploy/cloudflare.ts:116` | Deploy manifest drops files with duplicate content — `manifest[hash] = clean` keyed by hash; one filename lost, never uploaded. | Deploy `[{/a.txt,"same"},{/b.txt,"same"}]` → manifest has 1 entry |
| 15 🟠 | `lib/connectors/wordpress.ts:136` | `saveContent` silently truncates >2MB content (`content.slice(0, MAX_READ)`) — no warning or error. | 2.5M-char content → 2.0M chars posted |
| 16 🟠 | `lib/seo/programmatic-publish.ts:140-144` | Webflow collection ID ignored in push classification — `sameTarget` compares kind+site+external ID but not `webflowCollectionId`; re-push to col-B updates the wrong collection's item. | Publish to col-A, re-push targeting col-B → classified `update`, no block |
| 17 🟡 | `lib/seo/autopilot-service.ts:430-435` | Mid-run kill race — kill re-checked before `await generate(c)` but not between generation and `db.autopilotItem.create`; item created `pending` after the freeze already ran. (Latent until #1 is fixed.) | `killAutopilot()` during `draftGenerator` await → item still created |
| 18 🟡 | `lib/seo/autopilot-service.ts:414,435` | No atomic guard on overlapping sweeps — in-flight read and item create are separate calls; stale read re-generates same `(ruleId, kind, sourceRef)` → spurious P2002 in production. | Second sweep with stale in-flight read |
| 19 🟡 | `lib/seo/autopilot-service.ts:468` | `/killed/i` matches "unskilled" — generator throwing `"generator unskilled at this task"` marks the run `killed` instead of `failed`, skipping the failure alert. | Throw with "unskilled" in message |
| 20 🟡 | `lib/connectors/github.ts:178,211` | `listRepos`/`createRepo` crash on missing fields (`r.owner.login` → raw TypeError). | `/user/repos` → `[{name:"mystery"}]` (no `owner`) |
| 21 🟡 | `lib/connectors/github.ts:88`, `wordpress.ts:89`, `webflow.ts:96` | Malformed JSON → raw `SyntaxError` out of `listRepos`/`listDir`/`readFile`/`pushFiles` (and WP/WF equivalents). Vercel/Cloudflare handle this correctly — inconsistent. | 200 with non-JSON body |
| 22 🟡 | `lib/deploy/types.ts:74-77` | Cloudflare finished deploys report "queued" forever — terminal statuses `"success"`/`"failure"` aren't mapped by `normalizeStatus`. | Successful deploy → status stays "queued" |
| 23 🟡 | `lib/deploy/cloudflare.ts:93` | `ensureProject` masks probe errors — any GET error (e.g. 500) is treated as "not found" and triggers a POST create; original error masked, possible duplicate-create side effects. Only create on 404. | GET project → 500 → POST create attempted |
| 24 🟡 | `lib/connectors/github.ts:265-295` | `pushFiles`: commit created (step 4), ref PATCH fails (step 5) → commit dangles, branch never moves, retry creates duplicate commit. | Network drop between commit and ref calls |
| 25 🟡 | `lib/seo/programmatic-publish.ts:519-540` | `pushToConnector()` succeeds, then `prisma.programmaticPage.update({status:"published"})` runs *outside* the try/catch → page live on WordPress/Webflow but marked unpublished locally → next run pushes again → duplicates. | Transient DB hiccup right after push |
| 26 🟡 | `lib/newsletter/service.ts:288-300` | Import drift: `db.subscriber.create` succeeds then `port.createContact` throws → DB has subscriber, Resend segment doesn't (silent drift); conversely `createSegment` can succeed while the later DB update fails → orphaned Resend segment. | Resend API hiccup mid-import |
| 27 🟡 | `lib/audit/runner.ts:136-205` | Issues marked `"fixing"` before work; rollback snapshot saved only *after* the file loop — crash mid-run leaves files half-written, issue stuck in `"fixing"`, no snapshot to revert. | OOM/kill during scheduled multi-file fix |
| 28 🟡 | `lib/audit/runner.ts:274-295` | `revertFixRun` restores files in a loop with no atomicity; a `writeFile` throw mid-revert leaves the site half-restored with no progress record. | SFTP/GitHub failure during revert |
| 29 🟡 | `lib/alerts/adapters.ts:88,153` | Unescaped URL in Telegram `href` and in `renderAlertEmail` HTML — label is escaped, URL is not; a quote breaks out of the attribute (alert links derive from dashboard deep-link fields). | URL `https://x.test/"onmouseover="alert(1)` |
| 30 🟡 | `lib/alerts/dispatch.ts:188-191` | Malformed quiet-hours times degrade to 00:00 — `toMin` maps `NaN→0` via `(h||0)`; a typo (`"9pm"`) silently reshapes delivery windows instead of failing closed. | `inQuietHours({start:"abc",end:"09:00"}, 00:30)` → `true` |
| 31 🟡 | `lib/sitefiles/crypto.ts:57` | `decryptSecret(encryptSecret(""))` throws `Unrecognized credential format` — empty ciphertext segment rejected by the `!ctB64` guard. Round-trip contract broken for `x=""` (empty password/token). | `encrypt("")` then `decrypt()` |
| 32 🟡 | `lib/local/service.ts:228-245` | `runLocalGrid` swallows per-cell provider errors as `position:null` ("absent"); coverage/avg computed from partial data, and `actualCostUsd` set to the *estimated* full cost even when calls failed — misattributed spend. | Partial DataForSEO outage |
| 33 🟡 | `lib/local/grid.ts:101` | Substring false positive in client matching — `hay.includes("als")` matches `"False Positive LLC"`. Reproducer: `matchClientPosition([{businessName:"False Positive LLC"}], "Al's")` → `1` instead of `null` → wrong position attribution in grid reports. | — |
| 34 🟡 | `lib/ads/brief.ts:152` | `validateBrief` crashes on non-string/null input (`brief.product?.trim` → TypeError; `validateBrief(null)` → TypeError). Malformed API body 500s. | `{product: 123}` or `null` |
| 35 🟡 | `lib/ads/service.ts:320` | `generateCreatives` with `variants: NaN` → zero creatives created, no error; spend-cap check runs against a NaN estimate. | `variants: NaN` |
| 36 🟡 | `lib/social/service.ts:313` | `createPost` does `new Date(args.scheduledFor)` with no validity check → `Invalid Date` persisted (real Prisma would throw at write). | `scheduledFor: "not-a-date"` |

## Lower priority (⚪/minor)

| # | Location | Issue |
|---|---|---|
| 37 ⚪ | `lib/connectors/source.ts:37-43`, `lib/deploy/index.ts:25-31` | `decryptSiteConfig`/`decryptHostingConfig` swallow decrypt/JSON errors → return `{}`; connector proceeds with empty config and fails later with misleading errors. Trigger: `MARKETR_CREDENTIALS_KEY` rotated or corrupted `configEnc`. |
| 38 ⚪ | `lib/seo/programmatic-publish.ts:575` | `regenerateSitemap(...).catch(()=>{})` — sitemap failure silently dropped; published pages missing from `sitemap.xml` with no signal. |
| 39 ⚪ | `lib/seo/programmatic-publish.ts:571,622` | `.catch(()=>{})` on `auditProgrammatic` — push can be marked "published" with no audit trail. |
| 40 ⚪ | `lib/seo/autopilot-service.ts:423,465` | `skippedInFlight` counts cap-trimmed candidates as "already in flight" — wrong number in API result and audit log (3 candidates, cap 2 → `skippedInFlight: 1`). |
| 41 ⚪ | `lib/newsletter/service.ts:205-208` | Segment-creation failure swallowed (`resendAudienceId=null`); sends still work but the Resend audience silently never syncs. |
| 42 ⚪ | `lib/audit/fixer.ts:60-68` | `llmOr` catches *all* LLM errors and returns a fallback — masks expired key/quota with silently degraded fix content (deliberate pattern; awareness). |
| 43 ⚪ | `lib/newsletter/resend.ts:141,157,167,176` | Unsafe casts on live Resend responses (`(res.data?.data ?? []) as {id:string}[]`); a shape change marks broadcasts "sent" with bogus `messageIds`. Code admits shape is untested. |
| 44 ⚪ | `lib/connectors/github.ts:232,244,256,266` | `ghJson<{…}>` casts on Git Data API responses, header admits "untested against the live API" — shape mismatch → confusing TypeError mid-deploy. |
| 45 ⚪ | `app/api/studio/assets/_handlers.ts:28` | `JSON.parse(r.metadata)` unguarded — one corrupt row 500s the entire asset list. |
| 46 ⚪ | `lib/audit/runner.ts:67` | `JSON.parse(await fs.readFile(path)) as {files:…}` — corrupt snapshot makes `revertFixRun` throw exactly when the safety net is needed. |
| 47 ⚪ | `lib/newsletter/blocks.ts:274` | `EMAIL_RE` accepts `a@b..co` — malformed addresses pass validation, bounce at send. |
| 48 ⚪ | `lib/ads/brief.ts:85,134` | Negative variant index → `"Creative angle: undefined"` (`-1 % 5 === -1`); `fanOutVariants(NaN)` → `[]` despite documented minimum-1. |
| 49 ⚪ | `lib/ads/service.ts:497` | `pollCreative` falls back to `costEstimateCents` and books it via `recordSpend` when provider reports no cost — `costActualCents` holds an estimate (design judgment call; the field is named "actual"). |
| 50 ⚪ | `lib/ads/service.ts:556` | Creative in `generating` without `providerJobId` → sweep counts it `pending` forever — never resubmitted, never failed, never alerted (not reachable via current paths; no healing path). |
| 51 ⚪ | `lib/social/channels.ts:253` | `nextRetryAt(0)` → `RETRY_BACKOFF_MS[-1]` → `undefined` → `Invalid Date` (latent; current caller passes ≥1). |
| 52 ⚪ | `lib/retention/radar.ts:57,85` | Trailing-slash-only URL change fires spurious `new_page` — URL identity is raw string compare, no normalization. |
| 53 ⚪ | `lib/local/sentiment.ts:87` | Docstring/code mismatch: docstring says stopwords *and* sentiment words filtered; only STOPWORDS is — `great`/`terrible` appear as themes. |
| 54 ⚪ | `lib/llm/openai.ts:36` | `OpenAiCompatibleLlmProvider.generate` sets **no request timeout** (Slack/Telegram adapters use 15s `AbortSignal.timeout`) — hangs indefinitely on an unresponsive endpoint. |
| 55 ⚪ | `lib/usage.ts:18` | `recordUsage` accepts negative quantities (decrements the meter); float increments accumulate binary error (`0.1+0.2`). |
| 56 ⚪ | `lib/studio/service.ts:722` (obs) | Pre-charge `checkDomain` failure inside `confirmDomainPurchase` propagates with **no** `studio_domain_purchase_failed` audit, contradicting the documented invariant at `:644` ("every purchase attempt (confirm) is audited"). |
| 57 ⚪ | `lib/alerts/evaluate.ts:67,74,79`, `dispatch.ts:112` (obs) | Project-scoped rule fires on project-less events; severity filter bypassed when event has no severity; `cooldownSec: 0` skips dedup entirely; partial channel failure still reports event `"sent"`; `sentAt` set on failed delivery; no max-retry policy (cron retries forever). |

## Explicitly verified safe ✅

- All 15 cron routes fail closed when `CRON_SECRET` is unset (session-auth fallback; no unauthenticated path).
- Secrets encryption: missing `MARKETR_CREDENTIALS_KEY` throws — fail closed.
- RBAC: 30 authz checks pass (viewer/editor/admin scoping, cross-project isolation).
- Path traversal: `../`, `..\`, absolute, deep paths rejected pre-network in GitHub push, zip extract, SFTP — zero fetch calls on traversal attempts.
- Zip caps: 2000-file / 50MB / 10MB-per-file enforced; binary skip; invalid/empty zip handled.
- CSV import: BOM, quoted commas/newlines, mismatched columns, 10k vs 10,001 rows, duplicate/invalid emails handled.
- OAuth: single-use states, replay rejected, 10-min TTL, cross-user binding, refresh 5-min pre-expiry margin.
- Purchase tokens: single-use (concurrent same-token → exactly one wins), 5-min TTL, cross-project rejected, price-change aborts with audit and no charge.
- Unsubscribe: per-recipient tokens, RFC 8058 one-click headers verified.
- Guardrails fail closed: no API key, no brand kit, unverified domain all block with clear errors.
- Determinism: all four suites byte-identical across 3 runs.

## Untested (out of sandbox reach)

- Live provider HTTP paths (Resend, Buffer, Higgsfield, Canva, Porkbun, DataForSEO, GitHub, WordPress, Webflow, Vercel, Cloudflare) — mock ports only.
- Real Postgres behavior (row locks, transactions, `@@unique` enforcement) — several concurrency bugs above are inferred from code + fakes.
- `requireUser()` in `lib/session.ts` — needs a live NextAuth session.
- `defaultDraftGenerator` (LLM), SMTP success path (sandbox blocks SMTP), nodemailer stubbing.

---
*Bugs reported, not fixed, per Tico's instruction. No source files modified; no commits.*
