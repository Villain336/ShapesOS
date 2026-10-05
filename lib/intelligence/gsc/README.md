# M1 — GSC-first rank intelligence

GSC is the default rank truth for owned sites. Paid SERP (the M6 barrel at
`lib/intelligence/providers`, `fetchSerp` in `routing.ts`) is residual-only:
competitor keywords, zero-impression queries, SERP-feature composition.
M6's `fetchSerp` calls `assertBudgetAvailable()` internally — every paid call
is circuit-broken by construction.

## Google OAuth tokens (reused, not rebuilt)

M1 does **not** build a second OAuth flow. Tokens live in the M21 vault:

- `ConnectorConnection` row with `connectorKey = "google-search-console"`
  (OAuth config + `webmasters.readonly` scope in `lib/vault/oauth.ts`).
- Encrypted credential blob on `ConnectorCredential`, decrypted server-side
  via `getDecryptedCredential()` (`lib/vault/refresh.ts`).
- Per-project binding via `ProjectDataSource` (`projectConfig.property` =
  the SC property, e.g. `sc-domain:example.com`).
- `getGscToken()` (`client.ts`) resolves the binding → decrypts → silently
  refreshes when the token is expired or near-expiry → throws a
  reconnect prompt when refresh fails; a 401 mid-pull refreshes once more.
- HTTP: `api.ts` is the only Search Console client. The bulk cron
  (`client.ts`) and the M21 agent-tool adapter
  (`lib/connectors/m21/native/google-search-console.ts`) both call it; it
  rides the shared live connector layer (`lib/connectors/m21/live/http.ts`).

## API caps (honored in code)

| Cap | Value | Handling |
|---|---|---|
| Rows | ~50,000/day/search-type/property | paginate `startRow`/`rowLimit: 25000`; hard stop at 50k with `truncated: true` on the run |
| Rate | 1,200 QPM/site | in-process throttle in `client.ts` |
| Hourly data | `HOURLY_ALL`, last ~30 days only | hourly pulls chunk into 24h windows; chunks older than 30d are skipped, not failed |
| 429/5xx/quota 403 | — | exponential backoff + jitter, 4 retries, honors `Retry-After` (shared live layer) |

Every API call is metered into `api_meter` (`vendor: "google_gsc"`,
`meter: serp_call` — the only search-data bucket in `ApiMeterKind`, filter
by vendor to separate GSC from paid SERP; `cost_usd: 0` because GSC is free).
The meter rows are the append-only per-call audit log (spec §4 invariant 6).

**Deviation note:** there is no `gsc_api_call` value in `FileChangeAction`
and M1 may not write migrations, so per-call audit lives in `api_meter`
rather than `file_change_log`. Recommend adding a dedicated enum value when
a migration is allowed.

## Snapshots

`pullSnapshots(workspaceId, projectId, window, granularity)` stores one
`gsc_snapshot` row per chunk (hourly = 24h chunks, daily = whole window),
upserted on `(projectId, windowStart, windowEnd, granularity)`. Rows are the
aggregated query × page × country × device rows from Search Analytics.

## Delta engine

`computeDeltas(workspaceId, projectId, pre, post)` — the primitive M2's radar
consumes. Aggregates snapshots per window (hourly preferred when present,
never mixed with daily), matches on page × query, emits
`PageQueryDelta{ page, query, deltaClicks, deltaImpressions, deltaPosition, magnitude }`.
`deltaPosition = post − pre`, so **negative = moved up**. Magnitude is a
0–100 blend normalized against the largest move in the call.

## Visibility recompute

`recomputeGscVisibility()` feeds per-query GSC aggregates through the
**existing** `visibilityScore()` math in `lib/rankings.ts` (the same
1/log2(p+1) click-share curve the paid path uses) — GSC impressions stand in
for keyword volume. One formula, two data sources. Winners/losers come from
the delta set (position improved/declined, minimum magnitude gate).

## BigQuery bulk export (free setup)

The export is configured by the user in Google Cloud — Marketr never performs
it, it only reads the dataset when linked. Setup (free for small sites):

1. Search Console → select the property → **Settings** → **Associate a
   Google Cloud project** (create one if needed).
2. In the same Settings pane, enable **BigQuery export** and pick the
   dataset. Google creates `searchdata_site_impression` (daily) and
   `searchdata_url_impression` tables.
3. In Marketr, open the GSC data source config and save
   `{ bigquery: { projectId, dataset, table? } }`
   (`saveBigQueryExportConfig()`).
4. `getBigQueryExportStatus()` returns `{ configured: true, ... }`.

What the export buys: it **removes the 50k rows/day API cap entirely** and
gives bulk history. Honest limits (documented, not hidden):

- **Anonymized queries are excluded** from the export — rare queries that
  Google anonymizes never appear. The API path has the same gap.
- Export tables are daily-granularity; hourly still comes from the API.
- Cost: BigQuery storage + queries are ~$0 for small sites; large properties
  should set a BigQuery cost cap in Google Cloud.

When unconfigured, everything degrades gracefully: `getBigQueryExportStatus()`
returns `{ configured: false, reason }` and callers use the API path.

## Rank-check cadence (Tico-locked default)

SPEC-PHASE10 §10 Q3 (locked 2026-09-26): long-tail tracked keywords stay on
**weekly** checks; head terms check daily. `schedule.ts` is the single source
of truth:

- `isLongTailKeyword()` — heuristic: 4+ words in the phrase, or known volume
  < 500.
- `checkCadence()` — "weekly" for long-tail, "daily" otherwise.
- `isCheckDue(keyword, lastCheckedAt)` — the gate the scheduler consumer
  (`POST /api/rankings/check`) calls before spending a paid SERP call.

No schema change (Keyword has no cadence column — M1 may not write
migrations), so the policy is derived per keyword at schedule time. Explicit
per-keyword overrides, if a scheduler ever stores one, take precedence.

## URL Inspection queue

Hard wall: **2,000 queries/day/site**, no service-account escape. Design:

- `enqueueInspection()` — one URL at a time with priority 1–5 + reason.
  There is deliberately no sweep API.
- `drainInspectionQueue()` (run from the cron) — priority desc, fair-share
  across projects (round-robin by least-served), hard stop at the daily cap.
- Quota ledger persists per site per UTC day in the GSC data source config.

**Scope note:** full live inspection calls
`POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`
with `{ inspectionUrl, siteUrl, languageCode }` and requires the **user's**
OAuth token with the `webmasters.readonly` scope (same vault path as the
client). The v1 stub performs quota accounting with the real endpoint shape
but makes no network call; results are flagged `stub: true`. Enabling live
inspection is an explicit opt-in per workspace (documented decision, not a
silent default).
