# Marketr Skills / Connectors / Settings — Landscape Research (Synthesized)

**Date:** 2026-09-22 · **Phase:** spec-first Phase 3 groundwork · **Status:** READ-ONLY research. No code written, no purchases, nothing published. **Vault-private.**
**Per-track sources:** [track1-skills.md](./track1-skills.md) · [track2-connectors.md](./track2-connectors.md) · [track3-file-assets.md](./track3-file-assets.md) · [track4-settings.md](./track4-settings.md)
All facts web-sourced 2026-09-22; star counts via GitHub API same day. ⚠️ marks items the researchers could not verify.

---

## 1. Agent skill systems — SKILL.md is the de-facto standard

**What exists:**
- **Agent Skills open standard** (Anthropic origin; spec published at agentskills.io 2025-12-18; donated to the **Agentic AI Foundation**). A skill = folder with mandatory `SKILL.md` (frontmatter: `name`, `description` required; `allowed-tools`, `model`, `license`, `version` optional) + optional `scripts/`, `references/`, `assets/`.
- Core mechanic: **progressive disclosure** — only `name`+`description` (~100 tokens) load at startup; full body loads on agent match; `scripts/` execute via bash with only output entering context. A skill bundle ships "a megabyte of detail at near-zero token cost."
- Supported by ~32 tools: Claude Code, OpenAI Codex CLI, Gemini CLI, GitHub Copilot/VS Code, Cursor, JetBrains Junie, AWS Kiro, Block's Goose, OpenClaw, Hermes Agent. Reference repo `anthropics/skills`: **177,586 stars** (2026-09-22).
- **ChatGPT custom GPTs + Actions** (OpenAI): link-based distribution (no install), Actions = OpenAPI 3.1.0 schema + API-key-or-OAuth. **Revenue sharing is still an invite-only, US-only pilot as of Jan 2026** — no self-serve checkout, no per-GPT purchases. Builders monetize via third-party paywalls (Authflow/Stripe) or use GPTs as lead funnels. Don't model Marketr skill monetization on the GPT Store.
- **Claude Connectors**: Anthropic's official framing — *"connectors = what Claude can do, skills = how it should do it."* Connectors are OAuth MCP integrations (Notion, Slack, Asana, Linear, Google Workspace…); partners are told to ship **both** (MCP server + skills that teach the agent to use it).
- **Registries:** skills.sh (Vercel Labs, `npx skills add owner/repo`, install-count leaderboard); ClawHub (OpenClaw, semver + changelogs + security scan summaries, ~1.5M downloads claimed); `openai/skills` repo (27.5k stars); awesome lists: `VoltAgent/awesome-agent-skills` (34.7k stars, 1,000+ skills), `VoltAgent/awesome-openclaw-skills` (52.7k stars, 5,400+ skills), `huggingface/skills` (11k stars).
- Install/updates: personal dirs (`~/.claude/skills/`), project dirs (`.claude/skills/`), plugin marketplaces, API (beta `skills-2025-10-02`, snapshot versioning, pin exact or `"latest"`). No verified push/auto-update channel anywhere; ClawHub has semver, skills.sh uses unversioned dynamic GitHub pulls (known supply-chain weakness).

**Trust is the #1 risk:** Zenity Labs at **Black Hat USA Aug 2026** found a skills.sh credential-theft campaign (1.7M+ installs before takedown); **ClawHavoc** (early 2026) put hundreds of malicious skills on ClawHub; an ArXiv preprint survey claims 26.1% of community skills have vulnerabilities. Skills are trusted plain text — `allowed-tools` frontmatter and hooks are the only gating.

---

## 2. Connector ecosystems — MCP won; auth is a commodity layer

**MCP (Model Context Protocol):**
- Open standard, JSON-RPC. **Donated by Anthropic to the Agentic AI Foundation (Linux Foundation) Dec 2025**; backed by OpenAI, Google, Microsoft, AWS, Cloudflare. Adopted by ChatGPT, Gemini, Copilot, VS Code, Cursor. 155K+ stars across official org repos; `modelcontextprotocol/servers` 82k stars; FastMCP 24k.
- Official registry: **~9.6K servers** (May 2026, still in preview). Community registries: Smithery (~3–12K, varies by source), Glama (~18–37K, sources disagree), mcp.so (~17K).
- **Zapier itself runs a GA hosted MCP server** (`mcp.zapier.com`) exposing 40K+ actions / 9K+ apps across all plans — the fastest bridge to Zapier's catalog.
- Spec has **no built-in multi-tenancy**; the ecosystem converged on two patterns: server-level shared token vs **per-user OAuth** (isolated per user/session, auto-refresh, `requires_reauth` recovery). For Marketr: MCP client per user/session, tokens stored per user.
- Auth mechanics: remote servers act as OAuth 2.1 authorization servers (dynamic client registration RFC 7591, PKCE, revocation RFC 7009). Best practice: store hashes, discard upstream identity tokens.

**Zapier / Make / n8n:**
- **Zapier**: 9K+ apps / 40K+ actions; SDK via Platform UI or CLI (`zapier push`); auth platform-managed with auto-refresh; Team plan ($69/mo) adds shared app connections + SSO; Enterprise custom. Pricing unit = **task** (per action step) — gets expensive for multi-step flows. No user REST API for managing Zaps — agents use the hosted MCP server.
- **Make** (ex-Integromat): 2K+ apps, visual scenarios; **no self-hosting**; pricing unit = **operation** (per module), 3–5× cheaper than Zapier ($9/mo for 10K ops; Teams $29).
- **n8n**: ~200K GitHub stars, 400+ native + community nodes; credentials AES-encrypted at rest via `N8N_ENCRYPTION_KEY`; native OAuth2 with auto-refresh; community self-host free unlimited; Cloud from $20/mo. **Fair-code Sustainable Use License v1.0 — NOT OSI/AGPLv3-compatible for embedding.** The reference credential-vault design (AES at rest, OAuth auto-refresh, test-on-save), not an embeddable dependency.

**"Universal connector" frameworks:**
- **Pipedream Connect**: embeddable managed auth, 10K+ pre-built tools, drop-in Connect Link UI, per-end-user accounts; **free to 1,000 connected accounts**; SOC 2 II, HIPAA BAA.
- **Paragon ActionKit**: 1K+ actions, 130+ connectors, per-user isolated OAuth + white-label Connect Portal; Pro ~$550/mo est., Enterprise ~$60–120K/yr est.
- **Composio**: agent-first, 250+ connectors, per-user MCP URLs; usage pricing ~$29/200K calls.
- **Activepieces** (~23.6k stars, MIT core — clean license), **Windmill** (~17.5k stars, **AGPLv3 — license-compatible**).
- **Universal auth UX:** browser OAuth consent → encrypted vault → silent refresh → re-auth only on failure. Every mature platform converged here; build nothing custom if a managed layer exists.

---

## 3. File/asset knowledge — two ingestion paths, RAG at scale, citations non-negotiable

**Two ingestion paths recur everywhere:**
- (a) **Manual upload → project-scoped knowledge** (ChatGPT Projects, Claude Projects, NotebookLM sources, Perplexity Spaces)
- (b) **OAuth connectors (Drive/Notion/Dropbox/S3) → workspace-scoped, permission-synced knowledge** (Dust 100+ connectors, Glean 275+, Guru 100+)

**RAG, not context-stuffing, at scale:** Claude auto-RAGs knowledge at ~10× context when it nears limits; NotebookLM is the purest "reference not retrieve" model; AnythingLLM/Dify/Open WebUI all RAG-first. Small files can go straight to context; large libraries must index.

**Permissions — Glean is the reference implementation:**
- Index-time ACL sync with a unified principal model; **filter-then-rank at query time** (never post-filter, never ask the LLM to withhold); ACL sync on a **tighter loop than content sync** (revocation lag = security bug, not freshness bug); filtering even at typeahead/facet level (hidden-result counts are a leak).
- Manual uploads are inherently "uploader owns" — ACLs only get hard with connectors, where each connector's per-document ACL must be normalized to one identity model.
- Dust syncs connectors permission-scoped; Guru does permission-aware ingestion + DLP/PII redaction before indexing.
- **For Marketr v1:** connector sync honoring source ACLs (Drive ACLs via API) + project-level upload isolation = "safe enough"; full Glean-style mirroring is a later milestone.

**Provenance/citation:** Perplexity (inline, clickable — best consumer UX), NotebookLM (per-source), Guru (citations restricted to verified Cards). Every retrieved chunk must carry `source_doc + connector + page/section` back to the answer. This is what separates "AI search" from "chatbot with files."

**Notable open-source implementations (stars via GitHub API 2026-09-22):**
- **AnythingLLM** — 66,321 stars, MIT, YC-backed. RAG-workspace specialist: drag-drop ingestion, LanceDB (9+ vector DB options), **workspace isolation + RBAC**, multi-user, no-code agent builder, native MCP. **Strongest single OSS reference for Marketr's file/workspace design.**
- **Dify** — 156,848 stars, Apache 2.0. Largest OSS AI-app platform: agentic workflows + RAG pipelines + knowledge bases. Reference architecture for knowledge + agent + tooling in one product.
- **Open WebUI** — 152,795 stars, MIT/BSD-style. Built-in RAG ("Knowledge"/collections), Pipelines plugin system. Closest OSS analog to a hosted chat+knowledge UI.
- **Khoj** — 37,461 stars, **AGPL-3.0** (matches Marketr's license). Self-hostable AI second brain.
- **Dust core** — 1,472 stars, MIT. The actual enterprise connector+agent codebase — a real connector-implementation reference despite low stars.

**Vector DB (secondary):** **pgvector for v1** if Marketr runs Postgres (zero new infra, fine under ~1–10M vectors, HNSW capped at 2000 dims); **Qdrant** (Apache 2.0) as the migration path for filtered search at scale; avoid Chroma for production.

---

## 4. Settings patterns — baseline at workspace, override at project

**Workspace/org vs project IA (concrete, verified 2026-09-22):**
- **Vercel** — cleanest "baseline at workspace, override at project": team roles (Owner/Member/Developer/Security/Contributor/**Viewer is free, not a seat**/Billing), access groups, SAML SSO; **shared env vars linked into projects** ("Link Shared Variable"); project-level per-env vars with **write-once sensitive** prod values.
- **Linear** — Settings > Administration (billing, plans, SSO, integrations); workspace gates API-key creation; notifications stay per-user (never workspace).
- **GitHub** — org: billing profile, SAML/EMU, Copilot policies + seat mgmt, audit-log streaming; repo sidebar: General / Access / Code & automation / Security / **Secrets & variables (org → env → repo inheritance)** / Integrations. **Copilot/MCP allow-lists live at org, not per repo** — agent policy is org-level.
- **PostHog** — org: billing/usage, SSO; project = data silo: own API key, data-governance switches (IP storage, recordings), access control, billing limits.
- **Langfuse** (MIT, self-hosted-first — closest structural cousin to Marketr): org → projects; credentials at project level (`pk-lf`/`sk-lf` pairs).
- **Supabase** — usage moved to org level in 2026; projects hold API keys (`anon` RLS-scoped vs `service_role` bypass) and per-project add-ons billed to org. "Entitlement at org, provisioning at project."
- **Reflex** — audit log at **both** org and project levels; **deployment approvals at project level**.

**Per-project agent config (the canonical pattern):**
- **ChatGPT Configure tab** is the reference IA: Name / Description / Instructions / Conversation starters / Knowledge / **Capabilities toggles** (tools on-off) / **Actions** (OpenAPI schema + API-key-or-OAuth) / visibility.
- **Dust Agent Builder:** Instructions + Tools & Knowledge + model/reasoning-effort — and **effort affects credit consumption**. Model choice = cost knob = the pattern for Marketr's hosted margin.
- **Cursor rules:** three scopes (Project `.mdc` / User settings-UI / Team) with activation taxonomy **always / auto-attached (glob) / referenced / manual** — directly reusable for Marketr's skill/tool enablement per project.
- **Claude Projects:** Instructions + Knowledge + visibility (private/shared) — the three primitives for per-project agent config.

**Approval gates / trust ladder:** Reflex project-level deployment approvals; GitHub branch protection; Cursor plan-vs-act mode. External evidence supports Marketr's trust ladder with the **mode default at workspace level + per-project override**.

**Billing scoping:**
- **Seats at workspace** (Linear, GitHub Copilot seat mgmt); **usage rolls up to workspace/org** (Vercel, Supabase, PostHog, Dust credits); per-project add-ons/caps (Supabase add-ons, PostHog billing limits).
- Two quota kinds: **resource-count** (gauges — projects, seats, keys; enforced at create time, 402) vs **metered** (windowed — API calls, LLM spend; 429, warn at 80%).
- **Hybrid seat+usage is the modern norm** (per-seat base + usage credits). For Marketr: self-hosted/BYO = resource-count entitlements only; hosted/bundled keys = **per-workspace credit metering with project-level attribution** (agency resale).

**Security:**
- **SSO/SAML is always workspace-level** (Vercel, GitHub, Supabase, Reflex, Linear) — never per-project.
- Audit logs at both levels (GitHub enterprise streaming; Reflex org + project logs). Map: workspace audit (members, keys, billing) + project activity log (agent runs, approvals, publishes, connector changes).
- Key scoping: PostHog granular scopes × access levels; Supabase anon/service_role tiers (capability-based, not just scopes); secrets shown once. BYO keys stored as **write-once, per-project secrets with optional workspace-level shared secrets linked in** (Vercel's model is the closest template).

---

## 5. Architecture-shaping findings (synthesis for the spec phase)

1. **Adopt SKILL.md (Agent Skills open standard) as the skill packaging format.** ~32 tools support it, `anthropics/skills` has 177.6k stars, OpenAI ships official SKILL.md skills. Don't invent a format.
2. **Layer skills on top of MCP connectors** — Anthropic's official "kitchen + recipes" pattern (connectors = what, skills = how). Marketr skills (SEO audit, content brief, rank report workflows) sit atop MCP-based data connectors (Search Console, GA4, WordPress, ad platforms).
3. **Ship both directions of MCP:** consume third-party MCP servers for data-in, and expose Marketr *as* an MCP server (agent-consumable distribution moat).
4. **Trust is the top ecosystem risk — plan verification before launch.** 1.7M-install credential-theft campaign on skills.sh (Black Hat Aug 2026), ClawHavoc on ClawHub, 26.1% vulnerable-skill claim. Marketr needs a review/verification + signed-versioning story from day one, not after launch.
5. **Per-user OAuth is the correct granularity** for a marketing-agency tool (ad accounts, GA properties). Don't hand-roll the OAuth vault — Pipedream Connect (free to 1K accounts), Paragon, Composio, or the MCP OAuth 2.1 pattern natively. Zapier's hosted MCP server is the fastest bridge to 9K+ apps.
6. **File knowledge needs both ingestion paths, Glean-style permission discipline, and first-class citations.** Uploads (project-scoped) + OAuth connectors (workspace-scoped, ACL-synced); filter-then-rank; ACL sync faster than content sync; chunks carry `source_doc + connector + page/section`. pgvector v1 (zero new infra), Qdrant migration path.
7. **Settings IA: baseline at workspace, override at project.** Workspace owns: members/roles, billing, SSO/SAML, shared secrets, key-creation policy, Copilot-style agent allow-lists, audit log. Project owns: agent instructions + enabled skills/tools + model/effort, knowledge sources, approval mode, data-governance switches, per-project secrets (write-once), per-project API key pairs.
8. **Hosted margin requires per-workspace metering with project-level attribution.** Dust's "reasoning effort affects credit consumption" is the model; hybrid seat+usage is the norm; warn at 80%, hard cap with 429-style block. Self-hosted stays entitlement-only (resource-count quotas).

---

## 6. What could not be verified (flags for the spec phase)

- OpenClaw's reported 390k GitHub stars — implausible, do not cite. skills.sh launch date and "100k+ skills" claim — sources conflict. MCP SDK ~97M/mo downloads, 9.6K official-registry servers, registry size discrepancies (Smithery 3K–12K, Glama 18K–37K) — methodology varies.
- Make acquired by Celonis at $11B — single Medium source. n8n live star count — couldn't fetch live GitHub. Composio stars/pricing details, Pipedream repo stars, Paragon enterprise pricing ($60–120K/yr estimate) — community/press-sourced.
- GPT Actions first-run consent UX — not re-fetched from OpenAI docs. Guru pricing — sources split ($10–25/seat historical vs 2026 enterprise-only). ChatGPT Projects file limits — sources disagree (5/20/25/40). Dust connector ACL mechanics — not verified against primary docs. Notion/Slack exact settings groupings; Replit Agent / Windsurf per-project agent settings; data-retention controls per product — not covered; needed for the data-governance section.
- License caution carried forward: n8n (fair-code/SUL) and Activepieces (MIT core + proprietary EE) are **not cleanly AGPLv3-embeddable**; Windmill (AGPLv3) and Khoj (AGPL-3.0) are; MCP SDKs are permissive (verify per-SDK at build time); Open WebUI's actual LICENSE file wasn't opened — confirm before reusing code.

---

*Per-track reports with full sourcing, pricing tables, and IA details: [track1-skills.md](./track1-skills.md) · [track2-connectors.md](./track2-connectors.md) · [track3-file-assets.md](./track3-file-assets.md) · [track4-settings.md](./track4-settings.md)*
