# THREAT-MODEL-MCP — Marketr as MCP server (Phase C, W5)

Author: Z7 (build agent). Date: 2026-09-22. Status: written BEFORE code (spec §5 gate).

## Scope

`lib/mcp/` (auth, protocol, tools, OAuth 2.1 + DCR), `POST /mcp` (streamable HTTP,
hand-rolled JSON-RPC — see T11), API routes under `app/api/mcp/`, consent screen
`app/mcp/authorize/page.tsx`, settings UI `components/settings/McpManager.tsx`.
Consumes the sibling metering track's `meter()` / `getUsageSummary()` via dynamic
import with fail-closed fallback. Does NOT touch `lib/metering/` or its migration.

Out of scope: MCP *client* inside Marketr (explicit non-goal, spec §9); live vendor
executions (tools return honest mock / "live unavailable" results).

## Trust boundaries

1. **Unauthenticated internet** → `/mcp`, DCR register, token endpoint.
2. **API-key bearer** (`mcpk_...`) → `/mcp` with per-key scopes.
3. **OAuth access token** (DCR flow) → `/mcp` with granted scopes.
4. **Signed-in Marketr session** → key management UI/API, consent screen.
5. **Marketr server internals** (Prisma, metering service) — trusted.

## Assets

Workspace data (projects, rankings, keywords, audits, briefs, scheduled skills,
usage ledger), API key material, OAuth codes/tokens, metering integrity (no free
rides), audit trail integrity.

## Abuse cases

### T1 — Tenant confusion (workspaceId smuggled in tool arguments)
*Attack:* caller passes `workspaceId: "<victim>"` in `tools/call` arguments to
read another workspace's projects/rankings.
*Mitigations (all must hold):*
- The `workspaceId` argument is **never read** from tool input. Every handler
  receives `ctx.workspaceId` derived from the auth context (API key row or OAuth
  token row) at request entry.
- Zod schemas for tool args do not declare `workspaceId`; an injected field is
  stripped/ignored (`z.object(...).strict()` where feasible — unknown keys throw).
- Defense in depth: every Prisma query in every handler is `where: { workspaceId:
  ctx.workspaceId }`; shared across all 10 tools via the tool-runner wrapper, not
  per-handler discipline.
*Tests:* cross-tenant `tools/call` with forged `workspaceId` returns only the
caller's workspace rows; strict-schema rejection logged.

### T2 — Scope escalation (key with `tools:list_projects` calls `get_usage_summary`)
*Attack:* a least-privilege key calls a tool outside its granted scopes.
*Mitigations:*
- Scopes are per-tool (`tools:<name>`); the runner checks `key.scopes.includes(
  requiredScope(tool))` before metering or execution — a failed check runs nothing.
- Scope names are fixed constants; no wildcards, no prefix matching, no `*`.
- Consent screen and key-creation UI render the exact scope list being granted.
*Tests:* key with only `tools:list_projects` calling `get_usage_summary` →
JSON-RPC error, no meter charge, no audit "executed" row (denial is audited too).

### T3 — Key leakage via tool descriptions, logs, error messages
*Attack:* raw key material surfaces in a tool description served to the model,
in server logs, or in an error string echoed to the client.
*Mitigations:*
- Tool descriptions are static strings reviewed at build time; they contain no
  key material, no hashes, no prefixes beyond the public `mcpk_` prefix.
- Only the key *prefix* (for identification) and key *id* appear in logs/audit;
  never the raw key, never the hash.
- Creation response shows the raw key **once**; it is never retrievable again.
- Error messages to MCP clients are generic (`"authentication failed"`); detailed
  reasons (revoked vs expired vs unknown) go to server logs only — and even there,
  never with key material.
*Tests:* create-key response scanned for raw key appearing on a second GET;
log capture during auth failures contains no `mcpk_` secret segment.

### T4 — Rate-limit bypass
*Attack:* hammering `/mcp` or the DCR/token endpoints; rotating keys to multiply
quota; shared-IP keying that one key's abuse exhausts for others.
*Mitigations:*
- Per-key fixed-window limiter (`lib/mcp/rateLimit.ts`): default 60 calls/min per
  key/client, bounded map (10k entries, oldest evicted) so the limiter can't be a
  memory-exhaustion vector. Keyed by keyId/clientId, NOT by IP — rotating keys
  doesn't multiply one key's budget, and one abuser doesn't burn another's.
- DCR register and token endpoints have their own stricter limiter (10/min/IP)
  since they are pre-auth.
- `429` responses carry `Retry-After`; denied calls are not metered.
- Single-instance in-memory stance is documented (same as `lib/api/rate-limit.ts`);
  front with Redis for replicas.
*Tests:* 61st call within the window → JSON-RPC rate-limit error; separate keys
have independent budgets.

### T5 — DCR abuse (redirect_uri validation, open redirect)
*Attack:* registering `redirect_uri: "https://evil.example/cb"` or
`https://marketr.example\@evil.example` to steal authorization codes.
*Design decision (2026-09-22):* DCR is **public by design** per RFC 7591 — no
session required at registration. Registration creates an opaque client id and
binds NOTHING (no workspace, no token, no secret). The client stays unowned
(`user_id NULL`) until the first consent approval, which **claims ownership**
(first approver wins; a different user can never hijack a claimed client).
The dangerous steps (code issuance, token minting) require the signed-in user's
explicit approval, and codes go only to the exact registered redirect_uri.
*Mitigations:*
- `redirect_uris` must be absolute HTTPS URLs (http allowed only for
  `http://localhost` / `http://127.0.0.1` loopback per RFC 8252); no fragments,
  no credentials in userinfo, hostname must parse and not be an IP outside
  loopback... (loopback only for http; https IPs rejected).
- At authorize time, the requested `redirect_uri` must **exactly match** a
  registered URI for that clientId; mismatch → hard error page, no redirect.
- Codes are single-use, 10-minute expiry, bound to the exact redirect_uri.
- `state` is echoed opaquely; we never redirect to a URI we didn't store.
- Client revocation: owner or workspace admin can DELETE the client; all its
  codes and tokens are deleted (token lookup is by hash, so outstanding
  tokens die immediately).
*Tests:* DCR with `javascript:` and user-info URIs → 400; public DCR with null
owner accepted and unowned; authorize with unregistered redirect_uri → error
page, no 302 to attacker; first approver claims ownership; second user approval
rejected (no hijack).

### T6 — Token replay / code replay
*Attack:* replaying a stolen authorization code or access token; using a code
issued for client A at client B; two concurrent exchanges of the same code.
*Mitigations:*
- Codes: single-use enforced **race-safely** — the code row is claimed with a
  single conditional `updateMany` (`used=false` AND unexpired); concurrent
  exchanges race on that atomic statement and exactly one wins. 10-min expiry,
  bound to `client_id` + exact `redirect_uri`; PKCE (`S256`) verified when a
  challenge was registered.
- Tokens: random 256-bit, stored as SHA-256 hash only; bound to one workspaceId
  + scope set; 1-hour expiry; no refresh tokens in v1 (re-run the code flow).
- Token auth uses constant-time comparison of hashes.
*Tests:* double code exchange → second fails; **concurrent** double exchange
(Promise.all) → exactly one winner, one token minted; token for workspace A
used with a key... (tokens don't take workspace args — see T1) can't cross
tenants; expired token rejected.

### T7 — Consent-screen scope misrepresentation
*Attack:* the consent page shows "read projects" but the token is minted with
`tools:run_seo_audit` (scope swap between display and issuance).
*Mitigations:*
- The authorize flow stores the **requested scope set** server-side (in the
  pending authorization record / signed session state), not in a client-mutable
  hidden field. The consent POST approves/denies that stored set; the code is
  minted with exactly the stored set. The consent page renders from the same
  stored set.
- Unknown scope strings are rejected at authorize time (400), never minted.
*Tests:* tampered scope parameter in the consent POST is ignored; minted code
scopes == displayed scopes == requested scopes.

### T8 — Disabled-workspace access
*Attack:* calling `/mcp` with a valid key after the admin disabled MCP for the
workspace (or deleted the workspace).
*Mitigations:*
- `mcpEnabled` is read from the workspace row on **every** `/mcp` request (no
  caching); disabled → `403 mcp_disabled` before any tool logic, before metering.
- Key creation/listing APIs also 404 when disabled (no key management surface
  while off).
- Revoked keys and deleted workspaces fail at the same gate.
*Tests:* valid key + `mcpEnabled=false` → 403; enable → 200; disable → 403 again.

### T9 — Unmetered execution (metering service unavailable)
*Attack/failure:* `lib/metering/service` fails to import (sibling track not yet
deployed) or `meter()` throws → tool runs for free, ledger silently diverges.
*Mitigations:*
- Dynamic `import("@/lib/metering/service")` inside a try/catch; if the module
  or `meter` is missing, the tool call fails **closed** with a plain
  `"metering unavailable"` error — the handler never runs.
- If `meter()` resolves `{ ok: false }` (cap exceeded / unknown action), the
  call fails closed with the reason; no execution.
- Metering happens BEFORE the handler, with a unique idempotency key per call
  (`mcp:<call-uuid>`); a retry with the same JSON-RPC `id` does not double-charge
  (idempotency key is per transport call, documented).
- `get_usage_summary` is itself a tool: it calls `getUsageSummary()` read-only;
  if unavailable it fails closed too (never returns fabricated numbers).
*Tests:* metering module stubbed to throw → tool call errors, handler spy not
invoked; `meter()` returning `{ ok:false, reason:"cap_exceeded" }` → error, no
execution; audit row records the denial.

### T10 — Audit evasion / tag forgery
*Attack:* an MCP call executes without an audit row, or with forged tenant tags.
*Mitigations:*
- **Every** authenticated MCP RPC is audited, not just tool calls: `initialize`
  and `tools/list` write `mcp_rpc` rows; tool calls write `mcp_tool_called` /
  `mcp_tool_denied`; disabled-workspace and rate-limited rejections are logged
  as denials. The tool runner writes the audit row from `ctx` (server-derived),
  never from tool args; both successes and denials are logged.
- Audit writes use the same fail-swallowing convention as `lib/auditlog.ts`
  (audit must not break the tool), but a periodic reconciliation... (v1: best
  effort, documented; the ledger's UsageEvent is the billing source of truth).
- Summaries contain tool name, keyId/clientId, workspaceId, credits charged —
  no key material (T3).
*Tests:* every battery case asserts a matching `FileChangeLog` row with
`filePath` starting `mcp:` and correct tenant tags; initialize/tools/list
produce `mcp_rpc` rows.

### T11 — Protocol confusion (hand-rolled JSON-RPC)
*Decision:* the official SDK's `StreamableHTTPServerTransport` binds to Node
`IncomingMessage`/`ServerResponse`, which Next.js App Router route handlers don't
expose. v1 hand-rolls JSON-RPC 2.0 for `initialize`, `notifications/initialized`,
`tools/list`, `tools/call` over `POST /mcp` (plain JSON responses — legal
streamable-HTTP). Risks: batch requests, `Accept: text/event-stream` negotiation,
protocolVersion mismatch. Mitigations: strict JSON-RPC shape validation
(version/id/method), batch requests rejected with a clear error (single-call
only, documented), unknown methods → `-32601`, `protocolVersion` echoed from the
client's supported list (`2025-06-18`, `2025-03-26`). Revisit with the SDK
transport if we need SSE resumability. The `/mcp` route is outside `app/api`,
so the M11 scanner's route-coverage walk doesn't see it — auth is still enforced
in code and the battery covers it; the new `requireMcpAuth` helper is added to
the scanner's primitive list for the `app/api/mcp/*` management routes.

### T12 — Prompt/tool-description injection downstream (noted, accepted)
Tool descriptions are served to untrusted models; a compromised client could
misrender them. Descriptions are static, secret-free (T3), and treated as
untrusted input downstream per spec §6.4. No dynamic content in descriptions.

### T13 — Rate-limit bypass via multi-instance desync
*Attack:* two (or N) app instances behind a load balancer each run an
in-memory limiter: each allows 60 calls/min per credential, so the effective
budget is 60×N. An attacker who can fan out across instances multiplies quota.
*Mitigations:*
- Pluggable limiter (`lib/mcp/rateLimit.ts`): `InMemoryRateLimiter` (kept as
  the single-box/self-host default — behavior unchanged) plus
  `PostgresRateLimiter` (windowed counters in `mcp_rate_limits`, incremented
  with a single atomic `INSERT ... ON CONFLICT DO UPDATE` statement so
  concurrent instances serialize on the row and agree on the count).
- Selection via `MCP_RATE_LIMITER=postgres|memory` (default `memory`, preserving
  current behavior); hosted/multi-box deployments MUST set `postgres`
  (documented at the top of rateLimit.ts and in the settings UI copy).
- Buckets keyed by credential id, not IP (same as T4); pre-auth limiter
  unchanged in keying, now sharing the pluggable backend.
- Expired windows are cleaned opportunistically (every 128th check) plus an
  exported `cleanupRateLimits()`; the table cannot grow unboundedly.
*Tests:* two limiter instances × 70 concurrent checks on one bucket → exactly
60 allowed total (no double-count from races); `MCP_RATE_LIMITER` unset/bogus →
memory limiter; stale rows removed by cleanup, current-window rows kept.

### T14 — OAuth consent workspace-picker privilege escalation
*Attack:* the approver posts `workspaceId` of a workspace they do not belong
to, binding the OAuth token to a foreign tenant (cross-tenant token mint).
*Mitigations:*
- The picker lists ONLY `getAccessibleWorkspaces(userId)` (owner OR member).
- The `select` POST never trusts the posted id: membership is re-checked
  against a fresh DB query; failure → 403 `workspace_not_accessible`, no
  re-sealed grant issued.
- The final `approve` POST re-checks membership for the workspace sealed in
  the grant (the user could have been removed between select and approve).
- `approveAuthorization` still mints the code from server-verified values only.
*Tests:* select with a foreign workspaceId → rejected; approve after the
membership row is deleted → rejected; minted code's workspaceId == the
selected (and accessible) workspace.

### T15 — Sealed-grant workspace tampering
*Attack:* attacker flips bytes in the re-sealed grant to swap `workspaceId`
after the select step ("workspace swapped post-seal").
*Mitigations:*
- The grant is AES-256-GCM sealed (`secrets()`); any modification breaks
  authentication → decrypt throws → `400 invalid_grant`, fail closed.
- The approve step requires `pending.workspaceId` to be a non-empty string
  that round-tripped through the seal — a grant from the pre-picker era
  (no workspaceId) cannot approve.
*Tests:* byte-flipped bound grant → `invalid_grant`; structurally valid grant
with `workspaceId` deleted → rejected; valid bound grant approves exactly
once for the bound workspace.

### T16 — byKey usage enumeration across keys
*Attack:* `getUsageSummary().byKey` maps key id → credits. If exposed broadly,
it leaks which keys are active and their relative traffic.
*Mitigations:*
- `byKey` is keyed on the stable opaque key **id** (cuid), never the name,
  prefix, or hash — renaming a key doesn't fork its history, and no secret
  material is involved.
- The only consumer is the admin-gated `GET /api/mcp/keys` (server-side
  `requireWorkspaceRole(..., "admin")`); the MCP `get_usage_summary` tool
  returns the summary to the caller but per-key attribution is a
  workspace-admin concern, not a per-key-holder one.
- Revoked keys keep historical attribution (join on id); deleting a key row
  is a hard delete and drops its future attribution — documented.
*Tests:* non-admin `GET /api/mcp/keys` → 403 (existing M11 coverage);
revoked key id present in `byKey` still resolves to a usage number.

### T17 — New tools: analyze_serp / research_keywords (standalone paths)

*Attack/abuse:* the two new tools expose live-vendor primitives to agents.
`research_keywords` costs 40 credits per call via passthrough — an agent
loop (or a compromised client) can burn budget fast; `analyze_serp` at 1
credit is cheap enough to hammer for SERP scraping via the MCP surface.

*Mitigations:*
- Same gates as every tool: strict zod schemas (no `workspaceId` in args —
  T1), per-tool scope check (`tools:analyze_serp`, `tools:research_keywords`)
  before metering or execution (T2), metering BEFORE the handler via
  `meterToolCall` with the underlying action key (`serp_analysis`,
  `keyword_research` — T9), per-key rate limits (T4/T13), and a capped
  workspace fails the call closed before execution.
- Cost asymmetry is explicit in the tool descriptions served to the model
  ("Costs 40 credits") and in the scope labels on the consent screen, so a
  key grant is informed. The 40-credit figure comes from the credit table
  via `TOOL_CREDIT_PASSTHROUGH`, not a hardcoded string — table and tools
  cannot drift.
- Handlers call the same un-metered cores as the REST routes
  (`analyzeSerp` / `researchKeywords` lib functions); the tool's single
  passthrough charge is the only ledger write (T14 — no double charge).
- `research_keywords` is the fuller task (volumes + clustered ideas);
  `get_keyword_ideas` is kept unchanged for the lighter expansion.
- Mock honesty (T12/residual): in this environment the vendor is
  unavailable, so both tools return clearly-labeled mock results
  (`live: false, mock: true`) — never fabricated data presented as real.

*Tests:* scope-denied call → no charge, no execution; keyId attribution
present on the passthrough event; capped workspace → denied before
execution; mock flag present in results.

## Residual risks (accepted, documented)
- In-memory rate limiting remains the default and is single-instance; hosted
  multi-box deployments must set `MCP_RATE_LIMITER=postgres` (documented).
- No refresh tokens in v1; OAuth tokens live 1 hour.
- `degraded` connector-style honesty: vendor-backed tools return
  clearly-labeled mock data or "live unavailable" only when the underlying
  provider is the mock one — never fabricated data presented as real.
- Phase 6: `run_seo_audit` and `get_keyword_ideas` call the same real
  implementations as the chat tools — `lib/audit/project-audit.ts`
  (`runAudit`, real file scan; labelled mock only for demo sites) and
  `getSeoProvider().keywordIdeas` (DataForSEO when configured, labelled
  mock otherwise). The runner's single pre-execution charge stays the only
  ledger write: `runAudit` is called with `skipMetering` so `site_audit` is
  not charged twice (T14); `serp_calls` usage is recorded like the in-app
  paths.
- Sibling contract risk: `meter()`'s per-tool passthrough semantics are
  defined by the metering track; we pass the UNDERLYING action key (e.g.
  `action: "rank_check"` for `get_rank_report`) with `evidenceRef:
  "mcp:<tool>"` documenting the passthrough, and `keyId` for per-key
  attribution. `"mcp_tool_call"` is never the ledger action — it costs
  zero in the credit table. If the sibling's table resolves differently,
  the integrator must reconcile.
