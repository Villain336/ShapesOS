# Remediation plan — FULL-AUDIT-2026-10-03

Every finding and suggestion from `docs/audit/FULL-AUDIT-2026-10-03.md`, mapped
to a phase. One branch + PR per phase, each green (unit + DB tests, typecheck,
production build, batteries) before the next starts.

**Owner decisions (2026-10-03):** product name is **ShapesOS** in all
user-facing text (internal identifiers such as `MARKETR_*` env vars, cookie
names and DB names stay, so existing installs keep working); new hosted
signups get a **trial plan**, with an env switch for invite-only signup;
delivery is **one PR per phase**.

## Phase 0 — ship-ability (`claude/phase-0-shipability`)
- [x] `npm ci` ERESOLVE → `.npmrc legacy-peer-deps` (and copied into the Docker deps stage)
- [x] Migration order: renamed `connector_slice5` → `…013500`, `cad_slice4` → `…130000`; `scripts/db/pre-migrate.sql` repairs history on existing DBs; `scripts/db/migrate.sh`
- [x] Schema drift: `20261003000000_phase0_schema_drift` (WFH enums converted in place, `mission_plane_links`, missing indexes/default) + CI guard `scripts/ci/check-schema-drift.mjs`
- [x] Typecheck: `npm run typecheck` (`next typegen && tsc`), 8 GB heap in CI/Docker, AGENTS.md updated
- [x] `next build` with ssh2 native binding → `serverExternalPackages: ssh2, cpu-features`
- [x] `.env.example`: 72 undocumented vars documented (launch battery 150/150)
- [x] Security battery: `fleet/reviews` + `rank/pull` editor-gated; ops lookups / command audit / workspace switch explicitly membership-gated; 3 public-by-design routes documented (39/39)
- [x] Test scripts: `npm test` (unit, DATABASE_URL unset), `npm run test:db` (manifest `scripts/test/db-tests.txt`); ops/workflows RLS suites fixed; WeasyPrint cases skip without the venv
- [x] CI: Node 22, pgvector image, unit tests, fresh migrate, drift guard, least-privilege app role (`scripts/db/create-app-role.sql`), DB tests as that role, batteries, build
- [x] Compose: one-shot `migrate` service/stage (Prisma CLI was missing from the slim runner)
- [x] CSS compat: default Tailwind palettes + legacy radius/shadow steps mapped to Agentic OS tokens (~95 files render again)

## Phase 1 — security (`claude/phase-1-security`)
High
- [x] H1 stored XSS: sanitize design SVG `body` (server-side, SVG profile), share preview as `<img>`/sandboxed, CSP
- [x] H2 spend proposals: workspace-scoped approve/reject + store
- [x] H3 compose runs app as non-superuser role; add `workspaceId` to every RLS-only query (clipper, voice agents/scripts/sessions, office docs, playbooks, substrate campaigns, missions)
- [x] H4 fail closed on unset secrets in production (fake SMS/mail/calls/CallRail providers, GBP intake, unsubscribe HMAC, `MARKETR_APPROVAL_SECRET`, CTV pixel, `PAYLOAD_SECRET`); refuse fake providers in production; ignore `params.workspaceId` outside tests
- [x] H5 MCP connector tools default to mutating unless `readOnlyHint` / admin allow-list
- [x] H6 Activepieces flows/runs bound to workspace
- [x] H7/H8 SSRF: dataset web ingest, fleet sitemap + `<loc>` same-domain, via `safeFetch`
- [x] H9 login lockout: capped backoff, break-glass reset
Medium
- [x] Trusted-proxy client IP (rate limits, vanity redirect); lockout map eviction can't reset a locked account
- [x] Member roles: no grant above own rank; owners-only on owner rows; pending invites don't count as owners
- [x] MCP OAuth: role required at consent, scopes capped by role, membership re-checked per call; consent page shows client name + redirect host + "unverified"
- [x] `safe-url.ts` IPv6/NAT64/6to4/CGNAT/benchmark ranges via `net.BlockList`; strip `Authorization` on cross-origin redirects
- [x] CTV creative path traversal (realpath + prefix + regular-file + size cap; dev-only)
- [x] Clipper URL source + skill import via `safeFetch`; linkverify/render-server/spot-kit IP checks
- [x] Knowledge corpus mutations platform-operator only
- [x] Memory poisoning: inferred lessons/knowledge stay out of prompts until accepted; recalled memory delimited as untrusted
- [x] Public SVG logo: rasterize/reject SVG, `nosniff` + `CSP: sandbox`
- [x] Compose secrets `${VAR:?}`, services bound to 127.0.0.1 (MinIO, Postiz, Listmonk, Umami)
- [x] Outreach webhooks: workspace bound into the signature/sequence; durable idempotency
- [x] Composio: exact draft-creator allow-list; separation of duties (approver ≠ requester); requester not client-supplied
Low
- [x] CSP + HSTS, `poweredByHeader: false`
- [x] Constant-time secret compares (cron gate, scheduler events, call reminders); auth before body validation
- [x] Media OTP: `crypto.randomInt`, attempt limit, bound to approval+approver, never returned to caller
- [x] MCP API keys expire / revoked with creator; OAuth client rebinding doesn't strand tokens
- [x] Ads campaigns: brandKitId must belong to the workspace
- [x] Funding data-room: email OTP/magic link; beacon honours link expiry
- [x] Connector intro actor from session, not body
- [x] Project file download `nosniff` + sandbox
- [x] Credential envelope key id (rotation)
- [x] `javascript:` links in programmatic SEO; Telegram botToken validation
- [x] Open-signup control: `SIGNUP_MODE=open|invite` (trial plan itself lands in Phase 3)
- [x] Shared route error wrapper (ZodError→400, NotFound→404, Forbidden→403, no raw messages) across the ~25 routes that 500 on client errors; voice route status codes; funding intro-requests + attribution spend validation
- [x] CSV export formula-injection escaping (crm leads, usage, programmatic, univer)
- [x] Dependency upgrades: next ≥16.3.8, protobufjs, expr-eval, sharp, undici, braces, deepmerge-ts, nanoid
- [x] Activepieces piece catalog dynamic-require broken in production build

Follow-ups found while doing Phase 1 (carried forward)
- [x] Nonce-based CSP via the proxy so `'unsafe-inline'`/`'unsafe-eval'` can be dropped; browser-verify Monaco/Univer/Payload under CSP (Phase 3 UI pass, workstream L). `proxy.ts` sets a per-request policy from `lib/security/headers.ts` (pages: `'nonce-…' 'strict-dynamic'`, eval dev-only; `/api/*`: scriptless sandboxed policy); `next.config.ts` no longer sends a CSP; every page renders per request. Verified in Chromium against a production build with zero CSP violations: login, dashboard home, site IDE (Monaco + workers), site builder srcdoc preview (Tailwind CDN), Office sheet + doc (Univer), Studio + design editor, settings/connectors, settings/providers, Knowledge Brain, Payload `/admin` (first user, login, posts editor), public `/s/[token]` signed out. Nothing needed `'unsafe-eval'`.
- [x] Real CallRail webhook still resolves the workspace from `?w=` with one host-wide secret → per-workspace secret (Phase 2)
- [x] Payload `payload` schema grants for the least-privilege app role (Phase 2)
- [x] UI: MCP read-only tool allow-list editor; hide corpus/automation-binding controls from non-operators (Phase 3, workstream L — connectors settings editor; Knowledge Brain manage controls and a new Activepieces flow-bindings panel render only for `MARKETR_PLATFORM_OPERATORS`, browser-verified both ways)
- [x] Optional CAPTCHA/step-up after repeated login failures (Phase 4a identity: `lib/auth/captcha.ts` — after `LOGIN_CAPTCHA_AFTER_FAILURES` (default 3) failures per account or IP in the lockout window the credentials login needs a Turnstile/hCaptcha token verified server-side before the password is compared; no provider configured → documented no-op, capped backoff only)

## Phase 2 — integrity (`claude/phase-2-integrity`)
- [x] Ops: approval `consume()` (atomic, in-transaction); transition table; guarded restock; total recompute on patch (drafts only); Int32 total bounds; idempotency-key returns existing invoice; overdue sweep guarded; paging validation
- [x] Credits: plan change syncs included pool + cap; expiring top-ups lower the cap; Context.dev budget atomic
- [x] Messaging: claim-before-send (`queued→sending`), provider idempotency key, meter/reserve before send
- [x] E-sign: terminal states (voided/declined/expired) ignore events; monotonic status; guarded completion + link firing; invalid dates; errored envelope recoverable; double-confirm guard
- [x] Connector intros: guarded transitions (409), expiry enforced at action time; boundary parser (curly apostrophes, "do not", bans before cadence)
- [x] Legal: guarded deadline completion; recurrence anchored to series start
- [x] Scheduler: per-schedule try/catch + park; 8-year search; cron parser rejects malformed ranges; workflow cron reuses scheduler cron (OR semantics, 0–7 DOW, TZ)
- [x] Time zones: bookings DST-safe; WFH standups/digests/focus/rituals use IANA TZ + calendar stepping; insurance leap-day term
- [x] Validation: WFH expenses (zod, ISO-4217, strict dates); CRM import row numbers + numeric bounds; NaN paging (done: workstream G); CAD NaN STL (done: workstream G)
- [x] Tests for each (incl. leap-day/DST/concurrency cases, real ops consume path)
- [x] Self-hosted metering records but never blocks (BYO keys); plan changes across the self-hosted boundary flip blocking; data migration unblocks untouched self-hosted caps
- [x] Phase 1 carry-overs done here: CallRail per-workspace webhook secret; Payload schema grants (+ schema created on fresh installs)

Follow-ups found while doing Phase 2 (carried forward)
- [x] Daily SMS cap is still check-then-act (make it one conditional update, like the Context.dev budget) — done in 4a: the claim takes a transaction-scoped advisory lock per workspace-day, then counts sent + in-flight rows and claims (or suppresses "cap") in the same transaction; concurrency DB test (12 parallel candidates, cap 3 → exactly 3 sent; old code sent 9)
- [x] Allocation rules: empty-string percent still reads as 0 — done in 4a: validator parses raw inputs; blank/whitespace/null/non-numeric = "required" (400), explicit 0 still valid; route no longer pre-coerces with Number(); settings panel refuses a blank field
- [x] Context.dev daily cap resets to default each day (carry the configured cap forward) — done in 4a: a missing day reads, and is seeded with, the latest earlier day's cap (default only with no history)
- [x] Scheduled skills run in UTC (per-schedule IANA timezone; `cronMatchesInZone` exists) — done in 4a: `scheduled_skills.timezone` (migration 20261005400000, default UTC), validated on write, `nextRunAfterInZone` (agrees with `cronMatchesInZone`; DST fall-back fires once, spring-forward gap fires shifted forward), tick parks a corrupt zone; timezone field in the schedule wizard (defaults to the creator's zone) and detail editor
- [x] Intros: decline/withdraw don't enforce expiry (only send-type actions do) — done in 4a: tenant decline, side-A decline and withdraw of a proposed intro flip a lapsed proposal to expired and refuse with intro_expired (409); window also in the guarded update

## Phase 3 — one product (`claude/phase-3-product`)
- [x] Rename to ShapesOS in all user-facing text (web, emails, metadata, MCP consent, mobile)
- [x] Trial plan for hosted signups (`DEPLOYMENT_MODE=hosted`: 14 days, 500 one-time credits, hard cap; ended trial = read-only for metered actions with an upgrade prompt; lapsed hosted subscriptions land on an ended trial) + invite-only env switch (Phase 1). Plan entitlements themselves stay in Phase 4
- [x] Onboarding wizard (business context, rename workspace, first connections, intelligence report) — `/dashboard/welcome`, skippable, resumable, shown once
- [x] Unified "needs you" approvals inbox across all queues + sidebar badge
- [x] Notification center (model, bell, read state) feeding from approvals/alerts
- [x] Navigation regrouped Grow / Design / Operate / Agents; orphaned pages linked (SEO, Nurture, Prospects, Voice, Insurance, Runs index, Billing); ⌘K covers every destination; settings grouped (done: settings grouped into six sections, Billing in settings + sidebar workspace/account menus)
- [x] Workspace lifecycle: create, rename, delete (owner-only, typed name, cascade-safe, audited in `workspace_lifecycle_events`); agency clients UI (Settings → Clients)
- [x] Invites emailed (SMTP, else Resend; copy-link fallback)
- [x] CRM actions: email / text / call / enroll in nurture / invoice / delete (the per-lead conversation inbox UI moved to Phase 4b)
- [x] Reviews links to real approval UI (not raw JSON)
- [x] Confirmations on all destructive actions (replace `window.confirm`), shared toast system, undo where cheap
- [x] Accessibility fixes (clickable divs, alt text, focus styles)
- [x] Docs: README, COMPLETE-VISION statuses, COMPETITORS; root docs moved under docs/ (specs → `docs/specs/`, threat models → `docs/security/`, past audits/reports/design maps → `docs/history/`, M9 source lists → `docs/research/`, `docs/COMPETITORS.md`; references updated; `docs/quickstart.md` DB steps fixed for the app role)
- [x] Repo hygiene: untrack previews/ + training/traces + docs scratch; remove dead vault primitives and duplicate `/api/websites` tree (done: 14 zero-importer files removed from `components/vault/primitives`. Left: `/api/websites` — the "duplicate of `/api/sites`" claim is unverified and `scripts/verify-m11-security.mjs` checks routes under it)

## Phase 4 — next builds (PRs 4a → 4b → 4c, stacked on Phase 3)
4a — platform (`claude/phase-4a-platform`)
- [x] Observability: `/api/health` (DB + migrations), compose app healthcheck, structured JSON logging, Sentry/OTel hooks (env-gated, no-op without DSN); backup job (pg_dump + retention) and restore doc
  - How: `GET /api/health` is the readiness check: the DB must answer within 2s, every shipped migration must be applied and none failed. It returns 200 or 503, with counts only. `GET /api/health/live` is the liveness check (no I/O). The compose `app` healthcheck calls `/api/health`.
  - `lib/observability/log.ts` writes JSON lines, with secrets and emails scrubbed (`redact.ts`). `proxy.ts` sets an `x-request-id` on every request. `errorResponse`/`withErrorHandling` log 500s with the context and the request id.
  - `instrumentation.ts`: `onRequestError` logs the error and reports it to Sentry. That reporter is dependency-free (`lib/observability/sentry.ts`, envelope POST). `register()` turns on `@vercel/otel` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  - `scripts/ops/backup.sh` + the compose `backup` service run `pg_dump -Fc` with a read-back check, a sha256, retention, and an optional S3/MinIO upload via curl SigV4.
  - `docs/ops/BACKUP-RESTORE.md` has the restore procedure and a recorded drill (dump → restore → drift OK, orphan test green as the app role).
- [x] GDPR export (workspace + user) + account deletion; orphaned rows in workspace tables without an FK cleaned on workspace delete
  - How, export: `lib/gdpr/` reads the live catalog, so new tables are covered automatically.
    - `GET /api/workspaces/[id]/export` (admin+, audited as `workspace_exported`, one export per workspace at a time) streams every workspace-owned table: direct, through foreign keys, and RLS-scoped.
    - `GET /api/account/export` streams your memberships, invites and authored rows.
    - Both leave out secret columns and credential tables.
  - Account deletion: `DELETE /api/account` with the email typed back.
    - It refuses if you're the sole owner of a workspace that has other members.
    - Solo workspaces are deleted through `purgeWorkspace`. In shared ones you leave and ownership passes to another owner.
    - Personal rows are deleted, and person references are pseudonymized (hash-chained, append-only and lifecycle tables are kept as they are). Then you're signed out.
  - UI: Settings → Your account, and an export card in Settings → General.
  - Orphans: migration `20261005100000` adds `ON DELETE CASCADE` foreign keys on the 25 unlinked tables (`workspace_lifecycle_events` is kept on purpose). `workspace-orphans-db.test.ts` derives every `workspace_id` table from the catalog, fills each one, deletes the workspace and asserts nothing is left.
- [x] 2FA (TOTP + recovery codes) + passkeys (WebAuthn); SCIM 2.0 users/groups; step-up CAPTCHA after repeated login failures (provider optional). Migration `20261005200000_phase4a_identity`. TOTP (RFC 6238, ±1 step, last-step replay protection, secret sealed with the credential envelope) + 10 hashed single-use recovery codes; a first factor for an enrolled user yields a PENDING JWT with no `sub`, so every guard (requireUser/auth(), pages, proxy) reads it as signed out until the `two-factor` or `passkey` Auth.js provider finishes it (`lib/auth/mfa/session-token.ts`; the proxy bounces pending sessions off `/dashboard`); wrong codes share the login lockout. Passkeys via @simplewebauthn v14 (register/list/rename/remove, usernameless sign-in, second factor, re-auth; rpID/origin from APP_URL→AUTH_URL; server-side single-use 5-min challenges). Disable/regenerate/remove need re-auth (fresh code or a second factor in the last 10 min). Workspace "require 2FA" (owners; enforced in `getMembership` + setup redirect to `/security/setup`). SCIM 2.0 at `/api/scim/v2` (Users/Groups CRUD + PATCH, `eq` filters, ServiceProviderConfig/ResourceTypes/Schemas) with per-workspace hashed tokens (owner-managed in Settings → Security; FORCE RLS; token names its workspace so the lookup is RLS-scoped); active=false parks the userId (access ends at once), groups map to admin/editor/viewer, owners immutable. Also fixed: OAuth/OIDC/SAML users got a random Auth.js id on every sign-in (no adapter) — now `provider:providerAccountId`. UI: Settings → Your security, Settings → Security (policy + SCIM tokens), login second step / passkey / CAPTCHA. Tests: RFC 6238 vectors, guard/proxy, CAPTCHA, SCIM parsing (unit); mfa-db (replay, recovery single use, challenges, software-authenticator WebAuthn), security-settings-db, scim-db (conformance + cross-workspace denial)
- [x] OpenAPI spec for the public API + outbound webhooks (signed, retried, per-workspace endpoints, delivery log) (done: `lib/api/openapi.ts` builds OpenAPI 3.1 from the live zod schemas (MCP tool inputs, public form body, webhook payloads via `z.toJSONSchema`) for `/mcp`, the MCP OAuth endpoints, public lead forms, plus a `webhooks` section; served at `GET /api/openapi.json`, rendered server-side at Settings → API reference; test checks structure, refs and that every path/method is a real route. Webhooks: `lib/webhooks` + migration `20261005300000_phase4a_webhooks` (FORCE RLS), admin-only endpoints (https + safeFetch rules, event filter, `whsec_` secret shown once, on/off, rotate, test), Stripe-style `ShapesOS-Signature` HMAC-SHA256 with a 5-minute replay window, durable queue drained by `/api/cron/webhooks` (cronGate, SKIP LOCKED, 1m×4ⁿ backoff capped 24h, 8 attempts → dead letter, stuck-row reclaim, 30-day pruning), delivery log + redeliver UI; emitted from lead created/updated, invoice paid, approval needed/decided, agent run finished/failed and every notification (producer seam), never failing the action)
- [x] Global record search (leads, invoices, docs, files, projects) in ⌘K (done: `GET /api/search/records` → `lib/search/records.ts`: leads, invoices, Office docs, files, SEO + client projects, missions, CAD projects, e-sign envelopes, legal docs, clients in one `withWorkspaceScope` transaction, escaped ILIKE ranked by pg_trgm similarity, per-kind min-role table; trigram GIN indexes in `20261005300100_phase4a_record_search`; ⌘K "Records" section (debounced) between Go and Do; CRM `?tab=`/`?invoice=` deep links)
- [x] Plan entitlements enforced server-side (white-label and other tiered features) (done: one table in `lib/billing/entitlements.ts` (features: white-label, custom branding, custom domains, API/MCP, webhooks, SSO, SCIM; limits: seats, workspaces, projects; self_hosted = everything, unknown plans fail closed) + `entitlements-server.ts` (`hasEntitlement(ws, "scim")` seam for SCIM). 403 + upgrade message on white-label writes/logo, custom domain, MCP enable/keys and every `/mcp` call, invites (seats), project + workspace creation, SSO auto-provisioning, webhooks; public review/share pages and the public logo drop white-label on plans without it, dashboard tint needs custom_branding; UI notices, seat counter, plan table in Billing)
- [x] Carried follow-ups: daily SMS cap atomic; allocation empty percent; Context.dev cap carried forward; scheduled skills per-schedule TZ; intro decline/withdraw expiry; decided-notifications for scheduler/CAD/mail/media; data-room file view CSP (done: first five ticked under Phase 2 follow-ups; decided notifications go through `notifyApprovalDecided` after each decision — scheduler runs → schedule creator, CAD proposals, mail approvals, media buys (approved once fully approved; denied when a pending buy is revoked) — DB-tested; data-room `/r/funding/<token>?dl=1` gets the sandboxed `USER_FILE_VIEW_CSP` from proxy.ts (the route's own CSP was being dropped for the page policy — confirmed with `next dev`), route also sets it + nosniff + no-store, header verified on the real response)

4b — product builds (`claude/phase-4b-builds`)
- [ ] Live connector wiring: GA4, GSC, Google Ads, Meta Ads, Drive, Notion; outreach sending adapter; GBP (real HTTP code, tested against recorded fixtures; keys supplied later)
- [ ] Social loop: media posts, Studio → social, engagement → attribution; analytics home
- [x] CRM conversation inbox UI (inbound + outbound per lead)
  - How: `/dashboard/crm/inbox` (nav: Grow → Inbox; "Conversation" on the lead slide-over). One thread per lead merged from the `outbound_message` ledger (outbound sends + inbound rows), newest first, with channel / unread / assigned (lead owner) / search filters and cursor paging (`lib/crm/inbox.ts`, `GET /api/crm/inbox/threads[/leadId]`). Polls while the tab is visible.
  - Unread is per user: `conversation_reads` (FORCE RLS) holds each member's last-read time per lead; it only moves forward and acknowledges only messages already shown.
  - Replies (`POST …/[leadId]/reply`, editor+; viewers read) go through the dispatcher's `queueMessage`, so consent, quiet hours, the daily cap and the approval gate apply; the requester is the replier.
  - Inbound email now exists: outbound email carries a signed per-workspace Reply-To (`reply+<ws>-<hmac>@MESSAGING_INBOUND_EMAIL_DOMAIN`), `POST /api/messaging/inbound/email` takes Resend's Svix-signed `email.received` webhook (fail closed), fetches the body from Resend's receiving API, strips the quoted original and threads it on the sender's lead. Inbound SMS that matched no lead can't be threaded (the ledger doesn't keep the sender number); the inbox counts them.
- [x] Mobile: configurable API base URL, EAS config, push notifications, rebrand
  - How: server URL = in-app Server setting (probed via `/api/health/live`; https except private networks) → `EXPO_PUBLIC_API_BASE_URL` → `app.config.ts` extra → localhost. `app.config.ts` replaces `app.json` (ShapesOS name/scheme, placeholder bundle ids from env, EAS project id, dev/preview suffixes); `eas.json` has development / preview / production profiles with placeholders only.
  - Push: `push_devices` (FORCE RLS, `expo_token` excluded from GDPR exports by name) + `/api/mobile/push-devices` (own devices only, viewer+). The Phase 3 producers push approval needed / decided and run failed to enabled, un-muted devices (`lib/push/notify.ts`, fire-and-forget, off unless `PUSH_PROVIDER=expo`); `DeviceNotRegistered` deletes the token, 5 consecutive errors delete it too. Settings tab: opt-out and per-kind mutes; sign-out unregisters.
  - Sign-in now matches Auth.js v5 (CSRF cookie, `X-Auth-Return-Redirect`, server-set cookie names incl. `__Secure-` and chunks; the old flow never sent the CSRF cookie) and supports the Phase 4a second step (TOTP or recovery code through the `two-factor` provider; passkey-only accounts are sent to the web).
  - Rebrand: ShapesOS name, wordmark splash/loading, Agentic OS tokens (`src/theme.ts`) instead of violet. Not done: no icon/splash artwork (no binary assets), and nothing was booted on a device or simulator (none on this box); flows are tested against mocked servers.
- [ ] CAD derived BOM; datasets slices 3–4

4c — design system (`claude/phase-4c-design`)
- [ ] Design-system migration of the remaining legacy files (worst first), then delete the compat block
