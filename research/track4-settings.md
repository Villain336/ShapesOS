# TRACK 4 — Settings Architecture Patterns Landscape Research

**Date:** 2026-09-22 · **Status:** READ-ONLY research (no code, no purchases) · **Vault-private**

> Marketr is an open-source (AGPLv3) marketing & SEO workspace (Next.js) with an AI agent.
> Settings are needed at **workspace level AND per-project level**.
> Self-hosted = BYO API keys; hosted = keys bundled with margin.
> Everything below is sourced from live docs/pages fetched 2026-09-22; items I could
> **not** verify are explicitly flagged.

---

## 1. Workspace/Org vs Project Settings — concrete IA examples

### 1a. Vercel — Team settings vs Project settings (verified via vercel.com/academy + docs)

**Team-level settings** (billing, identity, and shared policy live here):
- **Members** — roles: **Owner** (full access incl. billing + team settings), **Member**
  (deploy, manage integrations/domains across all projects), **Developer**
  (non-production deployments), **Security** (manages security settings + secrets only),
  **Contributor** (no access until assigned to specific projects), **Viewer**
  (read-only preview access; **does not count as a paid seat**), **Billing**
  (invoices + billing settings only).
- **Access Groups** — named groups ("Core Developers") mapping members → projects with a
  project role, for scale. Enterprise: linkable to Directory Sync (SCIM) groups.
- **Project Members** (per project): assign a team member **Project Viewer**,
  **Project Developer**, or **Project Admin**. Rule: *team role sets the baseline;
  project roles fine-tune it per project*.
- **Authentication** — SAML Single Sign-On config at team level; "Require SAML for
  login" enforcement toggle. Directory Sync group→role mapping
  (`vercel-role-owner`, `vercel-role-member`, etc.).
- **Shared Environment Variables** — team-level variables linked into projects via
  "Link Shared Variable" (shown under the project's Shared tab); avoids duplication.

**Project-level settings**:
- **Environment Variables** — scoped per environment (production / preview / development);
  production-scoped variables can be marked **sensitive = write-once** (can't be read back
  after save). Takes effect on redeploy.
- **Domains** (add existing or buy), **Functions** (regions, failover — Enterprise),
  **Git** (branch/deployment config), plus per-project storage/billing where applicable.

**Relevant to Marketr:** the cleanest "baseline at workspace, override at project" model
found: shared secrets defined once at workspace and *linked* into projects; sensitive
values write-once. Seats charged only for productive roles (Viewer free).

### 1b. Linear — Workspace settings (verified via linear.app/docs/workspaces + /members-roles, official docs)

- **Settings > Administration** (admins/owners only): workspace name + URL, login
  preferences, third-party app review requirement (Enterprise), Project Updates on/off,
  Initiatives feature toggle, members management, import/export issues, **change plans**,
  **billing information**.
- Also admin/owner-visible: workspace-level labels, custom project statuses,
  workspace-level templates (issues/projects/documents), SLA rules, integrations
  (GitHub, GitLab, Slack, Figma, Sentry — workspace-level integration settings are
  permission-gated; some integrations connectable per-member with own credentials).
- **Roles:** Admin / Member / Guest ("from full administrative control to limited guest
  visibility"); on Free plans all users are Admins. Suspended members lose access
  immediately and are removed from the next billing cycle.
- **Settings → API → Personal API keys** — user-created keys; workspace admins can gate
  who may create them (`personalApiKeysRole`). This is the surface AI agents use
  (e.g., Linear MCP server for Claude Code: global `~/.claude/settings.json` vs
  per-project `.claude/settings.json` config — mirrors the global/project scope split).
- Notification settings are **per-user**, not workspace — a consistent pattern:
  defaults/workspace policy up top, personal notification preferences per account.

**Relevant to Marketr:** workspace = the billing + identity + policy container;
integrations and API-key creation policy are workspace-gated. Per-user notification
defaults kept out of workspace settings.

### 1c. GitHub — Organization settings vs Repository settings (verified via docs.github.com + repo-settings labs)

**Organization settings:**
- **Access:** members, teams, outside collaborators.
- **Billing and licensing** — single billing profile per org (all services roll up to one
  payment method/invoice); **Billing managers** role can view/download invoices without
  org ownership.
- **Authentication Security** — SAML SSO enforce per org, IP allow list, Enterprise
  Managed Users; **Developer Settings → Personal access tokens** (token lifetime + SSO
  requirement policy).
- **Copilot** — policies (IDE chat/CLI features, allowed/excluded models, MCP enablement,
  extensions) + **Seat Management** (Copilot billed per seat at org level).
- **Audit log** — org-level; Enterprise adds audit-log **streaming** to SIEM/S3.
  Documented event types include `org.sso_response`, `repo.destroy`,
  `org.remove_member`, `oauth_access.revoke`.
- Org-level **security defaults for new repositories** (Dependabot, secret scanning,
  push protection) — policy inheritance down to repos.

**Repository settings** (left sidebar): **General** (name, features, danger zone),
**Access** (collaborators, teams), **Code and automation** (Branches, Pages, Actions),
**Security** (code security and analysis), **Secrets and variables** (Actions secrets,
Dependabot secrets, Codespaces secrets — environment/repo/org scoping), **Integrations**
(webhooks, GitHub Apps with per-app permissions + repository scope).

**Relevant to Marketr:** GitHub is the archetype of "org sets security/billing policy;
project sets operational config; secrets inherit org → env → repo." Also the clearest
example of **agent-relevant org policy**: Copilot/MCP allow-lists and model exclusions
live at org level, not per repo.

### 1d. PostHog — Organization vs Project (verified via posthog.com docs mirrors + oauth-development-guide)

- **Organization settings:** billing and usage (Cloud), license management (self-hosted),
  members, SSO.
- **Project settings** (each project = a data silo; all queries project-specific):
  project name, **Project API key** (distinct write-only token per project, regenerable),
  timezone, autocapture snippet, **data capture configuration** (e.g., whether full IP
  is stored — data-governance control at project level), recordings on/off,
  **Access Control** (org-wide vs invited-users-only; private projects Enterprise).
- **API key scoping:** Personal API keys (`phx_…`, shown once) with granular scopes
  (`experiment:read`, `experiment:write`, …) and access levels **All / Organization /
  Team**. Billing limits configurable per project.
- Multiple projects per org and private projects are **plan-gated** (self-serve / teams /
  enterprise).

**Relevant to Marketr:** data-governance switches (IP storage, recordings) belong at
project level; billing + key-scope policy at org. "Project = data silo" maps directly to
Marketr projects (client sites) with per-project retention/governance.

### 1e. Langfuse — Organization → Project (verified via docs.dust-style community setup guides + self-hosting docs)

- Hierarchy: **Organization → Projects**. API credentials live at **Project Settings →
  API Keys**: key pair `pk-lf-…` (public) + `sk-lf-…` (secret, shown once).
- Self-hosted: headless init via env vars provisions org + project + key pair; **first
  user becomes org owner**. Pricing is usage/consumption based on Cloud.

**Relevant to Marketr:** open-source (MIT), dev-tool audience, self-hosted-first —
closest structural cousin to Marketr among the examples: org owns identity/billing,
project owns credentials and data.

### 1f. Supabase — Organization vs Project (verified via supabase docs + dashboard PRs)

- **Organizations:** one subscription/plan per org (Free/Pro/Team/Enterprise);
  **usage statistics moved from project level to organization level** (confirmed by
  dashboard PR "remove project usage settings callout," Apr 2026). Org settings: team
  members + roles (Owner/Admin), usage, SSO (Team/Enterprise), billing.
- **Projects:** each a dedicated instance (Postgres, Auth, Storage, Edge Functions,
  Realtime). Project settings: General, **API** (Project URL + `anon` public key +
  `service_role` key), Database, Authentication (providers, URL config), Storage,
  Edge Functions, Billing/add-ons.
- **Key scoping:** `anon` (public, RLS-limited — safe client-side) vs `service_role`
  (bypasses RLS — backend only). **Project add-ons** (compute, IPv4, log drains, custom
  domains, PITR) are configured **per project** and billed to the org subscription —
  a clean "entitlement at org, provisioning at project" split.
- Free-project quota counted per org (2 active free projects; members with
  Owner/Admin roles consume quota).

**Relevant to Marketr:** Supabase's recent consolidation of usage to org level is
evidence for "metering rolls up to workspace; quotas/limits can still gate at project."
The anon/service_role split is a good model for Marketr's own agent API keys (scoped
read keys vs privileged keys).

### 1g. Reflex (AI app builder) — unusually explicit org-vs-project settings table (verified via reflex.dev docs)

| Organization level | Project level |
|---|---|
| Members and seats | Which members can open the project |
| Organization roles (Admin, Manager, Member) | Project roles (Viewer, Editor, Admin + custom roles) |
| Billing, credits, and spending limits | Project name and deletion |
| Verified domains and auto-join | Deployment approvals |
| Single sign-on (SSO) | Secrets and integrations |
| Connected cloud providers | Project activity (audit log) |
| Organization-wide activity (audit log) | Apps and deployments |

**Relevant to Marketr:** the **audit log at both levels** and **deployment approvals at
project level** are directly applicable to Marketr's scheduled fix-agent (trust ladder:
supervised → scheduled → autopilot) — approval policy should be a per-project setting
with workspace-level defaults.

### ⚠️ Could not verify
- **Notion** and **Slack** exact settings groupings — did not re-check live docs in
  this pass. Known pattern (unverified here): workspace settings with
  owner/admin/member/guest roles, billing, SSO (Enterprise), workspace-level app
  management.
- **PostHog's current settings sidebar** (sources included older mirrors); the
  org-vs-project split above is consistent across sources but exact labels may drift.

---

## 2. Per-project agent configuration — AI/agent products

### 2a. Dust (verified via docs.dust.tt, official)

Per-agent (Agent Builder) configuration:
- **Instructions** — the system prompt / behavioral guidelines.
- **Tools & Knowledge** — which tools the agent may invoke (web search, data-source
  search, etc.); data sources are attached from **Spaces** (company data scoped by
  space; space = permission boundary for both agents and knowledge).
- **Advanced → model selection:** auto models (Basic / Standard / Premium —
  Dust-maintained lists) or pin a specific model; **reasoning effort**
  (None/Light/Medium/High). Reasoning effort *affects credit consumption and the model
  access tier* — i.e., model choice is directly metered.
- Agents are workspace objects shared with the team; Sidekick drafts instructions.

**Relevant to Marketr:** Instructions + enabled tools + model/effort selection is the
minimal complete per-project agent config. Dust's "effort affects credits" is the
pattern for Marketr's hosted margin model (model choice = cost knob).

### 2b. Cursor rules (verified via cursor.com/docs/context/rules summaries + community repos)

Three scopes, matching Marketr's needs almost 1:1:
- **Project Rules** — `.cursor/rules/*.mdc`, version-controlled, apply to all users on
  the project. Activation types: **always** (`alwaysApply`), **auto-attached** (glob
  patterns), **referenced** (by description), **manual** (`@rule-name`).
- **User Rules** — Cursor Settings > General > Rules for AI; global to the user across
  all projects; **not file-based** (managed in Settings UI).
- **Team Rules** — shared across the team (team scope).
- Massive community adoption of the project-rules convention (awesome-cursorrules
  ecosystem, per-project `.mdc` files in the wild).

**Relevant to Marketr:** the activation-type taxonomy (always / on-file-match /
on-demand / manual) is directly reusable for Marketr's agent skills & tools
enablement per project. "User rules live in Settings UI, not files" argues for a
workspace-level default prompt in UI + per-project instruction files.

### 2c. Claude Projects (verified via multiple setup guides + community docs)

Per project: **name + description**, **Project Instructions** (standing system prompt
applied to every chat in the project), **Project Knowledge** (uploaded docs/PDFs/code;
paid plans get RAG when content approaches limits; ~200K context on paid), conversation
history grouped in the project, **visibility** private/shared (Team/Enterprise).
Free plan cap: 5 projects.

**Relevant to Marketr:** the Instructions + Knowledge + shared/visible pattern is the
canonical consumer-agent config; Marketr's per-project agent should expose the same
three primitives (system prompt, knowledge sources, visibility).

### 2d. ChatGPT custom GPTs (verified via multiple builder guides)

The **Configure tab** is the reference IA for a per-agent settings surface:
- **Name, Description, Instructions** (system prompt), **Conversation starters**,
  **Knowledge** (file uploads), **Capabilities** (toggles: Web Browsing, DALL·E,
  Code Interpreter/Data Analysis), **Actions** (OpenAPI schema + Authentication:
  API Key/Bearer or **OAuth**), Additional Settings, **visibility** (Only me /
  Anyone with link / GPT Store — store listing requires verified builder profile:
  name + domain TXT verification).

**Relevant to Marketr:** Capabilities toggles = enabled tools/skills; Actions + auth =
Marketr's WordPress/Webflow connectors per project; conversation starters = agent
suggested prompts. Note the OAuth-vs-API-key choice for third-party actions — Marketr
connectors should offer both.

### 2e. Approval gates / automation permissions (patterns verified, agent-adjacent)

- **Reflex:** "Deployment approvals" is a **project-level** setting.
- **GitHub:** branch protection rules + required reviewers per repo = the classic
  approval gate; org sets the policy, repo configures it.
- **Cursor community pattern:** plan mode (no changes until plan approved) vs act mode
  — a two-mode trust gate.
- **Marketr's own decision (per SPEC):** fix agent on a trust ladder —
  supervised → scheduled → autopilot. External evidence supports placing the *mode*
  default at workspace level and the *per-project override* at project level.

### ⚠️ Could not verify
- **Replit Agent** per-project/workspace settings — not checked in this pass.
- **Windsurf** rules (global vs workspace) — known pattern from training data but not
  re-verified; treat as unverified.
- **Dust Spaces** permission details beyond the docs excerpts above.

---

## 3. Billing-relevant scoping — seats vs usage, workspace vs project

### Verified patterns

| Product | Seat model | Usage model | Where limits attach |
|---|---|---|---|
| **Vercel** | Paid seats by role; **Viewer role is free** (not a seat) | Compute/bandwidth/usage-based; spend management | Billing **per team**; usage rolls up |
| **GitHub** | Per-user seats; **Copilot seats managed at org** (Seat Management) | Actions minutes, storage, packages | Single billing profile **per org**; org sets defaults |
| **Supabase** | — (not seat-based) | MAU, storage, compute; usage **moved to org level** (2026) | One subscription **per org**; add-ons **per project** billed to org |
| **PostHog** | — | Events-based usage pricing; billing limits per project | Billing + usage at **org**; project-level spend caps |
| **Linear** | Per-seat; suspended members drop off next cycle | — | Plans/billing at **workspace** |
| **Dust** | Per-seat (workspace) | **Credits**; model + reasoning effort affect consumption | Credits at workspace; effort chosen **per agent** |
| **Reflex** | — | Credits + spending limits | Billing/credits/limits at **org** |

### Key abstractions found (verified in community design docs, consistent across products)

1. **Two quota kinds** (quotas.md design doc, splitsmith billing doc):
   - **Resource-count quotas** (gauges): max projects, max seats, max API keys —
     enforced at *create* time; over-limit → `402 Payment Required` / "delete or upgrade."
   - **Metered quotas** (windowed counters): API calls, events, LLM spend — enforced
     per billing period; hard cap → `429`; common soft pattern: warn at 80%, block at 100%.
2. **Fail-open commercial gates:** when a plan declares no limit, the check is a no-op —
   enforcement engages only once a plan names a finite limit.
3. **Hybrid seat+usage is the modern norm** (schematichq analysis): per-seat base for
   access + usage-based overages/credits for consumption. "AI workflows let teams
   produce more output without increasing headcount — under a pure seat model revenue
   stays flat while vendor cost rises." This is *exactly* Marketr's situation.
4. **Tenant-level LLM metering** (KnowledgeStack design): `agent_capacity_units` =
   max LLM spend per tenant, tracked via the LLM gateway — directly applicable to
   Marketr hosted tier (keys bundled with margin ⇒ must meter per workspace).

### Implications for Marketr's tiers (Starter $29 / Pro $79 / Agency $199 white-label)

- **Self-hosted (BYO keys):** no usage metering needed for LLM cost (user's own keys);
  entitlements are resource-count quotas (projects, seats, connectors, scheduled runs).
- **Hosted (keys bundled with margin):** needs per-workspace credit/usage metering
  with project-level attribution (agency resale), soft warnings + hard caps, and
  per-project model/effort defaults (Dust pattern) as the cost knob.
- **Agency $199 white-label:** mirrors Supabase's model — org subscription + per-project
  provisioning; usage rolls up to workspace for the invoice, attributable per project
  for client billing.

---

## 4. Security patterns

### SSO/SAML — always workspace/org level (verified)
- **Vercel:** Team Settings > Authentication > SAML SSO; "Require SAML for login";
  Directory Sync (SCIM) with group→role mapping; SAML SSO Enterprise or paid add-on.
- **GitHub:** Organization > Authentication Security (SAML enforce, IP allow list,
  EMU); documented audit event `org.sso_response`.
- **Supabase:** SSO at organization level on Team/Enterprise plans.
- **Reflex:** SSO listed under organization-level settings.
- **Linear:** workspace login preferences (admins); SCIM on Enterprise.

**Pattern:** identity is never per-project. SAML config, enforcement, SCIM, and
verified-domain auto-join all live at the workspace/org tier.

### Audit logs — both levels (verified)
- **GitHub Enterprise:** audit log with streaming to SIEM/S3; events typed per scope
  (`org.*`, `repo.*`, `oauth_access.*`).
- **Reflex:** organization-wide activity (audit log) **and** per-project activity
  (audit log).
- **Community SaaS pattern** (edraid/nextjs-supabase-saas-starter, 80 stars): dedicated
  `audit-log/` admin surface with admin-gated access.
- Marketr mapping: workspace audit log (member changes, key changes, billing) +
  project activity log (agent runs, approvals, content publishes, connector changes).

### API key scoping (verified)
- **PostHog:** personal keys with granular scopes (`resource:read/write`) × access
  levels (All / Organization / Team); key shown once, `phx_…`.
- **Supabase:** `anon` (RLS-scoped, client-safe) vs `service_role` (RLS-bypass,
  backend-only) — capability-based key tiers, not just scopes.
- **GitHub:** fine-grained PATs; org policy can restrict token lifetime + require SSO.
- **Linear:** workspace gate on who may create personal API keys.
- **Langfuse:** project-scoped `pk-lf`/`sk-lf` pairs, secret shown once.
- Marketr mapping: workspace-level keys (admin) vs project-scoped agent keys; secret
  shown once; optional expiry; SSO-gated issuance for hosted enterprise tier.

### Secret storage (verified)
- **GitHub:** Secrets and variables at org / environment / repository levels —
  inheritance chain.
- **Vercel:** env vars per environment; production-scoped variables can be
  **sensitive = write-once** (never readable again); shared team variables linked into
  projects.
- Marketr mapping (BYO keys): store third-party keys as write-once, per-environment
  (per-project) secrets with optional workspace-level shared secrets linked in —
  Vercel's model is the closest template.

---

## Appendix — Sources consulted (all fetched 2026-09-22)

- Vercel Academy "Settings" — https://vercel.com/academy/vercel-foundations/vercel-settings
- Vercel Directory Sync docs — vercel.com/docs/directory-sync
- Linear Docs: Workspaces — https://linear.app/docs/workspaces ; Members and roles — https://linear.app/docs/members-roles
- GitHub Docs: audit log events for Enterprise Cloud — docs.github.com (enterprise-cloud@latest)
- PostHog docs mirrors (projects.mdx, oauth-development-guide.md) via github.com
- Dust docs — docs.dust.tt (agents/model-selection, agents/create-your-first-agent)
- Reflex AI builder organization docs — github.com/eeshsaxena/reflex (docs/ai_builder/organization/overview.md)
- Supabase billing FAQ + dashboard PR #45393 (usage moved org-level) via github.com
- Cursor rules scoping — cursor.com/docs/context/rules (via voxmedia/open-agent-toolkit summary)
- Claude Projects setup — github.com/jamesgray-ai/cookbook, bradylandry/second-brain-template
- Custom GPT Configure tab — github.com/dlwhyte/reed, cammac-creator/ibanforge, vouch-protocol/vouch, wildnetedge.com guide
- Billing models — schematichq.com seat-based pricing 101; getmonetizely.com pricing metrics; knowledgestack/ks-docs billing-quotas.mdx; ronakmalik27/dotnet-starter quotas.md; mandakan/splitsmith 08-billing-and-quotas.md
- GitHub RBAC/SSO manual checks — github.com/microsoft/ghqr (MANUAL_CHECKS.md)

## Explicitly unverified / not re-checked
1. Notion and Slack exact settings groupings (known pattern from training data only).
2. Replit Agent and Windsurf per-project agent settings.
3. Data retention/deletion controls per product (not researched in this pass — needed for Marketr's data-governance section).
4. PostHog's *current* settings sidebar labels (sources included older mirrors).
5. Dust Spaces permission-model details beyond docs excerpts.
