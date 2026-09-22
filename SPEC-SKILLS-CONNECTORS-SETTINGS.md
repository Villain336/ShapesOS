# Marketr — Skills, Connectors & Settings Spec

Status: DRAFT for Tico's approval (spec-first Phase 4). No build until approved.
Decisions locked 2026-09-22: hybrid connector architecture (direction 3); SKILL.md open standard; Claude-style skill semantics; install permission = workspace admins + explicit grants; files = attach/reference only; no public marketplace (built-in registry + URL/GitHub install); settings = workspace baseline + per-project override.
Landscape research: `research/skills-connectors-settings-landscape.md`.

## 1. Problem

A Marketr workspace's marketing reality lives outside Marketr: Search Console and GA4 hold the traffic truth, briefs live in Drive/Notion, the site lives in WordPress/Webflow. Marketr's agent can't reach any of it, so every session starts with the user copy-pasting context the business already has, and every new project repeats the same setup. For agencies this is worse: 10–30 client projects, each needing its own data connections, with client data that must never leak across projects. The cost is measured in hours of repeated setup per client and an agent that answers without ever knowing the business.

## 2. Target user

**Priya, agency owner (white-label).** Runs 12 client projects in Marketr. Today she screen-shares GA4 numbers into chat and re-uploads the same brand brief per project. She'd switch for per-client data connections she sets up once, skills her team can reuse, and an audit trail she can show clients.

**Marcus, solo founder.** One project, five tools. He wants one OAuth click per tool and an agent that just knows his stack. He uses ChatGPT with copy-paste today; he'd switch for an agent wired directly to his data, self-hosted if he wants.

## 3. The idea

Marketr learns your stack. Connect your data sources once, install skills that teach the agent how your business does marketing, and set defaults at the workspace level that every project inherits — then override per project. The sentence that sells it: "Connect Search Console, Drive, and WordPress once, and Marketr's agent works like it's on your team."

## 4. Why now

Three standards converged: MCP is now an industry standard (Linux Foundation, Dec 2025 — ChatGPT, Gemini, Copilot adopted), SKILL.md is a published open agent-skills standard (~32 tools support it), and per-user OAuth vaults are a solved pattern. Inside Marketr, the foundation is already built: provider abstractions (DataForSEO, SiteConnector, DeployTarget), AES-256-GCM credential encryption (M6), workspace RBAC (M11), and audit logging. We're adding the missing layer, not starting over.

## 5. Core user flows

**Flow 1 — Install a skill from the built-in registry.**
1. Admin opens Workspace Settings → Skills → Registry tab; sees bundled packs (e.g. "SEO Audit", "Content Brief", "Rank Report") each with name, description, version, tools it uses.
2. Admin clicks Install on "SEO Audit"; Marketr records the SKILL.md, version 1.2.0, source=registry, installed-by.
3. Admin opens a project → Project Settings → Skills, toggles "SEO Audit" ON for that project.
4. In a Marketr chat for that project, the agent's system prompt now includes the skill's name+description (~100 tokens); when the user asks for an audit, the agent loads the full SKILL.md and follows it, calling the Search Console connector tools the skill declares.

**Flow 2 — Install a skill from a GitHub URL.**
1. Admin opens Workspace Settings → Skills → Install from URL, pastes `https://github.com/acme/seo-skills`.
2. Marketr fetches the repo's SKILL.md, shows name/description/version, pins the install to the current commit SHA, and flags it "untrusted source — review before enabling."
3. Admin reviews the SKILL.md preview, clicks Install; provenance (URL + SHA + installer) is written to the audit log.
4. Re-pinning to a newer commit is a deliberate one-click action later; MVP never auto-updates URL skills.

**Flow 3 — Connect a data source (OAuth).**
1. User with `connectors.connect` permission opens Workspace Settings → Connectors → "Google Search Console" → Connect.
2. Browser OAuth consent flow (Google); Marketr stores the token encrypted (AES-256-GCM) scoped to that user + workspace, with refresh token.
3. Token refreshes silently; if refresh fails, the connector shows "Reconnect needed" and the next use prompts a one-click re-auth. No other user is affected.
4. Admin opens a project → Project Settings → Data, selects the Search Console connection and picks the property (e.g. `example.com`) for that project. Other projects can't see it.

**Flow 4 — Attach a file to a Marketr chat.**
1. In any Marketr chat, user clicks Attach → Upload (PDF, docx, csv, image) or Browse Drive/Notion (via connected connectors).
2. The file is attached to that session; the agent can read it and cite it ("per your Q3 brief…"). Attachments are listed in the session and in Project Settings → Files.
3. Nothing is indexed or embedded; removing the attachment removes the agent's access. No vector DB, no background sync.

**Flow 5 — Attach a generic MCP server (breadth path).**
1. Admin opens Workspace Settings → Connectors → Add MCP server, pastes a Streamable-HTTP endpoint URL (self-hosted may also use a stdio command).
2. Marketr handshakes, lists the server's tools with names/descriptions, and records the server as a connector of kind=mcp.
3. Admin enables selected tools per project in Project Settings → Data; the agent can then call them like any native tool, subject to the same permission and audit rules.

**Flow 6 — Override a workspace default at project level.**
1. Admin sets Workspace Settings → Defaults: model = "sonnet-tier", approval mode = "supervised", brand voice file attached.
2. For client Acme (regulated industry), admin opens Project Settings → General, overrides approval mode to "manual-only" and attaches Acme's compliance brief.
3. Project Settings shows every value as "inherited from workspace" or "overridden"; one click resets to inherited. Overrides never affect other projects.

**Flow 7 — Audit review.**
1. Owner opens Workspace Settings → Audit Log, filters by actor/event/project.
2. Every skill install/enable, connector connect/disconnect, file attach, and settings change appears with who/when/project. Exportable as CSV.

## 6. Data model

- **Skill** — id, workspaceId, name, slug, description, source (`registry`|`url`|`upload`), sourceRef (URL or pack id), version, shaPin (for url), skillMd (text), declaredTools (string[]), trustTier (`built-in`|`pinned-url`), installedBy (userId), installedAt.
- **ProjectSkill** — projectId, skillId, enabled (bool), enabledBy, enabledAt. Unique(projectId, skillId).
- **Connector** — id, key (`google-search-console`, `ga4`, `wordpress`, `webflow`, `google-drive`, `notion`, `buffer`, `resend`, custom…), kind (`native`|`mcp`), displayName, authType (`oauth2`|`apiKey`|`none`), configSchema (json), mcpEndpoint (nullable), workspaceId (nullable — null = built-in).
- **ConnectorConnection** — id, connectorId, workspaceId, userId, status (`active`|`needs_reauth`|`revoked`), scopes (string[]), connectedAt, lastRefreshAt.
- **ConnectorCredential** — connectionId (unique), encryptedBlob (AES-256-GCM via SecretsProvider), keyVersion, expiresAt. Never logged, never returned to clients.
- **ProjectDataSource** — projectId, connectionId, connectorKey, projectConfig (json — e.g. Search Console property, Drive folder id). Unique(projectId, connectionId).
- **FileAttachment** — id, projectId, sessionId (nullable), source (`upload`|`connector`), connectorKey (nullable), externalRef (nullable), filename, mimeType, sizeBytes, uploadedBy, createdAt.
- **WorkspaceSettings** — workspaceId (unique), defaultModel, defaultApprovalMode (`supervised`|`scheduled`|`manual`), notificationDefaults (json), dataGovernance (json — retention flags), agentAllowList (string[] — which tool namespaces the agent may use).
- **ProjectSettings** — projectId (unique), overrides (json — any workspace default), locale, brandContext (text), domains (string[]), approvalModeOverride (nullable), publishingControls (json).
- **AuditLog** (existing, new event types) — `skill.installed`, `skill.enabled`, `skill.disabled`, `connector.connected`, `connector.disconnected`, `connector.reauth`, `file.attached`, `file.removed`, `settings.workspace_updated`, `settings.project_updated`.

Skill loading (agent runtime): at session start, for each enabled ProjectSkill, inject `name: description` (~100 tokens each) into the system prompt. When the agent's reasoning matches a skill, load its full skillMd into context. Skills declare tools; the agent may only invoke declared tools that resolve to enabled project data sources. Denied invocations are refused with a message, not silently skipped, and logged.

## 7. MVP scope

- Skill library: install from built-in registry (ship 4 packs: SEO Audit, Content Brief, Rank Report, Competitor Watch), from GitHub URL (SHA-pinned, untrusted-source warning), and from SKILL.md file upload.
- Per-project skill enable/disable with inherited-vs-overridden display.
- Progressive-disclosure skill loading in the Marketr agent loop, with declared-tool gating.
- Uniform Connector interface with two implementations: native adapters + generic MCP client (Streamable HTTP; stdio allowed on self-hosted).
- 12 first-party native adapters (Tico's call 2026-09-22): Google Search Console, GA4, WordPress, Webflow, Google Drive, Notion, Buffer, Resend, DataForSEO, Meta Ads, Google Ads, Canva. (WordPress/Webflow/Buffer/Resend/DataForSEO standardize the existing M2/M8/M19/M20 integrations behind the new interface; Canva via the Canva Connect API — OAuth, review-gated — per the marketr-research-growth findings.)
- Per-user OAuth vault: browser consent → encrypted storage → silent refresh → one-click re-auth on failure. API-key auth for services without OAuth, encrypted identically.
- Per-project data source binding (e.g. pick the Search Console property per project).
- File attach/reference in chat sessions and briefs (upload + Drive/Notion browse). No indexing.
- Workspace Settings pages: Skills, Connectors, Members/Roles (extend M11), Providers/Keys, Data Governance, Security, Notifications, Defaults, Audit Log.
- Project Settings pages: General (locale, domains, brand context), Skills, Data, Files, Automation/approval permissions, Publishing controls.
- Permission grants: `skills.install`, `connectors.connect` assignable to roles or individual users; owner/admin hold all by default (extends M11 RBAC).
- Full audit coverage of every flow above, CSV export.

## 8. Non-goals (explicit)

- **No public skill marketplace.** Tico killed it. No third-party publishing, no revenue split, no review pipeline. Rationale: the trust incident record (1.7M+ installs credential theft) makes a marketplace a liability before we're a platform.
- **No file indexing / RAG / vector search.** Tico chose attach/reference. Rationale: 10x less infrastructure, no permission-sync engine, no stale-index bugs; revisit only if attach/reference proves insufficient.
- **Marketr exposed as an MCP server** — later. Rationale: consume first, expose after the connector model is proven.
- **Usage metering / connector billing on hosted** — later. MVP ships with no pricing change; the metering design (per-workspace credits, project attribution) is recorded for the hosted tier.
- **Auto-update of URL-installed skills** — pinned SHAs only in MVP; deliberate re-pin action. Rationale: silent upstream changes are a supply-chain risk.
- **Zapier hosted-MCP bridge as a first-class curated connector** — the generic MCP attachment covers it in MVP; a polished one-click version is later.

## 9. Monetization

No pricing change in MVP. The path, recorded for the hosted tier: per-workspace credit metering on connector tool calls (metered tools warn at 80%, hard-stop at cap — the 402/429 pattern), with project-level attribution so agencies can see per-client cost. Self-hosted stays entitlement-only (BYO keys, no metering). Skills themselves are free and open — there is no marketplace to take a cut from, by design.

## 10. Differentiation & moat

1. **Skills + connectors + marketing workflows in one open-source workspace.** Nobody bundles standard SKILL.md skills with first-party marketing connectors (Search Console → content engine → WordPress publish) in a self-hostable package.
2. **Hybrid breadth.** The MCP long tail gives "as many as possible" on day one; the curated native core keeps the critical paths trustworthy. Competitors pick one; we ship both behind one interface.
3. **Agency-shaped scoping.** Workspace baseline + per-project override with per-client data isolation and a full audit trail is exactly the white-label agency shape — and it's structural, not a feature flag competitors can bolt on in a sprint.

## 11. Tech approach

Next.js + Prisma + PostgreSQL (existing Marketr stack). New server-side libraries only; no new infrastructure for MVP.

- `lib/skills/` — registry loader (built-in packs), URL importer (fetch + SHA pin + SKILL.md parse/validate frontmatter), progressive-disclosure injector for the agent system prompt, declared-tool gating.
- `lib/connectors/` — the uniform `Connector` interface (`listTools()`, `invoke(tool, args, credential)`, `authType`, `configSchema`); `native/` adapters (8 first-party); `mcp/` generic client over Streamable HTTP using `@modelcontextprotocol/sdk` (stdio transport allowed on self-hosted only).
- `lib/vault/` — reuse the M6 AES-256-GCM encryption + M11 SecretsProvider abstraction (env key default, KMS-ready). OAuth2 flows: Auth.js providers where they exist, custom OAuth2 client otherwise; refresh loop on a cron, status transitions to `needs_reauth` on failure.
- Agent loop changes: skill manifest injection at session start, full-SKILL.md load on match, tool calls routed through the connector interface with per-project enablement checks.
- UI: `app/dashboard/settings/*` (workspace) and `app/dashboard/projects/[id]/settings/*` (project), reusing the existing settings-page patterns from M11/M12. No new component-library exceptions — RareUI/BeautifulUI/shadcn per the standing constraint.
- Dependencies to add: `@modelcontextprotocol/sdk`. Everything else exists in the repo.

## 12. Success metrics

First 30 days (in-house agency beta): ≥80% of active workspaces connect ≥1 data source; ≥3 skills enabled across active projects; zero credential incidents; median OAuth connect time < 2 minutes.

First 90 days (public repo + Product Hunt): connectors installed in ≥40% of new workspaces within 7 days of signup; skill-install-to-project-enable conversion ≥50%; ≥5 community-contributed URL-installable skills observed in the wild (no marketplace — just GitHub links people share); hosted credit-metering design validated against real usage data.

## 13. Risks & open questions

- **Exact MVP native-adapter list** — decided 2026-09-22 (Tico): Search Console, GA4, WordPress, Webflow, Google Drive, Notion, Buffer, Resend, DataForSEO, Meta Ads, Google Ads, Canva.
- **Skill tool-action approvals** — decided (pending final spec sign-off): skill-declared tool calls follow the existing M18 trust ladder (supervised → scheduled → manual-only), default supervised — same as every other agent action in Marketr. Tico can veto before build.
- **MCP transports in MVP** — decided: Streamable HTTP everywhere; stdio only on self-hosted. Rationale: stdio needs local process execution, unsafe on hosted.
- **Marketr as an MCP server** — decided: later, not MVP.
- **Per-seat vs per-workspace for connector credentials on agency white-label** — needs research during build. Proposal: credentials are per-user; project binding is per-project; a "service account" connection type owned by the workspace (not a person) is the likely answer for agencies — validate with the in-house beta.
- **Google/Notion OAuth app verification** — needs research. Production OAuth consent screens need app verification (brand, domains, review). Flag as a pre-launch checklist item, not a spec blocker.
- **Unverified research items carried over** (flagged in the landscape report): skills.sh skill counts, Make/Celonis acquisition, Guru pricing, ChatGPT Projects file limits. None block MVP; re-verify if cited in docs.
