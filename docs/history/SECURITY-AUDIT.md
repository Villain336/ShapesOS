# Marketr — Security Audit

**Date:** 2026-09-21
**Scope:** Full codebase at `~/workspace/marketr` (Next.js 15, TypeScript, Prisma/PostgreSQL, Auth.js v5, AGPLv3) — all 174 API routes, auth/authz, crypto, connectors, webhooks, cron, uploads, headers, dependencies.
**Method:** Read-only static review by three parallel auditors + independent spot-checks of high-risk items. No code modified, nothing committed. Findings verified by direct read/grep, not speculation.
**Bar:** "Secure and reliable day 1" before any private beta with Launchabl.

---

## Executive summary

**Overall posture: solid foundations, fixable gaps.** The fundamentals are genuinely good: every one of the 174 API routes requires authentication and scopes data access to the user's workspace membership (zero missing-auth routes, zero direct IDOR found), credential encryption is sound AES-256-GCM with fail-closed key handling, Auth.js runs on secure defaults, and there is no SQL injection or command injection surface anywhere. Audit logging of business actions (deploys, purchases, role changes, kill-switches) is thorough.

The gaps are concentrated in **authentication hardening, fail-open defaults, and financial guardrails** — exactly the things that bite on day 1 of internet exposure. Nothing found is unfixable; most are small, well-scoped changes. The recommended day-1 must-fix list is at the bottom.

### The 5 most important findings

1. **[High] No brute-force protection on the admin credentials login** (`auth.ts:83-106`). The self-hosted admin login accepts unlimited password guesses with no throttling, lockout, or CAPTCHA — and failed attempts aren't even logged. A weak `ADMIN_PASSWORD` on an internet-exposed instance falls to a dictionary attack, yielding full owner access.
2. **[High] Resend webhook accepts unsigned payloads when `RESEND_WEBHOOK_SECRET` is unset** (`app/api/newsletter/webhooks/resend/route.ts:34-38`). Fail-open dev fallback: anyone can POST forged `email.bounced`/`email.complained` events and silently suppress real subscribers while polluting the audit log.
3. **[Medium] 12 cron routes let any signed-in viewer trigger workspace-wide sweeps** (e.g. `app/api/cron/newsletter/route.ts:32-42`, `cron/social/route.ts:30-39`, `cron/ads/route.ts:30-41`). The session path checks login but not role, so a read-only viewer can force-send scheduled newsletters early, publish queued social posts, or spend real Higgsfield money on ad jobs — deviating from the `cron/alerts` route, which already gates on editor+.
4. **[Medium] Spend guardrails have holes.** Editors can replace the Higgsfield API key and raise the monthly spend cap without bound (`app/api/ads/settings/route.ts:41,59,75`), contradicting the documented capability matrix ("connection credential CRUD stays admin+"). Separately, all spend caps are check-then-act races — N concurrent requests can overshoot the cap by N× per-op cost (`lib/ads/service.ts:179-189`, `lib/seo/backlink-pull.ts:220-240`).
5. **[Medium] SSO auto-provisioning trusts unverified email claims** (`lib/sso.ts:24-55`). Domain match on `email.endsWith(@SSO_DOMAIN)` grants workspace membership (configurably up to `owner`) without ever checking `email_verified` — a lax IdP lets an attacker assert someone else's address and walk in. Invites are likewise tokenless: whoever signs in with a matching email claims the pending invite (`lib/authz.ts:60-68`).

### Severity counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 8 |
| Low      | 14 |
| Info (verified clean / hardening notes) | 9 |

---

## Findings

### HIGH

#### H1 — No brute-force protection on the admin credentials login
- **File:** `auth.ts:83-106`
- **What's wrong:** The self-hosted admin login (`ADMIN_EMAIL`/`ADMIN_PASSWORD` env comparison at `POST /api/auth/callback/credentials`) has no per-IP throttling, no account lockout, no CAPTCHA. Auth.js v5 provides no built-in credential throttling, and none was added. There is no `middleware.ts` and no rate-limit code anywhere in `app/` or `lib/`.
- **Exploit:** On an internet-exposed instance, an attacker can run unlimited password guesses against the single privileged account. A weak `ADMIN_PASSWORD` falls quickly → full owner access to every workspace, connector credential, and deployment target.
- **Fix:** Add rate limiting on the auth callback (per-IP + per-account, exponential backoff/lockout); document a strong-password requirement for `ADMIN_PASSWORD`; add failed-login audit events (see M8).

#### H2 — Resend webhook fails open when `RESEND_WEBHOOK_SECRET` is unset
- **File:** `app/api/newsletter/webhooks/resend/route.ts:34-38`
- **What's wrong:** Svix signature verification only runs `if (secret)`. When the env var is unset, unsigned payloads are accepted with only a `console.warn` — the known M19 dev fallback, still present. No replay protection in the unsigned path either (timestamp checks live inside the secret-set branch).
- **Exploit:** Anyone who can reach the endpoint POSTs forged `email.bounced`/`email.complained` events; `handleResendWebhook` marks real subscribers unsubscribed and writes audit entries — silently suppressing legitimate recipients and polluting logs. This is a compliance-relevant flow (suppression lists).
- **Fix:** Fail closed — return 401 when `RESEND_WEBHOOK_SECRET` is unset in production; allow an explicit `ALLOW_UNSIGNED_WEBHOOKS=true` opt-in only for local dev.

### MEDIUM

#### M1 — 12 cron routes let any signed-in viewer trigger workspace sweeps
- **Files:** `app/api/cron/ads/route.ts:30-41`, `cron/autopilot/route.ts`, `cron/backlinks/route.ts`, `cron/decay/route.ts`, `cron/internal-links/route.ts`, `cron/local-competitors/route.ts`, `cron/local-grid/route.ts`, `cron/newsletter/route.ts:32-42`, `cron/radar/route.ts`, `cron/reviews/route.ts`, `cron/social/route.ts:30-39`, `cron/visibility-score/route.ts` (POST handlers)
- **What's wrong:** The pattern is `const user = isCron ? null : await requireUser()` with no `requireWorkspaceRole` on the session path — only the `CRON_SECRET` path is gated. `cron/alerts/route.ts:40-43` already requires `editor` for the same pattern ("viewers can't flush"), and `cron/fix-agent` / `cron/reports` have role checks, so these 12 deviate from the codebase's own convention.
- **Exploit:** A read-only `viewer` member can POST and force-run `runDueBroadcasts` (sends scheduled newsletters early), `runDueSocialPosts`, `runDueAdJobs` (spends real Higgsfield money), or burn DataForSEO/LLM quota on decay/radar/backlinks sweeps — actions the UI policy reserves for editors/admins.
- **Fix:** Mirror `cron/alerts`: require `requireWorkspaceRole(user.id, workspace.id, "editor")` on the session path in all 12.

#### M2 — Editor can manage the Higgsfield API key and raise the spend cap
- **Files:** `app/api/ads/settings/route.ts:41,59,75`; `app/api/ads/_lib.ts:21-26` (`requireWorkspaceEditor` = editor+); `lib/ads/service.ts:121-135` (`updateSpendCap` validates only non-negative finite — no upper bound)
- **What's wrong:** POST stores/replaces the encrypted Higgsfield key, PATCH changes `monthlyCapCents`, DELETE revokes — all editor+. The `lib/authz.ts` capability matrix documents "connection credential CRUD stays admin+".
- **Exploit:** A compromised or rogue editor sets the cap to billions and burns the workspace owner's Higgsfield credits via generations, or deletes the key (DoS on the ad pipeline). In agency settings, editors may be client staff — this is a real trust boundary.
- **Fix:** Require admin+ for POST/PATCH/DELETE on `/api/ads/settings`; add a sane upper bound to `updateSpendCap`.

#### M3 — Spend caps are check-then-act, not atomic
- **Files:** `lib/ads/service.ts:179-187` (check) → `:189` (record); `lib/seo/backlink-pull.ts:220-224` (check) → `:233-240` (paid calls, spend recorded after); same pattern in `lib/local/service.ts`
- **What's wrong:** Cap is read, then the paid operation runs, then spend is recorded — three separate steps. Cron-triggered jobs go through the same services (no bypass), but the race applies to them too.
- **Exploit:** N concurrent pull/generation requests all read spend-below-cap before any records spend; each proceeds, overshooting the monthly cap by up to N × per-op cost.
- **Fix:** Atomic conditional increment inside a transaction (`UPDATE … SET spend = spend + x WHERE spend + x <= cap`, reject on 0 rows affected).

#### M4 — SSO auto-provisioning trusts unverified email claims
- **Files:** `lib/sso.ts:24-55` (`provisionSsoUser`); `auth.ts:110-124` (signIn callback)
- **What's wrong:** Domain match (`email.endsWith(@SSO_DOMAIN)`) auto-joins the configured `SSO_WORKSPACE_ID` with `SSO_DEFAULT_ROLE`, but the code never checks `email_verified` on the OIDC/SAML profile, and `VALID_ROLES` permits `SSO_DEFAULT_ROLE=owner`.
- **Exploit:** With a lax or misconfigured IdP that doesn't verify email ownership, an attacker asserts `victim@SSO_DOMAIN` and is auto-provisioned into the workspace — as owner if the operator set `SSO_DEFAULT_ROLE=owner`.
- **Fix:** Require `email_verified === true` before provisioning; restrict `SSO_DEFAULT_ROLE` to viewer/editor/admin (never owner).

#### M5 — Invite flow: no token, no expiry, email-match claiming
- **Files:** `app/api/workspace/members/route.ts:77-100`; `lib/authz.ts:60-68` (`linkPendingInvites`)
- **What's wrong:** An "invite" is just a pending email row; whoever signs in with a matching email (via any configured provider) claims it. No single-use token, no expiry. Safe with Google (verifies email), risky with a generic OIDC IdP that doesn't.
- **Exploit:** Combined with M4's unverified-email issue, an attacker asserting an invited address claims the invite's role.
- **Fix:** Single-use invite tokens with expiry, claimed via token link instead of bare email match.

#### M6 — Authenticated SSRF in WordPress connector test flow
- **File:** `app/api/websites/wordpress/test/route.ts:35` → `lib/connectors/wordpress.ts:65`
- **What's wrong:** `baseUrl` from the request body is trimmed and passed straight into `new WordPressConnector(cfg)`, which does `fetch(`${this.base}/wp-json${path}`)`. No scheme validation, no host allowlist, no private-IP/metadata blocking anywhere in the codebase (zero hits for `169.254.169.254`, `allowlist`, `isPrivate`, or DNS-rebinding guards). The same connector is reused by the fix-agent and content-publish paths after a site is stored.
- **Exploit:** A project admin sets `baseUrl` to `http://169.254.169.254/latest/meta-data/...` or an internal `http://localhost:<port>/...`; the server fetches it and returns the response body in the info/error message.
- **Fix:** Validate `baseUrl`: require `http(s)://` scheme, resolve DNS and reject loopback/link-local/RFC1918/multicast, block `169.254.169.254` and `metadata.google.internal` explicitly, and re-resolve at request time (or pin the resolved IP via a custom agent) to defeat DNS rebinding. Centralize as `assertSafeUrl()` in `lib/`.

#### M7 — No Content-Security-Policy
- **File:** `next.config.ts:1-47`
- **What's wrong:** Headers include `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, a restrictive `Permissions-Policy`, and HSTS (correctly gated on `NEXTAUTH_URL` being https). CSP is explicitly deferred because Monaco loads editor assets from a CDN needing `unsafe-eval`.
- **Exploit:** Any stored-XSS sink that slips through (e.g. HTML in newsletters, site-file content in previews — `app/api/newsletter/preview/route.ts:28` returns raw rendered HTML) executes without CSP mitigation.
- **Fix:** Self-host Monaco assets, then ship a nonce-based strict CSP. This is the single biggest residual header gap.

#### M8 — Audit logging blind on authentication events
- **Files:** `auth.ts:128-143` (signIn callback — no audit), `auth.ts:104-114` (Credentials `authorize` returns null silently), `lib/authz.ts:62-68` (`linkPendingInvites` grants membership with zero audit trail), `lib/authz.ts:111-113` (`forbidden()` returns 403 without logging)
- **What's wrong:** Business-action audit coverage is good (member add/role change/remove, credential create/delete, BYO key add/revoke, `studio_domain_purchased`, autopilot kill/unkill, broadcast lifecycle, deploys). But there are no events for successful logins, **failed logins** (brute force is invisible — compounds H1), logouts, invite acceptance (a privilege-grant event), or 403 denials (blind to probing).
- **Exploit:** An attacker guessing passwords or probing endpoints leaves no server-side trace; incident response starts blind.
- **Fix:** Emit audit events on sign-in success, Credentials authorize success/failure, sign-out, `linkPendingInvites` grants, and 403 denials.

### LOW

#### L1 — `CRON_SECRET` bearer comparison is not timing-safe (all 15 cron routes)
- **File:** e.g. `app/api/cron/ads/route.ts:22-27` — `return header === \`Bearer ${secret}\``; no `crypto.timingSafeEqual` anywhere in `app/api/cron` or `lib`.
- **Exploit:** Theoretical timing side-channel on the secret comparison; low practical risk over network jitter.
- **Fix:** Hash both sides (e.g. SHA-256) and compare with `crypto.timingSafeEqual`. (Handling is otherwise good: fail-closed when unset — `if (!secret) return false`.)

#### L2 — Credentials password check is plain `===` and failures aren't logged
- **File:** `auth.ts:104-114` (`email === adminEmail && password === adminPassword`)
- **Exploit:** Minor timing side-channel; the bigger issue is the missing failure logging (covered in H1/M8).
- **Fix:** `timingSafeEqual` on fixed-length buffers + failed-login audit.

#### L3 — Unsubscribe tokens are `cuid()`, not CSPRNG
- **File:** `prisma/schema.prisma:1808` (`Subscriber.token @default(cuid())`); consumed in `lib/newsletter/service.ts:318`, `app/api/newsletter/unsubscribe/route.ts:37-53`
- **Exploit:** cuid v1 is timestamp+counter+random, not cryptographically random. Worst case: an attacker unsubscribes other people's addresses (nuisance, not data theft) — the token is the sole auth for a state-changing public endpoint.
- **Fix:** `crypto.randomUUID()` / `randomBytes(32)` for new subscriber tokens.

#### L4 — CSV formula injection in programmatic SEO export
- **File:** `app/api/programmatic/export/route.ts:15-18` (`csvCell()`)
- **What's wrong:** Cells are quoted/escaped for commas and quotes, but values starting with `=`, `+`, `-`, `@` (dataset titles/descriptions come from user-imported CSVs) are emitted verbatim.
- **Exploit:** An editor imports a dataset with a title like `=cmd|' /C calc'!A0`; another member downloads the export and opens it in Excel → formula execution on the victim's machine.
- **Fix:** Prefix any cell matching `/^[=+\-@]/` with a single quote or tab.

#### L5 — `javascript:` link schemes survive Tiptap→HTML rendering
- **File:** `lib/seo/programmatic.ts:297` — `<a href="${escapeHtml(href)}">`
- **What's wrong:** `escapeHtml` neutralizes markup but doesn't validate the URL scheme. A `javascript:…` link mark in a Tiptap node renders into published page HTML (and the `dangerouslySetInnerHTML` preview at `components/ProgrammaticStudio.tsx:1249`, which renders the user's own pages — self-XSS only there).
- **Exploit:** Published programmatic pages served to visitors contain clickable `javascript:` links. Low impact (requires victim click; content is authored by the site's own editors).
- **Fix:** In `renderInline`, allowlist `http(s):`, `mailto:`, `tel:`, and relative URLs; drop or neutralize anything else.

#### L6 — Telegram bot token path injection in alert adapter
- **File:** `lib/alerts/adapters.ts:94` — `` `${base}/bot${config.botToken}/sendMessage` ``; `validateChannelConfig` (`lib/alerts/channels.ts:22`) only checks non-empty
- **What's wrong:** User-supplied `botToken` interpolated into the URL path with no format validation. Hostname is pinned to `api.telegram.org` (env-overridable only), so this is path manipulation against Telegram's API, not true SSRF — limited attacker gain.
- **Fix:** Validate format `/^\d{5,}:[A-Za-z0-9_-]{30,}$/` in `validateChannelConfig`; `encodeURIComponent` the token.

#### L7 — Stored SVG logos: allowed but unhardened
- **File:** `app/api/brand-kits/[id]/logo/route.ts:27-51`
- **What's wrong:** SVG uploads allowed; extension derived from client-reported `file.type` (spoofable, though stored filename is `${id}${ext}` so no path traversal). Verified currently unexploitable: logos are consumed only as base64 data URIs in PDFs (`lib/pdf/generate.ts:70`) and as `<img src>` in newsletters (scripts don't run inside `<img>`); no static route serves the `logos/` dir.
- **Fix (defense in depth):** Verify magic bytes server-side instead of trusting `file.type`; if the dir is ever exposed statically, serve with `Content-Security-Policy: sandbox` or strip scripts/event handlers on upload.

#### L8 — No PKCE in Canva OAuth
- **File:** `lib/studio/service.ts:85-105` (the `CanvaPort` interface supports it; never generated)
- **What's wrong:** No `code_challenge`/`code_verifier` in the authorization flow. Defense-in-depth against authorization-code interception.
- **Fix:** Generate a verifier, store alongside the pending state (10-min TTL map already exists), send the challenge.

#### L9 — Canva disconnect doesn't revoke provider-side
- **File:** `lib/studio/canva.ts` (`revokeToken` is a documented no-op — Canva exposes no revocation endpoint)
- **What's wrong:** Tokens remain valid at Canva for up to ~4h after "disconnect". Local delete is the source of truth, but the UI doesn't say so.
- **Fix:** Make the UI explicit: "Disconnected in Marketr; Canva-side token expires within 4h."

#### L10 — JWT sessions can't be revoked server-side
- **File:** `auth.ts` (strategy `jwt`, 12h absolute maxAge); sign-out only clears the cookie
- **What's wrong:** A stolen JWT stays valid the full 12h. Standard JWT tradeoff, but there's no denylist and no "revoke all sessions" control.
- **Fix:** Document the tradeoff, or add a token-version/denylist table checked in the `jwt` callback.

#### L11 — Weak default DB password in `.env.example`
- **File:** `.env.example:8` — `POSTGRES_PASSWORD` ships a short guessable default that docker-compose uses verbatim
- **Exploit:** Operators who copy `.env.example` → `.env` without changing it get a guessable database password.
- **Fix:** Empty default + `openssl rand` generation instruction.

#### L12 — Admin can self-promote to owner
- **File:** `app/api/workspace/members/[id]/route.ts` (PATCH — no self-exclusion)
- **What's wrong:** An admin can grant themselves `owner`. Marginal (admins are already near-full), but role grants should be monotonic.
- **Fix:** Forbid self role-changes, or require owner+ for owner grants.

#### L13 — No rate limiting on LLM draft generation
- **File:** `app/api/content/draft/route.ts` (editor+, no throttle); `lib/usage.ts` metering is explicitly best-effort and doesn't gate
- **What's wrong:** An editor can burn the workspace's BYO LLM budget unchecked.
- **Fix:** Per-user/per-workspace rate limit or an LLM spend cap.

#### L14 — No schema validation library; manual validation only
- **Files:** all 174 `app/api/**/route.ts` — zero Zod/`safeParse` hits (Zod not in package.json)
- **What's wrong:** Nothing broken found — explicit field picking everywhere (no `...body` spreads), role allowlists (`VALID_ROLES` + last-owner guard in `app/api/workspace/members/route.ts`), email regexes, host/port checks on site creation. But manual validation at this scale is fragile (e.g. `readJsonBody` in `lib/sitefiles/api.ts:30` has no explicit size cap beyond Next.js defaults; type coercion done ad hoc).
- **Fix:** Adopt Zod for request schemas; add an explicit `MAX_BODY_BYTES` check in `readJsonBody`.

### INFO — verified clean / positive controls

- **SQL injection:** No `$queryRaw`, `$executeRaw`, or raw SQL strings anywhere. All Prisma query-builder with parameterized inputs.
- **Command injection:** No `child_process` (exec/spawn/sync) in `app/`, `lib/`, `scripts/`, or `components/`. PDF pipeline is Takumi WASM — no headless browser, no ffmpeg shell-outs. Zip extraction has verified zip-slip protection (`lib/connectors/zip.ts` → `sanitizePath` throws on `..`).
- **Credential crypto** (`lib/sitefiles/crypto.ts`): AES-256-GCM, random 12-byte IV per encryption, versioned `v1:iv:ct:tag` envelope, auth tag verified on decrypt, throws when `MARKETR_CREDENTIALS_KEY` unset (fail-closed). No AAD binding to workspace, single global key, no rotation — documented, KMS stub planned; acceptable for self-hosted.
- **No hardcoded secrets** in source; no secrets in `console.*` or audit logs (only non-sensitive hints like `••••a1b2c3d4`).
- **`AUTH_SECRET`:** Auth.js v5 throws `MissingSecret` in production when unset (verified in `node_modules/@auth/core`) — fail closed; `.env.example`/`DEPLOY.md` document `openssl rand -hex 32`.
- **Cookies:** Auth.js v5 defaults, no overrides — httpOnly, `SameSite=Lax`, `Secure` + `__Secure-` prefix over HTTPS. 12h absolute maxAge with no sliding extension.
- **CORS:** No `Access-Control-*` headers anywhere; no `middleware.ts` — API is same-origin only. Correct posture.
- **Cron auth:** Fail-closed when `CRON_SECRET` unset; POST-only, no GET variants; cron spend paths reuse the same cap-checked services.
- **Canva OAuth:** 24-byte random single-use state, 10-min TTL, bound to initiating user (`expectedUserId`); `redirect_uri` derived from request origin (no open redirect); tokens encrypted at rest; 5-min-early refresh; in-memory state map is a documented single-instance limitation.
- **No `allowDangerousEmailAccountLinking`** anywhere (n/a — JWT sessions, no adapter, no account linking).
- **SSRF-checked surfaces (clean):** Slack webhook pinned to `https://hooks.slack.com/`; Buffer/Canva/Porkbun/DataForSEO/Higgsfield/Vercel/Cloudflare/GitHub/Webflow all use constant API hostnames; Canva `import-canva` stores `downloadUrl` but never fetches server-side; no link-preview/unfurl fetching; no generic webhook channel type; report download reads only server-generated paths constrained to the workspace.
- **Dependencies:** `npm audit` could not run (sandbox registry policy denies the audit endpoint — `403 policy_denied`; nothing installed or modified). Fallback: queried OSV for all direct dependencies including `next@16.3.5`, `next-auth@5.0.0-beta.32`, `ssh2@1.17.0`, `adm-zip@0.6.1`, `diff@9.0.0`, `nodemailer@10.0.10`, `resend`, `@prisma/client@6.19.3`, `yjs`, tiptap — **0 known vulnerabilities in direct deps**. Caveat: transitive tree not covered; run `npm audit` in CI/on a real host.

---

## Day-1 remediation status (2026-09-22)

All 7 recommended must-fix items were remediated and fixture-verified. Baseline was commit `af93d50`; remediation landed in `fix(day1): security hardening + critical edge-case fixes`.

| Item | Finding | Status |
|---|---|---|
| 1 | Brute-force protection on `/login` (H1) + failed-login audit (M8) | ✅ Fixed — `lib/auth/rate-limit.ts`: independent per-account (5/hr) + per-IP (20/hr) limits, 15-min progressive lockout, timing-safe credential comparison, fail-open audit writes; `edge-platform-core.mts` login-rate-limit 7/7 |
| 2 | Fail-closed Resend webhook (H2) | ✅ Fixed — `lib/newsletter/webhook-auth.ts` extracted helper, 401 when no secret and no opt-in, explicit `ALLOW_UNSIGNED_WEBHOOKS=true` dev opt-in only; messaging webhook 3/3 |
| 3 | Editor-gate 12 cron session paths (M1) | ✅ Fixed — centralized `lib/cron/gate.ts`; correct `CRON_SECRET` = service actor, otherwise authenticated user, session path requires editor+ and is workspace-scoped; cron-gate 3/3 |
| 4 | Admin-gate Higgsfield key/cap management (M2) | ✅ Fixed — admin-only credential/spend settings + $10,000 monthly ad-spend cap |
| 5 | `email_verified` on SSO + tokenized invites (M4, M5) | ✅ Fixed — SSO requires `email_verified === true`, cannot mint owners (`SSO_DEFAULT_ROLE=owner` clamped to `editor`); tokenized expiring single-use invites + acceptance UI/API; platform sso 11/11, authz 40/40 |
| 6 | WordPress `baseUrl` SSRF validation (M6) | ✅ Fixed — centralized `lib/connectors/safe-fetch.ts` (pre-request validation, manual redirects, per-hop revalidation, redirect cap, injected fake DNS/fetch); all WP operations use it; `connectors/ssrf` 14/14 |
| 7 | Strong DB password default (L11) + `ADMIN_PASSWORD` docs | ✅ Fixed — stronger `.env.example` guidance |

Additional day-1 edge-case fixes (all 🔴/🟠 items in `docs/history/EDGE-CASE-REPORT.md` items 1–16) are also remediated and fixture-verified; see that report for details. Everything else from the audit (atomic spend caps hardening, CSP, PKCE, JWT revocation, Zod adoption) remains deferred post-beta hardening.

**Verification (2026-09-22):** `tsc --noEmit` clean; Next.js production build passed; `prisma format`/`validate`/`generate`/`migrate status`/`migrate deploy` all clean; all four edge fixtures run twice with identical deterministic counts.

---

## Recommended day-1 must-fix list (before private beta)

In priority order, all small and well-scoped:

1. **Brute-force protection on `/login`** (H1) + failed-login audit events (M8) — the single highest-risk gap on an internet-exposed instance.
2. **Fail-closed Resend webhook** (H2) — one `if` branch; prevents silent subscriber suppression.
3. **Editor-gate the 12 cron session paths** (M1) — mirror the existing `cron/alerts` pattern; prevents viewers from triggering spend/sends.
4. **Admin-gate Higgsfield key/cap management** (M2) — align with the documented capability matrix.
5. **`email_verified` check on SSO provisioning + tokenized invites** (M4, M5) — closes the identity-claiming hole.
6. **WordPress `baseUrl` SSRF validation** (M6) — `assertSafeUrl()` helper; the only true SSRF found.
7. **Strong DB password default** (L11) + document `ADMIN_PASSWORD` strength — two-line `.env.example` fix.

Everything else (atomic spend caps, CSP after Monaco self-hosting, PKCE, JWT revocation story, Zod adoption) is hardening for the weeks after beta, not beta-blockers.

---

## Caveats

- Static review only — no live PostgreSQL, no live third-party APIs; runtime behavior (e.g. actual Resend webhook delivery, real OAuth round-trips) is unverified, consistent with the rest of the project's mock-only verification posture.
- `npm audit` was blocked by sandbox registry policy; OSV fallback covered direct dependencies only.
- Findings reference the tree at commit `af93d50` (M22). No files were modified during this audit.
