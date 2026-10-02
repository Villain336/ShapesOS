# Knowledge Brain — Dark V2 Design Spec

- Date: 2026-09-30. Directed by Tico: full visual flip to a DARK particle-universe treatment, REVERSING the 2026-09-26 light-space lock.
- Reference: Tico's video — dark particle galaxy that BLOOMS open on load, deep zoom-out to a massive node network, node-click → camera flies into a wiki-style document view with a right reference panel, Obsidian-style 3-pane layout.
- Type: DESIGN SPEC. No code until Tico approves the look from this document.
- Scope discipline: this is a **reskin + motion upgrade**. The corpus (v9: 339 sources, 5,924 chunks), data model, tenant isolation, and every existing Brain function stay untouched. The sage-wiki evidenced-graph ideas (see `sage-wiki-brain-fit.md`) are explicitly **out of scope** — Brain v3, not this spec.

## 1. Headline decisions

1. **Full-page dark.** The reference video is a fully dark UI, not a dark canvas in a light page. The entire Brain page — sidebar, health strip, tables, panes — goes dark. No light/dark mixed chrome.
2. **Particles, not beads.** The v6 "bead model" wireframe armature is gone. Sources are luminous cores; chunks are additive-blended sparkles; ambient dust adds depth. One visual language: light in darkness.
3. **The cinematic is the first impression.** Bloom-on-load → deep zoom-out → settle. It plays once per page load (not per tab switch), is skippable, and respects `prefers-reduced-motion`.
4. **Galaxy and document are one continuous space.** Clicking a source core flies the camera into it and the view becomes the wiki article pane; the backlink panel slides in from the right. Esc / breadcrumb flies back out. No page reload, no route change mid-flight.
5. **Audit layer keeps its doctrine, translated to dark.** Dense tables stay dense tables. Health strip stays a strip. Only the tokens change.

---

## 2. Dark surface palette (explicit token mapping)

The house pattern in `AGENTS.md` is written for light surfaces. This is the dark adaptation — every light token gets exactly one dark successor.

| Token | Light (current) | Dark V2 | Notes |
|---|---|---|---|
| Page bg | `bg-[#FAFAF7]` | `#07070C` "abyss" | Near-black, faint blue-violet cast so violet glow reads |
| Panel bg | white | `#0E0E15` "panel" | Cards, panes, table container |
| Panel bg (raised) | `bg-stone-50` | `#14141D` "raised" | Hover states, nested wells |
| Border | `border-stone-200` | `rgba(255,255,255,0.08)` | 1px hairlines only; no heavy dividers |
| Text primary | `text-stone-900` | `#F4F4F6` | Titles, values |
| Text secondary | `text-stone-500` | `#A1A1AA` | Subtitles, meta |
| Text tertiary | `text-stone-400` | `#63636B` | Captions, hints |
| Table row hover | `bg-[var(--brand-50)]/40` | `rgba(255,255,255,0.04)` | Neutral on dark; brand tint would muddy |
| Info note | `border-stone-200 bg-stone-50` | `border-white/8 bg-white/[0.03]` | Same semantics |

### Brand vars on dark (the theming law holds)

Dynamic tenant brand-color theming is unchanged — only the *application* shifts:

- `--brand-600` (default violet `#7C3AED`): stays the primary action color. On dark it renders as filled buttons with a soft outer glow.
- `--brand-700` (`#6D28D9`): hover state.
- `--brand-50` → **replaced** by `--brand-glow: color-mix(in srgb, var(--brand-600) 35%, transparent)` for halos, active rings, focus states. Never use `--brand-50` as a surface on dark — it renders as washed-out gray.
- Primary button: `bg-[var(--brand-600)] hover:bg-[var(--brand-700)]` + `shadow-[0_0_24px_var(--brand-glow)]`. Same classes as light, plus the glow utility.
- Active tab/pill: `border-[var(--brand-600)] text-[var(--brand-600)]` on light becomes filled `bg-[var(--brand-600)]/15 border-[var(--brand-600)]/40 text-white` on dark — outlined brand text on near-black fails contrast; tinted fill passes.

### Pillar color coding (preserved, brightened for dark)

Same hues as the locked galaxy, raised ~10% lightness so they read on black:

- Marketing: `#8B5CF6` (violet-500, was effectively `#7C3AED` on light)
- Growth: `#22D3EE` (cyan-400)
- Design: `#FB7185` (rose-400)
- Tier 1 / Tier 2 / Tier 1S pills keep their current assignments; on dark they render as tinted fills (`bg-{color}/15 border-{color}/30`) rather than solid fills, except the actively-selected pill which is solid.

---

## 3. The cinematic: bloom → zoom-out → drift

Plays once per full page load. Total runtime **6.0s**, skippable at any point (click, Esc, or any keypress jumps to the final state).

### Beat 1 — Ignition (0.0–1.2s)
- Frame starts on pure abyss `#07070C`. A single point of white-violet light at center screen, ~4px, with a soft bloom halo.
- 6,263 particles (339 source cores + 5,924 chunk sparkles) stream outward from the point along randomized radial vectors with slight tangential curl. Easing: `easeOutExpo` — violent at first, settling.
- Core particles (sources) lead; sparkles trail with a 0.15s stagger. Trails fade over 0.6s (motion-blur feel via afterimage pass, strength 0.85).

### Beat 2 — Constellation (1.2–3.5s)
- Camera dollies back from z=8 to z=42 (units; FOV 55°), `easeInOutCubic`. As distance grows, particles resolve into three pillar-colored neighborhoods (force-layout positions are precomputed — no live simulation during the cinematic).
- Source cores ignite: each core scales 0→1 with a 12ms stagger ripple outward from the hero source, plus a one-frame flash sprite.
- The hero source's dotted orbital ring draws itself (dash-offset animation, 1.0s).

### Beat 3 — Settle (3.5–6.0s)
- Camera eases to its resting orbit (z=42, 12° elevation). UI chrome fades in: health strip (staggered 60ms per card), toolbar, legend, "Cinematic tour" button. Canvas is interactive from 4.5s (before chrome finishes — the galaxy is the hero, not the cards).
- A one-line hint appears bottom-center: "drag to rotate · scroll to zoom · click a core" — fades after 6s, never shows again (localStorage).

### Idle drift
- Whole-field rotation 0.4°/s around Y. Sparkle shimmer: per-particle opacity noise (cheap sine hash, no CPU per-frame work). Ambient dust (2,000 points, 30% opacity) parallaxes on mouse move (±12px offset, lerped).
- The cinematic tour button replays Beats 1–3 on demand.

### Reduced motion
- `prefers-reduced-motion: reduce` → skip Beats 1–2 entirely; render the final settled frame with a 300ms fade-in. No autoplay drift (static until user drags).

### Performance budget
- **Counts:** 339 source cores + 5,924 chunk sparkles + 2,000 dust = 8,263 particles. Current corpus; the old 48/2,678 numbers are historical.
- **Draw calls:** 3 total. Cores = one `InstancedMesh` (icosahedron, detail 1). Sparkles = one `THREE.Points` with a soft-disc sprite texture and per-point color/size attributes. Dust = one `THREE.Points`. Edges: none drawn by default (the current galaxy's hairlines become a toggle — "links" — default OFF on dark; they read as noise on black).
- **Target:** 60fps on an M1-class GPU at devicePixelRatio ≤ 2.
- **Degradation ladder (automatic, measured over a 2s rolling window):**
  1. fps ≥ 50: full quality.
  2. 30–50: pixelRatio → 1, dust → 800, bloom pass → half res.
  3. < 30 sustained: drop to the existing 2D canvas force-graph (the current 3D/2D toggle becomes the automatic fallback; a small "2D mode — GPU limit" chip explains why).
- No per-frame allocations; positions are static buffers, only the group transform and shader time uniform update.

---

## 4. The graph on dark

- **Source cores:** luminous spheres, radius ∝ √chunks (same law as now), emissive pillar color, with a fresnel rim shader so they read as orbs of light rather than flat dots. Selected/hovered core gets `--brand-glow` halo + label.
- **Chunk sparkles:** additive-blended points, pillar color at 55% opacity, size 1.5–3px attenuated by distance. Additive on black = the "sparkle" effect for free.
- **Hero source:** dotted orbital ring (white, 40% opacity, slow rotation) + slightly larger halo. Unchanged semantics, redrawn for dark.
- **Clusters:** organic force-layout neighborhoods by pillar, as now. Labels ("MARKETING · 290" etc.) float as sprites, tertiary text color, fade in past z<50.
- **Interactions (kept):** drag to rotate, scroll to zoom, click a core to inspect. Hover a core → tooltip (source name, tier badge, chunk count). Search → camera flies to the matched core (same fly-to as node click, shorter: 0.9s).
- **Legend:** same three entries (core = source · size ∝ chunks / sparkle = chunk / dotted ring = hero orbit), restyled as a floating glass chip (`bg-black/40 backdrop-blur border-white/10`).

---

## 5. Node → document transition

This is the signature move from the reference video.

1. **Click a source core** → all other cores dim to 15% over 0.4s; the selected core's halo expands.
2. **Camera flight (1.2s, `easeInOutCubic`):** dolly from resting orbit to 2 units from the core, FOV narrows 55°→38° (dolly-zoom compression feel). At closest approach the core fills ~60% of the center pane.
3. **Crossfade (0.35s):** the core blooms to white and dissolves; the wiki article pane fades in over the center pane. The galaxy keeps idling, dimmed, behind a 70% abyss scrim — it never unmounts, so flying back is instant.
4. **Document view (article pane):** title, tier badge, license-basis line, then the source's dossier content — summary, key claims with chunk citations (this is where the future evidenced-graph slots in), chunk list. Typography: article measure 68ch, primary/secondary text tiers, links in brand-600.
5. **Right panel slides in (0.4s, `easeOutCubic`, 320px):** "References" — backlinks (other sources citing this one), related sources by pillar, chunk spans, and the audit actions (flag for review, propose removal). In galaxy mode this same panel shows the selection inspector / corpus quick stats instead — one panel, two modes.
6. **Breadcrumb** top-left of the center pane: `‹ Galaxy / {Source name}`. Click (or Esc) → reverse flight (0.9s), panel slides out, cores restore. The transition is symmetric and interruptible mid-flight.

---

## 6. 3-pane layout

Obsidian-style, all three panes collapsible (chevron toggles, state in localStorage):

| Pane | Galaxy mode | Document mode |
|---|---|---|
| **Left (280px):** nav | Search + concept/source list grouped by pillar; tier filter chips. Clicking a row flies the camera to that core. | Same list; active row highlighted. |
| **Center (flex):** stage | The particle galaxy canvas. | The wiki article pane (galaxy idling dimmed behind). |
| **Right (320px):** context | Corpus quick stats + selection inspector (empty state: "click a core"). | References panel: backlinks, related sources, chunks, audit actions. |

- Below the center stage (both modes): the audit layer — health strip, chunk distribution bar, filter toolbar, sources dense table, activity feed, dossiers. The stage is the new top; the audit layer is the command deck beneath it. Nothing is removed, only reordered: stage first, strip second, table third.
- Pane collapse: any pane can collapse to a 48px rail. Mobile (<1024px): panes become bottom-sheet tabs; the galaxy stays full-bleed.

---

## 7. Audit layer on dark

Every element keeps its function and doctrine; only tokens change per §2.

- **Health strip:** 7 stat cards (Sources, Cataloged, Chunks, Manifest, Corpus Eval, Proposals Pending, Flagged for Removal) as `#0E0E15` panels, 1px `white/8` borders, big numerals in primary text, captions in tertiary. Staggered fade-in after the cinematic.
- **Chunk distribution by pillar:** horizontal stacked bar on dark — same three pillar colors, track `white/6`.
- **Filter toolbar:** search input (`bg-white/[0.04] border-white/10`, focus ring brand-600), pillar/tier pills as tinted fills (§2), 3D/2D toggle, "Add source" ghost button, "Rebuild corpus" primary brand button with glow.
- **Source register:** dense table doctrine HOLDS — `hover:bg-white/[0.04]` rows, badge columns for tier/pillar/status, compact 13px type. Header row tertiary text, no heavy dividers.
- **Activity feed & dossiers:** timeline rows on dark; dossier cards as raised panels. Trust states (verified / pending / contradicted) get dot colors: emerald-400 / amber-400 / rose-400 — reserved semantic colors, never repurposed for brand.
- **Corpus eval / proposals / flagged:** unchanged counts and flows; the flagged-for-removal flow keeps its existing confirmations.

---

## 8. What stays (explicit non-goals)

- The corpus: v9, 339 sources, 5,924 chunks. No re-ingestion, no re-chunking.
- The data model, API routes, and tenant isolation. This spec touches presentation only.
- All existing Brain functionality: search-to-fly, add source, rebuild corpus, cinematic tour, 2D toggle, proposals, flagging, dossiers, eval display.
- VoiceStudio, brand-theming law, Lucide icons, dense tables. The house rules in `AGENTS.md` apply with the §2 dark mapping.
- Evidenced graph, tiered compilation, hybrid retrieval, trust quarantine, entity resolution — Brain v3, explicitly not here.

---

## 9. Migration & build slices

- **Feature flag:** `brain.darkV2` (env + per-user override). Dark V2 lives at the same route with `?brain=v2`; current light Brain stays the default until Tico approves screenshots. No flag cleanup until approval.
- **Slices (each: code → typecheck → tests → commit; one at a time):**
  1. **Dark tokens + audit layer reskin.** All §2/§7 changes, no canvas changes. Verifiable by screenshots of strip, toolbar, table on dark.
  2. **Particle galaxy renderer on dark.** §4; static settled frame, behind the flag.
  3. **Cinematic sequence.** §3 beats + idle drift + reduced-motion path.
  4. **Node → document transition + 3-pane layout.** §5/§6, right panel both modes.
  5. **Perf ladder + fallback + acceptance pass.** §3 degradation tiers, screenshot set, flag stays until sign-off.

### Acceptance criteria
- Screenshot set at each cinematic beat (ignition, constellation, settle, idle) + document view + right panel + audit layer — Tico approves the LOOK from these before any merge to default.
- 60fps on M1-class GPU at DPR ≤ 2 with the full v9 corpus; degradation ladder verified by throttling.
- `prefers-reduced-motion` path verified.
- Zero changes to corpus data, API shapes, or tenant scoping (diff the network payloads).
- Existing 2D toggle still works and serves as the automatic fallback UI.

---

## 10. Open questions for Tico

1. **Approve the look from this spec?** The load-bearing calls: full-page dark (yes), particles-not-beads (yes), the 6s cinematic (timings above — too long? too short?).
2. **Edge lines:** spec defaults them OFF on dark (they read as noise on black). Keep the toggle, or drop edges entirely?
3. **Dust + bloom:** the reference video leans heavily on bloom. Keep the afterimage/bloom passes, or is that too much motion for a work tool?
4. After visual approval: build in the 5 slices above, or do you want a clickable mock first?
