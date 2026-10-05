# Marketr — Revenue Attribution Threat Model (Phase 2, C2)

**Status:** Written against the shipped implementation; every abuse case has an
adversarial test in `scripts/verify-attribution.mts`.
**Scope:** `lib/attribution/*`, `/api/attribution/*`, `/dashboard/attribution`,
`AttributionTouch` / `AttributionSpend` models, UTM capture in the lead POST /
public form / CSV import paths.
**Assumptions:** No ad-provider APIs — spend is manual entry only. Touch data
is self-reported (UTMs, manual logging), never ledger-grade.

## Trust boundaries

1. **API layer** — the only enforcement boundary for multi-tenant isolation.
   Every query is scoped by `workspaceId` re-derived from the session; the DB
   registry is the source of truth, never a client-supplied workspace field.
2. **Capture paths** — UTMs arrive from untrusted clients (forms, CSVs, API).
   They are *claims about a visit*, validated and normalized server-side, and
   capped in length before storage.
3. **Report engine** (`lib/attribution/report.ts`, `models.ts`) — pure
   computation over tenant-scoped rows. It must never see another workspace's
   touches, spend, or won revenue.

## Abuse cases → mitigations

### T1. Cross-workspace IDOR (touch / spend / lead / timeline)
*Abuse:* A caller in workspace A reads or writes workspace B's touches, spend
rows, lead timelines, or revenue by guessing IDs.
*Mitigations:*
- Every touch write verifies the lead belongs to the caller's workspace
  (`logTouch` / `recordCaptureTouch` throw "Lead not found in workspace").
- Spend CRUD takes `workspaceId` and filters every read/update/delete by it;
  foreign rows return 404/false, never data.
- Timeline looks up the lead with `{ id, workspaceId }` before returning touches.
- Report queries scope touches, leads, spend, and content items by workspace.
- Battery: cross-workspace touch write blocked, foreign touch invisible in
  reports, foreign timeline lookup blocked, foreign spend update/delete/list blocked.

### T2. Touch spoofing and replay
*Abuse:* An attacker (or a buggy integration) floods a lead with fake touches
to steal credit for revenue, or replays the same touch to inflate touch counts.
*Mitigations:*
- **Dedup:** `touchDedupHash` = sha256 over the touch's natural key with the
  timestamp truncated to the hour; UNIQUE `(leadId, dedupHash)` is the
  race-safe backstop (P2002 → return the existing touch).
- Manual touch logging requires the **editor** role; reads are available to
  authorized workspace viewers.
- Touches are immutable from the API (no update/delete endpoint) — a spoofed
  touch cannot be edited into a more favorable channel later.
- Battery: duplicate submissions collapse to one row.

### T3. Spend tampering
*Abuse:* A viewer (or a compromised editor session) inflates spend to tank a
channel's ROAS, or edits another workspace's spend rows.
*Mitigations:*
- Spend create/update/delete require the **editor** role; reads are
  viewer-visible.
- All spend mutations are tenant-scoped; a foreign row ID behaves as not-found.
- Overlap dedupe: same (channel, campaign) rows with overlapping periods are
  counted once (earliest kept), so a duplicated invoice can't double spend.
- Zod validation rejects negative amounts, empty channels, and inverted periods.
- Battery: spend CRUD scoping, overlap dedupe, validation rejections.

### T4. Content-link tenant validation
*Abuse:* A touch in workspace A references a `contentId` belonging to
workspace B, leaking the existence (or URL) of B's pages into A's reports.
*Mitigations:*
- `logTouch` rejects any `contentId` that doesn't resolve to a ContentItem
  whose project belongs to the caller's workspace.
- The content report only joins workspace-owned ContentItems; unlinked
  content IDs never surface another workspace's URLs.
- Battery: foreign content association blocked; owned content links resolve
  to the correct published URL.

### T5. UTM limits and validation
*Abuse:* Oversized or malicious UTM values (script payloads, multi-KB strings)
stored and later rendered in the dashboard.
*Mitigations:*
- UTM fields are trimmed and length-capped (`utm_source` ≤ 160, `utm_medium` ≤
  80, `utm_campaign` ≤ 160, `utm_term`/`utm_content` ≤ 160) in `recordCaptureTouch`
  and the manual-touch Zod schema; over-limit input is rejected, never silently
  truncated into a different value.
- Channel is derived server-side from a fixed allowlist (`channelFor`); unknown
  sources fall back to sanitized slugs or `other` — never raw client text used
  as a channel key.
- Dashboard renders all values as text (React-escaped); no UTM value is ever
  interpreted as HTML.

### T6. Attribution limitations and confidence (not a vulnerability — a scope boundary)
Attribution here is **directional, not ledger-grade**. It must never be
presented as certainty:
- Only three models are supported: first-touch, last-touch, linear. No
  time-decay or position-based models yet.
- Offline influence (word of mouth, in-store visits) is invisible unless a
  touch is logged manually; won revenue with no touches is reported as an
  explicit **unattributed** bucket, never silently assigned.
- Cookie/UTM loss, ad-blockers, and cross-device journeys mean the first
  observed touch is a lower bound on the real journey. The dashboard labels
  model outputs as model-dependent.
- Spend is manual until ad-provider APIs land; ROAS on stale spend is flagged
  by the spend-entry dates shown next to the numbers.

## Residual risks (accepted)
- A malicious **editor** inside a workspace can still log fake touches or
  spend for that workspace — same trust level as editing leads. Mitigated by
  the activity/audit trail, not blocked.
- Public capture forms accept UTMs from anyone with the form token; token
  secrecy (per THREAT-MODEL-CRM.md T2) is the control.
