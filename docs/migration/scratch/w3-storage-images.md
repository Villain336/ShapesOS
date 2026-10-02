# Worker 3: Storage + Images — Migration Research (in progress)

Repo: ~/workspace/marketr. Read-only. Verified 2026-09-27.

## 0. Storage abstraction — the key discovery

**Almost all user-data storage already funnels through one abstraction: `lib/filesystem/`.**
- `lib/filesystem/service.ts` — public API used by every route: `writeFile({workspaceId, logicalPath, kind, bytes, mimeType, createdBy})`, `readFile`, `listDir`, `renameFile`, `moveFile`, trash/restore. Enforces 25 MB cap + upload safety (malware scan, magic-byte validation).
- `lib/filesystem/storage.ts` — byte store keyed by opaque UUIDv4s, two adapters:
  - `LocalDiskAdapter`: root = `MARKETR_STORAGE_DIR` or `<cwd>/.data/workspace-files` (atomic tmp+rename writes).
  - `S3CompatibleAdapter`: **hand-rolled SigV4** (PUT/GET/DELETE/HEAD, no SDK deps), config from `MARKETR_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/REGION/FORCE_PATH_STYLE`.
- `MARKETR_STORAGE=local` (default) | `s3`. "Multi-instance deployments MUST use s3; local disk is single-box only."

**This is the R2 story: `MARKETR_STORAGE=s3` + R2's S3-compatible endpoint is ~95% of the migration.**
R2 endpoint: `https://<account-id>.r2.cloudflarestorage.com`, region `auto`, path-style (current default `FORCE_PATH_STYLE=true` matches R2). R2 zero egress ⇒ ideal for the media-heavy studio (render PNGs, exports, stock assets, creative PDFs all go through this service).

**Direct-fs outliers that bypass the service** (must be moved individually): see inventory §1.

---

## 1. STORAGE INVENTORY (runtime; tests/scripts excluded)

### 1a. Already service-backed — R2 via `MARKETR_STORAGE=s3` flip (no code change)

| File | Line | What | R/W | Size |
|---|---|---|---|---|
| `app/api/files/route.ts` | 130 | FileManager uploads (25 MB cap) → `writeFile()` | W | ≤25 MB/file |
| `app/api/files/[fileId]/route.ts` | 68,120-125 | FileManager downloads, rename/move/restore → `readFile`/`renameFile`/`moveFile` | R/W | same |
| `app/api/projects/[id]/files/route.ts` | 132 | Project attachments → `writeFile()` (`storagePath: fs:<id>`) | W | ≤25 MB/file |
| `app/api/projects/[id]/files/[fileId]/download/route.ts` | 34 | Project attachment downloads | R | same |
| `lib/studio/creatives.ts` | 435-442 | Creative version PDFs → `/files/studio/creatives/<id>-v<n>.pdf` | W | KB–MB |
| `lib/studio/qr-designer.ts` | ~1513 | QR asset store (hash-deduped) → `writeFile()` | W | KB |
| `app/api/studio/creatives/[id]/upload/route.ts` | 37-38 | Uploaded creative PDF → `setCreativePdf()` → service | W | ≤25 MB |
| `app/api/flywheel/ctv/creative/validate/route.ts` | 44 | Workspace-file reads for CTV validation → `readWorkspaceFile()` | R | video MB |
| `lib/scheduler/outputStore.ts` | 148-156 | Scheduler run outputs (PRIMARY path) → `FilesystemServiceStore` via service | R/W | small–medium |
| `lib/security/upload-safety.ts`, `upload-audit.ts`, `malware-scan.ts` | — | In-memory buffer scanning inside the write path (no disk) | — | — |

### 1b. Direct filesystem writes — each needs its own R2 move

| File | Line | What | R/W | Size |
|---|---|---|---|---|
| `lib/pdf/generate.ts` | 155-157 | Report PDFs → `REPORT_STORAGE_DIR` (default `.data/reports/<id>.pdf`), takumi render | W | KB–few MB |
| `lib/authority/intelligence/pdf.tsx` | 163-166 | Intelligence report PDFs → `.data/reports/intelligence-<id>.pdf` | W | same |
| `lib/media/audio.tsx` | 189, 429-431 | Audio brief PDFs → `.data/audio-briefs/<id>.pdf` | W | same |
| `lib/media/io-briefs.tsx` | 145, 427-429 | IO brief PDFs → `.data/io-briefs/<brief>.pdf` | W | same |
| `lib/media/launch-packet.tsx` | 116, 506-509 | DOOH launch packet PDFs → `.data/launch-packets/<id>.pdf` | W | same |
| `lib/mail/eddm-brief.tsx` | 50, 399-401 | EDDM brief PDFs → `.data/eddm-briefs/<order>.pdf` | W | same |
| `app/api/brand-kits/[id]/logo/route.ts` | 58-63 | Brand-kit logo upload → `.data/reports/logos/` (direct `fs.writeFile`, NOT service) | W | KB (image) |
| `app/api/workspaces/white-label/logo/route.ts` | 64-69, 85 | White-label logo upload → `.data/reports/logos/` (direct `fs.writeFile`) | W | KB (image) |
| `lib/brand-logo.ts` | 75 | Reads logos back from `.data/reports/logos/` (confined via `resolveWithinDir`) | R | — |
| `lib/pdf/generate.ts` | 73-74 | Reads logo file into PDF render buffer | R | — |
| `lib/audit/runner.ts` | 26, 55-61, 67 | FixAgent file snapshots → `.data/fix-snapshots/<id>.json` (`FIX_SNAPSHOT_DIR` env) | R/W | KB (JSON) |
| `lib/connectors/local.ts` | 34-93, 146-154 | **Site IDE working copies** → `SITE_STORAGE_DIR` (default `.data/sites/<siteId>/working`) via `LocalDirProvider` (readdir/stat/readFile/writeFile per path) | R/W | MB (whole site trees) |
| `lib/connectors/zip.ts` | 51 | ZIP extraction → provider.writeFile (lands in site working copy above) | W | MB |
| `app/api/websites/[id]/route.ts` | 41 | DELETE site → removes working copy from disk (best-effort) | D | — |
| `lib/seo/programmatic-service.ts` | 498, 528-530 | Sitemap XML archive → `SITEMAP_STORAGE_DIR` (default `.data/sitemaps/<projectId>.xml`) on publish. NOTE: the public route (`app/api/programmatic/sitemap`) rebuilds in memory per GET — the disk copy appears to be a non-served archive. | W | KB |
| `lib/scheduler/outputStore.ts` | 98, 112 | Scheduler FALLBACK store → `.data/scheduler-runs/` (only if service import fails) | R/W | small |
| `lib/intelligence/corpus/store.ts` | 45-54, 96, 107 | Corpus manifest/chunks → `CORPUS_DIR` (default `data/corpus/`): `manifest.json`, `<asset>/chunks.jsonl`, `LICENSE.txt` | R/W | **56 MB in repo today** |
| `lib/intelligence/corpus/activity.ts` | 34-100 | Corpus usage tracking → `data/corpus/usage.json` | R/W | KB |
| `lib/intelligence/corpus/proposals.ts` | 49-162 | Proposed sources, payloads, removals, rebuild status → `data/corpus/proposed/`, `removals.json` | R/W | KB–MB |
| `lib/intelligence/difficulty/gate.ts` | 28, 64 | Reads eval state JSON from disk (`evalStatePath()`) | R | KB |
| `lib/intelligence/corpus/ingest.ts` | 100-107 | PDF fetch → `mkdtempSync(join(tmpdir(),"marketr-pdf-"))` scratch during ingest | R/W | transient |
| `lib/design/render-server.ts` | 96-106 | Inter woff2 + fontconfig conf written once per process → `os.tmpdir()/marketr-render-fonts*` | W | KB, startup-only |
| `app/api/flywheel/ctv/creative/validate/route.ts` | 68-74 | Video bytes staged → `os.tmpdir()/ctv-validate-*.mp4`, deleted after `validateCreative` (likely ffprobe path-based) | W/R | transient MB |
| `app/api/corpus/rebuild/route.ts` | 47 | Rebuild log → corpus dir log file; also `spawn("npx tsx scripts/ingest-corpus.mts")` child process (admin-only) | W | log KB |

### 1c. Static assets (`public/` — 944 KB total today)

| Path | What | CF move |
|---|---|---|
| `public/studio/3d-stills/*.png` (580 KB) | Pre-rendered Kenney 3D stills (build-time via `scripts/render-3d-stills.mts`; PNGs checked into repo) | Static → R2 bucket + CDN cache headers, or served from CF Pages/Workers static asset pipeline |
| `public/textures/` (344 KB) | ambientCG CC0 textures (Phase 11c) | same |
| `public/media/` (empty) | Payload Media upload landing dir (see §4) | becomes unnecessary once Payload points at R2 |
| `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg` | Framework leftovers | same static treatment |
| `lib/design/template-data/pack.json` | 232 native templates (generated by `scripts/generate-template-pack.ts`, imported by code — **bundled, not served**) | no move needed |
| `lib/design/mockup-frames.ts` | 20 SVG mockup frames — code-generated SVG in TS, no disk | no move needed |
| Templates registry (`COMPONENT-MANIFEST.json` etc.) | code/data bundled at build | no move needed |

### 1d. `next.config.ts` static config notes
- `output: "standalone"`; `serverExternalPackages: ["takumi-pdf"]` (wasm readFileSync load); `outputFileTracingIncludes` pulls onnxruntime `.so` (embeddings).
- **No `images:` config block; zero `next/image` imports in `app/` or `components/`** — there is no next/image optimizer to migrate. All studio imagery is client data-URLs, remote delivery URLs (Cloudinary/Pexels/Pixabay/Unsplash/BYOF), or server-rendered PNGs returned as response bytes.

### 1e. Sizes today
- `.data/`: 140 KB (preview env), dirs: `attachments/`, `eddm-briefs/`, `reports/`, `workspace-files/`. Real production would hold: ≤25 MB files per workspace, creative PDFs, scheduler outputs, site working copies.
- `data/corpus/`: **56 MB** (RAG chunks + backups; `data/corpus/backups/` contains v8 jsonl backups).
- Payload `public/media/`: empty today.

---

## 2. R2 MAPPING

### 2a. The easy 95% — `lib/filesystem/service.ts` consumers (§1a)
Set in the CF environment: `MARKETR_STORAGE=s3`, `MARKETR_S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com`, `MARKETR_S3_REGION=auto`, `MARKETR_S3_BUCKET=<bucket>`, `MARKETR_S3_ACCESS_KEY=<R2 token id>`, `MARKETR_S3_SECRET_KEY=<R2 token secret>`, leave `MARKETR_S3_FORCE_PATH_STYLE=true` (default; R2's standard endpoint uses path style). **No code change** — the hand-rolled SigV4 PUT/GET/DELETE/HEAD works against R2's S3 API (R2 implements SigV4). **UNVERIFIED**: not tested against live R2; subtle risks are clock-skew signing (hand-rolled `x-amz-date`) and R2's HEAD/404 semantics, which the adapter handles with explicit 404 checks already.

R2 pricing note for the media-heavy studio: **zero egress fees** — every PNG render, creative PDF, template asset, and FileManager download can be served without the S3 egress bill that makes AWS S3 punishing for this workload. Class A/B ops costs apply; renders are PUT-heavy, reads are GET-heavy.

### 2b. Per-outlier R2 moves (§1b)

| Outlier | R2 equivalent | Notes |
|---|---|---|
| PDF generators (`.data/reports|audio-briefs|io-briefs|launch-packets|eddm-briefs`) | **Route through `lib/filesystem/service` (logicalPath `/files/reports/<id>.pdf`)** → R2 via the §2a flip | Single-code-path change in each lib; download routes read via service. Biggest win: 6 libs, one pattern. PDF *rendering* itself (takumi) stays compute-side; only the artifact lands in R2 |
| Brand/white-label logos (`.data/reports/logos`) | Same — service write, `loadBrandKitLogoFile` reads via service | Small files; also candidate for CF Images if logo transforms are wanted later |
| FixAgent snapshots (`.data/fix-snapshots`) | Service write `/files/fix-snapshots/<id>.json` | Tiny JSON; alternatively Durable Object/KV, but R2 via service keeps one pattern |
| Sitemap XML archive (`.data/sitemaps`) | **Skip** — served in-memory already; drop the disk archive or write to R2 if an archive is wanted | Non-load-bearing |
| Scheduler fallback (`.data/scheduler-runs`) | Delete the fallback on CF (primary is already service-backed); or keep for single-box self-host only | The fallback exists for un-migrated installs |
| **Site working copies (`.data/sites/<id>/working`)** | **Hardest.** `LocalDirProvider` is path-tree oriented (readdir/stat/write-per-path, rename-on-delete). Options: (a) R2 prefix emulation: reimplement `LocalDirProvider` over the S3 adapter as `<siteId>/working/<path>` keys — needs **LIST** added to the hand-rolled SigV4 client (currently PUT/GET/DELETE/HEAD only) and `readdir` over prefix; (b) Cloudflare Containers/VM disk for the IDE working tree, R2 for everything else; (c) KV/Durable-Object virtual FS (wrong tool for MB-scale file trees). Recommend (a) with a LIST extension, or (b) if the migration keeps a Node container anyway (sharp/takumi/onnxruntime already need Node — see §3). | This is the only write site that is structurally directory-based rather than blob-based |
| Corpus (`data/corpus`, 56 MB) | **Static data pack, not runtime user data.** Options: (a) bake into the container image; (b) upload to R2 at build time, prefetch to local at boot (`CORPUS_DIR` points at the fetched copy); (c) rewrite reads to R2 GET/range-get (chunks.jsonl is line-oriented — range reads are awkward; full-file GET per asset is fine, biggest asset is `chunks.jsonl` main ~tens of MB). Also: `proposals.ts`/`activity.ts` do *writes* (proposals, usage, rebuild status) — those need a writable store (R2 or DB), not the static pack. | Cleanest: corpus pack read-only from R2/container; proposal/activity/removal state → DB tables (Prisma) instead of JSON files |
| tmpdir scratch (render fonts, CTV validate, PDF ingest) | Ephemeral: fine on any Node runtime with a writable tmp (containers/VM). **Blocked on pure Workers** (no tmpdir, no sharp, no ffprobe, no child processes). Fonts: could be fetched from R2 at boot instead of embedded base64 (~bloats the bundle anyway) | Not a storage migration issue — a compute-runtime issue |
| Corpus rebuild route (`spawn npx tsx`) | Admin-only; won't run on CF regardless — needs a container/job runner | Out of scope for storage |

### 2c. Uploads: browser-direct pattern
Today every upload goes client → Next route → memory buffer → storage (25 MB caps, malware scan in-path). On CF: keep this for ≤25 MB with scanning, OR add **presigned PUTs** — the hand-rolled SigV4 client would need a presign (query-string auth) addition; browser PUTs direct to R2 then notifies the route with the key, and the route runs `upload-safety` screen on a GET-before-register. **UNVERIFIED**: presign against R2 needs testing; the current adapter only signs header-based requests.

### 2d. Worker binding vs S3 endpoint
If the app runs on a Node-capable CF target (Containers, or the preview VM pattern), **keep the S3-HTTPS endpoint approach** — zero code change, same env-var contract, works identically in self-host Docker and CF. A Worker `R2 binding` only helps if routes are rewritten to the Workers runtime, which is incompatible with sharp/takumi-pdf/onnxruntime anyway (see §3). Recommendation: S3 endpoint everywhere; reserve R2 bindings for a future pure-Worker edge tier.

---

## 3. IMAGES — call sites + Cloudflare evaluation

### 3a. Image-processing call sites

| Call site | Input → Output | Where it runs today | CF recommendation |
|---|---|---|---|
| `lib/design/render-server.ts` `renderDocumentToPng()` — **the JSON→PNG render API** (`POST /api/studio/designs/render`) | DesignDocument JSON → `exportPageToSvg` (shared serializer w/ client) → `sharp(Buffer(svg), {density: 72*scale})` → PNG Buffer (in-memory; streamed back, never stored) | Node (sharp/libvips + fontconfig + embedded Inter woff2). Remote http(s) images fetched server-side with SSRF guard (DNS re-check, 8s timeout, 8 MB cap, 25 max) and embedded as data URLs | **Cannot move to Cloudflare Images.** CF Images URL transforms operate on *stored raster images*; they cannot ingest an arbitrary design JSON, run the custom serializer, apply SSRF-guarded fetch+embed, or resolve private fontconfig fonts. **Keep on Node compute (container)**; output PNGs then stored in R2 (§2a) and served/transformed *through CF Images* for thumbnails/variants |
| `lib/design/render-server.ts` `placeholderDataUrl()` | `sharp({create:{1×1}})` → 1×1 gray PNG data URL (cached) | Node | Trivial — replace with a hardcoded base64 constant if this module is ever ported; stays with render-server as-is |
| `lib/media/qr.ts:330` `renderQr` — styled QR export | Styled SVG (QR matrix + brand glyphs/logos) → `sharp(Buffer(svg), {density:300})` → high-res PNG (+ vector SVG variant) | Node, in-memory | **Keep on Node compute.** Same SVG-rasterization-with-precise-fonts constraint. Output → R2 + CF Images variants for delivery |
| `takumi-pdf` (`lib/pdf/renderer.ts`) + `@takumi-rs/helpers` | React JSX → PDF (Rust/WASM renderer, NAPI) | Node (externalized via `serverExternalPackages`) | **Not an image tool** — `@takumi-rs/helpers` is a runtime dep of `takumi-pdf` (confirmed via package-lock: `node_modules/takumi-pdf → ['@takumi-rs/helpers','react']`), never imported directly. Stays on Node compute; no CF Images relevance |
| `next/image` optimizer | — | **Not used anywhere** (zero imports; no `images:` config in next.config.ts) | Nothing to migrate. CF Images can serve as the *de facto* optimizer for R2-stored media going forward |
| Studio Uploads panel / AI-generated images | `app/api/studio/designs/generate-image` returns `data:image/png;base64` b64_json from the LLM provider directly to the browser; session assets live in a client zustand store (`lib/design/assets.ts`) | Browser + LLM API; never touch server disk | Generated images that need persistence → PUT to R2 via the service (or presigned), serve via CF Images. Uploads panel "upload" source = client data URLs today |
| Stock providers (Unsplash/Pexels/Pixabay/Brandfetch/Colormind/Poly Haven/ambientCG) | Third-party delivery URLs by default; Cloudinary = signed uploads to Cloudinary (BYO key) when configured | Remote | No change; CF Images can proxy/transform remote URLs if desired (fetch from R2-cached copy) |
| Mockup frames, template pack (232 templates) | Code-defined SVG / bundled `pack.json` | Bundle | No change |

### 3b. Sharp → Cloudflare verdicts
- **Which map to CF Images variants**: everything that is *already a stored raster* needing resize/format/quality — creative PDFs' preview PNGs, stored QR PNGs, uploaded images, render outputs, logo files. Flow: render on Node → PUT R2 → serve via CF Images (`/cdn-cgi/image/width=…/r2-key`) for delivery transforms.
- **Which need custom Worker code**: URL-transform plumbing is native (no custom code); if remote-image caching is wanted, a tiny Worker that fetches → R2 → CF Images covers the stock-provider hot path.
- **Which can't move**: the two sharp rasterizers (`render-server.ts`, `qr.ts`) — they rasterize *generated SVG with private fonts and embedded fetched images*. CF Images has no "render this JSON/SVG with custom fonts" API. (CF Images can rasterize simple uploaded SVGs, but not this pipeline — **UNVERIFIED** whether its SVG rasterizer would even accept these documents; regardless, the SSRF-guarded fetch + fontconfig + serializer chain must stay in app code.)
- Server PNG render is **sharp (libvips/librsvg), NOT node-canvas, NOT headless Chromium** — confirmed in `lib/design/render-server.ts` header ("Pipeline: DesignDocument → export-svg.ts → sharp (librsvg) → PNG"). Good news for containers (no browser), bad news for pure Workers (no native modules).

### 3c. Compute implication for the migration
sharp + takumi-pdf (wasm) + @xenova/transformers (onnxruntime `.so`) + ffprobe-style CTV validation + `os.tmpdir()` usage = this app **cannot run on the Workers isolates runtime**. The storage migration (R2 via S3 endpoint) is runtime-agnostic, but image/PDF/ML work needs Cloudflare **Containers** (or the current VM pattern) regardless. Plan: Node container for app+sharp, R2 for bytes, CF Images as the delivery/transform CDN in front of R2.

---

## 4. PAYLOAD MEDIA COLLECTION — verdict

**Today** (`payload/collections/Media.ts`):
- Payload 3.90.2, **default local upload adapter** (no storage plugin installed — confirmed: no `@payloadcms/storage-*` in package.json).
- `upload: { staticDir: path.resolve(process.cwd(), "public", "media"), mimeTypes: ["image/*"] }` → files land in **`public/media/`** (currently empty), served by Next at `/media/<filename>`. Collection adds an `alt` text field; read open, write requires a user.

**To point at R2 — two supported paths:**
1. **Official plugin `@payloadcms/storage-s3`** (v3-compatible): configure with `config: { endpoint: "https://<acct>.r2.cloudflarestorage.com", region: "auto", credentials: {...}, forcePathStyle: true }` + `bucket`, and add it to `payload.config.ts` plugins with `collections: { media: true }`. Payload then stores uploads in R2, serves via the bucket's public URL (or signed URLs). **UNVERIFIED**: exact plugin option names for 3.90.x need checking against the plugin README at implementation time; the plugin is S3-API-based and documented to work with S3-compatible endpoints (MinIO etc.), R2 included.
2. Keep `staticDir` for local dev; enable the plugin only when R2 env is present (fail-closed like the filesystem storage adapter).

**What changes in code:** install plugin, ~15 lines in `payload.config.ts` (plugin registration + `disableLocalStorage: true` on the Media collection so files don't also land in `public/media/`), env vars for R2. No change to `Media.ts` fields. Existing `public/media/` files: none today, so no backfill needed. If uploads existed, they'd need a one-time copy to the bucket.

**Also note:** Payload's admin UI image display and the Next `/media/*` serving path change — URLs become the R2 public/custom-domain URLs stored on the Media doc's `url` field. Any code referencing `/media/` paths: grep shows none outside the collection config (**UNVERIFIED**: only searched `app lib payload components scripts`; a full-tree grep at build time should confirm).

---

## 5. Open questions / UNVERIFIED items
1. Hand-rolled SigV4 vs live R2 (clock skew, HEAD semantics) — needs a live R2 test.
2. `@payloadcms/storage-s3` option names for Payload 3.90.x — check README at implementation.
3. Whether CF Images' SVG rasterizer could take these documents — speculative; not recommended regardless.
4. Presigned browser-direct PUTs to R2 — needs adapter extension + test.
5. `lib/filesystem/service.ts` write path details (virus scan, registry schema) were read at header level only; the full threat-model doc is `lib/filesystem/THREAT-MODEL.md`.
6. grep coverage: `app lib payload components scripts data prisma` — `vendor/` and `training/` not swept (build-time only, assumed).

