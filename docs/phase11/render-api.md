# Render API — POST DesignDocument JSON → PNG

> **Date:** 2026-09-27 · **Status:** built (integration #2 of 10, Phase 11).
> **Route:** `app/api/studio/designs/render/route.ts` · **Core:** `lib/design/render-server.ts`.

## What it is

The server-side render API turns every Canvas design into an **automation primitive**.
POST a `DesignDocument` JSON, get PNG bytes back. No browser, no canvas, no session
tricks — a pure function over the design JSON, which means:

- **n8n / Zapier / Make:** an HTTP Request node that renders any template.
- **GrowthOS batch loops:** "generate 100 on-brand variants from this brief" ends with
  100 PNGs, no human clicking export.
- **Nightly regeneration:** the variant that won gets re-rendered on a schedule; the
  loser gets killed. Designs that know what they're for.

This is integration #2 because the survey ranked it #2 in the top-10 moves:
*"Turns every template into an automation primitive: n8n nodes, GrowthOS batch
loops, 'regenerate the winners nightly.' This is the strategic asset the whole
company compounds on."* (asset-api-survey.md §14)

## The guarantee

**Server output agrees with canvas and SVG export.** The pipeline is:

```
DesignDocument → lib/design/export-svg.ts → SVG string → sharp (librsvg) → PNG
```

`export-svg.ts` is the *same serializer* the client's "Export SVG" button uses,
built on the shared chart-math layout models (commit `ebd360c`), so bar/line/pie
charts draw identically everywhere. The render API does not re-implement any
geometry — it feeds the identical SVG string to the rasterizer.

Two deliberate non-goals, matching the SVG exporter's own caveats:

- **Text wrapping:** Konva wraps at a pixel `width`; the SVG serializer preserves
  explicit line breaks but does not replicate word wrap. Multi-line text that
  relies on canvas word-wrap may reflow.
- **Fonts:** the SVG references font-family names. The server registers **Inter**
  (the editor default, embedded OFL woff2 — see `lib/design/render/`) with
  fontconfig; the rest of the curated set (Arial, Helvetica, Georgia, Times New
  Roman, Courier New, Verdana, Trebuchet MS) resolves to metric-compatible system
  fonts (Liberation Sans/Serif/Mono, Noto). Font families outside that set fall
  back to the system sans, same as any SVG viewer.

## Endpoint contract

### POST /api/studio/designs/render

Body (JSON) — supply exactly one of `id` / `document`:

```jsonc
{
  "document": { "schemaVersion": 1, "pages": [ /* ... */ ] }, // inline design JSON
  // or: "id": "<saved design id>",   // workspace-scoped, same read path as GET /api/studio/designs/[id]
  "pageId": "page-1",                // optional; defaults to the first page
  "scale": 2                         // optional; 1..3, default 1
}
```

`?id=` is also accepted on POST for convenience.

### GET /api/studio/designs/render?id=\<designId\>[&pageId=…][&scale=…]

Renders a saved design. Same workspace scoping.

### Responses

- `200` — `image/png` bytes. Dimensions = page size × scale (e.g. a 1080×1350
  page at `scale: 2` → 2160×2700). `Content-Disposition: inline` with a
  `design-<name>-<pageId>@<scale>x.png` filename. `Cache-Control: no-store`.
- `X-Render-Warnings` header (when non-empty): per-image notes, e.g. a remote
  image that failed to load and was replaced by a light-gray placeholder. The
  render itself always succeeds — one bad image never fails the batch.
- `400` — invalid input (bad JSON shape, `scale` outside 1..3, unknown `pageId`,
  both/neither of `id`/`document`, or an invalid design document — the document
  is validated with `lib/design/validate.ts` and garbage is never rendered).
- `401` / `403` — auth / role, via the standard workspace guard.
- `404` — `id` not found in this workspace (tenant isolation: a design id from
  another workspace renders as not-found, never leaks).
- `429` — per-tenant rate limit (see below), with `Retry-After`.
- `500` — render failed. The message is deliberately light; details go to the
  server log, never to the client.

## Protection (automation endpoint)

- **Workspace scoping:** every request passes `guardWorkspace`; saved-design
  loads are `findFirst({ where: { id, workspaceId } })` — cross-tenant ids 404.
- **Per-tenant rate limit:** `checkRateLimit("render:ws:<workspaceId>", "ai")` —
  the "ai" tier (20 req/min) because renders are expensive compute like LLM
  routes, keyed by workspace so one tenant's batch loop can't burn another's
  budget. The global proxy write/read tiers apply on top.
- **Scale cap:** `scale` is clamped to 3x server-side; the route rejects >3.
- **Image fetching:** remote URLs resolve through an SSRF guard (loopback,
  RFC1918, link-local/cloud-metadata, CGNAT, multicast, and all IPv6 blocked —
  checked pre-fetch *and* post-redirect), 8s timeout, 8 MB per-image cap,
  max 25 remote images per render. `data:` URLs pass through (the document is
  already size-capped at 5 MB by the validator).
- **No secrets in code; no internal details in error messages.**

## n8n example

An **HTTP Request** node that re-renders a winning template variant nightly:

1. **Method:** POST — **URL:** `https://<your-marketr>/api/studio/designs/render?scale=2`
2. **Authentication:** Header Auth — whatever your Marketr session/API auth is
   (the route uses the standard session guard).
3. **Body (JSON):**
   ```json
   {
     "id": "design_abc123",
     "pageId": "page-1"
   }
   ```
   or inline the document after a **Code** node fills `{{variable}}` placeholders:
   ```json
   { "document": {{ $json.document }} }
   ```
4. **Response:** set *Response Format* to **File** — the node outputs PNG bytes
   ready for a Drive/S3/WordPress upload node.
5. Watch the `X-Render-Warnings` response header: if a stock URL died overnight,
   the PNG still renders with a gray placeholder and the header tells you which
   element to fix.

GrowthOS batch pattern: **Code** node (fill variables → N documents) → **Split
In Batches** → **HTTP Request** (render, scale 2) → collect PNGs. Twenty renders
a minute per workspace is the guardrail; size batches accordingly.

## Files

- `app/api/studio/designs/render/route.ts` — POST + GET handlers.
- `lib/design/render-server.ts` — validation → SVG → PNG core, image
  resolution, SSRF guard, font registration. Never throws on bad input.
- `lib/design/render/inter-fonts.ts` — generated; embedded Inter woff2 (base64).
- `lib/design/render/OFL-LICENSE.txt` — SIL OFL 1.1 attribution for Inter.
- `lib/design/__tests__/render-server.test.ts` — 12 tests (validation
  rejection, PNG signature + dimensions at 1x/2x/3x-clamp, image fetch,
  failure→placeholder, SSRF no-network).

## Open items

- `document.fonts` discipline: the schema has no fonts manifest yet, so the
  server resolves families at render time (Inter embedded; curated set via
  system fontconfig; everything else → system sans). If brand-font fidelity
  becomes load-bearing, add a `fonts` manifest to the document and a
  Fontsource-backed registration step here.
- Word-wrap parity with the Konva canvas (see "The guarantee" above).
- Metering: renders are rate-limited but not yet credit-metered; hook into
  `lib/metering/service` if per-render billing is wanted.
