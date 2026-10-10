# Phase 21C: app platform security and platform design

Status: DESIGN ONLY. No runtime code, schema or dependency changes come with this document. Date: 2026-10-10. Base: `claude/p21b-drive` at `318d9d1` (Drive containers, picker handles, change journal). The owner reads this before any 21C runtime code starts.

Legend. `[EXT]` marks a claim resting on an external spec, browser behaviour or vendor statement, with what to verify. `[GAP]` marks a defect or missing piece I found in today's code that this design depends on. Unmarked statements are grounded in code I read, or are my own design choices.

---

## 1. Goals and non-goals

**Goals**
1. Outside developers add apps that cannot read more than the person allowed, act where a human is required, or break out of the page.
2. One authority rule: an app may do the minimum of (what the signed-in person may do now) and (what the install was granted). Never the sum.
3. Reuse what exists: `executeTool` tiers, `computeGrant`, the Phase 14 gates, MCP OAuth patterns, webhook signing, Drive containers and handles, FORCE RLS.
4. Everything an app can do is declared, shown in plain words, diffed on update, revocable at once and audited with the app id; kill switches work in seconds without a deploy.

**Non-goals:** hosted server code, paid apps and revenue share, a Chrome extension, a public open store (21D), headless background apps acting with a user's rights, standing access to folders.

**Honest limits**
- A permission system limits what an app may touch. It cannot stop an app that may read data and talk to its own server from sending the data there (abuse 14). Review, labels and a "Contained" tier reduce it; nothing removes it.
- Prompt injection through app text will sometimes work on the model. As in 21A, the design limits what it can then do; it does not detect it.
- Behaviour tests catch careless malice, not time bombs or harness detection.
- Review is a staffing problem, not a code problem (the plan's "review debt risk"). Section 13 sizes code, not people.

---

## 2. App types

| Type | UI runs | Server code | We can enforce | Ships |
|---|---|---|---|---|
| Declarative | Our React runtime from a JSON spec | none | everything (it is data) | C2 |
| Embedded web app | Sandboxed iframe, bundle hosted by us | none (publisher's own backend only via declared `network`) | CSP, sandbox, bridge, scopes | C4 |
| Remote app | Publisher's site, in a tab or (if it allows) an iframe | publisher's | tokens, scopes, tier floors; not their network or code | C6 |
| Hosted server code | n/a | ours | n/a | deferred |

**Declarative.** Today's mini-app spec (`lib/apps/spec.ts`, strict zod). `[GAP]` `runAppAction` runs a `call_tool` action through `executeTool` as the clicking user with `grant: ["workspace", ...spec.toolGroups]`. For an admin's own app that is fine; for a third-party spec it is a confused deputy, so `call_tool` and `toolGroups` become scope-gated (`agent.tools:<group>`), default-deny for third parties.

**Embedded** apps get a bridge, not network access to ShapesOS; persistence goes through it. **Remote** apps (a SaaS with its own login) get a launch URL, OAuth 2.1 tokens, signed webhooks and tool endpoints we call, with the strictest tier floors (section 7).

**Hosted server code: deferred, why.** It needs Firecracker or gVisor class isolation (not testable on this box: no Docker daemon), per-tenant secrets, egress control, CPU/memory/time metering, a billing story (compute costs us) and a patching duty. It would also let an app act in the background with the user's rights, breaking the "a person is present" assumption under most of this design. Unlock: a stable platform with real users, an owner cost decision, a red-teamed isolation technology and an egress proxy (decision 14). The validator rejects `type: "hosted"` from day one.

---

## 3. Trust boundaries and origin model

### 3.1 Diagram

```
 Publishers --signed upload--> Review pipeline --signed release--> Apps host
 Remote apps <--webhooks, tool calls | OAuth + /api/v1--> ShapesOS API (TRUSTED)
      /api/* session cookie only; /api/v1/* app tokens on an allow-list
                                 ^ capability token stays in the host
 Host page (shell, TRUSTED: prompts, picker, approvals, bridge)
     | iframe src (no cookies)        | one MessageChannel port per frame
     v                                v
 Apps host <key>.<appsdom>  -->  Sandboxed iframe (UNTRUSTED): opaque origin,
 static, CSP, content-hashed        no cookies or storage, connect-src = declared hosts
```

Boundaries: app to host (bridge only); host to API (install-bound token); app to internet (CSP, declared hosts); publisher to platform (signed releases); tenant to tenant (never).

### 3.2 Apps host and per-install origin

Each install gets `https://<key>.<apps-domain>`; `<key>` is a random 20+ character label, never reused, unrelated to the app name. Two workspaces installing one app get two origins.

- **Separate registrable domain** (decision 1), on the Public Suffix List `[EXT: publicsuffix.org process and lead time]`. A subdomain of `shapesos.com` would be same-site with the OS and share its HSTS `includeSubDomains; preload`.
- **A separate static service, not Next route handlers** (decision 2). `[GAP]` `next.config` sends `X-Frame-Options: SAMEORIGIN` on every response, `proxy.ts` sends `frame-ancestors 'self'`, and `host-routing.ts` never redirects unknown hosts, so a wildcard host pointed at the Next app would serve the OS under an app-controlled origin. An object store plus edge worker serving `/<digest>/...` with no secrets avoids all three. Wildcard DNS and TLS to our edge only, never a per-install CNAME to a third party `[EXT: CDN wildcard and header capabilities; vendor not chosen]`. Paths are content-addressed and the edge verifies the digest before serving (abuse 37).

### 3.3 Iframe, CSP, storage

```html
<iframe src="https://<key>.<appsdom>/<digest>/index.html#h=<handshake>"
        sandbox="allow-scripts" allow="" referrerpolicy="no-referrer"></iframe>
```

- `allow-scripts` only: no `allow-same-origin`, top-navigation, popups, modals, forms, downloads, pointer-lock or storage-access flags. `allow=""` delegates no camera, microphone, geolocation, clipboard, payment or fullscreen. Downloads, external links and copy are host-owned bridge calls (`ui.openExternal` shows a host dialog naming the domain: https only, one per 10 s, `noopener,noreferrer`).
- Consequence: without `allow-same-origin` the document has an **opaque origin** `[EXT: HTML Standard sandboxing flags]`: no cookies, `localStorage`, IndexedDB, Cache API or service workers; `fetch` sends `Origin: null`; module scripts and fonts need CORS from the apps host (`Access-Control-Allow-Origin: *` on public, credential-less files). Verify each in Chromium, Firefox and WebKit (section 11), including that CSP `'self'` still matches in an opaque-origin document. Apps use `storage.get/set` over `AppRecord`; ported web apps need an adapter (decision 3).
- The apps host also sends the policy as a header, so visiting the URL directly is sandboxed too:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <declared img hosts>;
  font-src 'self' data:; connect-src 'self' <declared https hosts>; frame-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors https://app.<domain> <desktop shell origin>
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), clipboard-write=()
X-Content-Type-Options: nosniff   Referrer-Policy: no-referrer   X-DNS-Prefetch-Control: off
```

`connect-src` is built server-side from the approved release only. Precedent: `SANDBOX_PREVIEW_CSP` already pairs `sandbox` without `allow-same-origin` with `connect-src 'self'`. The host page's own `frame-src` (`https: http:` today) should tighten to the apps domain and declared remote origins.

- Known CSP gaps `[EXT: verify in current browsers]`: WebRTC is not clearly governed by `connect-src`; DNS prefetch and preconnect can leak a hostname. Tested residuals, not closed (abuse 15).
- Cookies: the apps domain never receives ShapesOS cookies (different site; opaque-origin requests are cross-site `[EXT]`). `[GAP]` `auth.ts` has no cookie override, so Auth.js defaults (host-only, `SameSite=Lax`) should hold; add a test that the session cookie has no `Domain`.

### 3.4 The bridge

An origin check cannot work: a sandboxed frame's messages arrive with origin `"null"` `[EXT]`. Authenticity comes from three things.

1. **Handshake.** The host calls `POST /api/apps/installs/:id/frames` (session cookie, CSRF-protected); the server returns a single-use 60-second secret bound to install, user, release and a new `frameId`, carried in the URL fragment. The SDK entry posts `{type:"hello", secret}`. The host accepts only if `event.source === iframe.contentWindow`, the frame awaits a handshake and the server confirms the secret once. It then transfers one `MessageChannel` port (target `"*"` is unavoidable for an opaque origin) and sends nothing else that way. A frame that navigates elsewhere does not carry the secret.
2. **Port-bound identity.** Install, user and scopes are properties of the port in the host, never message fields.
3. **Envelope and replay control.** `{v:1, id, seq, method, params}`; `method` from an allow-list (`records.*`, `files.*`, `storage.*`, `ui.*`, `notify.*`, `tool.result`), each with a zod schema and a 256 KiB cap (binary as transferred `ArrayBuffer`, up to 8 MiB). `seq` must strictly increase; a repeat or gap closes the port. Mutations carry an idempotency key kept 24 h. Host-side limits (burst 20, sustained 10/s) apply before any network call.

**Host-mediated API.** The host calls `/api/v1/*` with a **capability token** minted for that frame; the app never holds a bearer token, so there is nothing to leak to a declared domain. Opaque 256-bit, SHA-256 stored (like `mcpt_`), 10-minute life, bound to install, user, release, frame and scope snapshot, revocable by `jti`, re-minted by the host via the session cookie. Not DPoP-bound in v1 `[EXT: RFC 9449]`. **Liveness:** the host pings every 5 s; no pong in 15 s shows "App not responding" with Close. Cross-site frames usually get their own renderer on desktop Chrome `[EXT: site isolation; not guaranteed elsewhere]`.

### 3.5 Host-owned UI

Permission prompts, the picker, approval cards and uninstall confirmations are drawn by the host outside the iframe from the platform scope table, never from app strings. The frame sits in host chrome showing app name, publisher and an "App content" label. The SDK has no call that renders a prompt. An app can still draw a fake one inside its rectangle; real prompts never appear there, and approvals live only in the inbox, so no app call can complete a Tier 2 or 3 step. Residual: users can be fooled by in-frame lookalikes.

A remote app embedded in an iframe gets the same sandbox plus `allow-same-origin allow-forms allow-popups` (safe for our origin: theirs is a different site) and a real `event.origin` check; if its server forbids framing it opens in a tab with no bridge.

---

## 4. The manifest

JSON, strict zod schema in `lib/apps/manifest/schema.ts` (new), stored per release as an immutable snapshot (as `MiniAppVersion` does). Draft:

```ts
const Id = z.string().regex(/^[a-z][a-z0-9]{1,29}(\.[a-z][a-z0-9-]{1,29}){1,3}$/);   // "acme.crm-sync"
const Host = z.string().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/);                   // no IPs, ports; one leading wildcard
const Effect = z.enum(["read", "write", "send", "money", "destructive"]);
const ScopeStr = z.string().regex(/^[a-z]+(\.[a-z]+)*(:[a-z0-9._-]+)?$/);             // re-checked against SCOPE_CATALOGUE

const Tool = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  description: z.string().min(10).max(500),   // plain text; control/bidi/zero-width rejected
  effect: Effect,                             // the app's ONLY risk input; a floor, never a ceiling
  input: JsonSchemaSubset,                    // depth<=4, <=20 props, every string maxLength<=4000, no $ref
  result: JsonSchemaSubset.optional(),        // free text marked {"x-freeText":true}
  needs: z.array(ScopeStr).max(8),            // subset of granted scopes
  endpoint: z.string().max(200).optional(),   // remote: path under remote.toolBase
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
}).strict();

const Common = {
  manifestVersion: z.literal(1),
  id: Id, name: z.string().trim().min(2).max(40), tagline: z.string().max(80),
  description: z.string().max(2000), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  publisher: z.object({ id: z.string(), name: z.string().max(60), supportUrl: z.url(),
                        privacyUrl: z.url(), termsUrl: z.url().optional() }).strict(),
  icon: z.string().max(200), categories: z.array(z.string()).max(3),
  compat: z.object({ platform: z.string(),     // semver range of manifest/bridge API, "^1.0.0"
                     sdk: z.string().optional(), minInstallerRole: z.enum(["admin","owner"]).default("admin") }).strict(),
  scopes: z.object({ required: z.array(ScopeStr).max(20), optional: z.array(ScopeStr).max(20),
                     justification: z.record(ScopeStr, z.string().min(10).max(240)) }).strict(),
  network: z.object({ connect: z.array(Host).max(10), img: z.array(Host).max(10).default([]),
                      purpose: z.record(Host, z.string().max(160)) }).strict(),
  data: z.object({ collections: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
                     maxRecords: z.number().int().max(100_000).default(10_000),
                     indexed: z.array(z.string()).max(3).default([]) })).max(20),
                   containerQuotaMb: z.number().int().min(1).max(1024).default(100) }).strict(),
  surfaces: z.object({ window: Win.optional(), sidebar: Side.optional(), widgets: z.array(Widget).max(4),
                       commands: z.array(Command).max(10),      // shown as "App name: command"
                       shareTargets: z.array(z.string()).max(5), fileHandlers: z.array(Handler).max(10),
                       pageActions: z.array(PageAction).max(5), // review-gated
                       settings: z.boolean() }).strict(),
  tools: z.array(Tool).max(30).default([]),
  events: z.array(z.string()).max(30).default([]), // WEBHOOK_EVENT_TYPES; each needs events.read:<type>
  pricing: z.null().default(null),                 // reserved; non-null rejected now
};
const Manifest = z.discriminatedUnion("type", [
  z.object({ ...Common, type: z.literal("declarative"), spec: MiniAppSpecSchema }).strict(),
  z.object({ ...Common, type: z.literal("embedded"), entry: z.object({ html: z.string(),
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), sbom: z.string() }).strict() }).strict(),
  z.object({ ...Common, type: z.literal("remote"), remote: z.object({ launchUrl: z.url(),
            allowFraming: z.boolean().default(false), redirectUris: z.array(z.url()).min(1).max(5),
            toolBase: z.url().optional(), webhookUrl: z.url().optional() }).strict() }).strict(),
]);
```

Cross-checks after parse (as `crossCheck` in `spec.ts`): every scope exists, is not default-deny, appears once, has a justification; every tool `needs` is declared; `agent.tools` requires a tool; a `network` host plus any sensitive read scope sets `reviewFlag: "data-egress"`; commands do not collide with built-ins after confusable folding; remote URLs pass `assertSafeUrl` at publish and every call; `entry.digest` matches the upload.

**Versioning.** `manifestVersion` is an integer bumped only for breaking changes; the platform supports current and previous for 12 months (decision 15) through pure `upgradeManifest` functions run on read; stored snapshots are never rewritten. `strict()` means unknown fields fail at publish. App `version` is monotonic semver; a yanked version stays yanked. A platform upgrade never changes an existing grant. The SDK is versioned separately; the bridge `v` lets the host refuse an SDK it does not speak.

---

## 5. Scopes, prompts and lifecycle

### 5.1 Catalogue

Grammar `domain.verb[:resource]`; exact match only, no wildcards or prefixes (as `lib/mcp/scopes.ts`). A scope is a ceiling, evaluated per call with the person's current role.

| Scope | Allows | Prompt text | v1 |
|---|---|---|---|
| `files.container` | Own container `/apps/<id>/<install>`, quota-capped | Keep its own files, up to {quota} | granted, low-key |
| `files.picked` / `files.picked:write` | Open / save a new version of files the person picks | Open files you choose / Change files you choose | requestable; write adds a picker confirm |
| `records.own` | Own `AppRecord` collections | Store its own data | granted |
| `records.read:<entity>` / `records.write:<entity>` | `OPS_ENTITIES` slug, per viewer role; writes through the ops gate | Read {entity} / Create and edit {entity} | non-sensitive entities; write needs review |
| `agent.tools` | Offer declared tools to agents | Offer tools to your agents. Sending, spending and deleting still ask you first. | requestable |
| `notify.send` | Plain-text notice to the using person, 5/day/user, in-app link only | Send you notifications (up to 5 a day) | requestable |
| `events.read:<type>` | Receive that webhook event type | Be told when {event} happens | requestable, review |
| `identity.name` / `identity.email` | Current user's name / email | See your name / email address | email needs review |
| `ui.*`, `files.handler:<mime>` | Surfaces (sidebar, widget, commands, share, Open with) | Appear in the sidebar, etc. | requestable |
| `browser.pageActions:url` | Current page URL for declared patterns, never content | Know which page you are on, for {sites} | deny until 21A page actions ship; broad patterns need review |
| `network:<host>` | `connect-src` to one exact host | Send and receive data with {host} | requestable, prominent |

**Default-deny for third parties in v1** (each needs an owner decision, review and likely new scope design): anything that moves money; `records.*` on finance, HR and payroll entities (invoices, payments, orders, purchase-orders, team-members, leave-*, applicants; decision 9); `records.*:*`; folder or root file access and private homes; connector credentials and secrets; `members.*`, `billing.*`, `settings.*`, `apps.manage`; `approvals.*` (no app ever approves anything); `automation.*` (workflows that later run as the user are a standing confused deputy); `agent.ask` (decision 8); `agent.tools:<group>`; `browser.pageText`, `browser.cookies`; `audit.read`; `network:*`, IP-literal and non-443 hosts.

**Data-egress rule:** `records.read:*`, `identity.email` or `files.picked*` plus any `network:<host>` forces human review, and the prompt says "can send this data to {host}".

### 5.2 Prompt

Built by the host from the table, never publisher HTML. The publisher's justification sits beneath each scope in quotes, "From the developer", plain text, no links. It shows publisher, verified domain, "Contained" (no network), "Connected to n sites" or "External app", and which scopes are optional. English and Spanish, sentence case, Agentic OS tokens, Lucide icons, pill buttons (`docs/design/DESIGN.md`).

### 5.3 Lifecycle

**Install (Tier 2, never auto).** `install_app` joins `NEVER_AUTO_ACTIONS` ("installing an app grants it access, so it always asks"). An agent may suggest an app (21D); only the card completes it. An admin installs, setting the workspace ceiling. Each person's first launch shows their own consent for the same scopes (optional ones refusable), because tokens are user-bound (decision 10). Install writes `AppInstall`, mints the origin key, ensures the container, audits.

**Update.** `diffManifest(old, new)` covers scopes, `network`, tools added or with a risen `effect`, surfaces, publisher and remote origins. No-diff or reduction updates apply under the workspace's auto-update policy. Any addition holds the install on the old release (`pendingReleaseId`) and raises a Tier 2 card with the diff, justifications and changelog. The old release keeps running unless killed (then the app suspends). Admins can pin or roll back. A suspended install keeps its data; tokens, handles, tools and webhooks stop at the next request.

**Uninstall.** (1) Show what is removed; offer **export** (container as a folder the person keeps, `AppRecord` as JSON). (2) Revoke tokens, refresh families, handles, tool registrations, webhooks. (3) Send a remote app a signed `app.uninstalled` so the publisher can delete its copy. (4) Soft-delete container and records for 30 days (decision 16), then purge. `[GAP]` `purgeAppContainer` deletes immediately and permanently; 21C wraps it in a grace period. Audit rows stay. Not undoable: data a remote or network-declared app already copied; the screen says so.

---

## 6. Identity and tokens

`AppPrincipal = {installId, appId, releaseId, workspaceId, userId, scopes}`. Embedded apps reach the API through host-mediated capability tokens (3.4); remote apps use OAuth 2.1.

**OAuth 2.1 for remote apps**, modelled on `lib/mcp/oauth.ts`: authorization code, PKCE S256 required, single-use code claimed by one conditional update, exact `redirect_uri` match, 10-minute codes. Unlike MCP's public DCR, clients are not self-registered: `client_id` is the reviewed app, redirect URIs come from the manifest, and the client authenticates at the token endpoint (hashed, rotatable secret). Consent is host-rendered with the install prompt. Access tokens: opaque, hashed, 15 minutes. Refresh tokens: one-time rotating, family-tracked, reuse revokes the family; 30 days sliding, 90 absolute `[EXT: OAuth 2.1 is an IETF draft and RFC 9700 the security BCP; verify status and refresh rules]`. A revocation endpoint (RFC 7009) for publishers. MCP tokens have no refresh and live an hour; app tokens are shorter because they run more often and reach more.

**Binding.** Each token row holds install, user, workspace, scope set, release and family. The workspace comes from the token, never request input (MCP T1).

**Per request, in order:** token valid; install `active` and release not killed (live, cache at most 5 s); publisher and platform not suspended; user still a member with current role (`getMembership`); effective scopes = token scopes, install grant, the user's `AppConsent`, and what the user's *current role* may hold (the `capScopesToRole` pattern plus a role floor per scope); then the resource check through the functions the session path uses (`driveRoleFor`, `entityReadRole`, the ops gate). A demoted editor's `records.write` stops at once; a viewer never holds a write scope. Authority is never added to the person's.

**Gated writes.** `records.write` on a gated transition goes through `executeGatedOpsWrite` as a proposal (`proposedBy: userId`, `via: app:<id>`). Approval, admin, billing, settings, token-minting and uninstall routes reject app principals through a new AUTHZ primitive `requireHumanSession`.

**Fail-closed allow-list.** App tokens work only under `/api/v1/*`, and each route is registered `appAccessible` with its scope; the existing `/api/*` surface stays session-only. Register routes in `scripts/verify-m11-security.mjs`.

**Rate limits.** `[GAP]` `proxy.ts` keys user limits on the session cookie; bearer calls fall back to IP, which many installs behind one cloud IP would share. The limiter lives in the `/api/v1` wrapper on the Postgres backend (`MCP_RATE_LIMITER=postgres` mandatory hosted): per install and user 120 reads and 60 writes a minute, per install 600 a minute, a daily write budget, a separate tool-call budget; repeated 429s auto-suspend (abuse 24).

**Audit.** `[GAP]` `FileChangeLog.actor` is an enum (`user, ai, fix_agent, system`); `OpsAuditEvent.actor` is a string. Add append-only `app_audit_events` (install, app, release, user, action, resource, decision, request id), FORCE RLS, no UPDATE/DELETE (ledger-trigger precedent); existing writers record `app:<appId>/<installId>` "on behalf of" the user. Denials are audited.

**Per-app identity in `computeGrant`.** `TOOL_GROUPS` is a fixed tuple used in zod enums, `AGENT_MAX_GROUPS` and the blocking UI. Add one static group `apps` ("Installed apps") so blocking, chips and `toolGroup()` keep working, and extend `GrantInput` with `appInstalls: [{installId, status}]`; the result carries `apps` plus members `app:<installId>`. The parent grant narrows both; blocking `apps` removes all; a per-install block removes one; suspended or killed installs drop out; `lead` and `actor` may hold `apps`, others only by explicit request and read-effect tools. `toolGranted` also requires the `app:<installId>` member.

---

## 7. Agent tools from apps

**Resolution.** Tools are `app.<installKey>.<tool>` (API alias `app__<key>__<tool>`, as `connector__`), resolved dynamically in `executeTool` like `resolveConnectorTool`. Namespacing stops shadowing of built-ins and other apps. Order: stop check; platform, publisher and install state (live); blocked groups; grant incl. `app:<installId>`; role; 21A preflight (taint); tier; confirmation; invoke; audit with app id.

**The platform derives the tier; the app declares only an effect, which can only raise it.**

| Effect | Action key `evaluateTier` sees | Tier | `ToolKind` | Auto-approvable |
|---|---|---|---|---|
| `read` | `read_app_data` (Tier 0 prefix) | 0 if other rules pass | safe | n/a |
| `write` | `write_app_data` (not in `TIER1_KINDS`) | 2 | publish | user rule, verified publisher only (decision 6) |
| `send` | `send_via_app` | 2 | publish | never (`NEVER_AUTO_ACTIONS`) |
| `money` | `app_money_action`, added to `TIER3_EXACT_KINDS` | 3 | spend | never |
| `destructive` | `delete_via_app` (Tier 3 pattern) | 3 | destructive | never |

Final tier = max(effect floor, Tier 3 scan of `"<name>: <description>"`, scan of input property names, remote floors below, review override). Unknown effect: Tier 2.

The text scan is a safety net only. `[GAP]` `TIER3_PATTERNS` miss common money words (charge, settle, remit, wire, invoice); `EXTERNAL_TOOL_MONEY_RE` catches them, but `isExternalToolAction` covers only `mcp_write`, `connector_write` and `composio:*`. Extend it to the app action keys. The scan over-triggers (a read tool "list refunds" becomes Tier 3); that direction is safe, and the CLI warns developers.

**Remote floors** (we cannot see their server): a tool whose input has any free-text string is at least Tier 2, since its arguments leave to a third party and an injected agent could otherwise exfiltrate through a "read" call; an unverified publisher's tools are at least Tier 2; Tier 0 `read` needs verified publisher plus a review pass (decision 7). Embedded and declarative tools can be observed in review.

**Where embedded tools run.** Hosted code is deferred, so an embedded app's tool runs only inside its open iframe via the bridge (`tool.invoke`/`tool.result`). Window closed: the call fails with "open the app". Background runs cannot use embedded tools. Honest cost of not hosting code.

**Descriptions and results are untrusted data** (21A kernel: `git show origin/claude/p21a-agentweb:lib/agentweb/{kernel,taint,reader,gate}.ts`; reuse, do not duplicate).
- *Descriptions are pinned* to the signed release; the model never sees text fetched from the app at run time, closing the MCP "description changes after approval" attack (abuse 26). Capped at 500 characters, control/bidi/zero-width stripped, linted with `INJECTION_RE`-style patterns and references to other tools, prefixed `[app: Name by Publisher]`.
- *Results are wrapped and tracked*: `wrapUntrusted(text, "app:<appId>")` (origin is a free string there), registered in the task's `TaintLedger`, validated against the declared `result` schema (unknown keys dropped, strings clipped). Typed fields reach the actor as-is; `x-freeText` fields go through the quarantined reader (no tools).
- *Flows are gated*: app-sourced values reaching the arguments of any `send`, `write`, `money` or `destructive` tool, a new origin or another app's tool need a confirmation card naming value and source (21A `checkFlow`).
- `[GAP]` 21A's ledger is in-process (`webTasks`: 4 tasks, 5-minute idle) and `taintPreflight` allows everything when no web task exists. For apps the task and ledger must exist whenever an app result enters context and survive a run's life across restarts and instances, or protection silently drops. This is a 21A dependency (C5).
- As in 21A, an idea restated in new words passes taint; a persuasive result can mislead an answer but cannot by itself cause a Tier 2 or 3 action.

---

## 8. Data

New tables (design only). Tenant tables carry `workspace_id`, cascade from `workspaces`, ENABLE and FORCE RLS on `app.workspace_id` (pattern: `20261005300000_phase4a_webhooks`).

| Table | Scope | Notes |
|---|---|---|
| `AppPublisher`, `AppRelease` | global | status, verification, manifest JSON, hashes, signature; releases immutable once approved. App role reads only; back office writes (precedent: `OpsStore` select-only lookup policy) |
| `AppInstall` | tenant | release, pending release, origin key, state, grants, network, update policy, quota |
| `AppConsent`, `AppToken`, `AppRefresh` | tenant | per-user scopes; hashes, family, expiry, revocation |
| `AppRecord` | tenant | unique `(workspaceId, installId, collection, key)`; JSONB; version |
| `app_audit_events` | tenant | append-only |

`MiniApp`/`MiniAppRecord` stay for in-workspace declarative apps; `AppRecord` is new, for installs. The plan's "`AppInstall` fed by `WorkspaceStoreItem`" is 21D's migration.

**`AppRecord` isolation.** Every query carries `workspaceId` and `installId` from the token; the policy also requires `install_id = current_setting('app.install_id')` when `app.principal = 'app'`. RLS is a safety net, not a boundary against code that sets the wrong value. Limits: record 64 KiB (as `RECORD_MAX_BYTES`), 10,000 per collection, 100 MB per install, keyset listing over at most 3 declared indexed fields. `[GAP]` `listRecords` scans up to 2,000 rows in memory; that does not scale to third parties and likely needs an index side-table (not designed here).

**Drive containers (21B as built):** `appContainer()`, `resolveInContainer`, writes through upload gate, scanner, quota and journal. 21C changes: opaque platform ids in both path segments (`APP_ID_RE` allows publisher-chosen dots); default quota 100 MB, not 1 GiB (`DEFAULT_APP_QUOTA_BYTES`), since installs also draw on the workspace total; previews of container files use the sandboxed `USER_CONTENT_CSP` (an app can write HTML or SVG); the change feed an app sees is filtered to its container and picked files (the workspace journal exposes every path and actor id).

**Picker handles.** The picker is host UI. `pickFileForApp` returns an HMAC-signed handle for one file, one `appId/install`, one mode, TTL 1 h default, 24 h max (15 minutes for apps unless the person ticks "remember for this session"). `openHandle` re-checks the picker's current access. `[GAP]` it never checks the install is still active or the release alive; add that, with the API's live-state read. Handles key on the string `appId/install`, so install ids must never be reused. A `readwrite` picker says "can change this file"; a handle cannot reach siblings or parents and the app never gets a path.

---

## 9. Review pipeline

Per release; a failed blocking stage stops it; decisions are logged with reviewer id.

1. **Manifest lint:** strict zod; catalogue; justifications; `network` hosts valid, non-private, explained; name and icon checks against built-ins, reserved words and known brands (confusable folding plus edit distance); tool lint (section 7); pricing null.
2. **Bundle scan (embedded):** file-type allow-list; 20 MB and 2,000-file caps; a real malware engine (`[GAP]` per the plan's inventory the Drive scanner is a no-op without `CLAMAV_HOST`; mandatory here); heuristics for obfuscation, `eval`, `document.cookie`, `window.top`, `postMessage("*")` and undeclared literal hosts (advisory; CSP is the control).
3. **Dependency audit:** the CLI emits a CycloneDX SBOM from the lockfile, checked against an advisory database `[EXT: OSV or GitHub advisory data; terms]`, flagging typosquat-looking names. Publisher-attested; a minified bundle cannot be reliably matched back.
4. **Sandbox behaviour test:** headless Chromium (Playwright is a dependency) runs the bundle under the real sandbox and CSP against a scripted host, recording CSP violations, network attempts, bridge calls versus declared scopes (an undeclared scope fails the release), `top`/popup attempts, CPU and memory, and whether each tool's observed effect matches its declared one. Time bombs and harness detection (`navigator.webdriver`) defeat it, hence runtime enforcement, rescans and sampled telemetry.
5. **Human review required for:** a publisher's first app and first three releases; `records.*`, `identity.email`, `files.picked*`, `events.read`, `notify.send`, `data-egress`, `browser.pageActions`; any tool with effect `send`, `money` or `destructive` (two different reviewers); any permission-diff update; every remote app; automation flags; a 5% sample; any release after a credential or key change.
6. **Signed, content-hashed release.** Digest = SHA-256 over a canonical listing of every path and hash. The platform signs `{appId, version, manifestHash, bundleDigest, reviewedAt, reviewerId}` with an Ed25519 release key (21A has a signer pattern in `lib/agentweb/identity`; this is a separate, KMS-held key, decision 13). The apps host checks the digest before serving; the shell checks the signature before rendering. Publishers also sign uploads with their own key, so a login takeover differs from a key takeover.
7. **Kill switches.**

| Level | Trigger | Effect (target: within 5 s of the next request) |
|---|---|---|
| Release | state `killed` | tokens fail, bundle 410, tools leave grants, handles refuse, webhooks stop; installs suspend until an approved update |
| Publisher | status `suspended` | same for all its apps; submissions blocked |
| Platform | `APPS_ENABLED=0` or a platform-state row | same for all apps; shell hides surfaces |
| Workspace | admin "pause app" / "turn off third-party apps" | same for that workspace (the `mcpEnabled` pattern) |

State is read live per request and tool call (TTL at most 5 s). `[GAP]` `getAgentBlockedGroups` keeps the last value on a read error; for kill switches a read error denies. A drill is part of C7. Remote revocation: tokens revoked server-side, publisher told by signed `app.suspended`.

---

## 10. Abuse cases

Each row: mitigation, then the test that proves it. "DB" is a Postgres suite as the least-privilege role; "Browser" is the section-11 harness.

| # | Attack | Mitigation | Test |
|---|---|---|---|
| 1 | Sandbox escape: host DOM via `parent/top`; a regression adds `allow-same-origin` | One frame factory; header `sandbox` repeats it; opaque cross-site frame | Unit: attribute equals `allow-scripts`. Browser: probe app, all host access throws |
| 2 | `top.location` change, popups, `window.open` phishing | No top-nav or popup flags; `openExternal` dialog, 1 per 10 s | Browser: blocked; dialog shows domain |
| 3 | App framed by an attacker page | `frame-ancestors` host only | Header test; Browser: third-origin frame blocked |
| 4 | Redress in host: fake approval or permission UI | Host-owned prompts outside the frame; approvals only in inbox | Browser: host chrome never under frame. Route: app principal approving gets 403 |
| 5 | Message forgery by another frame; app names another install or user | `event.source` plus handshake; identity is port-bound | Browser: second iframe's `hello` and calls ignored. Unit: schema rejects `installId`/`userId` |
| 6 | Handshake hijack: app navigates frame to harvest the port | Single-use 60 s secret in fragment | Browser: after self-navigation no port; reuse refused |
| 7 | Token replay: expired, other install or user, after uninstall | Bound claims, `jti`, live state | DB matrix, each 401 |
| 8 | Scope escalation or role widening (revoked or declined scope, demoted editor, viewer with write) | Per-call intersection; role floor; membership read per call | DB: revoke then call in same second denied; demote mid-session denied |
| 9 | Cross-tenant ids | Workspace from token; RLS | DB: forged ids 404 both ways |
| 10 | Cross-install `AppRecord` read in one workspace | Install predicate plus `app.install_id` policy | DB: raw SQL as app role, GUC=A, selecting B returns 0 |
| 11 | Container path traversal, Unicode and case tricks | `resolveInContainer`, `collisionKey`, whole-segment containment | Unit fuzz (`..`, NFC/NFD, `%2e`, backslash, NUL); 21B tests extended |
| 12 | Picker confused deputy: lure user to pick payroll.xlsx | Host picker names app, file, mode; nothing preselected; no folders | Browser: text snapshot. DB: handle A cannot open B or a sibling |
| 13 | Handle replay after uninstall, suspend or kill | `openHandle` live-state check `[GAP]` | DB: uninstall then `openHandle` fails |
| 14 | Exfiltration to a declared domain (the app's own server) | Cannot prevent. Label, scope-by-network review, "Contained" tier, quotas, later egress proxy (decision 14) | Rule only: data-egress flag forces review; prompt names host |
| 15 | Exfiltration via DNS prefetch, WebRTC, CSS, beacons, `ping` | `form-action 'none'`, minimal `img-src`, prefetch off; WebRTC/DNS residual `[EXT]` | Browser: canary server per channel in Chromium, Firefox, WebKit; results published, not assumed |
| 16 | DNS rebinding on remote tool or webhook calls | Resolve once, connect to pinned public IP, no redirects. `[GAP]` `safe-url.ts` documents its own lookup/connect gap | Unit: resolver flips to 127.0.0.1 on second lookup; call fails before sending |
| 17 | SSRF via webhook, tool endpoint, redirect URI, icon, launch URL | `assertSafeUrl` at save and per call; https, 443, no userinfo or IP literals | Address table incl. IPv4-mapped IPv6, NAT64, `169.254.169.254` |
| 18 | Webhook forgery or replay | Per-install `whsec_`, HMAC over `t.body`, 5-minute window | Reuse `verifyWebhookSignature` vectors: wrong secret, stale, tampered |
| 19 | Malicious update after approval; effect read to money; new tool | Immutable digest; `diffManifest`; permission-adding updates held | Property test: any added scope, host, tool or effect rise is in the diff. DB: pending release leaves old one running |
| 20 | Remote server changes behaviour after review | Cannot pin a server. Tier floors, anomaly monitor, kill switch | Kill drill under 5 s; monitor tests on synthetic anomalies |
| 21 | Publisher account takeover | MFA; separate signing key; 72 h cooling after credential change, release forced to review | Unit/DB: revoked-key release rejected; cooling-window publish routes to review |
| 22 | Typosquat or impersonation ("Shapes0S Billing") | Confusable folding, reserved names, edit distance, domain badge | 50 look-alike names flagged; prompt snapshot shows domain |
| 23 | Malicious dependency in bundle | SBOM advisory check; CSP and scopes bound blast radius | Fixture SBOM with known-bad package fails lint |
| 24 | CPU or memory exhaustion, API flood, DB bloat, container fills quota | Heartbeat overlay; per-install limits and quotas; auto-suspend | Browser: busy-loop overlay. DB: 10,001st record refused; concurrent writes stop at quota |
| 25 | Notification spam or fake system alerts | 5/day/user, plain text, in-app link, app badge, mute | DB: sixth refused. Unit: HTML stripped |
| 26 | Tool-description poisoning; description changed after approval; name collision with `send_email` | Pinned in signed release; lint; cap; prefix; namespaced `app.<key>.<tool>`; never fetched at run time | Injection corpus: zero unapproved Tier 2+. Unit: no code path reads a remote tool list; collision registers namespaced |
| 27 | Tool-result poisoning, incl. A's result driving B's send | Wrap, schema-validate, taint, confirm card | Corpus: hidden instructions, markdown-image exfil, forged tool-call text; zero unapproved Tier 2+ |
| 28 | Tier laundering: "read" that charges; "settle" for "charge" | Effect floor, extended money regex, name scan, remote floors, review, behaviour test | Unit: effect money is Tier 3 whatever the text; "remit funds" raises tier; behaviour test fails a contradicting tool |
| 29 | Prompt spoofing via justification text | Platform-built prompt; developer text quoted, plain, 240 chars | Snapshot with HTML, fake "ShapesOS requires", RTL override |
| 30 | Agent auto-installs or auto-accepts a diff | `install_app` and diff approval in `NEVER_AUTO_ACTIONS` | `autoAllowedFor("install_app") === false`; Phase 14 suite green |
| 31 | Consent phishing; auth-code interception or reuse | Host-rendered consent, exact manifest redirect, PKCE S256, single-use code | MCP route tests ported; concurrent exchange: exactly one wins |
| 32 | Refresh token theft | Rotation; family revoke on reuse | DB: spent-token replay revokes family |
| 33 | App works after kill (stale cache) | Live state, TTL 5 s; read error denies | Fake clock: kill, +6 s, all routes deny; error injection denies |
| 34 | Stored XSS from app-written HTML/SVG previewed in Files | Sandboxed `USER_CONTENT_CSP` | Browser: SVG with script, preview runs nothing |
| 35 | Delete via `records.write` | Delete is Tier 3 through ops gate; app principal cannot approve | DB: delete returns `approval_required`; approve with app token 403 |
| 36 | Zombie access after uninstall | One transaction plus registry of tables with `install_id` | DB: every `install_id` row revoked or gone |
| 37 | Bundle swapped after review; Host-header or cache confusion | Content-addressed keys, digest checked at serve, `Vary: Host` | Unit: modified object refused; edge test with forged Host |

---

## 11. Red-team and test plan

1. **Unit (TDD, vertical slices):** manifest, scope arithmetic and role caps, `diffManifest` (property tests), tier derivation, handshake and envelope, CSP builder. Seams (codebase-design): `AppAuthority.resolve(token) -> Principal | Denied` (live state, membership and scope intersection behind one call); `deriveToolTier`; `FrameFactory` and `AppsHost`, each with a real adapter and a fake (two adapters make a real seam).
2. **DB suites** (in `scripts/test/db-tests.txt`): RLS on every table, token binding, install isolation, immediate revocation, uninstall completeness, update-hold.
3. **Browser escape harness** (one `next dev` plus Playwright run inside `heavy.sh`): hostile fixtures for rows 1-6, 15, 24, 34 in Chromium; Firefox and WebKit if Playwright provides them here, otherwise UNVERIFIED-LIVE.
4. **Agent injection corpus:** descriptions and results with hidden instructions, forged tool calls, exfiltration, cross-app chains. Proposed pass bar (as 21A): zero unapproved Tier 2+ actions and zero exfiltration; a regression fails CI. Publish what it cannot stop.
5. **Also:** Phase 14 suites stay green with new action keys; `/api/v1` routes register in `verify-m11-security.mjs`; three sample apps built as outsiders plus five malicious fixtures before any invited publisher; an external review before opening further (decision 4).
6. **UNVERIFIED-LIVE until tried:** wildcard DNS/TLS on the apps domain, CDN behaviour, Safari and Firefox sandbox behaviour, real publisher OAuth, real WebRTC/DNS leak results.

---

## 12. Legal and operational items for the owner (outline; lawyer review required; not legal advice)

- **Developer agreement:** licence and IP; prohibited conduct; data-use limits (no sale, no model training on customer data); security duties and incident-notice time; sub-processor flow-down; suspension and takedown rights; indemnity; trademark use; governing law; counterparty entity.
- **Review guidelines (public):** minimal scopes, honest justifications, no deceptive UI or impersonation, no mining, privacy policy required, rejection reasons, appeal.
- **Takedown and DMCA:** designated agent, notice and counter-notice, repeat infringers `[EXT: statute, jurisdiction]`; non-copyright complaints; possible EU notice-and-action duties `[EXT: Digital Services Act applicability]`.
- **Privacy labels:** generated from scopes and network plus publisher attestations; liability for a false label.
- **Data-processing terms:** roles of customer, ShapesOS and publisher (for remote apps the publisher is likely an independent controller or sub-processor) `[EXT: GDPR Arts. 24-28; counsel decides]`; export and deletion on uninstall.
- **Incident response:** runbooks for a compromised app, publisher or platform bug; kill-switch drill; customer, publisher and regulator notice. `SECURITY.md` still has a placeholder contact: a launch blocker `[GAP]`.
- **Also:** end-user terms (apps are third-party), publisher sanctions screening, insurance.

---

## 13. Staged build plan

P = one Phase 18.x PR (the plan's unit). Rough sizes, not promises. Every milestone ends with typecheck (heap flag), touched-directory tests, DB suites as the app role, drift check and a two-axis code review.

| M | Scope | Depends on | Exit criteria | Size |
|---|---|---|---|---|
| C1 | Manifest, scope catalogue, `diffManifest`, `deriveToolTier`; extend `isExternalToolAction`; `NEVER_AUTO` entries; pure code | none | property tests; Phase 14 green | 0.5-1 P |
| C2 | Tables, RLS, install/update/uninstall, `app_audit_events`, kill-switch state, `purgeAppContainer` grace and export | 21B merged; C1 | DB: isolation, uninstall completeness, update-hold; drift check | 1.5 P |
| C3 | Tokens, `/api/v1` wrapper, per-install limiter, records/files endpoints, OpenAPI, `openHandle` live check | C2 | rows 5, 7-10, 13, 33 pass; M11 rows | 1.5 P |
| C4 | Apps host, CSP builder, frame factory, bridge, `packages/app-sdk`, host prompts and picker | C3; domain/CDN | escape harness green in Chromium; axe clean (light/en, dark/es) | 2-3 P |
| C5 | `computeGrant` per-install, `resolveAppTool`, taint/wrap, persistent ledger | C3; 21A merged | injection corpus passes; Phase 14 green | 1-1.5 P |
| C6 | Remote apps: OAuth client registry, signed webhooks, pinned-dialer fetch, tool endpoints | C3, C5 | rows 16-18, 31-32 pass | 1.5 P |
| C7 | Review pipeline, `packages/cli` (`init|dev|validate|publish`), signed releases, back-office kill switches, three sample apps | C4-C6 | samples pass; five malicious fixtures fail; kill drill under 5 s | 2 P |
| C8 | Red-team pass, docs, legal gates (section 12) | C7 | findings fixed or accepted in writing; then 21D opens | 1 P |

About 11-14 P of code, plus a standing review and operations duty not in those numbers.

**Dependencies.** 21B is built; 21C changes opaque path ids, default quota, handle live check, journal filter, purge grace. 21A (`TaintLedger`, `SafetyKernel`, reader, the `executeTool` preflight) must merge first, plus ledger persistence. `packages/app-sdk` and `packages/cli` do not exist: a monorepo layout change; the SDK must have no dependencies, and any bundler or CLI dependency needs owner approval.

**Decide before runtime code (C0):** 1, 2, 3, 4, 5, 6, 7, 9, 13. The rest can follow in C2-C6. A draft developer agreement is needed before the first outside publisher, not before C1.

---

## 14. Open decisions for the owner

1. **Apps domain.** Recommend a separate registrable domain on the Public Suffix List. Alternative (subdomain): shared HSTS and same-site cookies, bigger blast radius.
2. **Apps host.** Recommend a separate static edge service with no secrets. Alternative (Next route handlers): fewer parts, but header and host-routing coupling and the OS reachable on an app-controlled origin unless fenced.
3. **Sandbox mode.** Recommend `allow-scripts` only (opaque origin; storage via bridge). Alternative (`allow-same-origin` on the per-install origin): real localStorage, easier ports, one defence layer fewer.
4. **Who publishes in v1.** Recommend invite-only (first-party plus under ten vetted publishers) until tooling, legal and an external review are done. Alternative (open): fast ecosystem, unbounded review debt.
5. **Remote apps in v1.** Recommend yes, after embedded, with Tier 2 floors and verified publishers. Alternative (none yet): saves about 1.5 P and the SSRF/rebinding surface, but SaaS vendors cannot list.
6. **Auto-approving third-party writes.** Recommend never for send, money, destructive; write only by user rule and for verified publishers. Alternative (rules for all writes): fewer prompts, but an injected agent writes through any app without a human.
7. **Tier 0 for remote reads.** Recommend only for verified publisher, review pass and typed arguments. Alternative (trust declared `read`): smoother flows, but a free-text "read" is an exfiltration channel.
8. **App-to-agent (`agent.ask`).** Recommend off in v1. Alternative: useful apps, but another confused-deputy path and a credit-burn vector.
9. **Finance, HR and payroll entities.** Recommend denied in v1; revisit with six months of incident data. Alternative (allow with extra review): bigger market, much bigger breach cost.
10. **User consent on top of admin install.** Recommend yes. Alternative (admin consent covers all): less friction, but people are acted on without seeing what the app can do.
11. **Publisher verification.** Recommend DNS-verified domain, mandatory MFA, manual entity check for the "verified" badge. Alternative (email only): cheap, but takeover and impersonation get easy.
12. **Review staffing and SLA.** Recommend automation plus one named human reviewer, no public SLA in v1. Alternative (promised turnaround): a missed promise is a trust and legal problem.
13. **Release key custody.** Recommend a KMS-held online key under an offline root. Alternative (environment secret): one leaked variable forges every release.
14. **Egress proxy for embedded apps.** Recommend not in v1; show the residual risk. Alternative (all traffic via our proxy): logging and caps, but a large new service, privacy questions, latency.
15. **Old-manifest support.** Recommend current plus previous for 12 months. Alternative (current only): less code, breaks publishers on every change.
16. **Uninstall retention.** Recommend 30-day soft delete with an export offer. Alternative (immediate purge): privacy-clean, but one mis-click destroys data.
17. **Browser floor.** Recommend Desktop (Chromium) first-class, Chrome and Firefox once the harness passes, Safari best effort. Alternative (all at launch): wider reach, unverified sandbox behaviour in a browser I cannot test here.
18. **Security contact and disclosure policy.** Recommend setting the real address before any publisher is invited. Alternative (later): breaks `SECURITY.md`'s own launch-blocker rule.
