# Physical Attribution Kit (P2)

One-click measurement bundle per campaign: **tracking number + QR code +
vanity URL + promo code**. Every artifact stamps the bundle's `campaignName`
onto attribution touches, so first/last/linear models credit physical
responses with no model changes.

## Bundle anatomy

| Artifact | What it is | Where it lives |
|---|---|---|
| Tracking number | `CallNumber` provisioned via the R5 provider abstraction (fake telephony until `TWILIO_*` creds exist) | `attribution_bundle.number_id` |
| QR code | Generated on demand from the vanity URL (`qrcode` npm); nothing stored at rest. "Regenerate" cycles a render preset — the URL never changes, so printed codes keep working | `lib/physical/qr.ts` |
| Vanity URL | `/r/<slug>` — logs a scan, then 302s to the destination with UTMs merged in | `app/r/[slug]/route.ts` |
| Promo code | `WAVE-XXXXXX` (unambiguous alphabet), globally unique | `attribution_bundle.promo_code` |

## Attribution wiring (no model changes)

- New channel vocabulary in `lib/attribution/touches.ts` `channelFor()`:
  `utm_medium=promo` / `utm_source=promo|promo_code` → `promo_code`;
  `leadSource=promo_code` → `promo_code`; `leadSource=qr_scan` → `qr_code`
  (`qr` medium/source → `qr_code` already existed).
- `/r/<slug>` identified scans (`?lead=<id>` matching a workspace lead) log a
  `qr_code` / `vanity-url` / `qr` **visit** touch *before* the redirect.
  Anonymous scans are events only (`bundle_scan`) — touches require a lead.
- Promo redemption (public endpoint or `promoCode` on any lead-capture path)
  logs a `promo_code` / `promo` / `promo` **form** touch + a
  `bundle_redemption` row (unique per bundle+lead: re-submits don't double-count).
- Calls to the bundle's tracking number flow through the R5 inbound path;
  the number's `campaign` label is the bundle campaign, so the call touch
  carries the same campaign key.
- Per-bundle revenue in `bundleStats()` reuses `getAttributionReport()` and
  sums the bundle's campaign across channels per model.

## Metering

No new meter. Bundle creation, QR generation, and scan logging are pure
software with negligible marginal cost; call minutes continue to meter via
the existing `call_minutes` dimension (R5).

## Public surface & threat notes

- `GET /r/<slug>` — the slug is the capability: an unlisted random
  identifier (40-bit random suffix on auto-generated slugs; no directory or
  enumeration endpoint, so guessing is the only discovery path — not a
  cryptographic secret, and nothing behind the route is confidential).
  Slugs are **globally unique** (single `UNIQUE(vanity_slug)`), so the
  public route resolves deterministically with `findUnique` — no
  cross-workspace ambiguity. Unknown slug → 404, disabled bundle → 410
  (nothing logged). Scans store a sha256 of the IP + UTC day — no raw PII.
  Scan insert is unique per (bundle, ip, day): double-scans collapse via the
  P2002 race backstop. The `?lead=` identification param is validated
  workspace-side and never forwarded to the destination.
- `POST /api/attribution/bundles/redeem` — the promo code is the capability
  (30-bit random, `WAVE-` + 6 chars from a 32-symbol alphabet, globally
  unique; per-code+IP rate limit makes blind guessing infeasible).
  Unknown/disabled codes 404 with a generic message (no oracle). Per-code+IP
  rate limit (10/min) inside the proxy write-tier limiter. Zod + 8KB body
  cap. Email or phone required — no anonymous lead creation. Redemption
  unique per (bundle, lead).
- UTM merge precedence on redirect: scan-URL params (passthrough) >
  destination-URL params > bundle UTM defaults.
- Tenant isolation: slugs are globally unique so `/r/<slug>` resolves to
  exactly one bundle; promo codes resolve to their bundle's workspace and
  list/get/stats/patch routes are workspace-scoped via `getOrCreateWorkspace` +
  `requireWorkspaceRole` (editor+ for mutations).
- Known gaps (honest): transcription still stubbed (R5); the fake provider's
  counter resets per process — `createBundle` retries on e164 collision
  (P2002) inside its attempt loop; vanity slugs truncate to 40 chars.
  `createBundle` creates the `CallNumber` row and the bundle in one DB
  transaction (no orphaned number rows on failure), but the provider purchase
  itself can't roll back — with real Twilio creds, a DB failure after a
  successful purchase leaves an unrecorded number in the Twilio console.
  Anonymous scans are events only (`bundle_scan`); model attribution needs an
  identified lead (`?lead=`, redemption, or call).

## Battery

`scripts/verify-physical-attribution.mts` — 55 assertions, green on fresh
DBs (incl. the global-vanity-slug migration). Run: `DATABASE_URL=<fresh> npx tsx scripts/verify-physical-attribution.mts`.
