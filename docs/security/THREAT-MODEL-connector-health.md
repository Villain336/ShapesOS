# Threat Model — Connector Health (Phase B, track B3)

**Written BEFORE code** (spec §5: threat-model → build → verify).
**Date:** 2026-09-22. **Status:** build input, not a post-hoc audit.

## Scope

`lib/connectors/health.ts` (checker + `runHealthChecks()`), three API routes
(`/api/connections/health`, `/api/connections/[id]/health`,
`/api/connections/[id]/check`), the Health tab in Settings → Connectors, the
`ConnectorHealth` table, and the `connector_error` alert/event emission path.

Trust boundary: everything in this workstream runs server-side with
decrypted-credential access. The health payload that crosses to the client is
a strict projection — status codes, timestamps, and sanitized hints only.

## Abuse cases

### 1. Health-check SSRF — never probe user-supplied URLs

**Threat:** A background checker that "verifies connectivity" by fetching a
connection's configured endpoint can be turned into a server-side request
forgery oracle. The most dangerous case is WordPress: `baseUrl` is
user-supplied, and an editor in workspace A could point it at
`http://169.254.169.254/` or an internal admin panel, then read the health
result ("healthy" vs "error") as a network-reachability oracle — or worse,
have the server send an `Authorization` header to an attacker host.

**Decision:** the checker performs **zero network probes to user-configured
URLs**. Health is derived from credential/token lifecycle state the server
already holds:

- adapter live-wiring flag (code, not user input),
- `ConnectorConnection.status` (active / needs_reauth / revoked),
- OAuth token `expires_at` from the decrypted credential payload,
- the existing silent-refresh flow (`lib/vault/refresh.ts`), which talks
  only to provider token endpoints — never to user-configured hosts.

A connection is never marked `healthy` because a fetch to a user URL
succeeded. For `api_key` adapters there is no safe offline verification, so
the checker reports `unknown` ("no successful sync recorded yet") rather
than inventing confidence. `safeFetch` (SSRF-safe) exists for WordPress
operations, but the checker deliberately does not use it — no new request
surface is added at all.

**Phase 4b addendum (manual check only):** `POST /api/connections/[id]/check`
may pass `liveCheck` (`lib/connectors/m21/live/probe.ts`), which asks a
live-wired OAuth adapter for ONE cheap call to its fixed provider endpoint
(GSC sites list, GA4 account summaries, Drive `about`, Notion `users/me`,
Meta `/me`, Google Ads `listAccessibleCustomers`, GBP accounts). The host is
a code constant, never connection data, so this adds no SSRF surface; the
result is reduced to a closed code before it reaches the checker. The
scheduled `runHealthChecks()` never passes `liveCheck`.

### 2. Token/secret leakage into health payloads or error messages

**Threat:** Health results are readable by any workspace viewer. If the
checker returns a raw provider error (`invalid_grant: ...`, HTTP bodies,
stack traces) or logs the decrypted credential, tokens / API keys leak into
the `ConnectorHealth` row, the audit log, alert channels (email/webhook),
or server logs.

**Mitigations:**

- Error mapping is a **closed set**: every failure is classified to one of
  `expired_token | auth_rejected | provider_unreachable | config_missing |
  mock_adapter | unknown_error`. Raw messages are never persisted or
  returned.
- Defense in depth: `sanitizeHealthError()` strips token-shaped material
  (regexes for `access_token`/`api_key`/Bearer patterns) before mapping, in
  case a provider echoes credential material in an error body.
- Decrypted payloads are used in-memory only (token expiry check), never
  written to `ConnectorHealth`, never logged, never included in the API
  projection. The API serializer is an explicit allow-list, not a Prisma
  passthrough.
- `lastError` stores the **code + plain-language fix hint**, never the raw
  error.

### 3. Alert spam / notification fatigue as a DoS vector

**Threat:** A flapping connector (bad key, provider outage) could emit an
alert per check cycle — burying real alerts, hammering alert channels
(email/webhook/Slack), and becoming a cost/noise DoS against the workspace.

**Mitigations (two layers):**

- **Checker-side cooldown, escalating:** `ConnectorHealth` tracks
  `lastAlertAt` + `consecutiveErrors`. Alerts fire at most once per
  connection per status episode; error alerts back off exponentially
  (15 min → 1 h → 6 h → 24 h cap). A status change resets the counter. A
  stuck/flapping connector cannot send more than a bounded handful of
  alerts per day.
- **Alert-hub dedup:** `connector_error` is emitted via the existing
  `emitAlert()` path with a per-connection+status `dedupKey`, so workspace
  alert rules with cooldowns/digests/quiet-hours apply on top.
  No raw emails or webhooks are sent by the checker itself.

### 4. Status spoofing across workspaces (IDOR)

**Threat:** A member of workspace A crafts requests to read or trigger
health checks for workspace B's connections, learning which integrations a
competitor/agency-client uses, or forcing refresh attempts against B's
tokens (a refresh-storm side effect).

**Mitigations:**

- Every route resolves the connection by `{ id, workspaceId }` — never by
  `id` alone. `workspaceId` comes from the query param and is verified
  against the caller's membership (`requireWorkspaceAccess` / owner-or-admin
  check, same family the M11 scanner recognizes).
- The workspace summary route queries connections **by workspaceId first**,
  then left-joins health rows. There is no endpoint that takes an arbitrary
  connection id without a workspace scoping check.
- `runHealthChecks()` is a library function (scheduler invokes it), not an
  HTTP endpoint — no unauthenticated trigger surface.
- The manual "check now" POST requires connection-owner-or-admin, matching
  the existing refresh route's gate (refreshing someone else's OAuth token
  is a sensitive action).

### 5. Re-auth CSRF

**Threat:** If "Reconnect" were a state-changing GET (or a POST without
proper gating), an attacker could drive a victim's browser to initiate OAuth
flows or token refreshes cross-site.

**Mitigations:**

- The Health tab's "Reconnect" button **deep-links the existing OAuth
  connect flow** (`/api/connectors/[key]/auth-url` → provider). No new OAuth
  endpoints are built; the existing flow's signed-state CSRF protection is
  reused, not reimplemented.
- The manual check endpoint is POST-only, auth-gated, owner/admin-gated.
- Health checks never mint, rotate, or transmit tokens except through the
  existing silent-refresh code path (server-to-provider, no browser).

## Residual risks (accepted, documented)

- **Honest blind spots:** mock-only adapters report `unknown` forever (no
  live wiring exists to check; since Phase 4b there are 0 — all 14
  built-ins are live-wired), and `api_key` adapters report `unknown`
  until a successful sync is recorded. This is deliberate: faking green is
  worse than admitting ignorance. Tico owns live adapter wiring separately.
- **Token-expiry check is provider-trust:** a non-expired OAuth token may
  still be revoked at the provider; the checker reports `healthy` based on
  lifecycle state, not a live probe. Labeled as such.
- **In-memory rate limiting (Phase A) applies to the new routes** — fine for
  single-instance; multi-instance needs the shared store noted in Phase A.
