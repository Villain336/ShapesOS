# Wave B — One of Everything (Consolidation)

**Status:** spec approved by Tico 2026-09-28. Build in slices: code → typecheck → tests → commit per slice. One production build for the wave, at the end.

## Doctrine

One social entry (Postiz). One messaging home. One prospect model. One analytics home. No duplicate surfaces, no duplicate models. Everything local-only until Tico authorizes otherwise.

## Tico's locked decisions (2026-09-28)

- **Social:** current direction is right — Social tab is the single Postiz-centered entry; audit and kill stragglers.
- **Messaging:** build a big single inbox UI.
- **Prospect model:** `Lead` wins — the CRM-native model is canonical; `Prospect` and `OutreachProspect` migrate to / become views on it.
- **Analytics:** `Analytics` becomes the home; `Reports` folds into it as saved views.

## Slice 1 — Social: single Postiz-centered entry

**Inventory (verified 2026-09-28):** `app/dashboard/social` (SocialApp, 438 lines) is the publishing workspace. All send-to-social paths already route via Postiz: `app/api/clipper/clips/[id]/to-postiz`, `app/api/studio/assets/[id]/use-in-social`, `app/api/ads/creatives/[id]/send-to-social`. Postiz integration lives at `app/api/integrations/postiz` (channels, posts, status). Platform OAuth tokens live inside Postiz; Marketr holds only sidecar URL + API key.

**Work:**
1. Audit for any social OAuth/token storage or posting path that bypasses Postiz; reroute or remove.
2. Confirm the Social tab is the only dashboard entry point for publishing/scheduling (nav audit).
3. Remove or redirect any dead/duplicate social surfaces.

**Verify:** typecheck, existing social tests, screenshot of Social tab, no page errors.
**Commit:** `Wave B slice 1: single Postiz-centered social entry`.

## Slice 2 — Prospect model: Lead is canonical

**Inventory (verified 2026-09-28):**
- `Lead` — CRM-native: pipeline-bound, stages, deterministic scoring, `dedupKey` (email:/phone:), activities, attribution touches, calls. UI: `app/dashboard/crm`.
- `Prospect` — R6 enrichment scout: belongs to `ProspectList`, `enrichmentData`/`research` JSON, status flow new → enriching → enriched → failed → in_sequence → converted, optional `leadId`. UI: `app/dashboard/prospects` ("Prospect lists, waterfall enrichment, AI research, and CRM conversion").
- `OutreachProspect` — campaign-scoped: domain/url-centric, belongs to `OutreachCampaign`, quality/relevance scores. No `Lead` link today.

**Design:** `Lead` is the single system of record for a person/company. `Prospect` keeps its list-building/enrichment workflow role but every converted prospect resolves to exactly one `Lead` (via `leadId`, backfilled where missing using the shared `dedupKey` scheme). `OutreachProspect` gains an optional `leadId` and links on convert/reply. No new identity columns; dedup stays on `dedupKey`.

**Work:**
1. Prisma migration: add `leadId` to `OutreachProspect` (+ index); data backfill script linking existing prospects/outreach-prospects to leads by `dedupKey`, creating `Lead` rows (stage `new`, source `prospecting`/`outreach`) where none exists.
2. Lib: `lib/prospects/unify.ts` — `resolveLeadForProspect()`, `resolveLeadForOutreachProspect()` used by the convert flows.
3. UI: Prospects tab keeps the enrichment workflow; converted rows deep-link to the CRM lead. No second "people" table.

**Verify:** typecheck, unit tests for the resolver (dedup collisions, race-safe), RLS battery addition for the new column, screenshot of converted prospect → lead link.
**Commit:** `Wave B slice 2: Lead canonical prospect model`.

## Slice 3 — Analytics home (Reports folds in)

**Inventory (verified 2026-09-28):**
- `app/dashboard/analytics` — Umami-backed pageview stats (`AnalyticsPanel`), honest empty state without the sidecar.
- `app/dashboard/reports` — white-label reporting (`ReportsManager`): templates, block-editor, branded PDF generation, schedules, history.

**Design:** `/dashboard/analytics` becomes the home with two tabs: **Overview** (existing Umami panel) and **Reports** (existing ReportsManager). `/dashboard/reports` permanently redirects to `/dashboard/analytics?tab=reports`. One nav entry: "Analytics".

**Work:**
1. Analytics page: tab bar (Overview | Reports), query-param tab selection.
2. Move `ReportsManager` rendering under the Reports tab (no logic changes).
3. `/dashboard/reports/page.tsx` → redirect. Nav: remove Reports entry.
4. Keep editor-role gating for the Reports tab (it was editor-gated as a page).

**Verify:** typecheck, screenshot both tabs, redirect check (old URL → 307/308), no page errors.
**Commit:** `Wave B slice 3: Analytics home, Reports as saved views`.

## Slice 4 — Messaging: big single inbox

**Inventory (verified 2026-09-28):**
- Nurture (`app/dashboard/nurture`): approval-gated drip sequences across SMS/email/voice/direct mail, with a `MessageLogTab` (outbound sends) and consent. Broadcasts via Listmonk.
- Voice `CallSession` (13D): `channel` voice|sms|chat, `direction`, `transcript` JSON `[{role, text, ts}]`, `leadId → Lead`, `consentProof`, outcome, audit trail.
- AI chat threads (`app/api/chat/threads`): user ↔ Marketr assistant. **Out of scope** — user-facing, lives under Assistant.

**Design:** new `/dashboard/inbox` — "Inbox". One thread per lead, newest activity first. Each thread unifies: nurture outbound sends (from the message log) + voice/SMS/chat session transcripts, in chronological order, with channel badges and consent state. Read-first: drill into any item for the full transcript/proof. Any reply/compose routes through the existing gated flows (nurture approvals, 13D consent gates) — the inbox never sends directly. Filters: channel, unread, needs-reply (e.g. inbound SMS without outcome). Search by lead name/company.

**Work:**
1. API: `GET /api/inbox/threads` (per-lead aggregates: last activity, channel mix, unread) and `GET /api/inbox/threads/[leadId]` (merged chronological timeline). Session-resolved workspace (guardWorkspace). RLS-safe.
2. UI: `app/dashboard/inbox/InboxApp.tsx` — thread list (left) + timeline (right), filters, channel badges, consent chips, deep links to CRM lead / voice session / nurture log entry. RareUI/BeautifulUI/shadcn only, Lucide icons, dynamic brand accent.
3. Nav: add Inbox entry (position TBD — after CRM).

**Verify:** typecheck, unit tests for the timeline merge (ordering, channel mix, empty states), RLS battery for the new endpoints, desktop screenshots, no page errors.
**Commit:** `Wave B slice 4: single messaging inbox`.

## Wave-level verification (after slice 4)

- Full `tsc --noEmit` clean.
- Full test suite green.
- One production build; preview keeper restart; `/`, `/dashboard` health.
- Desktop screenshots of all four touched surfaces.
- Secret scan clean.

## Open questions (parked, not blocking)

- Inbox nav position and whether inbound SMS needs a dedicated reply composer later (v2; v1 routes through gated flows).
- Whether `ProspectList` workflows eventually merge into CRM views (v2; v1 keeps the enrichment workflow tab).
- Live DataForSEO benchmark still deferred ("do dfs later"). No GPU/fine-tune spend.
