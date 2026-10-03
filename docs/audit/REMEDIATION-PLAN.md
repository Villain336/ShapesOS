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
- [ ] H1 stored XSS: sanitize design SVG `body` (server-side, SVG profile), share preview as `<img>`/sandboxed, CSP
- [ ] H2 spend proposals: workspace-scoped approve/reject + store
- [ ] H3 compose runs app as non-superuser role; add `workspaceId` to every RLS-only query (clipper, voice agents/scripts/sessions, office docs, playbooks, substrate campaigns, missions)
- [ ] H4 fail closed on unset secrets in production (fake SMS/mail/calls/CallRail providers, GBP intake, unsubscribe HMAC, `MARKETR_APPROVAL_SECRET`, CTV pixel, `PAYLOAD_SECRET`); refuse fake providers in production; ignore `params.workspaceId` outside tests
- [ ] H5 MCP connector tools default to mutating unless `readOnlyHint` / admin allow-list
- [ ] H6 Activepieces flows/runs bound to workspace
- [ ] H7/H8 SSRF: dataset web ingest, fleet sitemap + `<loc>` same-domain, via `safeFetch`
- [ ] H9 login lockout: capped backoff, break-glass reset
Medium
- [ ] Trusted-proxy client IP (rate limits, vanity redirect); lockout map eviction can't reset a locked account
- [ ] Member roles: no grant above own rank; owners-only on owner rows; pending invites don't count as owners
- [ ] MCP OAuth: role required at consent, scopes capped by role, membership re-checked per call; consent page shows client name + redirect host + "unverified"
- [ ] `safe-url.ts` IPv6/NAT64/6to4/CGNAT/benchmark ranges via `net.BlockList`; strip `Authorization` on cross-origin redirects
- [ ] CTV creative path traversal (realpath + prefix + regular-file + size cap; dev-only)
- [ ] Clipper URL source + skill import via `safeFetch`; linkverify/render-server/spot-kit IP checks
- [ ] Knowledge corpus mutations platform-operator only
- [ ] Memory poisoning: inferred lessons/knowledge stay out of prompts until accepted; recalled memory delimited as untrusted
- [ ] Public SVG logo: rasterize/reject SVG, `nosniff` + `CSP: sandbox`
- [ ] Compose secrets `${VAR:?}`, services bound to 127.0.0.1 (MinIO, Postiz, Listmonk, Umami)
- [ ] Outreach webhooks: workspace bound into the signature/sequence; durable idempotency
- [ ] Composio: exact draft-creator allow-list; separation of duties (approver ≠ requester); requester not client-supplied
Low
- [ ] CSP + HSTS, `poweredByHeader: false`
- [ ] Constant-time secret compares (cron gate, scheduler events, call reminders); auth before body validation
- [ ] Media OTP: `crypto.randomInt`, attempt limit, bound to approval+approver, never returned to caller
- [ ] MCP API keys expire / revoked with creator; OAuth client rebinding doesn't strand tokens
- [ ] Ads campaigns: brandKitId must belong to the workspace
- [ ] Funding data-room: email OTP/magic link; beacon honours link expiry
- [ ] Connector intro actor from session, not body
- [ ] Project file download `nosniff` + sandbox
- [ ] Credential envelope key id (rotation)
- [ ] `javascript:` links in programmatic SEO; Telegram botToken validation
- [ ] Open-signup allowlist toggle (with Phase 3 trial plan)
- [ ] Shared route error wrapper (ZodError→400, NotFound→404, Forbidden→403, no raw messages) across the ~25 routes that 500 on client errors; voice route status codes; funding intro-requests + attribution spend validation
- [ ] CSV export formula-injection escaping (crm leads, usage, programmatic, univer)
- [ ] Dependency upgrades: next ≥16.3.8, protobufjs, expr-eval, sharp, undici, braces, deepmerge-ts, nanoid
- [ ] Activepieces piece catalog dynamic-require broken in production build

## Phase 2 — integrity (`claude/phase-2-integrity`)
- [ ] Ops: approval `consume()` (atomic, in-transaction); transition table; guarded restock; total recompute on patch (drafts only); Int32 total bounds; idempotency-key returns existing invoice; overdue sweep guarded; paging validation
- [ ] Credits: plan change syncs included pool + cap; expiring top-ups lower the cap; Context.dev budget atomic
- [ ] Messaging: claim-before-send (`queued→sending`), provider idempotency key, meter/reserve before send
- [ ] E-sign: terminal states (voided/declined/expired) ignore events; monotonic status; guarded completion + link firing; invalid dates; errored envelope recoverable; double-confirm guard
- [ ] Connector intros: guarded transitions (409), expiry enforced at action time; boundary parser (curly apostrophes, "do not", bans before cadence)
- [ ] Legal: guarded deadline completion; recurrence anchored to series start
- [ ] Scheduler: per-schedule try/catch + park; 8-year search; cron parser rejects malformed ranges; workflow cron reuses scheduler cron (OR semantics, 0–7 DOW, TZ)
- [ ] Time zones: bookings DST-safe; WFH standups/digests/focus/rituals use IANA TZ + calendar stepping; insurance leap-day term
- [ ] Validation: WFH expenses (zod, ISO-4217, strict dates); CRM import row numbers + numeric bounds; NaN paging; CAD NaN STL
- [ ] Tests for each (incl. leap-day/DST/concurrency cases, real ops consume path)

## Phase 3 — one product (`claude/phase-3-product`)
- [ ] Rename to ShapesOS in all user-facing text (web, emails, metadata, MCP consent, mobile)
- [ ] Trial plan for hosted signups + invite-only env switch; plan entitlements groundwork
- [ ] Onboarding wizard (business context, rename workspace, first connections, intelligence report)
- [ ] Unified "needs you" approvals inbox across all queues + sidebar badge
- [ ] Notification center (model, bell, read state) feeding from approvals/alerts
- [ ] Navigation regrouped Grow / Design / Operate / Agents; orphaned pages linked (SEO, Nurture, Prospects, Voice, Insurance, Runs index, Billing); ⌘K covers every destination; settings grouped
- [ ] Workspace lifecycle: create, rename, delete; agency client workspaces UI
- [ ] Invites emailed
- [ ] CRM actions: email / text / call / enroll in nurture / invoice / delete; unified inbox UI
- [ ] Reviews links to real approval UI (not raw JSON)
- [ ] Confirmations on all destructive actions (replace `window.confirm`), shared toast system, undo where cheap
- [ ] Accessibility fixes (clickable divs, alt text, focus styles)
- [ ] Docs: README, COMPLETE-VISION statuses, COMPETITORS; root docs moved under docs/
- [ ] Repo hygiene: untrack previews/ + training/traces + docs scratch; remove dead vault primitives and duplicate `/api/websites` tree

## Phase 4 — next builds (PRs 4a…)
- [ ] Observability: `/api/health`, compose app healthcheck, Sentry/OTel hooks, structured logging; backup job
- [ ] GDPR export + account/workspace deletion
- [ ] 2FA (TOTP) + passkeys; SCIM
- [ ] OpenAPI spec + outbound webhooks
- [ ] Global record search
- [ ] Plan entitlements enforced (white-label etc.)
- [ ] Live connector wiring: GA4, GSC, Google Ads, Meta Ads, Drive, Notion; outreach sending adapter; GBP
- [ ] Social loop: media posts, Studio → social, engagement → attribution; analytics home
- [ ] Mobile: configurable API base URL, EAS config, push notifications, rebrand
- [ ] CAD derived BOM; datasets slices 3–4
- [ ] Design-system migration of the remaining legacy files (worst first), then delete the compat block
