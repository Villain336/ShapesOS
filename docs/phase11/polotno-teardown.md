# Polotno Teardown — Research for Marketr Phase 11/12 Creative Editor

**Date:** 2026-09-27 · **Author:** Z7 research subagent
**Purpose:** Inform the build of a Polotno-class creative editor inside Marketr (Next.js marketing SaaS). **No code written.**
**Method:** Web search + fetches of polotno.com docs (incl. machine-readable `/pricing.md`, `/llms.txt`), official `polotno-project/skills` capability map (SKILL.md + capabilities.md, last updated ~Sep 2026), Konva/react-konva READMEs, and third-party comparison write-ups (Templated.io, Medium, Oct–Dec 2025).

> **Important correction to the standing assumption:** the `polotno` npm package is **not** MIT-licensed open source. Konva's own docs describe Polotno as a *"commercial design editor SDK built on Konva by the Konva maintainers"* (`npm install polotno`). The package is publicly installable and dev-usable with a free API key (60-day trial, credit backlink), but production use requires a paid license (see §2.6). Truly MIT parts of the ecosystem are Konva/react-konva themselves plus Polotno's sidecar repos (`render-tag`, `skills`, `polotno-ai-rules`, `n8n-nodes-polotno-studio`, `polotno-next` starter). Details in §2.7.

---

## 1. Product Overview

**Polotno** (polotno.com) is a white-label, embeddable, Canva-like **canvas design editor SDK** for React, aimed at businesses that need design-tool functionality *inside their own product* — not at end users directly. Its customers: SaaS products, web-to-print, e-commerce, AI startups, real estate, DAMs, CRM/MarTech, digital signage. Claimed traction: 200+ businesses, 100,000+ creators. It also runs **Polotno Studio** (studio.polotno.com), a free web editor built on the same SDK — essentially the demo/reference implementation, and the template/design lab.

### 1.1 UI layout (the canonical editor chrome)

The official SDK composes the editor from five replaceable components:

```
<PolotnoContainer>
  <SidePanelWrap>   ← <SidePanel store>            (left icon rail + tab panels)
  <WorkspaceWrap>
    <Toolbar store>                              (top toolbar, contextual)
    <Workspace store>                            (center canvas area)
    <ZoomButtons store>                          (bottom-right zoom controls)
    <PagesTimeline store>                        (bottom page strip)
```

- **Left rail: icon-tab side panel** — the Canva-familiar pattern. Tabs open panels. Default sections: **Templates, Text, Photos, Elements/Figures, Icons, Uploads, Videos, Backgrounds, Layers, Resize**; hidden built-in panels (`effects`, `animation`, `image-clip`) open programmatically via `store.openSidePanel(name)`. Sections are composable: `sections = [...DEFAULT_SECTIONS, { name, Tab, Panel }]`, `SectionTab`, `defaultSection` config. In Polotno 4 the panel UI is Polotno's own design system (Blueprint.js was deprecated in v4); theming via CSS variables (`--primary`, `--radius`, `--pn-*` scoping), dark mode, prebuilt themes, `setIcons()` to swap every editor icon, and `polotno/primitives` (Button, Input, Popover…) for building matching custom UI.
- **Top toolbar** — contextual per selected element type: font family/size/color, bold/italic/underline, alignment, spacing, flip, opacity, shadow, filters, crop, effects, z-order, align/distribute, group/ungroup, lock, delete, duplicate. Override/add per-element-type controls via the `components` prop.
- **Center canvas** — Konva stage with the active page; grey workspace background, page as a white "sheet" with drop shadow (print-sheet metaphor, same as Canva). Snapping guides, rulers, distance guides, selection rectangle, transformer (rotate/resize handles) are all style-configurable via `Workspace` props.
- **Bottom: PagesTimeline** — horizontal filmstrip of page thumbnails (add/clone/reorder/delete/duplicate per page). Not customizable — remove and build your own if needed.
- **Floating tooltip** — quick actions on selection (duplicate, delete, layers forward/backward).

### 1.2 Template system

Templates are just **serialized design JSON** (`store.toJSON()` ⇄ `store.loadJSON(json)`, current `schemaVersion: 4`). The canonical pattern: save a design JSON as a template, render its preview server-side (polotno-node or Cloud Render API), list previews in a custom side-panel grid (`ImagesGrid` + `useInfiniteAPI` can back the list from your own backend), and `loadJSON()` on click. Template *variables* (data-driven rendering) and batch rendering are core to the "design automation" story: templates + variables + programmatic rendering = programmatic image generation at scale. `@polotno/schema` validates/normalizes designs **without the editor** (DOM-free — works in servers, edge functions, LLM pipelines), including a published `design.schema.json` usable as an **LLM structured-output schema**, so an LLM can emit valid design JSON directly.

### 1.3 Brand features

- **Global fonts** (`addGlobalFont`) — app-wide brand fonts injected once, available in every design; distinct from *design fonts* (fonts embedded in a single JSON template).
- **Google Fonts built in** (list customizable), custom font upload config.
- **Color presets** config, custom side-panel asset libraries (point `ImagesGrid`/`useInfiniteAPI` at your own DAM/brand library), `setIcons()` for brand-consistent UI.
- Locking model doubles as brand guardrails (see §3).

### 1.4 Export options

| Format | API | Notes |
|---|---|---|
| PNG / JPEG | `toDataURL()`, `toBlob()` (faster), `saveAsImage()` | `pixelRatio` for hi-res, `pageId` for single page |
| PDF | `toPDFDataURL()`, `saveAsPDF()` | dpi control, **CMYK**, print **bleed + crop marks**, unit selection (px/pt/mm/cm/in) |
| GIF | `toGIFDataURL()`, `saveAsGIF()` | animated export, FPS control |
| MP4 | video export (timeline, `duration` per page) | audio tracks mixed in (`store.addAudio({src, volume, delay, startTime, endTime})`) |
| SVG | `@polotno/svg-export` package (extracted in v4) | vector output |
| HTML | `@polotno/html-export` package | design → web page |
| PPTX | PowerPoint export | decks from designs |
| JSON | `store.toJSON()` / `loadJSON()` | the canonical save/share/template format |

Export contract: `await store.waitLoading()` first (fonts + images may still be loading), then export. Server-side equivalents: **polotno-node** (headless Node render, puppeteer-based; `createInstance({key})`, `jsonToImageBase64(json)`, `instance.run()` for arbitrary store code; structured error codes like `IMAGE_FAILED`, `FONT_FAILED`, `DESIGN_INVALID`) or the **Cloud Render API** (managed HTTP rendering to image/GIF/PDF/MP4, batch-friendly).

### 1.5 What it does, in one paragraph

Drag-and-drop, multi-page canvas design editing with rich text, images, shapes, icons, video, and tables; full element styling (shadows, filters, blend modes, gradients, pattern fills, masks/crops); animation system (enter/exit/loop effects, timeline, MP4/GIF export); print-grade export (CMYK, bleed, crop marks); JSON-native designs for templates, data-driven generation, and server-side rendering; fully skinnable white-label UI with custom side panels. Plus a growing AI layer: AI image background removal ($0.03/removal, cloud API) and AI text generation (paid add-ons).

### 1.6 Pricing (current, from polotno.com/pricing.md — machine-readable, canonical)

- **Self-serve license: $899/month or $9,990/year (~$832/mo)** — unlimited usage on a single domain under one brand family; additional domains/brands = add-ons. Includes standard commercial agreement, public support SLA, self-managed upgrades, self-hosted editing + rendering. **Not** included: security/compliance alignment, roadmap influence, source code license. Paid add-ons (separate): Cloud Render API, AI background removal, AI text generation, custom dev services.
- **Enterprise: custom** — multi-domain/brand, version pinning, procurement-ready contract, defined support + escalation, liability coverage, security/compliance alignment, roadmap influence, *optional source-code license*.
- **Grass Roots program:** up to 90% discount for bootstrapped small teams.
- **Free trial:** 60 days on a private dev server, no credit card; upgrade required at 60 days or when moving to production.
- Legacy tiers reported in 2025–early-2026 comparisons ($199/mo Team ≤10 employees / 10k editor loads; $399/mo Business, unlimited loads) appear superseded by the current $899 flat model. Metered cloud costs separately: ~$0.004/image render via Cloud Render API, ~$0.03/background removal.
- The API key is obtained at polotno.com/cabinet and passed to `createStore({ key })`; `showCredit: true` keeps the "Made with Polotno" backlink (removable on paid license; docs ask you to keep it anyway for project support).

### 1.7 License & package map — verified OSS vs commercial

| Package | What it is | License / terms | Verified via |
|---|---|---|---|
| `polotno` (npm) | The editor SDK: store + React UI + canvas | **Commercial. Publicly installable; production use requires paid API-key license ($899/mo self-serve).** Konva docs call it a "commercial design editor SDK". Free 60-day dev trial with credit backlink. | konvajs.org docs; polotno.com docs overview; pricing.md |
| `polotno-node` | Headless Node renderer (puppeteer-based) | **Requires API key** — tied to the commercial license; not a free OSS package | npm/socket.dev docs (`createInstance({ key })` mandatory) |
| `@polotno/schema` | DOM-free design validation/normalization + TS types + JSON schema | Companion utility package (license not separately verified; treat as part of the SDK) | polotno skills capability map |
| `@polotno/svg-export`, `@polotno/html-export` | Export-format packages extracted from the core in v4 | Part of SDK family; license not separately verified | polotno skills SKILL.md |
| `konva`, `react-konva` (npm) | Underlying 2D canvas engine + React bindings, same team (Anton Lavrenov) | **MIT** — free for commercial use | konvajs.org "Key Facts" table |
| `polotno-project/render-tag` | HTML+CSS → canvas-2D rich-text renderer | **MIT** | repo README ("License: MIT") |
| `polotno-project/skills`, `polotno-ai-rules`, `polotno-next` (starter), `n8n-nodes-polotno-studio` | Agent skills, AI rules, Next.js starter, n8n nodes | **MIT** | repo READMEs |
| Polotno Cloud Render API, AI background remover, AI text gen | Metered cloud services | **Paid add-ons** (~$0.004/render, $0.03/removal) | pricing.md; Templated.io comparisons |

**Bottom line for Marketr:** there is no MIT "Polotno core" to embed for free. The realistic options are (a) license the SDK ($899/mo self-serve, or Grass Roots discount), or (b) build on the genuinely MIT layer — Konva + react-konva — and re-implement the editor shell ourselves, possibly borrowing *patterns* (and the MIT sidecars) from Polotno. That is also exactly why Polotno is the right teardown reference rather than a drop-in dependency: its architecture is proven, but its price point and key-gating are a strategic wedge for an open alternative.

---

## 2. Architecture Deep Dive

### 2.1 Canvas engine: Konva + react-konva

Polotno is the editor layer; Konva is the renderer. Konva's scene graph: **Stage** (root, one per canvas area) → **Layer** (each its own `<canvas>` + hit-detection canvas) → Group → Shape (Rect, Circle, Text, Image, Path, Star, Arrow, TextPath…). react-konva binds these to React components. Each Polotno element type maps to a Konva node rendered by a dedicated React component (`<TextElement>`, `<ImageElement>`, etc.), which is why custom element types are implementable as new React components.

### 2.2 Store model: store → pages → elements (MobX-State-Tree)

- `createStore()` → `store.addPage()` → `page.addElement({ type, ... })`. Everything is an MST (mobx-state-tree) node tree; all reads are plain property access (`element.x`); **all writes go through `set`** (`element.set({ x: 100 })`) — the same for pages and store-level settings.
- **Element types:** `text`, `image`, `svg`, `figure` (shapes via `subType`: rect, circle, star…), `line`, `video`, `gif`, `table`, `group`. Groups are MST subtrees and can own animations in v4.
- **App data escapes the schema via `custom`:** arbitrary props are silently ignored by the model — `element.set({ custom: { myId: '12' } })`, read back as `element.custom?.myId`. This is the sanctioned extension point for host-app metadata (campaign IDs, asset IDs, analytics tags…).
- **Reactivity:** MobX; any React component reading store/element state must be wrapped in `observer()` from `mobx-react-lite`. MST gotcha the docs call out: a computed view touching `getParent` must check `isAlive(self)` first (MST destroys nodes synchronously, React unmounts async).
- **Roles:** `store.setRole('user' | 'admin' | 'viewer')` — built-in read-only/viewer and admin modes.
- **Tools:** `store.setTool('draw')` — freehand drawing with stroke options.
- **UI state lives in the store too:** open side panels, zoom (`setScale`), rulers, bleed, distance guides — so the whole editor chrome is serializable/scriptable state.

### 2.3 JSON serialization format

Every design is plain, readable JSON — the **Polotno Design Format**, currently **schemaVersion 4**: `{ schemaVersion, pages: [ { id, width, height, background, duration, bleed, children: [ elements… ] } ] }`. Elements carry geometry (`x, y, width, height, rotation, opacity`), type-specific props (`text`, `fontFamily`, `src`, `cropX/Y/Width/Height`, `clipSrc`, `subType`, …), and `custom`. This JSON is simultaneously the save format, the template format, the server-render input (polotno-node / Cloud Render), and the LLM output target (publishable `design.schema.json` for structured output).

### 2.4 Undo/redo

`store.history.undo()` / `redo()`, `canUndo` / `canRedo`. History is an MST-level snapshot system (Polotno maintains an undo stack over store snapshots — the standard MST undo middleware pattern). Third-party forks advertise a "history timeline panel" UI built on the same history API.

### 2.5 Selection & transformer model

Single/multi selection (`selectedElements`, `selectElements`, `getElementById`, `deleteElements`), grouping/ungrouping, z-order ops, and the Konva `Transformer` for rotate/resize (uniform vs free resize). Alignment/distribution, spacing, and snap-to-grid/snapping guides come free from the Konva layer and are styled via `Workspace` props. Smart extras: select-by-type/color/font, copy/paste style ("paint format"), clipboard image paste (Ctrl+V).

### 2.6 Zoom / pan

Store-driven (`store.setScale(...)`), with a dedicated `ZoomButtons` component and keyboard/mouse-wheel handling in `Workspace`. Fit-to-screen, percentage zoom, and page-level navigation in the pages timeline.

### 2.7 Font loading

Google Fonts list is built in and customizable; `addGlobalFont` registers host fonts once for the whole app vs per-design fonts embedded in JSON. **Export discipline:** `await store.waitLoading()` before any export — fonts and images load async and the export would otherwise rasterize fallback glyphs. Server-side rendering notes exist for font consistency (fonts must be available in the headless Chromium).

### 2.8 Image upload handling

Default upload panel stores uploads as **base64 data URLs** — explicitly documented as *demo-grade only*; "production apps should implement their own" upload panel backed by their storage/CDN (upload to S3/your backend, store the URL in the element). Images carry `cropX/Y/Width/Height` (smart crop with `toggleCropMode()`), `clipSrc` (mask/frame shapes), borders, corner radius, flips, Konva filters. Asset loading config covers timeouts, error handling, CORS, and image downscaling quality.

---

## 3. Feature Inventory (exhaustive, with OSS-vs-paid flags)

**Editor chrome & canvas**
- Left icon-rail side panel with composable/custom sections; `DEFAULT_SECTIONS`; hidden panels (`effects`, `animation`, `image-clip`) — **core SDK**
- Contextual top toolbar with per-element-type `components` overrides; floating tooltip quick actions — **core**
- Canvas workspace: snapping, rulers, guides, distance guides, styled selection/transformer, zoom/pan, bleed preview, print units (px/pt/mm/cm/in) + dpi — **core**
- Pages timeline (filmstrip): add/clone/reorder/delete pages; per-page size, background, `duration`, bleed w/ per-side overrides; magic resize (`store.setSize(w,h,useMagicResize)` rescales content) — **core**
- Roles (user/admin/viewer), freehand draw tool, presentation (fullscreen slideshow) mode — **core**
- Localization via `setTranslations()` — **core**

**Text**
- Rich text (v4): per-fragment font family/size/style; inline editing (`toggleEditMode()`); alignment, line/letter spacing, stroke, text background, text on curve/path — **core**
- Google Fonts + custom font upload; global vs design fonts — **core** (bring your own font files/hosting)
- ⚠️ Gotcha documented: `placeholder` text renders in exports too — must be filled/removed pre-export

**Images**
- Upload (base64 default; BYO backend in production), clipboard paste, Unsplash stock search integration (BYO API key/quota) — **core**
- Smart crop mode, rotation, flip, corner radius, borders — **core**
- Masks/frames via `clipSrc` — **core**
- Filters & adjustments: brightness, contrast, saturation, highlights, shadows, temperature; duotone/color overlay; blend modes — **core**
- **Background removal — PAID cloud API (~$0.03/removal)**

**Shapes / graphics**
- Figures: rect/circle/star/etc. via `subType`, gradient fills (linear/radial), pattern & texture fills (built-in + custom image), stroke, radius — **core**
- Lines: dash patterns, arrowheads — **core**
- SVG elements with recolor (`replaceColor()`/`colorsReplace`, `resetColors`) — **core**
- Icons library panel — **core** (asset quality depends on your bundle)
- QR codes — supported in community forks as a custom element pattern; not a flagship built-in
- Charts — **not a native element type** (build as custom element or SVG)

**Video / animation / audio**
- Element animations: enter/exit/loop (move, fade, zoom, rotate, blink, bounce; duration/delay/easing); group animations; page `duration`; playback (`store.play()`, `setCurrentTime`); global timeline UI — **core**
- Video elements: trim (start/end), behave as layers; GIF elements; MP4 + GIF export — **core**
- Audio tracks: `store.addAudio({ src, volume, delay, startTime, endTime })`, mixed into MP4 — **core**

**Data & tables**
- Table element type — **core**
- Template variables / data-driven batch rendering — **core pattern** (your code supplies data)

**Layers & organization**
- Layers panel (reorder, rename?, show/hide), bring-to-front/send-to-back, lock/unlock (`draggable`, `contentEditable`, `styleEditable`, `resizable`, `removable` → computed `element.locked`), `alwaysOnTop`, `showInExport` — **core**
- Alignment + distribution, grouping, clipboard ops, select by type/color/font, copy/paste style — **core**

**Import**
- `loadJSON()`; **SVG import, PDF import, PSD import** (convert into editable designs) — **core capabilities per docs**

**Export** — see §1.4 table. PNG/JPEG/PDF/GIF client-side **core**; SVG/HTML via companion packages; MP4 core; PPTX core; server-side via polotno-node (key-gated) or Cloud Render API (**paid per-use**).

**AI**
- **AI background removal — paid cloud add-on**
- **AI image generation and AI text writing — paid add-ons** (community forks wire their own; the SDK exposes panels/APIs, Polotno bills the cloud calls)

**Programmatic / automation**
- `@polotno/schema` validation/normalization (DOM-free; LLM structured-output schema) — SDK family
- Cloud Render API — **paid**, batch-friendly managed rendering
- n8n community nodes (MIT) for workflow automation

**Not present (confirmed gaps):** real-time multi-user collaboration; native chart elements; native QR-code element; comments/approval workflow; mobile-native editing experience; built-in stock/template marketplace quality curation (BYO).

---

## 4. UX Patterns Worth Adopting (be specific)

1. **store → pages → elements + `custom` escape hatch.** The single best architectural idea: a typed core schema with a schemaless `custom` bag for host-app metadata. Adopt verbatim — it's what makes campaign↔design linking (asset IDs, utm, variant IDs) possible without schema migrations.
2. **Design = JSON, always.** Save, templates, undoable history, server render, and LLM output all speak the same document. Adopt: one canonical design document; everything else is a view or a render of it.
3. **`waitLoading()` before export.** Fonts/images resolve async; gate every export (and every "ready" indicator) on asset readiness. Copy the pattern, including visible loading state in the UI.
4. **Hidden power panels.** Effects/animation/image-clip live behind `openSidePanel(name)` rather than cluttering the rail — progressive disclosure for advanced tools. Adopt for our advanced features.
5. **Per-element-type toolbar overrides** (`components` prop). The toolbar is a function of selection type. Adopt: toolbar registry keyed by element type, host-overridable.
6. **Composable side-panel sections** (`{ name, Tab, Panel }` + `DEFAULT_SECTIONS`). Adopt: panels as plugins, not hardcoded tabs — this is what lets Marketr inject a "Brand Kit" or "Campaigns" panel later.
7. **Separate design fonts vs global fonts.** Per-document fonts travel with the template; brand fonts are app-global. Adopt the two-tier model for brand-kit work.
8. **Locking as fine-grained flags** (`draggable/contentEditable/styleEditable/resizable/removable` → computed `locked`). Better than a single boolean: enables "editable template" UX where a user can change text but not move the logo. Adopt for template guardrails.
9. **Roles in the store** (`user/admin/viewer`). Read-only preview and admin modes fall out of one flag. Adopt for approval workflows.
10. **`showInExport` and `alwaysOnTop`.** Per-element export visibility enables watermarks, safe-area guides, and annotation overlays that never leak into deliverables. Adopt.
11. **Magic resize** (`setSize(w,h,true)` rescales content). One-click "make this an Instagram Story" is a killer marketing-SaaS feature. Adopt.
12. **Bleed + per-side overrides + print units/dpi in the core model.** For a marketing SaaS that may touch print (flyers, mailers), page-level print metadata is cheap to carry and expensive to retrofit. Adopt.
13. **Published JSON schema as LLM contract.** Shipping `design.schema.json` for structured output turns "AI generates designs" from a demo into a pipeline. Adopt as the AI-generation interface.
14. **Theming via CSS variables + `setIcons()` + primitives.** White-labeling is a config surface, not a fork. Adopt for agency white-label (matches Marketr's white-label tiers).

---

## 5. Gaps / Weaknesses We Can Beat

1. **Pricing is the biggest wedge.** $899/mo self-serve (single domain/brand) prices out the long tail — freelancers, small agencies, indie SaaS. An MIT-core competitor (Konva-based, no key, no credit link) undercuts the entire model. Even Polotno's own Grass Roots program (up to 90% off) concedes the price is a barrier.
2. **Key-gated SDK + credit backlink.** `createStore({ key })` with a mandatory cabinet key and `showCredit` backlink means the "open" story is marketing, not reality. A genuinely open core with no phone-home is a trust and compliance win (SOC2-conscious buyers hate key-gated editors and opaque telemetry).
3. **No real-time collaboration.** No multiplayer cursors, comments, or approval flows — Canva's core moat in teams/agencies. An agency-facing editor with comments → approvals → client share links beats Polotno for Marketr's agency users.
4. **Upload story is DIY.** Default upload is base64-in-JSON (breaks at real image sizes; bloats the design document). Production requires every customer to build their own upload panel + storage wiring. Ship first-class uploads (direct-to-S3/R2 with signed URLs, automatic downscaling, `src` as URL) out of the box.
5. **Template quality is BYO.** Polotno ships an engine and a demo studio; template *quality/curation* is the customer's problem. Canva wins on templates, not canvas tech. A competitor that ships 500 genuinely good, on-trend marketing templates (ads, social, email headers, landing sections) wins the "time to first good design" battle.
6. **AI is an afterthought and metered.** AI background removal and AI text are paid cloud add-ons; AI image generation is panel-level, not workflow-level. A competitor with AI-native flows wins: "generate 10 ad variants from this brief" (JSON-first generation via structured output), auto-layout, brand-aware copy, background removal *included* not $0.03/pop.
7. **No native charts, no QR element, weak tables.** Marketing designs need charts (report graphics), QR codes (print/CTAs), and better tables constantly — all missing or second-class. Easy, visible wins.
8. **Text engine edge cases.** The docs themselves flag that `placeholder` text leaks into exports; canvas text rendering has known cross-browser baseline quirks (their own `render-tag` repo documents Chrome-first compromises and Safari mismatches). A competitor that nails WYSIWYG text fidelity (DOM-overlay editing like Canva's, or a better canvas text engine) differentiates on the thing users touch most.
9. **Mobile story is desktop-web.** Touch editing on a Konva stage is serviceable, not delightful; no mobile-native path. For a marketing SaaS used on phones, a responsive/mobile-first editing UX is an open lane.
10. **PagesTimeline isn't customizable** (per the capability map — remove and rebuild if you need different). Small symptom of a larger pattern: the prebuilt UI is take-it-or-leave-it in places. A competitor built *for* deep UI composition from day one (panels-as-plugins, see §4.6) is more flexible for vertical SaaS embedding.
11. **Print is supported but not celebrated.** CMYK/bleed/crop marks exist in export, but the product story is digital-first. A web-to-print-flavored competitor (proofing, preflight checks, printer profiles) could own the print lane Polotno under-serves.
12. **polotno-node is puppeteer-based** — heavy, slow cold starts, font wrangling in headless Chromium. A lighter server renderer (or edge-friendly render path) is an infrastructure win for batch/programmatic generation at scale.
13. **No brand-governance depth.** Locking flags exist, but there's no brand-kit enforcement (approved fonts/colors/logos, off-brand warnings), no asset approval flow, no usage analytics. For agencies/teams — Marketr's exact audience — "the editor that keeps clients on-brand" is an unclaimed position.

---

## 6. Strategic Implications for Marketr (Phase 11/12)

- **Don't license Polotno; clone its architecture on MIT foundations.** The $899/mo/domain price and key-gating conflict with Marketr's open-source positioning (AGPLv3 + commercial, like the rest of the stack). Build the editor on **Konva + react-konva (MIT)** with an MST/Zustand store modeled on §2 (store → pages → elements, `custom` bag, JSON design doc, `waitLoading` discipline).
- **The JSON design document is the strategic asset**, not the canvas. It unlocks: templates, server-side batch rendering, AI generation via structured output (`design.schema.json` pattern), version history, and the GrowthOS "generate 100 ad variants" loop. Spec the schema before the UI.
- **Adopt the panel-as-plugin and per-element toolbar-registry patterns** (§4.5, §4.6) so Marketr-specific panels (Brand Kit, Campaigns, AI Generator, Asset Library) are first-class, not hacks.
- **Beat Polotno where it's weakest for our audience:** price ($0 vs $899), no key/backlink, collaboration + approvals, first-class uploads, curated marketing templates, AI-native variant generation, native charts/QR, brand governance, mobile editing.
- **Defer:** video timeline/MP4 export and PSD import are expensive; ship static design + PNG/JPG/PDF/SVG first, add animation later. Background removal: use an included/BYOK model rather than a per-call toll.
- **Watch:** `polotno-project/render-tag` (MIT) is a genuinely useful primitive for canvas text fidelity if we hit text-rendering issues.

## Sources

- polotno.com/docs/overview (SDK docs) · polotno.com/llms.txt · polotno.com/pricing.md (machine-readable, canonical pricing)
- github.com/polotno-project/skills — `skills/polotno-sdk/SKILL.md`, `skills/polotno-sdk/capabilities.md`
- konvajs.org docs (about/key facts; react-konva README) — Konva MIT license; "commercial design editor SDK" characterization
- Templated.io comparisons (Oct/Dec 2025) and Medium white-label editor comparisons — feature highlights, legacy pricing, metered cloud costs
- Community forks (openpolotno / polotno-studio-nextjs-free) — feature lists, offline export matrix (PNG/JPEG/PDF-raster/GIF/HTML/SVG/JSON/PPTX), onboarding/keyboard-shortcut patterns

*Caveats:* two GitHub repo URLs suggested for the OSS core (`github.com/lavrton/polotno`, `github.com/polotno-project/polotno`) both 404'd as of 2026-09-27 — the SDK source is not published under those paths; the commercial characterization rests on Konva's official docs and polotno.com's own key/pricing pages. The npm `polotno` package's declared `license` field was not directly inspected; treat "commercial, key-gated" as the verified claim and the SPDX field as unverified.
