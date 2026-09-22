# TRACK 2 — Connector Ecosystems Landscape Research

**Date:** 2026-09-22 | **Author:** subagent (Track 2, parent: 74fd372d-0d41-4541-9cca-6adc04ebd562)
**Scope:** READ-ONLY research. No code, no purchases. Marketr is AGPLv3, Next.js, with an AI agent named Marketr.
**Why:** Marketr needs many data connectors (marketing tools, CRMs, analytics, CMSs, ad platforms) + integrations for user-owned assets.

> Every figure below comes from a web search run on 2026-09-22. Memory was not used as evidence.
> Items marked ⚠️ could not be independently verified or come from a single low-credibility source.

---

## 1. MCP (Model Context Protocol)

### What exists
- **The spec:** JSON-RPC-based open standard letting AI models invoke tools, read resources, and receive prompts from external servers. Often described as "USB-C for LLMs."
- **Governance (verified across multiple sources):** In **December 2025, Anthropic donated MCP to the Agentic AI Foundation (AAIF)** under the Linux Foundation — co-founded by Anthropic, Block, and OpenAI, with backing from Google, Microsoft, AWS, Cloudflare, Bloomberg. MCP is no longer single-vendor.
- **SDKs:** Official SDKs in Python, TypeScript, Go, Java, Rust, C#, PHP, Swift, Kotlin, Ruby. Reported ~**97M combined monthly downloads** for the Python + TypeScript SDKs (ecosystem-reported figure, ⚠️ not independently verified).
- **Recent spec additions:** MCP Apps (tool calls returning interactive UI components), elicitation (servers requesting structured input mid-task), registry preview, MCPB packaging, Streamable HTTP transport.

### Who adopted it (verified)
- **Anthropic:** Claude Desktop, Claude Code, Anthropic's own MCP marketplace.
- **OpenAI:** ChatGPT supports MCP (plugin system now supports MCP transport).
- **Google:** Gemini supports MCP as a first-class tool protocol.
- **Microsoft:** VS Code with GitHub Copilot, Microsoft Copilot, steering committee on official registry.
- GitHub, Notion, Slack, Atlassian ship official MCP servers. Claude Desktop, Cursor, dozens of agent frameworks support it natively.
- **Zapier itself** runs a hosted MCP server (`mcp.zapier.com/api/v1/connect`, Streamable HTTP, Bearer key) — GA across all Zapier plans, exposing 40,000+ actions across 9,000+ apps. Paragon's ActionKit also ships a public MCP server listed on the Anthropic registry.

### Adoption evidence (numbers)
| Signal | Figure | Source / date |
|---|---|---|
| Official MCP org repos | **155K+ stars across 30+ repos** | GitHub ecosystem tracker, ~mid-2026 |
| modelcontextprotocol/servers | **82K stars** | same |
| awesome-mcp-servers (community list) | **84K stars** | same |
| playwright-mcp | 30K · github-mcp-server 28K · fastmcp 24K | same |
| SDK downloads | ~97M/month combined (Python+TS) | ecosystem-reported, ⚠️ unverified |
| Official registry API (May 24, 2026) | **9,652 latest server records**; 28,959 total version records | registry.modelcontextprotocol.io via secondary aggregator ⚠️ |
| Remote MCP servers | **up 4x since May 2025** | blog cited in ecosystem scan ⚠️ |
| SDK language coverage | 10 languages | official org |

### Registries — discovery & install UX
| Registry | Model | Size (Sep 2026 reports) |
|---|---|---|
| **Official MCP Registry** (registry.modelcontextprotocol.io) | Steered by Anthropic/GitHub/PulseMCP/Microsoft; GitHub-OIDC + reverse-DNS namespace auth; publishers prove GitHub/domain ownership and publish `server.json`. **Still in preview, API frozen at v0.1 since Oct 2025, GA not announced.** Free and open. | ~9.6K servers (May 2026) |
| **Smithery** | Original community directory + hosted "proxy" servers with built-in OAuth handling; CLI for local install; Connect API (REST abstraction over MCP), namespace aggregation (`mcp.smithery.run/{namespace}`) multiplexes one user's connections into a single MCP endpoint. Freemium. | ~3,000 verified listings (mid-2026) per Towards AI; other sources say ~7K; Feb 2026 crawler found 3,650 via API ⚠️ (counts vary by methodology) |
| **Glama** | Auto-indexes GitHub (~37K servers claimed, Jul 2026; other crawls found ~18K Feb 2026 ⚠️); quality/safety scoring, maintainer verification, in-browser inspector, managed gateway with per-tool access control. Freemium. | ~23–37K (sources disagree ⚠️) |
| **mcp.so** | Community-contribution directory | ~17K claimed (Feb 2026 crawler) ⚠️ |
| **github.com/mcp** (official curated mirror) | 91 curated servers | registry research doc |

**Install UX pattern:** one-click/copy JSON config block for Claude Desktop, Cursor, VS Code, Windsurf; Smithery CLI handles auth; Glama's in-browser inspector lets you test tools without installing. PulseMCP (~7K) acts as official mirror feeding aggregators.

### Auth handling & per-user vs per-workspace scoping
- **The spec itself has no built-in multi-tenancy.** Scoping is a deployment choice, and the ecosystem has converged on two patterns:
  - **Server-level (shared) OAuth:** one admin authenticates once; every request uses the same upstream token (e.g., Bifrost "server-level OAuth"). Simpler; fine for single-tenant/agent-owned tools.
  - **Per-user OAuth:** each end-user authorizes individually; tokens isolated per user (e.g., Bifrost "per-user OAuth" configured via web UI; agency-swarm's `MCPServerOAuth` caches tokens per user under `~/.agency-swarm/mcp-tokens/` with automatic refresh; DeployStack stores per-user OAuth installations with `requires_reauth` self-service recovery when refresh fails).
- **Shared-admin workaround for broken per-user models:** e.g., Intuit/QBO allows only one admin connection per app per realm, so qbo-mcp holds one shared upstream connection and authenticates each MCP *caller* separately (per-user Bearer to the server), with per-user tool permissions layered on top. Relevant pattern for Marketr if any marketing API (e.g., Meta ads accounts) has similar one-token-per-app constraints.
- **Spec mechanics:** remote servers act as OAuth 2.1 authorization servers (dynamic client registration RFC 7591, PKCE, token revocation RFC 7009, discovery RFC 8414/9728); many implementations mint their own opaque access/refresh tokens, store only hashes, discard upstream identity tokens. Refresh is automatic; users re-authorize only when refresh fails.
- **Marketr-relevant:** Smithery's namespace aggregation shows the viable product pattern — per-user connections multiplexed behind one endpoint with per-user auth. For Marketr (Next.js + agent), the natural shape is: **MCP client per user/session, tokens stored per user**, not one workspace-wide server credential.

---

## 2. Zapier

### Connector/SDK model (how developers build)
- Two build experiences: **Platform UI** (visual, no-code + optional JavaScript tweaks) and **CLI** (`zapier-platform`): `zapier register` → build triggers/actions/searches → `zapier push`. Building blocks: **triggers** (data out of your API into a Zap), **actions** (Zapier → your API), **searches**, auth handlers.
- Auth options: OAuth 2, API key, session auth, basic auth; platform UI offers "advanced functions" for storing client secrets.
- Publishing: share link for private testing, then publish to the public **Zapier app directory** (9,000+ apps advertised on the SDK quickstart; one 2026 comparison cites 7,000+ ⚠️ — official docs say 9,000+, 40,000+ actions).
- **Zapier MCP server** (new, strategic for Marketr): `mcp.zapier.com/api/v1/connect`, Streamable HTTP, Bearer key from mcp.zapier.com; user pre-selects which app actions are exposed. GA across all plans. ⚠️ Agent-facing docs note: **there is no user REST API to programmatically create/manage Zaps** — agents connect via the hosted MCP server only. Partner API exists for embed partners.
- **Zapier SDK** (`@zapier/zapier-sdk`, ESM): lets code invoke any app a user already authorized in their Zapier account — "zero OAuth code," token refresh and retries handled, machine credentials for headless workers. This is the closest thing to "use Zapier as Marketr's auth layer."

### Auth handling
- Zapier stores OAuth tokens per connected app ("App Connections" page at zapier.com/app/assets/connections); refresh and retry handled by the platform. On Team plan: **shared app connections** — connections can be shared across the workspace instead of per-user private.

### Per-user vs per-team scoping
- Free/Professional: connections are per-user (private).
- **Team ($69/mo annual):** shared Zaps/folders, **shared app connections**, up to 25 users, SAML SSO, user roles/permissions, Premier Support.
- **Enterprise (custom):** unlimited users, VPC peering, SCIM, audit logs, log streaming, AI guardrails, annual task pool (up to ~2M tasks/mo), dedicated TAM.

### Pricing (verified Apr–Jul 2026; ⚠️ confirm at zapier.com/pricing before quoting — Zapier changes plans periodically)
Billing unit = **task** (each successful action step; triggers/filters/paths don't count).

| Plan | Monthly (billed annually) | Monthly (month-to-month) | Tasks/mo | Notes |
|---|---|---|---|---|
| Free | $0 | $0 | 100 | 5 Zaps, 2-step only, 15-min polling |
| Professional | $19.99 | $29.99 | 750 (base) | multi-step, all premium apps, webhooks, Copilot |
| Team | $69 | $103.50 | 2,000 (base) | shared connections/folders, SSO, 25 users |
| Enterprise | custom (UK reports £40–120K/yr) | — | custom | VPC, BYOM, SCIM, guardrails, TAM |

- 14-day Professional trial, no card. Over-limit usage auto-bills ~1.25× base task rate. 33% annual discount; 15% non-profit discount.
- Cost characteristic: task-per-action makes multi-step/high-volume flows expensive — e.g., 10K runs × 8 steps = 80K tasks ≈ $250–400+/mo on Team with add-ons (per a 2026 comparison ⚠️ estimate).

---

## 3. Make (formerly Integromat)

### What exists
- Founded 2012 (Prague) as Integromat, rebranded Make 2021. ⚠️ **Acquired by Celonis in early 2026 at a reported $11B valuation** — single Medium source, not verified elsewhere.
- Visual canvas ("scenarios"), routers/filters for branching, HTTP/JSON modules for any API, native AI modules (ChatGPT, Claude, Gemini as of 2026), **Custom Apps SDK** for building integrations, Enterprise "dynamic connections."
- **App count:** 2,000+ (directory listing, verified Jun 2026); 3,000–3,300+ claimed by review sources (⚠️ unverified, likely counting modules). 500K+ organizations/users claimed (⚠️ self-reported).
- G2 rating 4.7/5 (reported in tool directory ⚠️).

### Pricing (verified Feb–Sep 2026; billing unit = **operation**, each module execution)
| Plan | Price/mo (annual) | Includes |
|---|---|---|
| Free | $0 | 1,000 ops/mo, unlimited scenarios, 15-min min interval |
| Core | $9 | 10,000 ops/mo, unlimited active scenarios, Make API |
| Pro | $16 | + priority execution, custom variables, error handling, full-text logs |
| Teams | $29 | + team roles, shared scenario templates |
| Enterprise | custom | SSO, audit logs, dynamic connections, overage protection, enterprise apps |

- Consistently ~3–5× cheaper than Zapier at equivalent complexity (Make counts one op per module; Zapier one task per action).

### Self-hosted story
- ❌ **No self-hosting.** Cloud SaaS only (same as Zapier).

---

## 4. n8n

### What exists
- Open workflow automation: visual node editor, 400+ first-party integrations + **community nodes** (npm packages, installed self-hosted via Settings → Community Nodes; scanned by `@n8n/scan-community-package`; **only verified nodes offered on n8n Cloud**), Code node (JS/Python), webhooks, cron, queue mode, full REST API for workflow management, Git version control, LangChain-based native AI agent nodes.
- License: **fair-code — Sustainable Use License v1.0, NOT OSI-approved** (matters for Marketr's AGPLv3 posture — not license-compatible for embedding).

### Adoption evidence
| Signal | Figure |
|---|---|
| GitHub stars | ~**199,652** (Aug 2026, digitalapplied) / "190K" (DPI survey) — ⚠️ couldn't read live GitHub in this session; older skill docs say 68K (stale) |
| Templates | 900+ community workflow templates (n8n.io/workflows) |
| Positioning | Dominant self-hosted Zapier alternative; DPI/development-sector adoption (OpenFn comparison lists it vs gov-focused alternatives) |

### Pricing (2026; billing unit = **execution** — one whole workflow run = 1 execution regardless of steps)
| Plan | Price | Executions |
|---|---|---|
| Community (self-hosted) | Free forever | Unlimited (server costs only ~$5–15/mo) |
| Starter (Cloud) | $20/mo | 2,500/mo, 5 active workflows |
| Pro (Cloud) | $50/mo | 10,000/mo, unlimited workflows |
| Enterprise | custom | unlimited, SSO, audit logs, SLA |

### Credentials & auth model (directly relevant to Marketr)
- **Credentials encrypted at rest** with AES using `N8N_ENCRYPTION_KEY` (must be provided via env; losing it = losing all credentials).
- OAuth2 supported natively with automatic token refresh; API keys, basic auth, custom credential types per node; connection test on save.
- Self-hosted = you own the key and the vault. Cloud = n8n holds it.
- Sharing: credentials belong to the creating user; shared via Enterprise features/owner-admin roles — no public per-end-user multi-tenant OAuth story; you'd build that yourself.
- **Per-user vs per-workspace:** single encryption key per instance; credentials are user-scoped within one instance's DB (Postgres), not workspace-partitioned for SaaS multi-tenancy.

### Self-hosted story
- ✅ **Excellent** — Docker, npm, k8s; Postgres persistence; sealed secrets; the default choice for data sovereignty. This is n8n's core advantage.

---

## 5. Auth UX across all five — comparative summary

| Platform | OAuth | API keys | Credential storage | Refresh handling | Per-user vs shared scoping |
|---|---|---|---|---|---|
| MCP ecosystem | OAuth 2.1 (dynamic client reg, PKCE, RFC 8414 discovery) | Static Bearer (server-to-server) | Implementation-defined; best practice: encrypted at rest, tokens stored as hashes | Automatic; `requires_reauth` recovery pattern | **Deployment choice:** server-level shared token vs per-user OAuth (each user authorizes; isolated per user/session) |
| Zapier | Handled by platform; OAuth clients managed per app | Stored in "connections" | Platform-managed vault | Automatic, with retries | Private per-user → **shared app connections on Team/Enterprise** |
| Make | OAuth + API key per connection | Per connection | Platform-managed | Automatic | User connections; Teams = role-based; Enterprise = dynamic connections |
| n8n | OAuth2 native + generic creds | Encrypted credential store | AES via `N8N_ENCRYPTION_KEY`, at rest | Automatic OAuth refresh | User-scoped within instance; no SaaS multi-tenant OAuth layer |
| Pipedream Connect | Managed OAuth (Pipedream's approved clients or your own) | API keys accepted on behalf of users | HTTPS + encrypted at rest; SOC 2, HIPAA BAA | Automatic | **Per end-user** via external user IDs; 1 connected account per user/app/environment |
| Paragon | Fully managed OAuth + refresh across all integrations | Yes | Managed, encrypted, isolated per user | Automatic | **Per-user isolated credentials** + white-labeled Connect Portal |
| Composio | Managed OAuth/API keys/token refresh | Yes | Managed; SOC 2 Type II, ISO 27001 | Automatic | Per-user connected accounts; per-user MCP URLs |

**Universal UX pattern:** browser-based OAuth consent → tokens stored in an encrypted vault → silent background refresh → only surface re-auth when refresh fails. Every mature platform converges on this; build nothing custom here if a managed layer exists.

---

## 6. Notable open-source "universal connector" frameworks & marketplaces

| Project | What it is | Adoption evidence | Pricing / license |
|---|---|---|---|
| **FastMCP** (Python MCP framework) | FastAPI-style framework for building MCP servers | **24K GitHub stars** (ecosystem tracker, 2026) | Open source |
| **Activepieces** | Open-source automation platform; "pieces" = connector framework; built-in AI agents | **~23.6K GitHub stars** (Aug 2026) | MIT core (proprietary ee/); self-hosted Community Edition unlimited runs/users/flows |
| **Windmill** | Developer-first workflow engine + integrations | **~17.5K GitHub stars** (Aug 2026) | AGPLv3 Community Edition, unlimited executions |
| **Airbyte** | Open-source data movement (ELT); 500+ connectors — data-warehouse sync, less agent-oriented | Well-known; ⚠️ current star count not verified in this session | Open source |
| **Composio** | Agent-first integration platform: 250+ connectors (one community PRD claims 1,000+ toolkits / 500+ apps ⚠️ unverified), SDK for LangChain/CrewAI/AutoGen +20 frameworks, per-user MCP URLs, Universal MCP Gateway | Strong dev buzz; orchestrator open-sourced 2026 (press, ⚠️ single source). **GitHub star count not verified in this session.** | Usage-based: reported 200K calls for $29/mo with free tier (⚠️ from Medium review); SOC 2 II, ISO 27001 |
| **Pipedream Connect** | Embeddable: managed auth for thousands of apps, 10K+ pre-built tools/triggers, Connect Link drop-in UI, proxy API, SDK | Pipedream open-source repo is one of the most-starred integration projects (⚠️ exact stars not verified this session) | **Managed auth free up to 1,000 connected accounts/workspace**; production = sales/Enterprise; SOC 2 II, HIPAA BAA |
| **Paragon ActionKit** | 1,000+ pre-built agent actions, 130+ connectors, single API or MCP server, managed per-user OAuth, white-label Connect Portal, triggers/RAG/sync/workflows | 100+ engineering teams (self-reported ⚠️); customers cited: AI21, You.com (press ⚠️) | Pro + Enterprise, custom usage-based; est. ~$550/mo for 5 connections Pro; Enterprise est. $60–120K/yr (⚠️ community estimates). 14-day trial |
| **Zapier MCP** | Hosted MCP server exposing Zapier's whole catalog to agents | 40,000+ actions / 9,000+ apps (docs.zapier.com, Jul 2026) | Included in Zapier plans (all plans, GA) |
| **ToolHive / MCP360 / mymcptools** | MCP gateways: single-endpoint multiplexing, on-demand tool loading, health verification | Early-stage community projects ⚠️ | Open source / freemium |

**Not verified and excluded from figures:** exact Composio/Pipedream-repo star counts (couldn't fetch live GitHub); Airbyte current stars; Make/Celonis acquisition (single source).

---

## 7. Implications for Marketr (researcher notes, not decisions)

1. **MCP is the strategic bet.** Donated to a Linux Foundation body backed by Anthropic + OpenAI + Google + Microsoft; adopted by ChatGPT, Gemini, Copilot, VS Code. For an open-source marketing workspace with an agent, exposing Marketr *as* an MCP server (agent-consumable) and consuming third-party MCP servers (data in) rides the same standard.
2. **Auth is a solved-and-commoditized layer.** Per-user OAuth vaults with auto-refresh exist off-the-shelf (Pipedream Connect: free to 1K connected accounts; Paragon; Composio). Marketr should not hand-roll OAuth storage — integrate one managed auth layer or adopt the MCP OAuth 2.1 pattern natively.
3. **Per-user scoping is the expected default.** Zapier/Make/n8n all started workspace/instance-scoped and are bolting on per-user; the agent-native platforms (Paragon, Pipedream Connect, Composio) are per-end-user from day one. For a marketing agency tool, per-user OAuth per marketing account (ad accounts, GA properties) is the correct granularity.
4. **"Use the tools they already have" = Connect-style embedding.** Pipedream Connect and Paragon's Connect Portal are the direct models for letting Marketr users bring their own authenticated apps without Marketr storing raw credentials.
5. **Licensing caution:** n8n (fair-code/SUL) and Activepieces (MIT core + proprietary EE) are not cleanly AGPLv3-compatible as embedded dependencies; Windmill (AGPLv3) is. MCP SDKs are permissive/Apache-2.0-style (verify per-SDK at build time).

---

## 8. What could not be verified (flagged)

- Live GitHub star counts for n8n, Composio, Pipedream, Airbyte (no live GitHub fetch in this session; figures are from Aug–Sep 2026 secondary sources).
- MCP SDK 97M/month downloads; 9,652 official-registry servers; "remote servers up 4x" (all ecosystem-reported).
- Exact catalog sizes for Smithery/Glama/mcp.so (sources disagree: Smithery 3K–12K, Glama 18K–37K; methodology differs).
- Make acquired by Celonis, $11B (single Medium post).
- Composio pricing details and GitHub stars; Paragon enterprise price estimates (community-sourced).
- Zapier app count: official docs say 9,000+ apps / 40,000+ actions; some comparisons say 7,000+.
