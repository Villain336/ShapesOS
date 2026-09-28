# Phase 15 — Composio Catalog: "Every tool"

**Status:** SPEC DRAFT — queued after Phase 14 lands (…→ 13D → 14 → 15).
**Decided by Tico:** 2026-09-28 — "I want as many tools as possible from Composio."
**Goal:** Phase 14 wired 5 apps with ~30 pinned tools behind the approval gate. Phase 15 opens the catalog to Composio's full toolkit library (100+ apps, thousands of tools) — any agent in Marketr can act in any connected app, with the gate's conservative doctrine intact at scale.

---

## 1. Toolkit discovery — the tool router

- Phase 14 pins a static `V1_ACTION_CATALOG`. Phase 15 replaces pinning with **live discovery**: Composio's tool router/catalog API is queried per connected app, returning the full tool list (slugs, descriptions, auth requirements).
- Cached per workspace + app (`ComposioToolCatalog`: workspaceId, appKey, toolkitSlug, toolSlug, description, discoveredAt, version). Refresh on connect + periodic re-fetch; **drift detection**: when the live catalog disagrees with the cache (tools added/removed/renamed), flag in the Actions UI and require re-approval of any stored tier override that touches a changed tool.
- Composio tools remain Composio's IP — we store slugs + metadata, never copy their implementations.

## 2. Risk-tier derivation at scale (conservative default — load-bearing)

- The v1 rule engine (`risk.ts`) extends with **pattern-based derivation**: destructive verbs (delete/revoke/cancel/remove) → high; write verbs (send/post/create/update/publish) → medium; read verbs (list/get/search/describe) → low. Fuzzy match + per-app override tables.
- **Conservative floor, now universal:** any tool the classifier cannot confidently derive lands **gated** — never auto-executable. Unclassified = no execution path until classified and approved for auto/low.
- Per-app override tables are reviewable in the Actions UI; overrides may escalate but never downgrade below the derived tier (Phase 14 floor semantics, unchanged).

## 3. OAuth connect flow — reuse from Phase 14

- Same connect/disconnect/revoke flow per app, now rendered as a browsable toolkit directory: search, categories (CRM, comms, files, payments, social…), connection health per app.
- **Curated packs vs firehose:** out of the box, workspaces see curated packs ("Sales pack", "Marketing pack", "Support pack" — each a bundle of toolkits with pre-classified tiers). The full 100+ directory is one click deeper. Agents can only propose tools from connected apps; unconnected toolkits show "connect" as the CTA.

## 4. Data model (extends Phase 14)

- `ComposioToolCatalog` — cached tool list per workspace+app (above).
- `ComposioToolkitPack` — curated packs: name, toolkit list, default enabled state.
- `WorkspaceToolkit` — which toolkits a workspace enabled (from packs or à la carte), who enabled them, when.
- `ComposioActionApproval` / `ComposioActionLog` gain `toolkitSlug` + `packSource` for attribution.
- RLS battery extended to the new tables.

## 5. Metering & cost (load-bearing)

- More tools = more calls. Composio bills per tool invocation; free tier is 20K calls/mo, Pro $29/mo/200K (re-verify at build time).
- Per-workspace **call budgets**: soft cap with alert at 80%, hard cap option. Cost attribution per toolkit in the Activity view ("HubSpot ate 40% of your calls").
- Self-hosted Marketr = BYO Composio key (BYO data strategy, like BYO DataForSEO); hosted = keys bundled, metered into the ~90% gross-margin model. Define overage alert thresholds at build time.

## 6. Eval strategy for 100+ tools

- **Tier-accuracy sampling:** the pinned-catalog eval pattern from Phase 14 (expected-tier assertions) becomes a sampled eval — N tools per toolkit, human-labeled gold set, classifier agreement ≥ target before a toolkit's auto-read tier goes live.
- **Catalog-drift detection:** nightly diff of live catalog vs cache; new tools default to gated; a drift report lands in Actions → Activity.
- **"No silent execution" negative tests** extended: for every toolkit, an attempted bypass of the gate fails closed; an unclassified tool cannot execute.

## 7. UI surfaces

- **Actions → Toolkits:** searchable directory, pack cards, per-toolkit tool counts + tier breakdown, enable/disable, connect CTA.
- **Actions → Approvals:** unchanged (Phase 14 queue), now with toolkit filter.
- **Actions → Activity:** call counts per toolkit, cost attribution, drift alerts.

## 8. Build order

1. Live discovery + `ComposioToolCatalog` cache + drift detection.
2. Pattern-based tier derivation + universal conservative floor; sampled tier-accuracy eval harness.
3. Toolkit directory UI + curated packs + `WorkspaceToolkit`.
4. Metering: per-workspace budgets, alerts, cost attribution views.
5. Full eval battery + negative tests across toolkits.
6. Migration path: v1 pinned catalog becomes the "v1 pack" — zero regression for existing workspaces.

## 9. Verification (definition of done)

- tsc clean, production build green, tests green (new suites: discovery cache + drift, tier derivation on sampled toolkits, pack enable/disable, budget alerts, gate-bypass negatives per toolkit).
- Acceptance: connect a new app from the directory, an unclassified tool proposes → lands gated (never auto); drift simulation (changed tool slug) flags and requires re-approval; budget alert fires at 80%.
- Secret scan clean. Screenshots: toolkit directory, pack view, cost attribution. Local-only commit.

## 10. Cost & license reality check

- **Composio:** pricing/call limits re-verified at build time (they move). The trust boundary from Phase 14 stands: standard tiers hold user OAuth tokens on Composio's cloud. Tool metadata is descriptive data, not code — no license contamination.
- **Cost risk:** the real exposure is call volume, not seats — hence budgets + alerts as first-class, not follow-up.

---

## DECISIONS — LOCKED by Tico 2026-09-28

- **(a) Full firehose.** Every toolkit visible and enable-able from day one.
- **(b) high-gated** (default — Tico didn't pick; safest under the conservative doctrine: unclassified tools need approval + second confirmation until classified).
- **(c) No packs.** Full toolkit directory only — no shipped starter packs.

---

## OPEN DECISIONS (resolved 2026-09-28; unpicked items use the safe defaults above)

**(a) Enablement default.**
*Option 1 — Packs only (recommended):* workspaces start with curated packs; the full 100+ directory is opt-in per toolkit. Less OAuth sprawl, cleaner evals.
*Option 2 — Full firehose:* every toolkit visible and enable-able from day one. Maximum "as many tools as possible" energy, more surface to classify and meter.

**(b) Default tier for unclassified tools.**
*Option 1 — medium-gated:* goes to the approval queue like any write. Human reviews once, tier gets pinned.
*Option 2 — high-gated:* unclassified tools need approval + second confirmation, like destructive. Slowest, safest.

**(c) Who curates the packs?**
*Option 1 — We ship the packs:* Sales/Marketing/Support packs defined at build time from the sampled evals.
*Option 2 — Workspaces build their own:* no shipped packs, just the directory + save-as-pack. Maximum flexibility, zero curation cost for us.
