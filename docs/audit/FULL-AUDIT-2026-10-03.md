# ShapesOS — full audit: unit, edge-case, pen test, product gaps

**Date:** 2026-10-03 · **Commit:** `2f4ead9` · **Scope:** whole repo (925 route files / 1,280 handlers, ~400 Prisma models, 175 pages)
**Method:** unit + DB test runs; CI gates on a clean clone; live pen test against a production build (2 tenants, 4 roles, migration-built Postgres, app connected as a non-superuser); five parallel white-box reviews (authz/IDOR, injection/SSRF/XSS, secrets + agent prompt-injection, edge cases, product/workflow). Every High below was re-checked by reading the code; edge-case items were proven with `tsx` probes. API keys were ignored as instructed.

---

## 1. Verdict

The foundations are good: auth coverage is near-total, tenant isolation held under a live 1,280-handler cross-tenant sweep, webhooks fail closed, credential crypto is sound, and 2,622 unit tests pass. What's wrong falls into five buckets:

1. **The repo can't ship from a clean clone.** Install, migrate, typecheck and build each fail. CI is red at step 1.
2. **A handful of real cross-tenant / takeover bugs** in newer code: stored XSS on a public share page, cross-tenant ad-spend approval, cross-tenant Activepieces flows, forgeable inbound SMS, MCP tools that skip confirmation.
3. **Money and state-machine integrity:** replayable ops approvals, credit-pool holes, double-sent SMS, voided contracts that come back as signed.
4. **Deploy defaults:** the documented docker-compose runs Postgres as a superuser (silently disabling all 75 RLS policies) and ships known default secrets.
5. **Product cohesion:** ~95 UI files currently render unstyled, many features are unreachable from navigation, and there's no onboarding, unified approval inbox or notifications.

| Area | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security (pen test + review) | 0 | 11 | 13 | ~20 |
| Edge cases / correctness | 0 | 6 | 19 | 9 |
| Build / CI blockers | 5 blockers | | | |

---

## 2. Fix first (ranked)

| # | Fix | Why | Effort |
|---|---|---|---|
| 1 | Clean-clone blockers (§3) | Nothing else can be verified or deployed until CI is green | S |
| 2 | Sanitize design SVG `body`; render share previews as `<img>` or on a sandbox origin; add CSP | Stored XSS on the app origin → session-riding account takeover of anyone who opens a share link | S–M |
| 3 | Scope spend-proposal approve/reject by workspace | Any editor can approve/reject another tenant's ad spend (no RLS on those tables) | S |
| 4 | Non-superuser app DB role in compose + add `workspaceId` to every RLS-only query | One config line currently disables all tenant RLS; ~10 stores rely on RLS alone | M |
| 5 | Fail closed on unset secrets; refuse fake providers in production | Forge inbound SMS (re-opt-in STOPped leads = TCPA), forge GBP reviews, unsubscribe tokens, approval receipts | S |
| 6 | MCP connector tools default to `mutating:true` | Prompt injection in an attached doc or connector result can run write tools with no confirmation | S |
| 7 | Bind Activepieces flows/runs to the workspace | Cross-tenant trigger and run-detail read | M |
| 8 | Ops approval `consume()` step | One approval → unlimited payments/refunds | S |
| 9 | Messaging claim-before-send; meter before send | Double SMS/email to leads; credit cap doesn't stop sends | S |
| 10 | Credits: update pool/cap on plan change; lower cap when top-ups expire | Upgrades don't apply; ~4,500 free credits/month after any top-up | S |
| 11 | Login: trust only the proxy hop for IP; bounded lockout | Spoofed X-Forwarded-For bypasses IP limit; anyone can permanently lock the admin out | S |
| 12 | Member role rules: can't grant above own role; only owners touch owners | Admin → owner takeover | S |
| 13 | SSRF: route dataset web ingest, fleet sitemap, clipper, skill import through `safeFetch`; fix the IPv6 bypass in `safe-url.ts` | Full-read SSRF (cloud metadata creds land in a readable dataset) | M |
| 14 | E-sign terminal-state guard | Voided SOW webhook → "completed" → invoice draft fires | S |
| 15 | Scheduler: per-schedule try/catch + 8-year search window | A leap-day cron halts every workspace's schedules in 2028 | S |
| 16 | CSS compat block mapping stone/zinc/violet/etc. to tokens | ~95 files (16% of UI) render with no colors today | S |

---

## 3. Clean-clone and CI blockers (all confirmed)

1. **`npm ci` fails** with ERESOLVE: `nodemailer@^10` vs `next-auth@5.0.0-beta.32` (peerOptional `^7 || ^8`). Fix: pin nodemailer `^8`, or add `.npmrc` with `legacy-peer-deps=true`.
2. **Migrations fail on a fresh DB.**
   - `20261002012700_connector_slice5` sorts before `…013000_connector_slice4` but needs its enum.
   - `cad_slice4` (`032000`) sorts before `cad_slice2`/`cad_slice3`.
   - With those two renamed, all 135 apply cleanly.
3. **Schema drift.**
   - `schema.prisma` declares the `WfhMode` / `WfhStandupCadence` / `WfhNotificationProfile` enums and a `mission_plane_links` table, but no migration creates them.
   - The wfh mode columns are `TEXT` in SQL, so Prisma enum casts will fail on migration-built (i.e. production) databases.
   - Fix: generate a corrective migration and add `prisma migrate diff --exit-code` to CI.
4. **`tsc --noEmit` won't pass in CI.**
   - It runs out of memory even at 4 GB; 8 GB is needed. AGENTS.md says 4 GB, and CI passes no flag at all.
   - At 8 GB it fails once: `app/layout.tsx:31 LayoutProps`, a Next-generated type that only exists after `next build` or `next typegen`.
   - Fix: run `next typegen` before `tsc` and set `NODE_OPTIONS=--max-old-space-size=8192`.
5. **`next build` fails whenever `ssh2`'s optional native binding compiles** (Turbopack: "non-ecmascript placeable asset", via `lib/sitefiles/sftp.ts`). That's the normal case in Docker and CI images. Fix: add `"ssh2"` and `"cpu-features"` to `serverExternalPackages` in `next.config.ts`.
6. **CI batteries fail.**
   - `verify-phase7-launch` is 149/150: env vars missing from `.env.example`, e.g. `ACTION_APPROVAL_TTL_MS`, `ACTION_OAUTH_STATE_SECRET`, `ACTIVEPIECES_*`, `AMAZON_ADS_*`, `BRANDFETCH_API_KEY`.
   - `verify-m11-security` is 38/39: 11 flagged routes. 2 are real (§4 L-items); the rest are false positives and should go on its allow-list.
7. **Unit tests never run in CI.** There is no `test` script in package.json.
8. CI uses Node 20, while development runs on Node 22.

---

## 4. Security findings

### High

**H1. Stored XSS on the app origin via design share links.**
- Path: `lib/design/validate.ts:89-95` only checks that svg `body` is a string. `lib/design/export-svg.ts:251-258` inlines it raw. `app/s/[token]/page.tsx:150` renders it with `dangerouslySetInnerHTML`. There is no CSP.
- Effect: an editor plants `<image onerror=…>`. Any signed-in user who opens the share link (owner, teammates, or another tenant) runs attacker JS, which can call every cookie-auth API.
- The existing `sanitizeSvgBody` only runs on Iconify fetches, and its regex can be bypassed.
- Fix: DOMPurify SVG profile on write, `<img src=data:>` for previews, and a strict CSP.

**H2. Cross-tenant ad-spend approve/reject.**
- Path: the server action `decide` in `app/dashboard/media/advertising/proposals/page.tsx:130-145` calls `lib/adplatforms/gate.ts:156-185`, which uses `store.ts:86-101` (`findFirst`/`update` by bare id).
- `spend_proposals` and `spend_approvals` have **no RLS**, so this is exploitable on every deploy.
- Effect: an editor in A, holding B's proposal id, approves it (bypassing B's human gate and flipping B's ChatGPT campaign to approved) or permanently rejects it.
- Fix: pass `workspaceId` and use `updateMany({where:{id, workspaceId}})`.

**H3. The documented deploy disables tenant RLS.**
- Path: `docker-compose.yml:67` connects as `POSTGRES_USER`, which the postgres image creates as a superuser. Superusers bypass even `FORCE` RLS.
- Verified live: as a non-superuser the RLS suites pass, so the policies themselves work.
- Stores that rely on RLS alone (id-only `where`) therefore leak cross-tenant under compose:
  - clipper jobs and clips, voice agents/scripts/sessions
  - office docs (`lib/univer/docs.ts`), playbooks
  - substrate campaigns, missions
- Fix: migrate as admin, run the app as a `NOSUPERUSER NOBYPASSRLS` role, and add `workspaceId` to those queries anyway (defense in depth).

**H4. Hardcoded fallback secrets, with fake providers as the default.**
- Locations:
  - fake SMS: `lib/messaging/provider.ts:235`
  - GBP review webhook: `lib/authority/reviews/intake.ts:81`
  - unsubscribe HMAC: `lib/messaging/consent.ts:158`
  - `MARKETR_APPROVAL_SECRET`: `lib/media/safety.ts:380`, which signs the media, flywheel and PR approval receipts
  - CTV pixel, plus the fake mail/calls/CallRail providers
- Exploit: `POST /api/messaging/inbound/sms` with the literal bearer secret and `?workspaceId=<victim>`. Workspace ids are public via the logo route.
  - `Body=START` re-opts-in a lead who texted STOP (TCPA exposure).
  - `Body=STOP` silently suppresses leads.
- Fix: throw in production when the secret is unset (the pattern already exists in `lib/authority/outreach/sequences.ts:62`), refuse fake providers when `NODE_ENV=production`, and ignore `params.workspaceId` outside tests.

**H5. MCP connector tools bypass the chat confirmation gate (prompt injection → action).**
- Path: `lib/connectors/m21/mcp.ts:49` hard-codes `mutating:false`; the gate at `lib/chat/connector-tools.ts:262` only stops mutating tools.
- Effect: text from an attached file, a connector read (Drive, Notion, WordPress) or recalled memory can make the agent call `send_*`/`delete_*`/`create_*` on a custom MCP server in the same turn, with no "yes".
- Fix: default to mutating; treat a tool as read-only only when it has `annotations.readOnlyHint === true` or an admin allow-lists it.

**H6. Cross-tenant Activepieces flows.**
- Path: `lib/mcp/tools.ts:361` (`automation_trigger_flow`, `void ctx`) and `:399` (`automation_flow_status`), plus chat tools `lib/chat/tools.ts:871/925`, all against one host-wide engine.
- Effect: any tenant's MCP token or editor passes another tenant's `flowId` to fire it with an arbitrary payload, or any `runId` to read run details. In chat, status is kind "safe".
- Fix: a per-workspace flow/project mapping, checked on both trigger and status.

**H7. Full-read SSRF in dataset web ingest.**
- Path: `POST /api/datasets/sources {kind:"web"}` → `lib/datasetbuilder/ingest.ts:189`. It does a raw `fetch`, follows redirects, and checks only for http(s).
- Effect: the response text is stored and readable via `/api/datasets/reviews`, so cloud metadata credentials become readable.
- Fix: use `safeFetch`.

**H8. Competitor-fleet SSRF.**
- Path: `app/api/intelligence/fleet/watches/route.ts:69` checks only the scheme; `lib/intelligence/fleet/polite-fetch.ts:94` fetches the sitemap and every `<loc>` URL, following redirects, and stores snapshots.
- Fix: use `safeFetch` and same-domain-only `<loc>` URLs.

**H9. Permanent admin lockout DoS (live-verified).**
- Path: `lib/auth/rate-limit.ts:38`. Lockout is `15 min × 2^(failures−5)`, and locked attempts never decay it.
- Live: about 40 failed logins (only the admin email is needed) locked the owner out until process restart. The correct password was rejected.
- Fix: cap the backoff (e.g. 1 h), add a CAPTCHA/step-up after N failures, and provide a break-glass reset.

**H10. Ops approvals replay without limit.**
- Path: `lib/ops/gate.ts:324` rejects `"executed"`, but nothing ever sets that status.
- Probe: three `POST /api/ops/payments` calls on one approval created 3 payments. Refunds and reminders are affected the same way.
- Fix: an atomic `updateMany({id, status:"approved"} → "executed")` with `count === 1`, inside the write transaction.

**H11. Billing holes.**
- Plan changes never update `includedCredits`/`capCredits` (`lib/metering/service.ts:151,176`; `billing.ts:1386`): an upgraded agency workspace is still capped at starter's 2,500.
- Expired top-ups zero the purchased pool but leave the raised cap, so about 4,500 unpaid credits are spendable every month from then on.

### Medium

- **Login rate limit can be bypassed (live-verified).** `lib/api/rate-limit.ts:131` (also `app/r/[slug]/route.ts`) trusts the leftmost `X-Forwarded-For`. 30 of 30 rotated-IP attempts passed the 10/min limit. The lockout table also evicts its oldest entry at 10k, so flooding it with junk emails resets the admin's lockout.
- **Admin → owner self-promotion.** In `app/api/workspace/members/[id]/route.ts`, PATCH has no rank cap, so an admin can promote themselves and then demote the real owner. `ownerCount` also counts pending owner invites.
- **A viewer can mint an all-scope MCP OAuth token.** `app/api/mcp/oauth/consent/route.ts:25` has no role check, and `lib/mcp/auth.ts` never re-checks membership. The token can fire flows and burn credits; removed members keep their tokens until expiry.
- **The MCP consent page can be phished (live-verified).** `app/mcp/authorize/page.tsx:59` shows only the random `client_id`, never the client name or redirect host. Open dynamic client registration accepts any https redirect.
- **The SSRF guard can be bypassed.** `lib/safe-url.ts:83` misses IPv4-mapped IPv6 after URL normalization (`[::ffff:7f00:1]`, `[::ffff:a9fe:a9fe]`), NAT64/6to4, 100.64/10, 198.18/15 and 192.0.0/24. Fix with `net.BlockList` or ipaddr.js.
- **CTV creative validation path traversal.** `app/api/flywheel/ctv/creative/validate/route.ts:49` does a raw `startsWith("/tmp/")` check, so `/tmp/../…` reads arbitrary files (hash plus ffprobe output). A device path that never ends exhausts memory.
- **Blind SSRF.** In clipper URL sources (`app/api/clipper/_pipeline.ts:81`) and skill URL import (`lib/skills/importer.ts:177`).
- **The shared Knowledge corpus is cross-tenant writable.** Any tenant's editor can remove or propose sources and any tenant's admin can rebuild (which spawns `npx tsx`).
- **Agent memory can be poisoned.** Learning-pass lessons go live immediately (`lib/substrate/memory/learning-pass.ts:594`), and `prompt-context.ts:71` injects `needsReview` knowledge into every prompt for every user.
- **The public SVG logo serves inline.** `app/api/public/workspaces/[id]/logo/route.ts:18` has no `nosniff` or CSP sandbox, giving stored XSS on the app origin.
- **Docker defaults.** MinIO root credentials, Postiz `JWT_SECRET`, Listmonk admin and Umami secret all default to known literals, and MinIO 9000/9001 and Postiz 5000 are bound on all interfaces.
- **Outreach webhooks.** The HMAC covers only the body, while `workspaceId` comes from an unsigned query parameter, so a signed event can be replayed into another tenant. Idempotency is in-process only. (Needs verification.)
- **Composio substring match (latent).** `lib/integrations/actions/risk.ts:77` matches `"DRAFT"` anywhere in the tool name, which makes `GMAIL_SEND_DRAFT` auto-executable. It's only reachable via the orchestrator actor today.

### Low

- **Response headers.** No CSP, no HSTS, and `X-Powered-By: Next.js, Payload` is sent.
- **Secret comparisons aren't constant-time.** `lib/cron/gate.ts:32`, `app/api/scheduler/events/route.ts:35` and `app/api/calls/reminders/run/route.ts:18` compare secrets with `===`. `scheduler/events` also validates the body before checking auth, which discloses its schema.
- **Media OTP.** Generated with `Math.random`, kept in memory, unlimited guesses, and returned to the caller unless `MEDIA_CARD_MODE=live`.
- **MCP API keys outlive their creator** and can be created without expiry.
- **Ad campaigns accept another tenant's `brandKitId`.**
- **Viewers can trigger paid pulls:** `intelligence/fleet/reviews` and `intelligence/rank/pull`.
- **Funding data-room `?email=` is self-asserted.** Anyone with the link who knows an allowlisted investor's email gets in and is logged as that investor.
- **Connector intro actions take the actor from the request body.**
- **Composio has no separation of duties:** the requester can approve their own action.
- **The project file download route lacks `nosniff`/sandbox headers.**
- **Credential envelopes have no key id,** so the key can't be rotated.
- **Payload and media approval secrets have hardcoded fallbacks.** `PAYLOAD_SECRET` falls back to a literal (`payload.config.ts:34`); its impact needs verification.
- **Earlier audit items still open:** `javascript:` links in `lib/seo/programmatic.ts:297`, and the Telegram `botToken` is unvalidated.
- **Open Google signup** auto-provisions a workspace with no allowlist toggle.

### Dependencies (`npm audit --omit=dev`: 3 critical, 13 high)

- `next` 16.3.5 has an RCE in `next/og`. It isn't imported anywhere, so it's not reachable, but upgrade to 16.3.8.
- `protobufjs` (via `@xenova/transformers`, used for embeddings) has a critical code-injection advisory.
- `expr-eval` (via Activepieces) has a critical prototype-pollution advisory.
- `sharp`/libvips, `undici`, `braces`, `deepmerge-ts` and `nanoid` have high advisories.

### What held (verified)

- **Authentication:** 1,222 of 1,248 handlers deny anonymous callers; the rest are intentional (unsubscribe, pixel, MCP OAuth).
- **Viewer writes:** 511 of them return 403. The only remaining 2xx are read-only lookups.
- **Cross-tenant sweep:** the WS-B owner with a forged active-workspace cookie hit all 1,280 handlers and got **0 responses containing WS-A data**.
- **Object-level checks:** about 430 by-id queries reviewed; nearly all are workspace-scoped. Invites use 256-bit tokens, are email-bound and claimed atomically.
- **Public tokens:** 128–192-bit, hashed, with expiry and revocation.
- **Webhooks:** every inbound webhook fails closed and uses HMAC with constant-time comparison.
- **Auth redirects:** Auth.js `callbackUrl` is not an open redirect.
- **Request bodies:** a 60 MB chunked body gets a 400 in 0.3 s; malformed JSON gets a 400.
- **Credential crypto:** AES-256-GCM with a random IV, failing closed; stored secrets are never returned by the API.
- **Raw SQL:** all 111 raw-SQL calls use bound parameters.
- **Command execution:** every `child_process` call passes an argument array, with no shell.
- **WeasyPrint:** template names are validated and file access is restricted to its template directory.
- **Approval gates:** the Composio gate executes an approval only once. Media approvals are hash-bound with a two-person rule. Chat confirmations replay the stored arguments.
- **Repo hygiene:** no real secrets or `.env` files are tracked.

---

## 5. Edge cases and correctness (beyond §4)

**High**
- **Messaging double-send.** `lib/messaging/dispatcher.ts:338-392` does check → send → update with no claim step. It runs from the cron and on every approve click, so leads get duplicate SMS (TCPA risk).
- **Voided e-sign envelope comes back.** In `lib/esign/envelopes.ts:558-590`, a DOCUMENT_COMPLETED webhook turns a voided envelope into `completed` and fires the SOW→invoice-draft link. Concurrent duplicate deliveries fire it twice.
- **Leap-day cron halts the scheduler.** `0 0 29 2 *` makes `lib/scheduler/tick.ts:68` throw in 2028 (the search window is 366 days), and the uncaught error stops every workspace's schedules.

**Medium**
- **Ops money and transitions:**
  - Invoice, order and PO totals are Int32, so large totals overflow and return a raw Prisma 500.
  - Patching `taxCents` leaves `totalCents` stale.
  - Reusing an invoice idempotency key returns 500 instead of the original invoice.
  - There's no transition table: draft→overdue and draft PO→received are allowed, and a PO can be restocked twice.
- **Spending caps:** the Context.dev budget is check-then-act. Messaging meters after sending, so the credit cap doesn't stop sends.
- **E-sign:** status can regress (a late "sent" event overrides "partially signed"), and `expired` isn't treated as terminal.
- **Connector intros:** they can be accepted after expiry, and two concurrent accepts both succeed (a double offer to side B).
  - The "don't ask" parser misses the curly apostrophe (`don’t`), "do not ask", "never request", and "No more intros".
- **Legal:** marking a deadline done twice creates two next occurrences.
- **Time zones:**
  - Workflow cron combines day-of-month and day-of-week with AND, drops out-of-range values, and runs in server-local time.
  - Booking availability breaks on daylight-saving days: slots shift or duplicate.
  - WFH standups, digests and focus use the server's timezone; rituals step by fixed milliseconds, and "monthly" means every 30 days.
- **CSV formula injection** in `app/api/crm/leads/export` (leads come from the public form), plus the usage, programmatic and univer exports.
- **WFH expense validation:** accepts half-cents, 1e15 cents and the year 1900; "2026-02-30" silently becomes March 2; a numeric currency crashes with a 500.

**Low**
- **E-sign failure paths:** an invalid `signedAt` causes endless vendor retries, and an envelope in error state is stuck. A double confirm creates two vendor envelopes.
- **Overdue sweep** can overwrite an invoice that was just paid.
- **Legal recurrence drifts:** Jan 31 → Feb 28 → Mar 28, and a 2028-02-29 annual deadline stays on Feb 28.
- **Scheduler cron parser** accepts `"-5"` and `"1-2-3"`.
- **Insurance:** a leap-day effective date produces a policy term one day too long.
- **CRM import:** error row numbers are wrong.
- **Bad paging parameters:** `?take=abc` and `?limit=1.5` cause 500s.
- **CAD:** an STL with NaN coordinates produces "computed" check results.

**Error-handling sweep (live):** about 25 routes return **500 for ordinary client errors**: Zod errors, "not found" and the wrong content type all get caught as 500.
- Affected routes:
  - eddm/orders*, integrations/actions/*
  - datasets ask/reviews/sources, office/docs*, studio/pages
  - mail reconcile/send, esign templates/envelopes
- `funding/intro-requests` with `{}` crashes with a TypeError.
- `attribution/spend/[id]` PATCH with `{}` returns 500.
- voice routes return 400/500 with an "Unauthorized" body.
- In production builds, the Activepieces piece catalog returns 502 ("Cannot find module as expression is too dynamic").
- Fix: one shared `route()` wrapper that maps ZodError → 400, NotFound → 404 and Forbidden → 403.

---

## 6. Unit tests

- 221 files and 3,019 tests. **2,622 pass without a database**, and none of the failures is a logic regression.
- 35 files need a database. With one (migration-built, running as a non-superuser) they pass, including the RLS suites (runs 10/10, knowledge 5/5) and connector-slice4 39/39. The exceptions are `ops-rls` and `workflows-rls`, which need their own setup.
- 5 mobile test files use vitest, which is a separate package.
- 2 report tests hardcode a WeasyPrint venv at `~/workspace/biz-os/…`; set `MARKETR_WEASYPRINT_PYTHON` instead.
- The AG-UI adapter test silently needs the DB: state-snapshot failures are swallowed.
- **Coverage gaps:**
  - Ops tests stub the approval "consume" step, which is how the replay bug (H10) slipped through.
  - Nothing tests leap days or daylight-saving changes, or concurrent state transitions.
  - Playwright has 5 specs only (settings, connectors, chat). Signup, CRM, publish and billing have no end-to-end coverage.

---

## 7. Missing features, workflow breaks, platform gaps

**The product is broad but doesn't hold together yet:**
- 175 pages and 920 routes.
- About 85 non-webhook API routes have no UI caller.
- Prospects, Insurance, Voice and the run viewer have zero inbound links.
- Nurture is linked only from the marketing page.
- `docs/COMPLETE-VISION.md` is stale: it still calls Funding and CAD "specced".

### Top missing features (by impact)
1. **Unified "needs you" inbox.** About 20 approval queues exist: spend, outreach, nurture, scheduler, reports, CAD, intros, e-sign, insurance and Composio actions. `/dashboard/approvals` shows mission approvals only, yet this is the core agentic-OS promise.
2. **Onboarding.** Signup silently creates "<email>'s workspace" on `self_hosted` with 0 credits. There's no wizard, no business context, no trial, and the home screen is SEO-centric.
3. **Navigation.** The sidebar is a flat list of 31 items (`components/AppSidebar.tsx:76`) with no Grow/Design/Operate grouping, and it's missing SEO, Nurture, Prospects, Voice and Insurance. The ⌘K "Go" section has only 6 destinations.
4. **Notification center and push.** There's no Notification model, no bell, and no mobile push.
5. **A connected CRM.** From a lead you can't email, text, call, enroll in nurture or invoice. The unified inbox has an API but no UI.
6. **Workspace lifecycle.** You can't create, rename or delete a workspace. Agency client workspaces (the `Client` model) have no UI.
7. **Live connector code.** GA4, GSC, Google Ads, Meta Ads, Drive and Notion are mock-only (`lib/connectors/m21/native/*` says "LIVE WIRING not yet implemented"), as is outreach sending and GBP. This is missing code, not missing keys.
8. **Plan entitlements and a hosted trial.** Plans differ only by credit pool, and white-label works on every tier.
9. **GDPR export and account/workspace deletion.**
10. **2FA/passkeys and SCIM.**
11. **Global record search** across leads, invoices, docs and files.
12. **Invite emails.** Invites currently return a link for the admin to send by hand (`app/api/workspace/members/route.ts:107`).
13. **Public API docs (OpenAPI) and outbound webhooks.**
14. **The social loop.** Posts are text-only, Studio designs can't be sent to social, and engagement doesn't feed back into Attribution.
15. **Observability.** There's no `/api/health`, no app healthcheck in compose, no Sentry or OTel, and backups exist only as a DEPLOY.md checklist item.

### Where journeys break
- **Signup → workspace:** no guidance, can't rename, and the intelligence report is buried at `/dashboard/authority/intelligence`.
- **Connect → create → publish → results:**
  - Connecting a social channel means leaving for Postiz's UI.
  - Studio output has nowhere to go.
  - Results don't come back; Analytics is Umami pageviews only.
- **Invite → roles:** the link has to be copied by hand. There are only 4 workspace-wide roles, with no per-module or client-viewer role.
- **Mission → approval → outcome:** mission approvals work. Other proposals sit in separate queues with no notification, and run replays have no index page.
- **Lead → nurture → close:** you can't enroll a lead from the CRM. Reviews links to raw JSON at `/api/messaging/approvals` (`components/reviews/ReviewsApp.tsx:639,679,712`).
- **Billing:** not in the sidebar, with no enforcement and no trial.
- **Across all journeys:**
  - 13 delete flows have no confirmation, and 79 others use native `window.confirm`.
  - There's no toast system and almost no undo.
  - Accessibility: 65 clickable divs without a role, 12 images without alt text, and 18 `outline-none` with no focus style.
- **Mobile:**
  - `apiBaseUrl` is hardcoded to `localhost:3000`, there's no EAS config and no push.
  - Still branded "Marketr Agent" in violet.

### Design system (Agentic OS migration)
- **About 95 files (16%) render with no colors right now.**
  - `docs/design/tailwind.css:12` sets `--color-*: initial`, so stone, zinc, violet, emerald and similar classes **emit no CSS**. Verified: zero such utilities in the production CSS.
  - That's 1,885 neutral, 87 violet and 536 other default-hue usages.
- **Worst offenders:** LocalSeoTabs (119), ProgrammaticStudio (112), SitesManager (105), SiteIde (98), NewsletterStudio (94), StudioStudio, AdFactory, SocialApp, components/agents/*, app/dashboard/projects/*.
- **Other leftovers:** `bg-[#FAFAF7]` in 17 files, 142 raw hex values across 41 files, and gradients in 5.
- **Naming:** "ShapesOS" appears nowhere in source, while "Marketr" appears in ~264 user-facing strings (landing, login, metadata, MCP consent, mobile).

---

## 8. Suggested plan

**Phase 0 — ship-ability (1–2 days).**
- Fix the §3 blockers.
- Add a `test` script and run unit tests plus DB tests (with a Postgres service, as a non-superuser app role) in CI.
- Add `prisma migrate diff --exit-code`.
- Add a CSS compatibility layer so the 95 files render again.

**Phase 1 — security must-fix (about 1 week).**
- Items 2–15 in §2.
- CSP and HSTS; disable `poweredByHeader`.
- Harden compose: non-superuser role, `${VAR:?}` secrets, bind to 127.0.0.1.
- A shared route error wrapper (the 25 routes returning 500).
- CSV escaping.
- Dependency upgrades.

**Phase 2 — integrity (about 1 week).**
- Atomic claims and transition tables for ops, e-sign, intros, legal and messaging.
- Credit-pool sync.
- Time zones: store IANA zones and do DST-safe math in scheduler, workflow cron, bookings, WFH and legal recurrence.
- Tests for each.

**Phase 3 — make it one product.**
- Unified approvals inbox with notifications.
- Grouped navigation plus ⌘K over everything.
- Onboarding wizard with a hosted trial plan.
- Workspace lifecycle and invite emails.
- CRM ↔ messaging/nurture/invoice actions.
- Pick one name, Marketr or ShapesOS.

**Phase 4 — next builds.**
- Live wiring for GA4/GSC/Ads/Drive/Notion.
- Social loop with media and analytics.
- Notifications and mobile push.
- GDPR export/delete, 2FA, SCIM.
- OpenAPI and outbound webhooks.
- Observability (Sentry/OTel, `/api/health`).
- Finish the design-system migration file by file, worst first.

---

## 9. Notes on method

- **Live environment:** a scratch Postgres inside the session container (`marketr_live` from `db push`, plus `marketr_mig2` built from migrations in corrected order, with the app as the non-superuser role `marketr_app`).
- **Build workaround:** for the live build only, `ssh2`'s native binding was moved aside, and restored afterward. No tracked files were changed, and nothing was committed.
- **Session tokens:** minted with the test `AUTH_SECRET` for owner, editor, viewer (WS-A) and outsider (WS-B).
- **Not live-tested:** the object-level IDOR items (H2, H3 cross-tenant reads) were confirmed by code and DB metadata, not exploited against seeded victim objects.
- **Not covered:** IPv6 SSRF reachability (the sandbox has no IPv6), ffmpeg input abuse (not installed), and Payload CMS internals.
- **Reviewer artifacts:** session scratchpad (`inject2/`, `agentsec/`, `edge2/` probes, `authz2/` triage scripts).
