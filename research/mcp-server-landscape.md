# Marketr as MCP Server — landscape brief (2026-09-22, planning only, no build)

## 1. Real products exposing remote MCP servers today
- Linear — `https://mcp.linear.app/mcp`, streamable HTTP, OAuth 2.1 with Dynamic Client Registration (RFC 7591): client registers itself on the fly, no manual app registration. Source: auth0-ai-samples README (DCR example), factory-ai CLI docs.
- Notion — OAuth 2.0, remote HTTP endpoint. Sentry — `https://mcp.sentry.dev/mcp`, OAuth via browser consent. Stripe (agent-toolkit), Figma, Canva, Intercom, Monday, Vercel, Cloudflare, Shopify, Webflow, PayPal, Netlify — most use OAuth + DCR where supported, static Bearer/API-key header where not. Source: osaurus provider catalog, factory-ai CLI docs.
- Auth pattern: OAuth is the norm for multi-tenant SaaS; API keys/tokens survive for single-user or dev setups (`--header "Authorization: Bearer …"` at install time).
- Transport: Streamable HTTP is the current standard for remote servers; SSE is legacy/superseded. stdio remains for local-only. Source: modelcontextprotocol spec refs.
- Discovery/install: user pastes a URL into the host (`claude mcp add --transport http notion <url>`), host discovers tools, browser-based consent, then "Connected". Canonical index: registry.modelcontextprotocol.io. Source: factory-ai CLI docs, subagentic.ai guide.

## 2. Tool design granularity (hard-won lessons)
- 5–15 tools per server is the practical ceiling; 30+ degrades selection. Schemas are 60–80% of MCP token cost (~200–400 tokens per tool def, every request). GitHub's 91-tool server ate ~22.2% of a 200k context window. Source: maestro SKILL.md, savecraft mcp-design.md, xmcp SKILL.md.
- Cardinal sin: 1:1 REST-endpoint→tool mapping (top r/mcp post, 214 upvotes). Block Engineering's Linear integration went 30+ GraphQL mirrors → 2 tools. Design task-oriented tools ("make pizza", not "open oven door"). Source: savecraft mcp-design.md.
- Names guide behavior: verb+object, task-named (`notify-team` not `post-slack-message`). Outputs must be composable (return IDs the agent feeds into the next call), paginated by default (`limit`, `has_more`, `total_count`), and use `outputSchema` so results are typed. Source: maestro SKILL.md, xmcp SKILL.md, Medium 8-patterns.
- For large surfaces: progressive discovery (`search_tools` / `describe_tool` / `execute_tool`) or a category parameter, not a flat 40-tool dump. Host limits vary: Cursor ~40 tools total, Copilot 128 — design for the lowest common denominator. Source: maestro SKILL.md, mech-crate doc.

## 3. Security pitfalls
- Real incidents: May 2025 prompt injection vs GitHub MCP (over-scoped PAT pulled private repos); Asana cross-tenant access from an unenforced permission layer. Patterns: tool poisoning, confused deputy. Source: Webflow blog on MCP security.
- Multi-tenant rules: tenant ID must come from the validated auth context, never from agent-supplied params; tag every audit log entry with `tenant_id` and enforce tenant-scoped log access; per-tenant quotas server-side. Source: dev.to multi-tenant MCP, kunalganglani checklist.
- GitHub engineering guidance: secrets per specific task, authorization action-by-action (not once at login), dynamic short-lived credentials over fixed tokens. Source: Webflow blog.
- Also: rate limit + timeout + audit per tenant; redact secrets/PII from logs; treat tool descriptions AND tool results as untrusted input; destructive actions behind human-in-the-loop approval showing full params. Source: saschb2b security.md, web-researcher-mcp SECURITY.
- SDK gotcha: official TS SDK shipped without default DNS-rebinding protection (CVE-2025-66414, fixed in v1.24.0) — pin/verify SDK version. Source: saschb2b security.md.

## 4. Open-source TS reference implementations
- Official TypeScript SDK (github.com/modelcontextprotocol/typescript-sdk): existing code MIT, new contributions Apache 2.0 — both permissive, so both are AGPLv3-compatible as dependencies. Verified via repo README. Covers streamable HTTP + OAuth helpers.
- Stripe agent-toolkit (github.com/stripe/agent-toolkit) and xmcp (github.com/basementstudio/xmcp): useful design references, but I couldn't verify their licenses — check before embedding.
- No AGPLv3-licensed MCP server implementation surfaced in this research (couldn't verify; none found in the first pass).

## 5. Honest risks / support burden
- Context-window tax is permanent: every tool definition rides along on every request; bloat punishes all users.
- OAuth lifecycle is the #1 support surface: token expiry/refresh/revocation flows, per-user re-auth, DCR quirks per host. Budget for it.
- Prompt injection via tool results is an ongoing arms race — sanitize/delimit untrusted content, never put secrets in the model context.
- Spec churn: SSE→streamable HTTP migration and SDK V1→V2 already happened once; more churn is likely.
- Confused-deputy incidents are authorization failures (CWE-285), not model failures — per-tool, per-action authz is the fix, and it's server-side work the spec won't do for you.
- Rate-limit/cost abuse by runaway agents: enforce per-tenant budgets before upstream calls.
