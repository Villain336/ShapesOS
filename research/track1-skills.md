# TRACK 1 — Agent skill systems landscape research
Date: 2026-09-22 · Research-only, read-only. Vault-private.

> Sources were web-fetched 2026-09-22; facts below carry source links. Star counts were measured via the GitHub API on 2026-09-22 unless noted. Anything not verified this session is flagged **[UNVERIFIED]**.

---

## 1. Claude Agent Skills (SKILL.md format) — the standard

**Who built it:** Anthropic. Launched as a Claude feature Oct 2025; published as an **open standard** at [agentskills.io](https://agentskills.io/specification) on **2025-12-18**, donated to the **Agentic AI Foundation (AAIF)**. Reference spec + template + example skills live in [github.com/anthropics/skills](https://github.com/anthropics/skills) under `./spec` (official spec) and `./skills` (examples). GitHub API star count on 2026-09-22: **177,586 stars**.

### Format
A skill is a **folder** containing a mandatory `SKILL.md` plus optional `scripts/`, `references/`, `assets/`:

```
my-skill/
├── SKILL.md          # required: YAML frontmatter + Markdown body
├── scripts/          # optional: executable code (run, not read)
├── references/       # optional: deep docs loaded on demand
└── assets/           # optional: templates, schemas, static files
```

**Frontmatter (discovery layer):**
| Field | Required? | Notes |
|---|---|---|
| `name` | yes | kebab-case, max 64 chars, lowercase letters/numbers/hyphens; reserved words `anthropic`/`claude` banned; no XML tags; must match directory name |
| `description` | yes | "what it does and when to use it", max 1024 chars, non-empty, no XML tags — this is the *only* thing the matcher reads |
| `allowed-tools` | no (Claude Code extension) | restricts which tools the skill may use |
| `model` | no (Claude Code extension) | pin a model for the skill |
| `license` | no (open-spec field) | SPDX identifier for redistribution |
| `metadata` | no | extra key-value pairs |
| `version` | no | semver convention used by registries (ClawHub auto-increments on publish) |

Best practice from the community: keep `SKILL.md` under ~500 lines / <5k tokens; push depth into `references/` and `scripts/`.

### Discovery & invocation (progressive disclosure — the core mechanic)
Three loading levels:
1. **Level 1 — metadata (always loaded):** only `name` + `description` (~100 tokens per skill) go into the system prompt at startup. The agent decides relevance *almost entirely* from the description.
2. **Level 2 — instructions (on match):** the full `SKILL.md` body loads only when the agent (or user, e.g. "use the PDF skill") triggers it.
3. **Level 3 — resources (on demand):** sibling files load only when `SKILL.md` tells the agent to read them; `scripts/` are **executed via bash** — only their output enters context, which is cheaper and more reliable than having the model regenerate code.

This is why a skill bundle can ship "a megabyte of detail at near-zero token cost" — and why the description field is the product surface that matters.

### Hooks (event-driven, distinct from skills)
Configured in `~/.claude/settings.json` (or plugin `hooks/hooks.json`). Event types: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `Notification`. Each hook entry has a `matcher` (tool-name regex), `type: "command"|"prompt"`, `command`, `timeout`. The harness pipes JSON in via stdin; the script exits 0 (allow) or 2 (block), or emits JSON with `hookSpecificOutput.permissionDecision: "allow"|"deny"|"ask"|"defer"`. Rule of thumb from docs: **skills are request-driven (knowledge), hooks are event-driven (guardrails).** Disable hooks per-handler config or globally via `disableAllHooks: true`. *(Anthropic docs also provide official Skills-writing guidance: "MCP provides the professional kitchen, skills provide the recipes.")*

### Installation & enable/disable (Claude Code)
- **Personal:** `~/.claude/skills/` — follows the user across projects.
- **Project:** `.claude/skills/` — ships with the repo via Git.
- **Plugin marketplaces:** `/plugin marketplace add anthropics/skills` then `/plugin install document-skills@anthropic-agent-skills` (or community marketplaces like `mdorf/agent-skills`). Skills install inside plugins; disable/remove via plugin UI or settings. **[UNVERIFIED:]** per one mirror of Anthropic connector docs, "skills are not a standalone directory type — skills must be distributed as part of a plugin; you cannot submit a skill to the directory on its own" (for the Claude Code plugin directory specifically).
- **Claude.ai:** built-in skills ship on paid plans; custom skills upload via **Settings → Capabilities → Code execution and file creation → Customize → Skills** ("+" to add).
- **API (beta `skills-2025-10-02`):** `client.beta.skills.create(...)` uploads a zip/dir (≤30 MB, SKILL.md at root); custom skills are **private to the workspace**; invoke via `container.skills: [{type: "custom"|"anthropic", skill_id, version}]`, requiring the code-execution tool. Loaded into the container at `/skills/{skill-name}/`.
- **Subagents** don't inherit skills automatically — they must be listed in the subagent's `skills` frontmatter.
- **Enterprise:** managed settings push skills org-wide; priority order Enterprise → Personal → Project → Plugins.

### Versioning & updates
- **API:** snapshot versioning, not deltas — each new version is a complete re-upload. Anthropic skills: date format (`20251013`); custom skills: auto-generated IDs (epoch timestamps like `1759178010641129`); pin exact or use `"latest"`.
- **Plugin marketplaces:** update by re-installing the plugin / re-pulling the git marketplace repo. No in-app auto-update channel was verified this session **[UNVERIFIED]**.
- **Claude.ai uploads:** manual re-upload to replace; one community workflow re-uploads via console + activates the new version.
- **Claude Code extensions to the spec:** invocation control, `context: fork` (subagent execution), dynamic context injection — see code.claude.com/docs/en/skills.

### Adoption
The open spec is supported by **~32 tools** (Claude Code, OpenAI Codex CLI, Google's Gemini CLI, GitHub Copilot/VS Code, Cursor, JetBrains Junie, AWS Kiro, Block's Goose, OpenClaw, Hermes Agent, …). Adopters/partners named in coverage: **Microsoft, Atlassian, Figma, GitHub, Canva, Stripe, Notion, Zapier, Hugging Face** (`huggingface/skills`, 11,079 stars), **ElevenLabs** (`elevenlabs/skills`), **Obsidian** (`kepano/obsidian-skills`).

---

## 2. ChatGPT custom GPTs + Actions

**Who built it:** OpenAI. GPT Store launched Jan 2024.

### Building & publishing
- Builder (no-code dialog or config tabs): name, description, instructions (8,000-char limit), conversation starters, knowledge files, capabilities (web browsing, DALL·E, code interpreter), **Actions**.
- Visibility tiers: **private (only me)** · **link-only** · **workspace/Team** · **public (GPT Store)**. Review system checks brand guidelines + usage policies. Publishing a GPT requires a **paid ChatGPT plan**.

### Actions
- Defined by an **OpenAPI 3.1.0 schema** pasted into the builder (or imported from URL), mapping GPT operations to your API endpoints.
- Auth options: none, **API key**, or **OAuth** (builder supplies client ID/secret; user consents during the flow).
- Permission UX: ChatGPT prompts the user for consent (**"Allow"**) before an Action runs — first-run / per-action consent dialog. **[UNVERIFIED this session]** — not re-fetched from OpenAI docs today; confirm before quoting exact behavior.

### Install / revenue model
- **Install model:** no install at all — a GPT is a link. Distribution = GPT Store discovery (leaderboards, categories) or direct link. Store is gated to paid users.
- **Revenue sharing:** OpenAI promised a GPT-builder revenue program for Q1 2024 ("US builders paid based on user engagement"). As of **Jan 2026**, per multiple reports (WIRED cited), it is still an **invite-only US-only pilot**; no public criteria, no self-serve checkout, **no mechanism for direct per-GPT purchases or subscriptions** inside the Store. One 2026 guide estimates typical creators at "$100–500/month soft ceiling unless top 0.01% engagement."
- Builders monetize **outside** OpenAI instead: third-party paywalls (e.g. Authflow.ai — Stripe-backed auth + paywall via a single GPT Action), or GPTs as free lead-gen funnels to their own sites (UTM-tracked CTAs in instructions).
- Note: **ChatGPT Apps** (announced Dec 2025, separate surface) is where OpenAI is experimenting with commerce — initial support focused on physical goods, digital-products monetization "being explored" as of Dec 2025. Not the same as GPT Store monetization.

### Pricing (OpenAI side)
- GPT Store / custom GPT creation & use requires **ChatGPT Plus/Team/Enterprise**; public GPT use also gated to paid users. GPT Actions call the builder's own API — builder pays their infra.

---

## 3. Claude Connectors

**What it is:** Anthropic's product surface for **OAuth integrations to first-party apps** — Notion, Slack, Asana, Linear, Google Workspace, etc. Under the hood: remote MCP servers. Available in Claude.ai, Desktop, mobile, Cowork, and Claude Code.

**How it differs from skills (per Anthropic):**
| MCP / Connectors (connectivity) | Skills (knowledge) |
|---|---|
| Connects Claude to your service | Teaches Claude how to use it effectively |
| Real-time data access + tool invocation | Workflows, conventions, best practices |
| *What* Claude can do | *How* Claude should do it |

**Partner pattern (documented):** most partners ship **both** — a remote MCP server *plus* a plugin that wraps it with skills ("Claude knows how to *use* your product" vs "Claude can call your API"). Plugins (skills + connector refs + slash commands) work in **Claude Code and Cowork only**, not Claude.ai web/mobile.

**Adoption:** named as a core Claude product surface alongside skills; the "recipes on top of the kitchen" pattern is Anthropic's official guidance to MCP builders. No public install/usage numbers were found **[UNVERIFIED]**.

---

## 4. Open-source skill registries & marketplaces

### skills.sh — "npm for agent skills"
- **Who:** built by **Vercel Labs**.
- **What:** open directory + CLI. Install: `npx skills add owner/repo`; the CLI detects installed agents (Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, Gemini CLI…) and installs to the right path. Browseable leaderboard sorted by **install counts** (telemetry from the CLI).
- **Scale claims:** marketing ranges from "1,000+" to "100,000+ free skills" across videos/posts — the large numbers appear to include auto-indexed GitHub content **[UNVERIFIED — treat 100k+ as a marketing claim]**. One video cites the `find-skills` skill at 180k–190k installs.
- **Launch date discrepancy:** one Medium guide says "launched by Vercel in early 2025"; several Jan 2026 videos treat it as just launched. **[UNVERIFIED — flag.]**
- **Security record (verified):** Aug 2026, **Zenity Labs disclosed at Black Hat USA** that attackers cloned popular skills.sh listings, let clones build clean reputation + download counts, then rewrote them to exfiltrate **SSH keys and cloud credentials** — one affected skill family reached **>1.7M aggregate installs** before takedown. Separate criticism: "find-skills" style dynamic GitHub pulls with **no versioning** — listings can be silently rewritten by authors or hijacked accounts ("WordPress-plugins moment" comparisons).

### ClawHub — OpenClaw's skill registry
- **What:** public registry for **OpenClaw** (open-source personal AI agent; MIT; lobster mascot; went viral Jan 2026 under names Clawdbot/Moltbot). Install: `npm i -g clawhub` then `clawhub install <skill-slug>`.
- **Scale claims:** sources vary — 6,632 to 9,300+ to **10,700+ skills** (mid-2026), **1.5M+ total downloads** **[partially UNVERIFIED — figures conflict across sources]**.
- **Features:** SKILL.md-centered listings; **semver versions, tags, changelogs, download counts, stars, security scan summaries**; vector-embedding search (not keyword); TanStack Start + Convex + GitHub OAuth.
- **Repo stars:** [openclaw/clawhub](https://github.com/openclaw/clawhub) reported ~9.1k stars (Jul 2026) / 8.9k (mid-2026) in two sources. ⚠️ **Flag:** GitHub API returned **390,249 stars for `openclaw/openclaw`** on 2026-09-22, which is implausible (near the all-time record) and contradicts a third-party doc's "180,000+" — likely inflated; do not cite without verification. `openai/skills` = **27,545 stars** (measured same day).
- **Security record:** the **ClawHavoc** campaign found hundreds of malicious skills in early 2026.
- **ClawHub frontmatter extensions:** `trigger` (keywords/regex/`"*"` always-on), `tools` (`shell|filesystem|browser|http|memory|chat`), `version`, `author`, `config`, `depends`.

### Awesome lists / directories (GitHub)
| Repo | Stars (API, 2026-09-22) | Content |
|---|---|---|
| `VoltAgent/awesome-agent-skills` | **34,723** (MIT) | 1,000+ skills, cross-platform (Claude Code, Codex, Cursor, Gemini CLI…) |
| `VoltAgent/awesome-openclaw-skills` | **52,719** (MIT) | 5,400+ curated OpenClaw skills |
| `huggingface/skills` | **11,079** (Apache-2.0) | official HF ecosystem skills |
| `anthropics/skills` | **177,586** | official examples + spec + template |
| `openai/skills` | **27,545** | official OpenAI skills for Codex/Agents SDK, same SKILL.md standard |
| `ComposioHQ/awesome-claude-skills` | n/a | 107 skills (Claude.ai + API) |
| `majiayu000/claude-skill-registry` | n/a | 1,001+ skills, web search UI |
| `jdrhyne/agent-skills` | n/a | 35 curated, AgentVerus-certified |
| `claudemarketplaces.com` | n/a | directory of 2,748 Claude Code plugin marketplaces |
| `obot-platform/obot` | **1,035** (MIT) | Obot AI "governance platform" — small; not a skills marketplace per se |

Also named in community docs: **claudskills.com** (claims 62k+ skills), **agensi.io** (verified installs), **tokrepo.com**, **cursor.directory** (Cursor rules/skills), **claudemarket.ai** (blog/directory), **skillhub** (134k skills claimed by the `dsh-skill-store` plugin), GitHub code search `gh search repos "claude-skill"`.

### Cross-compat note
The SKILL.md folder is portable across CLIs; only install paths differ: `~/.claude/skills/` (Claude Code), `~/.codex/skills/` or `.codex/skills/` (Codex), `.cursor/skills/`, `.gemini/skills/`, `.agents/skills/` (OpenClaw), `~/.hermes/skills/` (Hermes). OpenAI documents SKILL.md compatibility in Codex and its API. GitHub Copilot in VS Code also supports it.

### Pricing
- skills.sh: free. ClawHub: free/open registry (MIT). Awesome lists: free. Nobody in this lane charges for listing; monetization (where it exists) is third-party paywalls or the builder's own API behind the skill.

---

## 5. Permissions / scopes & updates

### Permissions & scopes
- **Claude Code:** `allowed-tools` frontmatter scopes which tools a skill may invoke; the agent's own permission system (`permissions.allow`, PreToolUse hooks with allow/deny/ask) gates everything the skill does. **Skills are plain-text instructions, not sandboxed code** — trust comes from the user reading the SKILL.md before install; `scripts/` run arbitrary shell.
- **Anthropic API skills:** run inside the **container code-execution environment** (sandboxed); skills are copied to `/skills/{name}/`; multiple skills compose.
- **Enterprise/managed:** admin-pushed skills with priority ordering (Enterprise → Personal → Project → Plugins); department/workspace scoping exists in third-party platforms (e.g. Arkon-style portals).
- **ChatGPT Actions:** user consent dialog on first run ("Allow") + OAuth for authenticated APIs **[UNVERIFIED this session — from prior knowledge, re-verify before quoting]**; GPT review system screens listings.
- **Connectors:** OAuth-based; install = OAuth grant, managed in Claude's integrations panel.

### Updates
| System | Update mechanism |
|---|---|
| Claude Code plugins/marketplaces | re-install plugin / re-pull the git marketplace; no verified in-app auto-update channel |
| skills.sh | `npx skills add` re-install; listings are dynamic GitHub pulls with **no versioning** — a known supply-chain weakness |
| ClawHub | **semver + changelogs**; versioned publishes, CLI can update |
| Anthropic API | snapshot versions; pin exact or `"latest"`; full re-upload per version |
| Claude.ai custom uploads | manual re-upload through Console/Skills settings |

### Security — relevant to Marketr design
- ArXiv survey **arXiv:2602.12430** (cited in Medium coverage): **26.1% of community-distributed skills had vulnerabilities** — data theft 13.3%, privilege escalation 11.8%. Preprint, not peer-reviewed **[caveat]**.
- **Zenity Labs, Black Hat USA Aug 2026:** skills.sh credential-theft campaign, 1.7M+ installs before takedown.
- **ClawHavoc (early 2026):** hundreds of malicious ClawHub skills.
- Takeaway: the whole lane runs on **read-before-install trust**; registries that add versions/changelogs/security-scan summaries (ClawHub) are ahead of ones that don't (skills.sh dynamic pulls).

---

## Implications for Marketr (research → spec input)
1. **Format bet:** SKILL.md (Agent Skills open standard) is the de-facto packaging format across Claude Code, Codex, Copilot, Cursor, Gemini CLI, OpenClaw. A Marketr skill system should emit/consume SKILL.md to ride that standard.
2. **Layering:** skills (marketing workflows: SEO audit, content brief, rank report) on top of connectors/MCP (WordPress, Search Console, GA4 access) mirrors Anthropic's official "kitchen + recipes" pattern.
3. **Distribution options:** GitHub folder + install script (zero infra), a ClawHub-style registry (versioning + trust signals), or skills.sh-compatible `npx skills add owner/repo` listings.
4. **Hard problems to spec:** permissions/scoping (per-skill `allowed-tools`, team/workspace scoping), **updates** (no push channel anywhere), and **trust** (security incidents are the #1 ecosystem risk — plan review/verification before launch).
5. **Monetization precedent:** nobody charges for listing; paid value lives in the builder's API/paywall behind the skill (OpenAI GPT Store revenue sharing remains an invite-only pilot; don't model on it).

---
*Notable official links:* [agentskills.io/specification](https://agentskills.io/specification) · [anthropics/skills](https://github.com/anthropics/skills) (examples + `./spec` + `./template`) · [platform.claude.com Skills guide](https://platform.claude.com/docs/en/build-with-claude/skills-guide) · [Anthropic engineering: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) · [claude.com/blog: Skills explained](https://claude.com/blog/skills-explained)
