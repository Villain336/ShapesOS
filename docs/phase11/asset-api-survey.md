# Asset/API Survey — Phase 11 Creative Editor Expansion

> **Date:** 2026-09-27 · **Scope:** research only, no code, no build, no commits.
> **Marketr licensing frame:** AGPLv3 + commercial dual license.
> **Audience:** Tico + whoever specs/builds the integration phase.
> **Verification note:** all source facts were verified against official docs/ToS pages by research workers on 2026-09-27. Pixabay's official API docs were unreachable from the research environment (blocked), so Pixabay API-doc facts are triangulated from multiple independent summaries — **confirm the permanent-hotlinking clause and the "full API access" process against pixabay.com/api/docs before building.**

---

## 1. Pexels — ✅ Include behind BYO key (next stock source after Unsplash)

**What it offers.** Photos and videos only — no illustrations, vectors, music, or 3D. Curated, hand-picked library (curation quality over raw volume; no verified headline asset count). Strong lifestyle/marketing-adjacent photography and a broad video library — exactly what ad/social creative needs.

**API access.** Free, instant API key (pexels.com/api, no approval step). Default rate limits: **200 requests/hour, 20,000/month**. **Unlimited requests available free** by emailing api@pexels.com with a platform summary, proof of attribution (screenshots/demo), and the key. **Attribution required by the API terms** (stricter than the license itself): a prominent "Photos provided by Pexels" link wherever API results are used, plus photographer credit "when possible." You may not copy/replicate Pexels' core functionality (no wallpaper apps, no unaltered resale, no competing stock platform).

**License safety.** Clean for AGPLv3 + commercial. The Pexels License is a permissive content license (not copyleft): free personal + commercial use, no NC, no share-alike — zero interaction with AGPL obligations. Restrictions to honor: no unaltered resale, no trademark/logo use, no implying endorsement, no depicting identifiable people badly. None conflict with a commercial design tool.

**Integration shape.** `GET https://api.pexels.com/v1/search` (photos), `GET https://api.pexels.com/v1/videos/search` (videos). Auth: `Authorization: <key>` header. Rich per-size URLs on the `images.pexels.com` CDN (`src.original/large/medium/small/tiny`, landscape/portrait); video files as direct `.mp4` links. **Hotlinking is the intended pattern** — Pexels does not prohibit hotlinking its CDN URLs, so the Unsplash-style "hotlink in canvas, export on flatten" flow works. Server-side proxy still recommended for key hygiene (same as the existing Unsplash route).

**One-liner.** Commercially-clean permissive license plus a CDN built for hotlinking makes Pexels the natural second source behind the existing Unsplash panel; the API's attribution terms are already satisfied by the editor's attribution-in-`custom`-bag design (add a "Photos by Pexels" footer in the panel).

---

## 2. Pixabay — ✅ Include behind BYO key (secondary)

**What it offers.** Photos, illustrations, vectors (SVG), videos, animated GIFs — **6.3M+ assets** (Sept 2026). **The API covers images and videos only** (`image_type`: all/photo/illustration/vector; `video_type`: all/film/animation). Music/SFX and 3D models exist on the website only, not in the API. Note: Canva acquired Pixabay (Nov 2018, announced May 2019).

**API access.** Free, instant key on signup (no approval for the default tier). **~100 requests per 60 seconds**, responses required to be **cached 24 hours**, no systematic mass downloads. A separate approval-gated **"full API access"** tier unlocks `fullHDURL`/`imageURL`/`vectorURL` — without it those fields are simply absent. Attribution: not required (courtesy only, "by {user} via Pixabay").

**License safety.** Clean for AGPLv3 + commercial, with one caveat. The Pixabay Content License (since 17 Apr 2023) is permissive, not copyleft: commercial OK, no attribution, no NC, no share-alike — no AGPL interaction. Restrictions: no unaltered redistribution/resale (as stock-as-is or on merch without modification — relevant because Marketr *exports* designs), no implying endorsement, no trademark-laden commercial use, no misleading use. **Caveat: Pixabay does not guarantee model or property releases exist** for people/logos/trademarks in images — a marketing editor producing paid client campaigns should surface this as a disclaimer.

**Integration shape.** `GET https://pixabay.com/api/?key={KEY}&q=...` — **auth is a query-string `key` parameter, not a header** (server-side only; never expose client-side). Per-size URLs returned (webformatURL, largeImageURL; full-res gated behind approval). **Permanent hotlinking is explicitly not allowed** per the API docs — Pixabay expects search → download/cache → serve-yourself, structurally different from the Unsplash/Pexels hotlink pattern. **Verify against pixabay.com/api/docs before committing to an architecture.**

**One-liner.** Breadth pick for illustrations/vectors/GIFs with a permissive license, but the no-permanent-hotlinking rule forces a download-and-cache pipeline rather than the editor's current hotlink pattern, and full-res/vector URLs need separate approval — more integration work than Pexels for less marketing-relevant payoff.

**Pexels vs Pixabay — which is better for a marketing editor?** **Pexels.** (1) Curated marketing-grade photography + strong video library; (2) CDN URLs built for hotlinking, matching the editor's existing Unsplash pattern; (3) richer single-API integration (Authorization header, multiple `src` sizes, clean video file links); (4) unlimited quota free on request. Pixabay wins on breadth (vectors, illustrations, GIFs — asset types Pexels lacks) and burst limits, but withholds full-res/vector URLs behind approval and has no 3D/music in the API.

---

## 3. Openverse (WordPress Foundation) — ⛔ Skip as default; opt-in only with hard license filters

**What it offers.** Images and **audio** (music, SFX) — no video search. Aggregator of **600M+ openly-licensed works** from 45+ providers (Flickr, Wikimedia Commons, Europeana, Freesound, iNaturalist, etc.).

**API access.** Free, anonymous tier: **20 requests/min, 200/day**. OAuth2 app registration raises this to 100 req/min, 10,000/day; an "enhanced" tier (200/min, 20k/day) is available on request. **Attribution is legally mandatory for BY and SA licenses** — the API returns pre-formatted `attribution` text plus `license`, `license_url`, `creator`. **Warnings:** the ToS **reserves the right to charge fees for commercial uses** and heavy usage; Openverse **does not verify licensing status** — "you are responsible for independently verifying whether you have the right to use the content." Developers must also display "made using Openverse" trademark attribution.

**License safety.** ⚠️ **The riskiest source in this survey for the commercial tier.** The catalog mixes CC licenses including **by-nc/by-nc-sa/by-nc-nd** (non-commercial = unusable in Marketr's commercial offering), **by-nd/by-nc-nd** (no-derivatives = cannot be edited/transformed at all — a creative editor inherently remixes), and **by-sa** (share-alike = copyleft-like: incorporating BY-SA imagery into a client's distributed commercial design can encumber that design). The API **can** filter: `license_type=commercial,modification` excludes NC+ND (confirmed in Openverse GitHub issue #3264), and the safe pin is `license=by,cc0,pdm` (dropping BY-SA entirely; BY requires attribution, which the editor already carries). Even then, upstream licensing is unverified per the ToS.

**Integration shape.** `GET https://api.openverse.org/v1/images/` and `/v1/audio/` (`q`, `license`, `license_type`, `aspect_ratio`, `size`, `page_size`). Auth: anonymous or OAuth2 bearer token. Responses return third-party-hosted direct file `url` plus `foreign_landing_url` — **hotlinking is unreliable** (arbitrary third-party hosts, no CORS/hotlink guarantees); the WordPress inserter pattern is download/import into your own storage, so a server-side proxy/cache is effectively required.

**One-liner.** Mixed NC/ND/SA licensing, legally-mandatory attribution, unverified upstream licenses, unreliable third-party hotlinking, and a ToS that reserves commercial-use fees make it unsafe as a default source — if included at all, gate it behind opt-in with a hard-pinned `license=by,cc0,pdm` filter and mandatory attribution display.

---

## 4. Iconify — ✅ Include by default (no key). Best icon story in the survey.

**What it offers.** Icon **aggregator + public JSON/SVG API + search engine** (not a single icon set). **300k+ icons across 200+ open-source icon sets**: Material Design Icons, Material Symbols, Font Awesome, Bootstrap Icons, Phosphor, Lucide, Tabler, Heroicons, Remix Icon, Carbon, Fluent, Simple Icons (brands), Noto Emoji, OpenMoji, flags, and more. Also ships `@iconify-json/<prefix>` npm packages and a **self-hostable API server** (MIT-licensed).

**API access.** **Free, no API key, no account.** No published hard rate limit — it's a donated resource, so heavy/production dependence should plan for self-hosting (Docker/npm available) or the documented fallback hosts. **CORS: `Access-Control-Allow-Origin: *`** on search and SVG endpoints — direct client-side fetch works, no proxy needed. Backup hosts: `https://api.simplesvg.com`, `https://api.unisvg.com` (official components fail over automatically). No attribution required by the API itself.

**License safety.** **Per-set licensing is the central risk and it is manageable.** The API exposes each set's license (`/collections` returns a `license` field per prefix), so the picker enforces an allowlist:
- **Safe, no attribution in UI (MIT/Apache-2.0/ISC/CC0):** `mdi` (Apache-2.0), `material-symbols` (Apache-2.0), `lucide` (ISC), `tabler` (MIT), `heroicons` (MIT), `bi` (MIT), `ph` (MIT), `fluent` (MIT), `ri` (Apache-2.0), `carbon` (Apache-2.0), `devicon` (MIT), `simple-icons` (CC0 — brands), `logos` (CC0). 100k+ icons — more than enough as a default.
- **Attribution-required (CC-BY-4.0, commercial OK):** Font Awesome 6 Free, Line Awesome, IcoMoon Free. CC-BY attribution can live in an About/Legal screen or `THIRD_PARTY_LICENSES.md` — no per-export credit lines needed.
- **Exclude from any default picker:** CC-BY-SA sets (`entypo`, `arcticons`), GPL sets (`dashicons`, `gridicons`, `wordpress`, `et`), CC-BY-NC sets (`cbi`, `ps` — non-commercial is incompatible with the commercial tier outright).
- The Iconify API software is MIT, but that license does not cover the icon artwork — each set's license governs. **Bundling note:** fetching SVGs on demand and storing the sanitized body + `viewBox` in the user's document (not vendoring sets into the repo) keeps third-party art out of Marketr's own distribution — the cleanest posture for the AGPL build too.

**Integration shape.** `GET /search?query=<terms>&limit=32&prefixes=<prefix>` → `{icons, total}`; `GET /collections` → all sets with license info; `GET /{prefix}.json?icons=<n1>,<n2>` → batch icon JSON; `GET /{prefix}/{name}.svg` → ready SVG with `?color=&width=&height=&flip=&rotate=`. **Recommended pattern:** search client-side → on pick, fetch once, sanitize (strip `<script>`, event handlers, inline styles, animations; cap body size), store `prefix:name` + sanitized body + viewBox in the document. Rendering and PNG/PDF export then never touch the network. Keep the API host a single configurable constant for a self-hosting escape hatch.

**One-liner.** 300k icons, keyless, CORS-open, and the license field lets you hard-exclude every problematic set — with a permissive-only prefix allowlist, the safest icon bet in the survey.

---

## 5. Openmoji — ⛔ Skip as default (license landmine)

**What it offers.** Open-source emoji + icon set (HfG Schwäbisch Gmünd design university). **4,000+ glyphs** covering the full Unicode emoji set plus custom additions; color and black variants; SVG, PNG, color fonts. v17.0.0 (April 2026), actively maintained. Distinct hand-drawn, outline-heavy aesthetic.

**API access.** **No search API.** Free, no key. Distribution via npm package `openmoji`, jsDelivr CDN (pinnable to a version), unpkg, GitHub release zips. Also reachable through the Iconify `openmoji` prefix.

**License safety.** ⚠️ **Confirmed CC BY-SA 4.0.** (1) **Attribution is a hard requirement** everywhere the art is distributed — user-exported PNGs/PDFs containing OpenMoji would need the credit to travel with the export (metadata or an on-export license note), which is UI/UX friction on every export. (2) **ShareAlike attaches to adaptations:** per OpenMoji's own FAQ (#462), using glyphs unmodified as icons does not require releasing the app under CC BY-SA — but a design editor *invites* modification (recoloring, restyling), and any modified glyph becomes a derivative that **must stay CC BY-SA 4.0**, meaning the commercial-tier user cannot lock their own exported design proprietary. That's a real, hard-to-explain constraint for paying users. Bundling OpenMoji doesn't poison Marketr's own license (art is separate from code), but it imposes per-export attribution + derivative-share-alike obligations on *users' designs*.

**Integration shape.** No server-side search; client-side search would need a local codepoint/name JSON. Per-glyph CDN URLs are hotlinkable and jsDelivr serves CORS, so Konva can fetch SVG → sanitize → draw, or use PNG fallbacks.

**One-liner.** Iconify already hosts permissive emoji sets (Noto Emoji under Apache-2.0, Fluent Emoji under MIT) that cover the emoji use case with zero attribution and zero share-alike — Openmoji's share-alike + mandatory credit is friction a commercial design tool should not ship by default. If ever wanted, reach it through the Iconify picker, not a separate integration.

---

## 6. Google Fonts + Fontsource — ✅ Include by default (no key)

**What it offers.** ~1,600+ font families (sans, serif, display, mono, handwriting). Google Fonts = the open web-font catalog via CSS API (`fonts.googleapis.com/css2?family=…`) and a Developer API for catalog listing. Fontsource = npm packaging of open-source fonts — `@fontsource/<id>` (static weights) and `@fontsource-variable/<id>` (variable fonts) — each with ready-made `@font-face` CSS split by weight/style/subset; mirrors the full Google Fonts catalog. Also a keyless REST API (`api.fontsource.org/v1/fonts`, filterable by subsets/weights) and versioned jsDelivr CDN for stable direct file links.

**API access.** CSS API: no key, free, CORS-enabled. Developer API: requires a Google Cloud key (free, no billing). **Keyless alternative:** Google's catalog JSON at `https://fonts.google.com/metadata/fonts` (no key) or Fontsource's keyless API. Fontsource: no key anywhere (npm, API, CDN); actively maintained. **Privacy caveat:** loading fonts from Google sends every visitor's IP to Google — the Munich Regional Court (2022, 3 O 17493/20) ruled this can violate GDPR without consent. Self-hosting avoids the issue entirely.

**License safety.** Overwhelmingly safe: the majority are **SIL OFL 1.1**, some **Apache 2.0**, a few **Ubuntu Font License 1.0** (the Ubuntu family). OFL permits commercial use, embedding in apps/websites/documents, modification, redistribution **in exported PDFs/PNGs**; requirements are only keeping copyright + license text, not selling font files standalone, not redistributing modified versions under a Reserved Font Name. Industry-standard safe for embedding in commercial SaaS and user exports. Per-family check still needed (UFL terms differ slightly); restricting the picker to OFL/Apache families is the cleanest policy. Does not poison AGPL or the commercial tier. Fontsource packages carry each font's own license (mostly OFL 1.1) with license text in each package's README — auditing is mechanical.

**Integration shape (Konva).** Loading via `<link>` or self-hosted `@font-face`. **Critical Konva rule:** canvas rasterization uses whatever font is loaded *at draw time* — gate every render/export on `await document.fonts.load('700 16px "Inter"')` (or the `FontFace` API) before `stage.toDataURL()`, otherwise text silently renders in a fallback font and exports lie. PDF export: embed the font subset (OFL permits this). **Fontsource (self-hosted) beats the CSS API for this use case:** version-pinned, same-origin, offline builds, deterministic (Google updates fonts under you, shifting layouts), no GDPR IP leakage. Next.js: `import "@fontsource-variable/inter"` in the entry → fonts in the build. Granular imports keep bundle size tight. Font picker without bundling the catalog: query `api.fontsource.org/v1/fonts?subsets=latin&weights=400` keylessly at runtime, then lazy-load the chosen family (dynamic import of the npm package or CDN woff2 + `FontFace` API).

**One-liner.** OFL/Apache families are fully safe for SaaS embedding and exported designs; Fontsource npm as the primary pipeline gives version-pinned self-hosting with zero Google dependency — and always gate exports on `document.fonts.load()`.

---

## 7. 3D assets: Khronos glTF ecosystem + permissive libraries

**The sane integration shape for a 2D (Konva) editor:** Konva is 2D — 3D assets can't be nodes in the scene graph. The recommended architecture is a **3D → 2D sticker pipeline**: v1 = browse/search panels via the existing server-side proxy pattern, insert as a normal Konva image node from a **server-side render of the GLB to a transparent PNG** (headless three.js at a few preset angles the user picks in the panel — studio-quality stickers with shadows/HDRI lighting, exports trivially correct, no CORS/WebGL export pitfalls). v2 (later, opt-in) = live `<model-viewer>` overlay above the canvas, flattened to PNG on export.

### Khronos glTF-Sample-Assets — ⛔ Skip as a content library; keep as GLB test fixtures

**What it offers.** glTF itself is a format standard (glTF 2.0, ISO/IEC 12113:2022 — "the JPEG of 3D"), not an asset library. The closest thing to an official library is **KhronosGroup/glTF-Sample-Assets** — a **test suite** (~100 models: DamagedHelmet, Sponza, Fox, BoomBox…) meant to exercise renderers, not curated marketing content.

**API access.** No official asset search API. Files are fetchable from `raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/...` — no key. Predictable URL pattern for `.glb` files; hotlinking works technically but CORS/MIME is unreliable — proxy/cache server-side.

**License safety.** Collection declares **CC-BY 4.0** on most models (commercial OK, but attribution everywhere the asset appears = a friction tax). ⚠️ **License trap:** individual models carry their own terms — e.g. **Sponza is under the Cryengine Limited License Agreement** (proprietary, not usable in a commercial product). No site-wide CC0 guarantee; each model's README must be checked.

**One-liner.** Wrong shape (test assets), wrong license ergonomics (BY with per-model exceptions), zero marketing curation — but canonical GLB fixtures for building/testing the model-viewer integration.

### Poly Haven (polyhaven.org) — ✅ Include by default (no key). Best quality 3D library.

**What it offers.** ~2,000–2,500 photorealistic assets: **HDRIs (~989, up to 16–24K)**, PBR textures (~786, up to 8K), and 3D models (several hundred, scanned/VFX-grade). Quality-curated; Patreon-funded.

**API access.** Free, no key, commercial OK. Base `https://api.polyhaven.com`; OpenAPI spec at `/api-docs/swagger.json`. Endpoints: `/types`, `/assets` (filters by type/category/collection), **`/search`** (hybrid semantic + keyword, multilingual), `/info/{id}`, **`/files/{id}`** (full file tree by resolution/format — the download-URL source). Rate limits not published (429 with `Retry-After` on search). **ToS requirements:** send a unique `Referer`/user-agent identifying the app, and show a **"Powered by Poly Haven"** credit near surfaced content when building on the live API (one-line label, not a per-asset tax).

**License safety.** **All assets CC0, catalog-wide** — no attribution, no NC, no SA, commercial use permitted, redistribution allowed. Safe to bundle, serve, and ship by default in both tiers. (The API server code is AGPL — that's the API, not the assets.)

**Integration shape.** Thumbnails hotlinkable from `cdn.polyhaven.com/asset_img/thumbs/<slug>.png`; download URLs from `/files/{id}` (dl.polyhaven CDN). JSON API is browser-callable, but server-side proxy with the app's Referer/user-agent + response caching is cleaner and satisfies the ToS; cache downloaded assets in Marketr's own storage for reliability.

**One-liner.** The only source that combines CC0-catalog-wide safety + a real keyless commercial-safe search API + photorealistic quality. It beats the others for a marketing editor because: (1) license ergonomics decide — per-asset attribution and NC/SA landmines elsewhere are a legal-review tax on every client export; (2) quality matches the use case — photorealistic product mockups and HDRIs, not "game asset" low-poly; (3) actually integrable — ship it under the existing Unsplash-proxy pattern in an afternoon. **The HDRIs are the sleeper asset** — they're what make any 3D render look professional and the backbone of the server-side render pipeline.

### Quaternius (quaternius.com) — ✅ Include by default (curated bundle)

**What it offers.** Thousands of low-poly game assets by a single artist across themed packs (Ultimate Nature/Space/Modular kits, animated characters, vehicles). Many rigged + animated. glTF/GLB/FBX/OBJ/.blend. Flat, cohesive, stylized.

**API access.** None — pack-level ZIP downloads from the site (per-model GLB fetch possible via Poly Pizza).

**License safety.** **CC0, catalog-wide, no attribution** (per FAQ and pack-level `License.txt`). Safe for commercial, safe to bundle.

**Integration shape.** No API → curate-and-bundle selected packs into Marketr's storage (one-time build cost), or deep-link users to pack ZIPs.

**One-liner.** CC0 + cohesive style + animated humanoids (which Poly Haven lacks); no key; the only cost is manual curation, which fits an editor's "starter props" set.

### Poly Pizza (poly.pizza) — ✅ Include behind BYO key, with a hard CC0 + CC-BY license filter

**What it offers.** ~10,600 low-poly models — the de-facto successor to Google Poly (hosts the rescued Google Poly archive plus new uploads). Single self-contained `.glb` per model, browsable by 12 categories, animated-model flag.

**API access.** v1.1 at `api.poly.pizza` — **requires a free API key** (sign up → Settings → API; fits Marketr's BYO-key pattern). Keyword search, model-by-id, curated lists, category/license/animated filters. Unauthenticated calls return 401. Rate limits not published.

**License safety.** ⚠️ **Mixed, per-asset:** CC0, CC-BY, CC-BY-SA, CC-BY-ND, CC-BY-NC, CC-BY-NC-SA, CC-BY-NC-ND. ~69% is CC-BY (commercial OK but creator credit must be displayed and travel with the asset — a real UX cost). **A hard license filter is mandatory** — the API exposes one; safe subset is **CC0 + CC-BY only** (exclude all SA/NC variants).

**Integration shape.** Direct CDN pattern `https://static.poly.pizza/<uuid>.glb` (auth-free once the ID is known). One source notes Cloudflare bot protection can block datacenter IPs on the CDN — **proxy through the server** rather than hotlinking from the browser.

**One-liner.** Best programmatic source of lightweight stylized 3D, but per-asset license variance + bot-protected CDN + key requirement make it a gated panel, not a default.

### Kenney (kenney.nl) — ✅ Include by default (curated bundle)

**What it offers.** **40,000+ assets** — the largest cohesive low-poly kit library: City, Nature, Buildings, Vehicles, Furniture, Space, Hexagon tiles, UI, sprites, 2D + 3D. GLB/GLTF + OBJ + FBX per kit. Coherent flat/soft art direction — the most "marketing-illustration-ready" style of the three.

**API access.** None — no search API, no key. Direct per-pack ZIP download links (also mirrored on itch.io).

**License safety.** **Site-wide CC0, no attribution required** (only restriction: don't use the Kenney logo as endorsement). Safe for commercial, safe to bundle.

**Integration shape.** No API → curate-and-bundle a starter set of kits (City/Nature/Vehicles/Space) into Marketr's own storage. A self-hosted index is possible later (asset manifests are downloadable).

**One-liner.** 40k CC0 assets, marketing-illustration-ready style, zero licensing overhead; curation is a one-time build cost.

### Sketchfab — ⛔ Skip for now

**What it offers.** The largest 3D model platform: 6M+ users, **over 1 million free models, 700,000+ downloadable under Creative Commons** (glTF/GLB/USDZ via API; source formats not exposed via API). Mix of photorealistic and stylized, wildly variable quality. ⚠️ **Ownership change:** Epic sold Sketchfab (and ArtStation) to **KitBash3D in August 2026** — new owner, new risk; terms and API policy may shift.

**API access.** Data API: free, app registration required. **Download API: requires end-user OAuth login inside your app** — Sketchfab's own guidelines: *"end-users must be able to log in or create a Sketchfab account inside your application."* This is **not BYO-key compatible** — it needs an OAuth app + per-user login flow, which doesn't fit the Unsplash server-proxy pattern at all.

**License safety.** 🔴 **Per-model license mix includes NC and SA — default search returns NonCommercial and NoDerivatives models as downloadable** (documented license contamination). Most downloadable models are CC-BY (commercial OK, attribution required). **Attribution follows the asset everywhere it is used** — including in derivative works distributed to end users, meaning a Marketr-exported marketing design would need visible creator credit. NC models are the exact license poison the commercial tier must avoid.

**One-liner.** OAuth-per-user is incompatible with the server-proxy BYO-key architecture; per-model license contamination is the highest of any source surveyed; attribution-follows-asset clashes with editor exports; the KitBash3D acquisition adds fresh policy uncertainty. Revisit only if terms stabilize AND a CC0/CC-BY-only filter with mandatory credit display is built.

### 3D recommendation summary

**Best "quality 3D library" pick: Poly Haven.** Pair it with a curated Kenney/Quaternius bundle (default, stylized illustration props) — together they cover ~90% of marketing-editor 3D needs with zero keys and zero license risk. Poly Pizza sits behind BYO key for long-tail stylized search. Khronos samples = test fixtures only. Sketchfab stays out.

---

## 8. Cloudinary — ✅ Include behind BYO key — as the upload pipeline, not a stock tab

**What it offers.** **Not a stock source.** Media hosting/DAM + on-the-fly transformations: resize, crop, format conversion, optimization, AI background removal, video transcoding, global CDN, delivery URLs. No built-in stock library (enterprise Getty Images integration is a paid add-on).

**API access.** Free tier = **25 credits/month, no credit card**. Credit model: 1 credit = 1,000 transformations **or** 1 GB storage **or** 1 GB image bandwidth (single shared pool; video bandwidth costs more and is paid-plan-only for extra). Plus plan: $99/month (225 credits). Auth: `cloud_name` + `api_key` + `api_secret`; backend SDKs for signed uploads, or **unsigned uploads from the browser via an upload preset** (cloud name only, no secret exposed).

**License safety.** N/A — you host only assets the user provides or uploads. No third-party content licensing; nothing interacts with AGPL or the commercial tier. It's the user's own Cloudinary account and quota.

**Integration shape.** Upload API (signed server-side; unsigned via preset client-side); delivery at `https://res.cloudinary.com/<cloud>/image/upload/<transforms>/<public_id>` — **hotlinking is the design intent** (it *is* the CDN). Transformations are URL parameters: `w_400,h_300,c_crop`, `f_auto,q_auto`, `e_background_removal`. Official `next-cloudinary` package exists. Browser uploads supported via widget/unsigned preset; delivery URLs are plain hotlinkable HTTPS.

**One-liner.** Cloudinary is not stock media at all — its fit is the upload pipeline (user uploads → signed server upload → on-the-fly transforms for thumbnails, auto-format/quality, background removal → CDN delivery), complementary to the stock-search tabs. This is the "uploads that don't suck" answer to Polotno's DIY base64-in-JSON demo panel.

---

## 9. Bonus APIs/connectors

| Source | Verdict | One-liner |
|---|---|---|
| **Brandfetch** | ✅ BYO key | Domain → logo/palette/fonts → brand kit in one click. The agency onboarding moment. Ship with provenance + trademark warnings in the UI (third-party logos carry trademark/fair-use restrictions). |
| **Colormind** | ✅ Default, keyless — verify ToS first | AI palette generation, "generate a palette around our brand color." One afternoon of integration; **confirm production/commercial terms before shipping**. |
| **Transparent Textures** | ✅ Include (hotlinkable) | Pattern fills and backgrounds at near-zero effort. License-page evidence is thin — fall back to **ambientCG** (clearly CC0) if the check doesn't clear. |
| **Lorem Picsum** | Placeholder mode only | Wireframes/template previews; keeps templates looking designed before the user adds assets. Not a production stock library: no keyword search, fragile for permanent designs. |
| **remove.bg** | Optional BYO-key fallback | Paid-quality background removal (50 free API calls/mo) for hard cases (hair, product edges). Marketr already ships free client-side removal — honest fallback, not a default. |
| **Replicate (Real-ESRGAN)** | ✅ BYO key | Pay-per-use upscaling (~$0.0023/image) = the "make this print-ready" button. Record each model's license terms. Doubles as the general model escape hatch (GFPGAN faces, etc.) without GPU infra. |
| **unDraw / ManyPixels** | ⛔ Skip as integrated libraries | Commercial-OK for end use, but both 2026 licenses explicitly discourage compiling/searching/embedding the library in an app without consent. Users can upload their own; do not bundle. |
| **Mediamodifier** | BYO key, phase 2 | Paid mockup-rendering API; generated images can reportedly be cached. Real marketer need, but paid — ship 20 built-in SVG device frames first (~80% of the value at $0). |
| **Huemint** | ⛔ Do not include | Public API historically non-commercial. No written commercial rights = no inclusion. Colormind fills the palette-generation slot. |

---

## 10. Verdict table

| Source | Verdict | Rationale |
|---|---|---|
| Pexels | BYO key | Permissive license, hotlink-friendly CDN, curated photos+video; natural second stock panel |
| Pixabay | BYO key (secondary) | Breadth (vectors/illustrations/GIFs); no-permanent-hotlinking forces cache pipeline; full-res gated |
| Openverse | Skip default / opt-in filtered | NC/ND/SA license mix, mandatory attribution, unverified upstream licensing, reserved commercial fees |
| Iconify | **Default, no key** | 300k icons keyless CORS-open; permissive-only prefix allowlist enforced in code |
| Openmoji | Skip as default | CC BY-SA: per-export attribution + derivative share-alike on modified glyphs |
| Google Fonts | **Default, no key** | OFL/Apache families safe; serve self-hosted |
| Fontsource | **Default, no key** | Primary font pipeline: version-pinned npm self-hosting, keyless catalog API |
| Poly Haven (CC0) | **Default, no key** | Photorealistic HDRIs/textures/models, keyless search API, CC0 catalog-wide; "Powered by Poly Haven" credit line in panel |
| Quaternius (CC0) | Default (curated bundle) | Low-poly stylized assets, animated humanoids, CC0; no API — curate-and-bundle packs |
| Kenney (CC0) | Default (curated bundle) | 40k cohesive low-poly kits, site-wide CC0; no API — curate-and-bundle starter kits |
| Poly Pizza | BYO key, CC0+CC-BY filter | ~10.6k low-poly models; mixed per-asset licenses — hard filter mandatory |
| Khronos glTF-Sample-Assets | Skip as content library | Renderer test suite (~100 models), CC-BY with a Cryengine-licensed poison model (Sponza); keep as GLB test fixtures |
| Sketchfab | Skip for now | Per-user OAuth (not BYO-key compatible), NC/SA license contamination, KitBash3D acquisition adds policy risk |
| Cloudinary | BYO key — pipeline, not stock | Upload pipeline: signed uploads, auto-optimize/transform, CDN delivery |
| Brandfetch | BYO key | Domain → logo/palette/fonts → brand kit; provenance + trademark warnings |
| Colormind | Default, keyless | Palette generation; verify commercial ToS before shipping |
| Transparent Textures | Include (hotlinkable) | Pattern fills/backgrounds; confirm license or fall back to ambientCG |
| Lorem Picsum | Placeholder mode only | Wireframes/template previews; not a production stock library |
| remove.bg | Optional BYO-key fallback | Paid-quality alternative to built-in free removal for hard cases |
| Replicate/Real-ESRGAN | BYO key | Print-ready upscaling + general model escape hatch; record per-model licenses |
| unDraw / ManyPixels | Skip as integrated libraries | Licenses bar app embedding; users upload their own |
| Mediamodifier | BYO key, phase 2 | Mockups-as-a-service; built-in SVG device frames first |
| Huemint | Do not include | Free API non-commercial only |

---

## 11. Top three licensing landmines

1. **Openmoji CC BY-SA 4.0 share-alike.** Modified glyphs in user exports must stay BY-SA — a commercial-tier user couldn't lock their own design proprietary. Quarantine or skip; Iconify's Noto/Fluent emoji sets cover the use case permissively.
2. **Openverse mixed CC aggregation.** NC licenses unusable commercially, ND licenses unusable in an editor at all (fatal — an editor inherently remixes), BY-SA is copyleft-like on client work. If ever included: hard-pinned `license=by,cc0,pdm` filter, mandatory attribution display, opt-in only.
3. **unDraw/ManyPixels "no app embedding" clauses.** Commercial-OK for end use but both 2026 licenses discourage compiling/searching/embedding the library in an app without consent — don't bundle, don't build a live integration, users upload their own.

Cross-cutting: none of Pexels/Pixabay/Openverse content licenses are software copyleft, so none "poison" the AGPLv3 codebase itself — the risk sits in the *commercial tier's use of assets*: NC licenses and share-alike BY-SA are the two real hazards; BY-SA is the only one with copyleft-like properties.

---

## 12. Recommended integration build order

1. **Iconify (default, no key) + Google Fonts/Fontsource self-hosted** — one week, erases the two thinnest parts of the editor.
2. **Pexels behind the existing BYO panel** (same route pattern as Unsplash).
3. **Brandfetch brand-kit autofill (BYO key)** — the agency onboarding moment.
4. **Cloudinary upload pipeline.**
5. **Pixabay (cached-download variant of the panel) + Colormind + Transparent Textures.**
6. **Replicate upscaler (BYO key) + remove.bg fallback.**
7. **Poly Haven curated 3D stills gallery.**
8. **Mockup SVG frames → Mediamodifier later.**
9. **Template packs** (runs in parallel from step 1 — it's design work, not engineering).
10. **Server-side render API (JSON → PNG)** — the strategic compounding asset; spec it now, build after the asset story is in.

---

## 13. Proposed common asset-provider contract (modeled on the Unsplash integration)

```ts
AssetProvider {
  id: string;                    // "pexels", "iconify", ...
  kind: "photo" | "video" | "icon" | "font" | "texture" | "pipeline" | "ai";
  auth: "none" | "byo-key" | "oauth";
  search(params): Promise<AssetResult[]>;     // server route; never leaks keys client-side
  status(): Promise<{ configured: boolean }>; // honest unconfigured state
  licensePolicy: "permissive-allowlist" | "byo-filtered" | "attribution-carried";
}

AssetResult {
  id: string;
  providerId: string;
  thumbUrl: string; previewUrl: string; fullUrl: string;  // sized variants; hotlinkable or proxied
  width: number; height: number; duration?: number; mimeType: string;
  license: string;                     // per-asset license string
  attribution: { author?: string; authorUrl?: string; sourceName: string; sourceUrl: string };
  requiresAttribution: boolean;
  commercialSafe: boolean;             // computed from licensePolicy
}
```

Rules carried over from the Unsplash pattern: server-side keys only; search and status routes; honest unconfigured state; no fake results; attribution/provenance travels in the design element's `custom` metadata (source, author, license, asset id); clicking a result inserts it through the existing factories. Additions this survey forces: per-provider license allowlists enforced at the picker (Iconify prefixes, Openverse `license=` pin), a `commercialSafe` flag that gates what the white-label tier will insert, and an on-export license manifest for anything attribution-required.

---

## 14. Strategy: how Canvas wins — flexible, creative, valuable vs Polotno and Canva

Tico's full question: *"how to make the editor more flexible, creative, and valuable for the market we are targeting, and to compete with Polotno and Canva."*

### Who we're actually serving

Not "design-tool users" in the abstract. Three specific buyers:

1. **Marketing agencies** (white-label is a paid Marketr tier). They produce client deliverables at volume. Their pains: per-seat pricing that scales against them, clients who break brand guidelines, approval ping-pong over email, and producing 50 ad variants by hand.
2. **Founders/SMBs doing their own marketing.** They are not designers. Their metric is *time-to-first-good-design*: minutes from "I need a launch graphic" to something they'd actually post. Every blank canvas is a failure.
3. **Open-source self-hosters.** They chose Marketr because nothing phones home, no license key, data stays in their infra. They will self-host the editor as infrastructure and extend it.

Our invariants are non-negotiable and they are *also* the strategy: $0 core, no license key, AGPLv3 + commercial, the editor lives **inside** the marketing workflow (campaigns, brand kits, GrowthOS — not a standalone toy), AI-native variant generation, and it never auto-publishes.

### What flexibility, creativity, and value mean for THESE users

**Flexibility** does not mean a plugin API for developers — that's Polotno's game and we'd lose it. For our users, flexibility means:
- **Template variables at scale.** The agency doesn't want a better canvas; it wants "generate 100 on-brand ad variants from this brief" as a button. Flexibility = the design is *data*, addressable by automation. JSON-first documents, API-driven rendering (POST JSON → PNG), and batch generation are worth more than any panel.
- **Brand tokens that flow.** Paste a client domain → logo, colors, fonts land in the brand kit → every template and AI generation obeys them. Flexibility = the editor adapts to the *client*, not the other way around.
- **Share/review as infrastructure.** The approval loop (share link → comment → approve) is already built. Flexibility = that loop gets deeper (client portals, version compare) instead of the canvas getting wider.

**Creativity** does not mean more filters. For marketers, creativity is *generative depth at the moment of need*:
- The right stock photo, icon, illustration, texture, or font *right now*, without leaving the editor and without a second subscription.
- Effects that sell: mockups (the ad looks real), shadows/depth, charts and QR (already shipped — exactly the right instinct), textures that make a flat design feel designed.
- AI that is brand-aware: "10 variants in *our* voice, *our* colors" beats "10 generic variants" every time.

**Value** = time-to-first-good-design + brand governance + cost. Agencies will pay for the white-label tier when the editor *keeps clients on-brand* and *kills the approval thread*. Founders stay when the first design takes 3 minutes and costs $0. Self-hosters stay when it runs on their box with no key.

### Where Polotno is weak (our attack surface)

| Polotno's weakness | Our move |
|---|---|
| $899/mo, key-gated, credit backlink | $0, no key, no phone-home. Say it on every page. This alone wins the long tail of freelancers and small agencies. |
| No real-time collaboration, no comments/approvals | We already ship share links + comments + approvals. Deepen it: client review portal, version compare. This is an agency moat Canva charges for and Polotno lacks entirely. |
| Uploads are DIY (base64-in-JSON demo panel; production is the customer's problem) | First-class upload pipeline (Cloudinary or direct-to-R2 with signed URLs, auto-optimize, downscale). "Uploads that don't suck" is a genuine differentiator. |
| Templates are BYO — the engine ships, curation is your problem | Ship 200–500 genuinely good *marketing* templates (ads, social, email headers, landing sections). We will never match Canva's millions; we don't need to. We need the 500 templates that cover 95% of marketing jobs. |
| AI is metered add-ons ($0.03/background removal) | Background removal included free (done). AI variant generation brand-aware and batch-first, not a metered side panel. |

We do **not** need to beat their video timeline, MP4 export, or print CMYK depth. That's their expensive moat and not where our users' money is. Static creative is the volume game.

### Where Canva's moat is (flank, don't confront)

Canva wins on template volume, stock breadth, collaboration polish, and brand kit. A head-on fight is suicide. The flanks:

1. **Brand governance deeper than Canva's.** Canva's brand kit is Pro-gated and shallow (colors, fonts, logos). Ours can be *enforced*: lock the logo position, restrict to approved fonts, warn when a color drifts off-palette, per-client kits on the white-label tier. Position: "the editor that keeps clients on-brand" — unclaimed.
2. **Workflow integration Canva can't copy.** Canva designs are dead artifacts. Ours are born inside Marketr: linked to campaigns, briefs, brand kits, and (via GrowthOS) to performance data. "Designs that know what they're for" — the variant that won gets regenerated, the loser gets killed. Canva will never be inside your marketing OS.
3. **Batch AI generation, brand-aware.** Canva's Magic Studio is generic prompt-to-design. Ours: one brief → 100 variants → in *your* brand → human approves. That's the GrowthOS weapon, and it's a workflow Canva's consumer-shaped product won't build.
4. **White-label + self-host.** Canva cannot be embedded in an agency's client portal under the agency's brand on the agency's servers. We can. That's the paid tier.
5. **Cost.** $0 core vs per-seat SaaS. For a 20-person agency the math is brutal and we should put a calculator on the pricing page.

### How each surveyed integration maps to the fight

- **Pexels + Pixabay (BYO key, same panel pattern):** stock breadth flank vs Canva. Video, not just photos — Canva's stock video is paywalled; ours is a free key. Medium leverage, trivial effort (the panel pattern exists).
- **Openverse:** keyless, but mixed CC licenses including NC. Unsafe as a default source; a license-filtered fallback at best. Low leverage — skip unless the filter story is airtight.
- **Iconify (default, no key):** kills our "24 original icons" thinness overnight. Icons are high-frequency touches in marketing design. High leverage, low effort — best default icon story in the survey.
- **Openmoji (CC-BY-SA 4.0):** share-alike is the landmine — every exported design containing an Openmoji glyph arguably inherits share-alike obligations. Do not bundle as default; quarantine or skip.
- **Google Fonts + Fontsource (self-hosted):** typography is the single biggest quality signal in a design. Brand fonts that travel with the template. Low effort, high perceived quality. Include by default.
- **Poly Haven CC0 (3D/HDRI/textures):** the differentiator neither Canva nor Polotno does well — 3D hero stills for ads, product shots on HDRI lighting. Medium effort (server-side render to PNG), high "wow per effort."
- **Cloudinary:** the upload-pipeline answer (signed uploads, auto-optimize, on-the-fly transforms). Replaces base64-in-JSON. Infrastructure leverage; also unlocks responsive variants for the share pages.
- **Brandfetch (BYO key):** domain → logo/colors/fonts → brand kit in one click. This is the agency-onboarding killer feature. Highest value-per-effort in the entire survey.
- **Colormind (keyless):** AI palette generation with zero integration cost. "Generate a palette around our brand color" in the brand panel. Near-free creativity depth.
- **Transparent Textures (hotlinkable, permissive):** pattern fills and backgrounds. Near-zero effort, real texture depth.
- **Lorem Picsum (keyless):** placeholders for wireframes and template previews. Keeps templates looking designed before the user adds assets.
- **remove.bg (BYO key, 50 free/mo):** quality alternative to the built-in free remover for hard cases (hair, product edges). Optional, honest fallback.
- **Replicate (BYO key, pay-per-use):** Real-ESRGAN upscaling at ~$0.0023/image — "make this print-ready" button. Also the escape hatch for any future model (GFPGAN faces, etc.) without building infra.
- **unDraw / ManyPixels:** commercial-OK, no attribution — but both licenses explicitly discourage "adding them in an app." Do not bundle, do not build a live integration; users can upload their own. Noted and skipped deliberately.
- **Mediamodifier (paid API):** mockups-as-a-service. Real marketer need, but paid and BYO — phase 2. (Cheaper alternative: ship 20 built-in device frames as SVG; 80% of the value, $0.)

### Ranked top 10 moves (value to target market per unit effort)

1. **Brandfetch brand-kit autofill (BYO key).** Paste domain → logo, palette, fonts. The agency onboarding moment. Nothing else in this list has this ratio.
2. **Server-side/API-driven rendering (JSON → PNG endpoint).** Turns every template into an automation primitive: n8n nodes, GrowthOS batch loops, "regenerate the winners nightly." This is the strategic asset the whole company compounds on.
3. **Iconify as the default icon library.** No key, thousands of icons, one panel. Erases the thinnest part of the editor in a week.
4. **Google Fonts + Fontsource self-hosted.** Typography quality + brand fonts that survive export. Cheap, visible, permanent.
5. **Curated marketing template packs (200–500).** The only honest answer to Canva's template moat: not volume, but the *right* templates for marketing jobs. Design-heavy, so it runs in parallel with engineering.
6. **Pexels + Pixabay video/stock behind the existing BYO panel.** Same code pattern, new sources, video included. Flanks Canva's paywalled stock video.
7. **Cloudinary upload pipeline.** Kills base64-in-JSON, auto-optimizes, enables responsive share pages. The "uploads that don't suck" differentiator vs Polotno's DIY story.
8. **Poly Haven CC0 3D stills (server-rendered PNGs).** The wow factor neither competitor does: 3D product/hero renders inside a 2D editor. Start with a curated stills gallery, not a 3D viewport.
9. **Mockup frames (built-in SVG device frames first, Mediamodifier later).** Marketers live on mockups. Built-in frames capture most of the value at $0; the API waits for demand.
10. **Colormind palette generation + Transparent Textures in the brand panel.** Two keyless integrations, one afternoon each, permanent creativity depth.

Deliberately **not** in the top 10: Openverse (license risk), Openmoji (share-alike), unDraw/ManyPixels bundling (license bars app embedding), Huemint (free API is non-commercial only), video timeline/MP4 (expensive, wrong battle), print CMYK (later, if the print lane proves out).

---

## 15. Open items before build

1. **Pixabay:** confirm the permanent-hotlinking clause and the "full API access" (fullHDURL/imageURL/vectorURL) approval process against pixabay.com/api/docs. (Unreachable from the research environment.)
2. **Colormind:** verify current production/commercial terms of service before shipping in the commercial tier.
3. **Transparent Textures:** confirm the official license page; fall back to ambientCG (CC0) if it doesn't clear.
4. **Poly Pizza (BYO key):** enforce the CC0 + CC-BY license filter server-side; store creator credit in the node's metadata for CC-BY assets.
5. **Openverse (if ever considered):** hard-pin `license=by,cc0,pdm`, mandatory attribution display, opt-in only.
6. **remove.bg / Replicate / Mediamodifier:** record per-model, per-plan terms and meter usage per tenant per Marketr's metering invariants.

*End of brief. Nothing in this document authorizes a build — Tico approves a specific integration specification first.*
