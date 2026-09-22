# Marketr Batch Spec: Hardening + Scheduled Skills + Workspace Filesystem + Metering + MCP Server

**Status:** DRAFT — awaiting Tico's approval. No code until approved.
**Date:** 2026-09-22
**Decisions locked by Tico:** build order (hardening → filesystem+scheduler → metering+MCP); scheduler = unified trigger engine (cron + event triggers, user-editable) **with parallel subagents**; filesystem = S3-compatible day one + UI file manager, strictly workspace-scoped; metering = seat + marketing-action credits (units the market understands); MCP server = API keys + OAuth 2.1/DCR; hardening covers the new builds, not just fixes 3–6.

## 1. Problem

Marketr's platform layer (skills, connectors, settings — M21) is built but not yet battle-ready: no end-to-end test coverage on the new flows, one open security-scan finding, an upload path without type enforcement, and unaudited rate limits. On top of that, four capabilities are missing that the product needs to retain and monetize users: skills can't run on schedules or react to events; every workspace's skills, memory, artifacts, and files live in ad-hoc storage with no unified, secure home; the hosted SaaS has no usage metering to support its $29/$79/$199 tiers; and Marketr can't be called from outside (Claude, ChatGPT, other agents), leaving distribution on the table.

## 2. Target user

- **Mara, the agency owner** (primary): runs 10–30 client projects in Marketr's white-label tier. She needs per-client cost attribution (chargeback), scheduled reporting she can forward to clients, and proof that client data never leaks across workspaces.
- **Devon, the founder** (secondary): self-serve Pro user doing his own SEO. He needs to understand what he's paying for in marketing terms (not tokens), set a budget cap, and connect Marketr to the AI tools he already uses.

Both use the product today through the dashboard; both churn if they can't trust it (security, billing surprises) or automate it (schedules, external access).

## 3. The idea

Five workstreams, one batch: (1) harden the platform — E2E tests, kill the open scan finding, lock down uploads, audit rate limits — **and threat-model + harden each new build as it's built**; (2) a unified trigger engine where skills run on cron schedules or event triggers, fanning out to parallel subagents when a job splits; (3) a private per-workspace filesystem (UI file manager) that unifies skills, memory, artifacts, and files behind a workspace-scoped registry; (4) hosted metering in marketing-action credits with an immutable ledger, spend caps, and per-project dashboards; (5) Marketr as an MCP server — API keys for developers, OAuth 2.1 for public clients, a tight set of task-oriented tools.

The one-liner: **Marketr becomes the secure, metered, automatable marketing OS — scheduled, file-backed, billed fairly, and callable from any AI agent.**

## 4. Why now

The M21 platform layer just landed — hardening now is 10× cheaper than after users arrive. The landscape research (~/workspace/marketr/research/, 2026-09-22) shows the patterns are settled, not speculative: OAuth 2.1 + DCR is what Linear/Notion/Stripe converged on; hybrid seat+credits is where Cursor/Copilot/Agentforce converged; the DB registry (not folder prefixes) is the real multi-tenant isolation boundary. Building to settled patterns now avoids a rewrite later. Distribution-wise, every week Marketr isn't an MCP server is a week competitors absorb the agent-to-agent traffic.

## 5. Build phases (locked order)

- **Phase A — Hardening (fixes 3–6):** E2E suite, m11 scan finding killed, upload safety, rate-limit + validation audit.
- **Phase B — Filesystem + Scheduler + Connector health:** filesystem first (the scheduler stores run outputs there), then the trigger engine with parallel subagents, then the connector health dashboard.
- **Phase C — Metering + MCP server:** metering ledger first (MCP tool calls are metered from day one), then the MCP server.
- Each phase: threat-model → build → verify (automated checks + adversarial tests) → local commit. Nothing moves to the next phase with open critical findings.

## 6. Core user flows

### W1 — Hardening (Phase A)
1. **E2E suite (new `scripts/e2e/` Playwright suite, runs against local preview):** seed script creates an E2E workspace with admin + editor users and a demo project → suite walks: workspace settings (all 9 pages render + save), project settings (6 tabs), connector connect flow against the mock OAuth provider, skill install from URL (SHA-pinned) + skill upload, file attach in chat → every step asserts HTTP 200, no console errors, and audit rows written. Suite runs headless; failure blocks the phase.
2. **m11 scan finding:** the flagged routes get the missing RBAC checks (same `requireProjectRole` pattern as M21 routes); the static scan re-runs green and stays as a CI gate — the alarm is kept, the holes are closed.
3. **Upload safety:** user attaches a file in chat or the file manager → server checks MIME allow-list (images, PDF, txt/md/csv, common office formats) → verifies magic bytes (extension alone is not trusted) → enforces 25MB cap → passes bytes through the malware-scan hook (pluggable; ClamAV adapter for self-host, no-op stub with a logged warning when unconfigured) → clean files land in the workspace filesystem `/files`, failures are quarantined, rejected with a plain-language message, and audit-logged.
4. **Rate-limit + validation audit:** inventory every API route (211+) → apply tiered limits (auth: 10/min/IP; reads: 120/min/user; writes: 60/min/user; AI/skill executions: 20/min/user; MCP: per-key limits) → zod schemas on all M21 routes that lack them → adversarial test battery (oversize bodies, type confusion, deep nesting) must all 400/429 cleanly.
5. **Harden the new builds (applies to W2–W5):** before each workstream's code, a written threat model names the abuse cases (listed in §12); each workstream ships with adversarial tests for its abuse cases green. Security is a phase-gate, not a follow-up.

### W2 — Scheduled skills + parallel subagents + connector health (Phase B)
1. **Create a schedule:** Automations → Schedules → New → pick a skill (only skills enabled for the project) → choose trigger: cron (UI builder: daily/weekly/monthly + custom expression) or event (rank drop > N positions, new backlink detected, connector error, decay flag raised, content published) → set scope (project), approval mode (inherits the skill's trust ladder: supervised = notify + wait, scheduled = run + report, autopilot = run silently) → save. The schedule appears in the list with next-run time.
2. **Trigger fires:** engine loads the schedule, checks the actor's grants (`skills.install` holders and admins can create; project editors can create project-scoped) → runs the skill through the agent loop with declared-tool gating (unchanged from M21) → run history records status, duration, credits used, and output.
3. **Parallel fan-out:** if the skill run decomposes into independent subtasks (e.g., rank report = per-keyword-cluster checks), the engine fans out to subagents up to the workspace concurrency cap (default 4, admin-configurable) → each subagent run is separately audited and credit-metered → results aggregate into one report → outputs written to the workspace filesystem `/artifacts/runs/<run-id>/`.
4. **User edits:** pause/resume/edit/delete any schedule; per-run detail view shows timeline, subagent breakdown, cost, and the exact outputs; event triggers show the firing event payload.
5. **Connector health:** Settings → Connectors → Health tab: every connection shows status (healthy / degraded / needs_reauth / error), last successful sync, quota usage where the provider reports it, and last error with a plain-language fix hint → "Reconnect" deep-links the OAuth flow; admins get notified on `needs_reauth` and repeated errors per notification settings.

### W3 — Workspace filesystem (Phase B, built before W2's engine)
1. **Open the file manager:** Dashboard → Files → workspace tree with four roots: `/skills` (installed skill packs), `/memory` (agent memory), `/artifacts` (generated reports, site builds, run outputs), `/files` (uploads + Drive/Notion references). Strictly workspace-scoped — no UI path ever lists another workspace's tree, and every API call re-checks `workspace_id`.
2. **Upload:** drag-and-drop or picker → goes through the W1 upload-safety pipeline → lands in `/files` (or a chosen folder) → shows in chat attach picker immediately.
3. **Skills and agents use it:** installed skills live at `/skills/<skill-id>/SKILL.md`; skill runs read/write only inside their granted roots via scoped FS tools; chat attachments reference `/files/<id>`; the IDE reads/writes project working files under `/artifacts`.
4. **Manage:** rename, move, delete (trash with 30-day retention, then purge), per-workspace quota meter in settings (default 10 GB, admin-configurable), download.
5. **Storage:** self-host single box = local disk adapter; hosted / multi-box = S3-compatible (MinIO bundled in compose for self-host). Same code path; the DB registry (`WorkspaceFile`) is the isolation boundary every operation passes through. Storage keys are content-addressed UUIDs — user filenames never appear in paths.

### W4 — Hosted metering (Phase C, ledger before anything bills)
1. **Usage happens:** any metered action (keyword lookup, rank check, AI content generation, publish, skill run, subagent run, MCP tool call, file storage GB-days) appends an immutable `UsageEvent` (workspace, project, actor, action, credits, idempotency key, evidence ref) to the ledger. Self-hosted records locally with no enforcement dependency on Stripe.
2. **User sees cost:** Settings → Usage: per-workspace dashboard (credits used vs included, by action, by project), per-project views for agency chargeback, CSV export. Spend caps default ON (block at cap with a plain-language notice; admin can raise or add credits).
3. **Billing:** seat tiers keep their base fee (Starter $29 / Pro $79 / Agency $199) with an included credit pool; overage via top-up packs or per-credit billing through Stripe (hosted only). The internal ledger is the source of truth; Stripe is a pluggable sink.
4. **Dispute evidence:** every charge links to its ledger entries — what ran, when, for which project, at what credit cost. No black boxes.

### W5 — Marketr as MCP server (Phase C, after the ledger)
1. **Developer path:** Settings → API keys → create key (name, scopes = per-tool permissions, expiry) → `curl`/Claude Code with `Authorization: Bearer mk_...` → streamable HTTP at `/mcp`. Keys are revocable, per-key rate-limited, and every call is audit-logged tenant-tagged.
2. **Public-client path:** any MCP client (Claude, ChatGPT) → "Connect Marketr" → OAuth 2.1 + Dynamic Client Registration (no manual client ID) → browser consent screen showing exact scopes → client gets a token bound to the user's workspace.
3. **Tool calls:** 8 task-oriented tools v1 — `list_projects`, `get_rank_report`, `run_seo_audit`, `get_keyword_ideas`, `draft_content_brief`, `get_site_health`, `list_scheduled_skills`, `get_usage_summary`. Never 1:1 REST mirrors (tool schemas are 60–80% of MCP token cost). Tenant ID is derived from auth context on every call; each tool re-checks the caller's grants; tool descriptions contain no secrets and are treated as untrusted input downstream.
4. **Off by default:** the MCP server is disabled per workspace until an admin enables it in settings (explicit opt-in for the new attack surface).

## 7. Data model (MVP entities)

- **W1:** no new entities. `AuditEvent` gains `source: 'e2e' | 'upload_scan' | 'rate_limit'` values.
- **W2 — ScheduledSkill** `{ id, workspaceId, projectId?, skillId, triggerType: 'cron'|'event', cronExpr?, eventSource?, eventConfigJson?, createdBy, approvalMode, concurrencyLimit, status: 'active'|'paused', lastRunAt?, nextRunAt? }`; **SkillRun** `{ id, scheduleId?, workspaceId, projectId?, skillId, trigger: 'cron'|'event'|'manual', status, startedAt, finishedAt?, creditsUsed, outputPath?, auditId }`; **SubagentRun** `{ id, skillRunId, taskLabel, status, startedAt, finishedAt?, creditsUsed }`; **ConnectorHealth** `{ connectionId, status: 'healthy'|'degraded'|'needs_reauth'|'error', lastCheckAt, lastError?, quotaUsed?, quotaLimit? }` (derived/cached, refreshed by a checker job).
- **W3 — WorkspaceFile** `{ id, workspaceId, logicalPath, storageKey (uuid), filename, mimeType, sizeBytes, kind: 'skill'|'memory'|'artifact'|'file', createdBy, createdAt, trashedAt? }`; **WorkspaceQuota** `{ workspaceId, limitBytes, usedBytes }` (usedBytes maintained transactionally). Storage adapter interface: `put/get/delete/exists`, implemented by `LocalDiskAdapter` and `S3CompatibleAdapter`.
- **W4 — UsageEvent** `{ id, workspaceId, projectId?, actorId?, action, credits (integer, no floats), occurredAt, idempotencyKey (unique), evidenceRef? }` — append-only, no updates/deletes; **CreditBalance** `{ workspaceId, includedCredits, purchasedCredits, usedCredits, periodStart }`; **SpendCap** `{ workspaceId, capCredits, blockAtCap: true, alertAtPct }`. Credit table v1 (per-action costs) lives in code config, versioned.
- **W5 — McpApiKey** `{ id, workspaceId, userId, name, keyHash, scopes: string[], expiresAt?, lastUsedAt?, revokedAt? }`; **McpOAuthClient** `{ clientId, workspaceId?, userId, redirectUris, createdAt }` (DCR registrations); MCP calls reuse `AuditEvent` with `source: 'mcp'` + tenant tags.

## 8. MVP scope (shippable behaviors)

**W1:** Playwright E2E suite (settings, connect, skill-install, attach flows) green in local preview; m11 finding closed with scan green; upload pipeline (allow-list + magic bytes + 25MB + scan hook + quarantine) live on chat attach and file manager; tiered rate limits + zod coverage on all M21 routes with adversarial battery green; written threat models for W2–W5 before their code.
**W2:** trigger engine (cron builder UI + 5 event sources), schedule CRUD + run history with cost, parallel subagent fan-out (cap default 4) with per-subagent audit, trust-ladder approval modes, connector health dashboard with re-auth flow.
**W3:** file manager UI (browse/upload/rename/move/trash/quota meter), registry-gated API, local-disk + S3 adapters (MinIO in compose), chat attach + skills + IDE all reading/writing through it, 30-day trash retention.
**W4:** immutable usage ledger, credit table v1, usage dashboards (workspace + per-project + CSV), default-on spend caps with alerts, Stripe top-up/per-credit billing (hosted), self-host records without Stripe dependency.
**W5:** `/mcp` streamable HTTP endpoint, workspace API keys (scoped, revocable), OAuth 2.1 + DCR, 8 task-oriented tools, per-key rate limits, tenant-tagged audit, off-by-default per workspace.

## 9. Non-goals (explicit)

- Public skill marketplace (already decided against); public file-sharing links (workspace-only is the point).
- Real-time collaborative editing of files; file content indexing/embeddings (the attach-and-reference-only rule stands — name/path listing only).
- An MCP *client* inside Marketr beyond the existing generic connector (W5 is server-only).
- Token-level billing UI or per-token invoices (credits are the user-facing unit).
- Automatic credit-price optimization / dynamic pricing — fixed table v1, revisit with data.
- Multi-region storage replication; S3 versioning (trash retention covers MVP).

## 10. Monetization

Seat tiers keep their base fees — Starter $29, Pro $79, Agency white-label $199 — each with an included monthly credit pool (see Appendix A for the v1 credit table: 1 credit = $0.01, per-action costs at ~4× raw vendor cost, pools sized from sample burn profiles). Overage: top-up credit packs or per-credit billing through Stripe (hosted only), default hard cap ON with alerts at 80%. Self-hosted stays BYO-keys with local metering records and no Stripe dependency (the Aider/Cline/Zed "free path" that keeps the open-source funnel honest). The agency tier's per-project usage dashboards + CSV export are the chargeback story: Mara bills her clients per project with Marketr's ledger as evidence, which is itself a retention hook. MCP access is included in Pro/Agency seats (metered like any other action) — distribution first, monetize via the credits it consumes.

## 11. Differentiation & moat

1. **Trust is the feature.** Workspace-scoped everything (registry-gated filesystem, tenant-from-auth MCP, immutable metering evidence, default-on spend caps) — built for the agency that stakes client relationships on it. Competitors bolt this on; it's in our foundation.
2. **Marketing-unit economics.** Nobody else bills SEO work in keyword lookups and rank checks. Users understand it, agencies mark it up per client — and it turns our cost structure into their pricing power.
3. **The automation loop is closed.** Scheduled skills + event triggers + parallel subagents + file-backed outputs + connector health = the product runs itself and proves it. Each scheduled run is a retention event.

## 12. Tech approach

Next.js (repo's pinned version — consult `node_modules/next/dist/docs/` before writing route/handler code) + Postgres + Prisma, local-only until Tico authorizes otherwise. Key pieces: Playwright E2E against `next start` + local PG; storage adapter interface (`LocalDiskAdapter` default, `S3CompatibleAdapter`, MinIO in compose); trigger engine as a new `lib/scheduler/` module reusing the M21 trust-ladder and audit code; usage ledger as append-only Postgres table with idempotency keys; MCP via the official TypeScript SDK (MIT/Apache 2.0) on streamable HTTP; Stripe SDK hosted-only behind a feature flag. LLM: two-tier routing per Appendix B (Haiku 4.5 for copy via a new native Anthropic adapter in `lib/llm`; gpt-5-nano for bulk/background). Dependencies: playwright, minio (compose service), @modelcontextprotocol/sdk, stripe, @anthropic-ai/sdk (adapter only). Nothing here touches paid/live services without Tico's explicit go-ahead.

## 13. Success metrics (30 / 90 days)

- 30d: E2E suite green on every commit; zero critical/high scan findings; upload battery (EICAR + polyglots + spoofed extensions) 100% blocked-or-quarantined; rate-limit battery all 429/400 correctly.
- 60d: filesystem passes traversal/IDOR/quota-bypass adversarial battery; 10+ scheduled skills running in dogfood with run history + cost visible; connector health catches a real `needs_reauth` before a user hits it.
- 90d: metering ledger reconciles to the credit in randomized audits; spend caps + usage dashboards live; MCP server serving the 8 tools to at least one external client (Claude/ChatGPT) with tenant-tagged audit complete; zero billing disputes lost for lack of evidence.

## 14. Risks & open questions

- **Credit pricing numbers** — MODELED 2026-09-22 (Appendix A): 1 credit = $0.01; cost-plus actions at ~4× raw vendor cost; AI content value-priced; pools Starter 2,500 / Pro 10,000 / Agency 30,000; overage via top-up packs, hard cap default ON. DECIDED — pending spot-check of DataForSEO official pricing pages before launch (see Appendix A caveats).
- **Subagent concurrency default** (4) and max runtime guardrails — decided at 4 default, revisit with load data. DECIDED (revisitable).
- **MCP off-by-default** per workspace — recommended; if Tico wants on-by-default for Pro+, say so. NEEDS USER CALL.
- **Malware-scan backend for hosted** (ClamAV sidecar vs managed service) — NEEDS RESEARCH during W1.
- **Runaway scheduler loops** (event trigger that fires itself) — mitigated by max-runs-per-hour per schedule + cycle detection in the threat model; adversarial test required. DECIDED.
- **Clock skew / missed cron fires** — the engine reconciles on boot (catch-up policy: fire once, mark missed). DECIDED.
- **Migration of existing `.data/attachments` into the registry** — one-way migration script, old files keep working via compat read path. NEEDS RESEARCH (small).
- Tico owns hardening 1 (real-PG migration test) + 2 (live adapter wiring) separately — this spec assumes mocks where those touch (connector health shows `unknown` for unwired adapters, honestly). DECIDED.

## Appendix A — Credit table v1

**Unit: 1 credit = $0.01.** Cost-plus actions are priced at ~4× raw vendor cost (75–80% gross margin on variable cost, consistent with the resell-with-margin data strategy). AI content actions are value-priced (raw LLM cost is negligible; users pay for the outcome). Publishing and connector syncs cost 0 — never punish the outcome.

### Per-action credit costs

| Action | What's metered | Raw vendor cost | Credits | Basis |
|---|---|---|---|---|
| Rank check | 1 keyword, live SERP | $0.002 | 1 | cost-plus |
| SERP analysis | 1 live SERP pull | $0.002 | 1 | cost-plus |
| Keyword research run | search volumes, up to 100 keywords (1 task) | $0.09 | 40 | cost-plus |
| Keyword ideas expansion | Labs keyword ideas, ~1k items | ~$0.13 | 50 | cost-plus |
| Competitor keyword gap | Labs ranked keywords, ~1k items | ~$0.13 | 50 | cost-plus |
| Site audit | On-Page crawl, up to 500 pages | $0.075 | 30 | cost-plus |
| Backlink summary check | 1 summary request | $0.024 | 10 | cost-plus |
| Content brief (AI) | brief generation | ~$0.0005 | 5 | value |
| AI article generation | full article | ~$0.0012 | 15 | value |
| Content refresh (AI) | decay refresh pass | ~$0.0008 | 10 | value |
| Scheduled skill run | base fee | — | 5 + metered actions inside the run | value |
| Subagent spawn | orchestration, per subagent | — | 2 + that subagent's metered actions | value |
| MCP tool call | — | — | underlying action's credits | passthrough |
| Publish | — | $0 | 0 | — |
| Connector sync | — | $0 | 0 | — |
| Storage over quota | per GB-month beyond included quota | infra | 1 | value |

### Tier pools

| Tier | Price/mo | Included credits | Implied raw vendor cost | Gross margin on variable cost |
|---|---|---|---|---|
| Starter | $29 | 2,500 | ~$6.25 | ~78% |
| Pro | $79 | 10,000 | ~$25 | ~68% |
| Agency white-label | $199 | 30,000 | ~$75 | ~62% |

### Sample burn profiles (why the pools fit)

- **Devon (Pro):** 2,000 rank checks (2,000) + 40 research runs (1,600) + 20 gap analyses (1,000) + 40 AI articles (600) + 20 briefs (100) + 50 backlink checks (500) + 30 scheduled runs base (150) ≈ **5,950 credits** → fits 10,000 with headroom.
- **Mara (Agency, 10 clients):** 5,000 rank checks (5,000) + 100 research runs (4,000) + 50 gaps (2,500) + 100 articles (1,500) + briefs/refreshes/backlinks (~2,000) ≈ **15,000–18,000 credits** → fits 30,000; per-project dashboards let her charge each client back.

### Overage and caps

- Top-up packs: $50 = 5,000 credits; $200 = 22,000 credits (10% bonus).
- Auto-overage billing at $0.012/credit — **opt-in only**. Default is a hard cap: actions block at 100% of (included + purchased) with a plain-language notice; alerts at 80%.
- Credits reset monthly; purchased top-up credits roll over 12 months.

### Verification caveats

- DataForSEO's official pricing subpages failed to load during research (2026-09-22); SERP, Keywords Data, and Backlinks figures rest on 3+ corroborating third-party sources quoting those pages. **Spot-check against dataforseo.com before launch.**
- Prices rose ~20% on 2026-07-01 (Backlinks, Labs, On-Page); SERP unchanged. The ~4× markup absorbs a repeat move, but re-check annually.
- No published volume tiers — ask DataForSEO sales about committed-volume pricing once hosted spend is material; any discount flows straight to margin.
- Raw cost source: `research/pricing-raw-costs.md` (checked 2026-09-22).

## Appendix B — LLM routing (two-tier, decided 2026-09-22)

Tico picked direction B from the LLM comparison (research: `research/llm-comparison-raw.md`).

### Hosted default routing

| Workload | Model | Why |
|---|---|---|
| Client-facing copy (articles, briefs, content refresh) | `claude-haiku-4-5` ($1.00/$5.00 per 1M) | Best writing reputation in the cheap tier; ZDR-eligible |
| Agent loop, skill runs, bulk summarization, reports | `gpt-5-nano` ($0.05/$0.40 per 1M) | Cheapest reliable API; structured outputs + tool calling |
| Background/deprioritized (scheduled digests, decay checks) | `gpt-5-nano:flex` ($0.02/$0.20 per 1M) | Same quality, latency-tolerant workloads |

### Unit economics

Per AI article (~2k input / 1.5k output tokens): Haiku costs $0.0095 vs $0.15 revenue (15 credits) → **93.7% margin**; nano costs $0.0007 → **99.5%**. The credit table (Appendix A) is unchanged — AI actions are value-priced, so model choice moves margin, not credit prices.

### Build work

- `lib/llm` gains a **native Anthropic Messages-API adapter** — Anthropic is not a base-URL swap, so this is a small dedicated adapter, not config. Scoped into the agent-loop/scheduler work (it touches the same code).
- A workload router selects the model per call site; one config surface (`LLM_MODEL_COPY`, `LLM_MODEL_BULK`, `LLM_MODEL_BACKGROUND` alongside existing `LLM_*`).

### Trust

Pursue OpenAI ZDR approval; use only ZDR-eligible Anthropic models. "Zero data retention" becomes an agency-tier selling point.

### Self-host path

Recommended: **Qwen3.8-27B** (Apache 2.0, fits a single 24GB GPU via vLLM, OpenAI-compatible endpoint → existing `LLM_BASE_URL` design, validated single-shot tool calling). Caveat: marketing-copy quality unverified — test against Marketr's brief/article prompts before recommending it; API fallback stays available for chained tool sequences.

### Killed

- **DeepSeek** — no ZDR, China-hosted: disqualified for agency client data regardless of price.
- **Gemini 3.8 Flash as cost basis** — introductory pricing doubles 2027-01-01; never anchor to it.
