# M9 Design-Pillar Source List — "Marketr, expert from day 1"

Compiled 2026-09-26. Licensing verified against Sept 2026 sources; [UNVERIFIED] marks single-source or unverified-license items.
Binding tiers (from SPEC-PHASE10.md §M9):
- **Tier 1** — official platform materials. Free to learn from; shippable ONLY where the license permits.
- **Tier 2** — openly-licensed / public-domain. Shippable into the corpus with attribution.
- **Tier 3** — paywalled courses & books. Private-deployment overlay ONLY (Tico's buy list). Never ships.
- 🚫 **Never** — ripped/pirated PDFs in the shipped product (the Anthropic $1.5B settlement pattern).

Companion: `M9-CORPUS-SOURCES.md` (marketing/growth pillar). Same tier discipline, same ingest mechanics.

## Headline licensing finding

The design pillar is **better-positioned than marketing** on clean sourcing. Design has three genuinely open official systems: the **U.S. Web Design System (CC0 public domain)** and the **GOV.UK Design System (Open Government Licence 3.0)** are both shippable verbatim with attribution, and **WCAG 2.2** ships under the W3C Document License (verbatim with attribution, do-not-modify). That is the design pillar's equivalent of the Search Central CC-BY green light — an openly-licensed backbone the marketing pillar never got.

The flip side: **Apple HIG, Material Design guidelines, and Fluent guidance are all learn-only** (all-rights-reserved; free ≠ licensed). Material's *icons* are Apache 2.0 and Fluent UI's *code* is MIT — but the guideline *text* is not. And the design canon's deepest craft books (typography, color, design systems) skew paywalled, so Tier 3 carries real weight here. Butterick's *Practical Typography* is the sharpest trap: free to read online, © all-rights-reserved, "no part may be reproduced without written permission" — learn-and-paraphrase only, never ingest.

## TIER 1 — Official platform materials

| # | Source | Org | Cost/Access | What Marketr learns | Licensing caveat |
|---|---|---|---|---|---|
| 1 | **Apple Human Interface Guidelines** (developer.apple.com/design) | Apple | Free; active 2026 | Platform interaction idioms: clarity/deference/depth principles, Dynamic Type, safe areas, touch targets, platform-specific patterns | ❌ All rights reserved. Learn-only → original synthesis |
| 2 | **Material Design 3** (m3.material.io) | Google | Free; active 2026 | Component anatomy, color roles, elevation, expressive motion, shape scale — the most complete component-level system | ❌ Guideline text rights-reserved; learn-only. ✅ Material **icons** are Apache 2.0 (remix/re-share allowed) |
| 3 | **Microsoft Fluent Design System** (Fluent 2) | Microsoft | Free; active 2026 | Depth, light, motion, materials (Mica/Acrylic); cross-platform (web/Windows/mobile) guidance | ❌ Guidance text presumptive rights-reserved [page-level terms UNVERIFIED]; learn-only. ✅ Fluent UI **code** is MIT |
| 4 | **WCAG 2.2** (w3.org/TR/WCAG22) + **wcag.json** | W3C | Free; active 2026 | Accessibility ground truth: principles, guidelines, success criteria, techniques — the compliance reference the a11y work needs | ✅ **W3C Document License — shippable verbatim WITH attribution, DO NOT MODIFY content** (w3c/wcag repo grants use "in full or in part" with attribution and no changes) |
| 5 | **WAI-ARIA Authoring Practices Guide** | W3C | Free; active 2026 | Interaction patterns: keyboard behavior, roles/states for tabs, dialogs, menus, carousels — design-engineering patterns with a11y built in | ✅ Same W3C terms — verbatim with attribution, no modification |
| 6 | **U.S. Web Design System (USWDS)** (designsystem.digital.gov) | U.S. GSA / 18F | Free; active 2026 | **The shippable backbone:** components, patterns, layout, typography guidance with accessibility baked in — civic-grade, research-tested | ✅ **CC0 1.0 public domain** (verified in uswds/uswds README; a few third-party parts excepted — check LICENSE.md at ingest) |
| 7 | **GOV.UK Design System** (design-system.service.gov.uk) | UK GDS | Free; active 2026 | Forms-first component patterns, the best **content-design** guidance in any official system, accessibility-tested components | ✅ **Docs © Crown copyright under Open Government Licence 3.0** (reuse incl. commercial, with attribution); code MIT |
| 8 | **web.dev — design/UX articles** (web.dev) | Google | Free; active 2026 | Modern web UX: Core Web Vitals-adjacent UX, responsive patterns, form design, image/typography guidance | ✅ **CC-BY 4.0** — Google's standard developer-content footer (text BY, code samples Apache 2.0) [single-source: standard footer convention] |

Also free to learn from (lower signal or presumptive rights-reserved, not individually listed): IBM Carbon Design System (code Apache 2.0; guidance text [UNVERIFIED]), Atlassian Design System, Adobe Spectrum, Shopify Polaris, GitHub Primer (code MIT; docs presumptive ©), Salesforce Lightning Design System — all learn-only for guidance text.

## TIER 2 — Openly-licensed / public-domain (shippable)

| # | Source | Author/Org | License | What Marketr learns |
|---|---|---|---|---|
| 9 | **MDN Web Docs** — CSS/design reference | Mozilla/MDN contributors | **CC-BY-SA 2.5+** | Implementation-adjacent design knowledge: layout (grid/flex), typography, color, responsive patterns. ⚠️ Share-alike: segregate like Wikipedia in M9 list |
| 10 | **Wikipedia design clusters** (graphic design, typography, color theory, UX, design history) | Wikimedia | **CC-BY-SA 4.0** | Definitional/conceptual breadth — fastest seed for concept coverage. ⚠️ Segregated BY-SA asset, tag chunks with source+license |
| 11 | **Point and Line to Plane** (1926) | Wassily Kandinsky | **US public domain** (1926 works entered PD Jan 2022) | Composition/form theory roots — the fine-art ancestor of layout: point, line, plane, tension, balance |
| 12 | **Pedagogical Sketchbook** (1925) | Paul Klee | **US public domain** | Form-generation theory — how simple forms grow into complex compositions; Bauhaus design pedagogy |
| 13 | **Concerning the Spiritual in Art** (1911) | Wassily Kandinsky | **US public domain** | Color/form psychology roots — early color-emotion mapping, ancestor of color-theory teaching |
| 14 | **Open-props / open design tokens** (GitHub, e.g. `open-props`) | Community (Adam Argyle et al.) | **MIT** [repo-level; verify per-file] | Design-token practice: named color/spacing/type/easing tokens as shipped code — how tokens encode design decisions |
| 15 | **awesome-design / design resource lists** (GitHub, various) | Community | **CC0 / MIT** (verify per repo) | Curated breadth: tools, references, checklists — discovery layer, spot-review before weighting |

## Tier 2-adjacent — free practitioner publications (learn + synthesize; short attributed quotation under fair use only, NOT bulk ingestion)

| # | Source | What Marketr learns |
|---|---|---|
| 16 | **Nielsen Norman Group articles** (nngroup.com) | UX research depth — usability heuristics, eyetracking findings, IA; the free shadow of the paywalled reports/courses. Presumptive © |
| 17 | **Baymard Institute free articles** | Ecommerce UX research (cart, checkout, product pages) — free shadow of the paywalled benchmark DB. Presumptive © |
| 18 | **Laws of UX** (lawsofux.com, Jon Yablonski) | Psychology principles as design rules (Fitts, Hick, Miller, Jakob…) — site free to read; **book is Tier 3**; site license [UNVERIFIED] → synthesize only |
| 19 | **Butterick's Practical Typography** (practicaltypography.com) | The best free typography rules on the web — but 🚫 **© all-rights-reserved, "no part may be reproduced without written permission."** Learn-and-paraphrase ONLY; honor the author by paying/crediting, never ingest |
| 20 | **Atomic Design** — free online book (atomicdesign.bradfrost.com) + Brad Frost's blog | Atoms→pages methodology, pattern-library governance, design-system maturity. Free to read; **license [UNVERIFIED]** → synthesize only until confirmed |
| 21 | **Refactoring UI blog + tips** (Adam Wathan & Steve Schoger) | Interface design tactics — free shadow of the paywalled book |
| 22 | **Emil Kowalski's design-engineering writing** (emilkowal.ski) | Motion/interaction craft aligned with the house philosophy — already encoded in the emil-design-eng skill; blog is the extended source. License [UNVERIFIED] |
| 23 | **Growth.Design case studies** | UX teardowns of real products — free, high-signal critique examples. Presumptive © |
| 24 | **Style Guide Guide** (Brad Frost) | How to build style guides/design systems — free site, license [UNVERIFIED] |

**Rejected as ambiguous/unsafe (do NOT ingest):** any **CC BY-NC-SA** design textbooks or OER (the NC trap from the M9 list — fine for education, poison for the commercial tier); Canva Design School (ToS-restricted, HubSpot-Academy pattern — learn-only and carefully); DesignBetter.co / InVision free books (© InVision, free-to-read ≠ licensed); Hack Design email course (©); Medium/UX Collective articles (© individual authors — learn-only with per-author attribution discipline); Dribbble/Behance galleries (© creators; look-don't-ingest).

## TIER 3 — Paywalled books & courses (private overlay ONLY; Tico's buy list)

**Books — the design canon (all in-copyright → Tier 3):**
- *Interface & interaction:* **Refactoring UI** (Wathan & Schoger) — tactical interface design, the highest-ROI craft book; **Don't Make Me Think** (Krug) — usability as common sense; **The Design of Everyday Things** (Norman) — affordances, mapping, the psychology of use; **About Face** (Cooper) — interaction design as discipline, personas/goal-directed design; **Designing Interfaces** (Tidwell) — pattern catalog.
- *Typography:* **Thinking with Type** (Lupton) — the working typographer's handbook; **The Elements of Typographic Style** (Bringhurst) — the typographer's bible.
- *Color:* **Interaction of Color** (Albers) — color relativity exercises, the perceptual foundation.
- *Design psychology:* **100 Things Every Designer Needs to Know About People** (Weinschenk); **Laws of UX** (Yablonski) — the book behind the site; **Universal Principles of Design** (Lidwell) — 125 principles as an audit checklist.
- *Design systems:* **Design Systems** (Kholmatova) — systems as shared language; **Atomic Design** print edition (Frost) — the print companion to the free site.
- *Craft & practice:* **Ruined by Design** (Monteiro) — ethics and responsibility; **Design Is a Job** (Monteiro) — client practice; **Creative Selection** (Kocienda) — Apple's demo-driven product process; **Seductive Interaction Design** (Anderson) — psychology of engagement; **Lean UX** (Gothelf/Seiden) — design inside agile teams; **Sprint** (Knapp) — the 5-day design sprint.
- *Growth-adjacent:* **Hooked** (Eyal) — habit-forming product loops.

**Courses:**
| Course | Org / Price (2026) | What Marketr learns |
|---|---|---|
| **Shift Nudge** | MDS / ~$300–500 | Interface design process end-to-end — layout, type, color, hierarchy as a system |
| **Learn UI Design** (Erik Kennedy) | ~$900–1,200 | Practical UI design curriculum — the course version of Refactoring-UI-style craft |
| **Interaction Design Foundation** | ~$200/yr | UX methods, HCI theory, design thinking — broad practitioner curriculum |
| **NN/g UX Certification** | ~$6,000+ (courses a la carte) | Research-grade UX training — the credential behind the free articles |

## Proprietary layer — Marketr's own design system (the uncopyable asset)

No competitor can license this: the corpus's unique training material for "the Marketr style."

- **`app/dashboard/studio/StudioApp.tsx`** (692 lines) — the locked house-style code reference: light `#FAFAF7`-family shell, violet-600/700 primaries and icon tabs, dense tables, Lucide icons only, no emoji UI, structural borders, restrained motion. Every new page is diffed against this file before approval (Tico's lock, 2026-09-25).
- **`~/workspace/skills/better-ui/SKILL.md`** — the polish rulebook: concentric radii, optical alignment, shadows-for-elevation/borders-for-structure, interruptible transitions, 0.96 press scale, exact easing values. This is *original, owned* design-engineering knowledge — Tier 1S-grade material Marketr itself produced.
- **`~/workspace/skills/emil-design-eng/SKILL.md`** — the motion/interaction philosophy: the animation decision framework (frequency → purpose → easing → duration), never-animate-from-scale(0), popover transform-origins, springs, GPU-only properties, reduced-motion discipline.
- **House rules (MEMORY.md):** light mode only, `#FAFAF7` shell, violet everywhere, dense tables, Lucide only, no emoji UI, no teal/green primary buttons, restrained motion, structural borders, RareUI/BeautifulUI/approved shadcn-registry components only.
- **Corpus role:** the shipped Marketr UI itself becomes training data for the design pillar — component code + screenshots paired with the rules above. This is how the fine-tune learns "the Marketr style" the way it learns frameworks from books.

## DAY-1 SEED SET — the 10–15 sources to ingest first

**Shipped corpus (ingest verbatim, with attribution metadata):**
1. **U.S. Web Design System** (CC0) — the backbone: components, patterns, layout, accessibility baked in
2. **GOV.UK Design System** (OGL 3.0) — forms-first patterns + the best content-design guidance in any official system
3. **WCAG 2.2** (W3C doc license) — accessibility ground truth; verbatim, attributed, unmodified
4. **WAI-ARIA Authoring Practices** (W3C doc license) — interaction patterns with a11y built in
5. **web.dev design/UX articles** (CC-BY 4.0) — modern web UX guidance
6. **Kandinsky — Point and Line to Plane** + **Klee — Pedagogical Sketchbook** (PD) — composition/form theory roots
7. **MDN CSS/design reference** (BY-SA, segregated) — implementation-adjacent design knowledge
8. **Wikipedia design clusters** (BY-SA, segregated) — conceptual breadth across graphic design, typography, color, UX
9. **Marketr's own design system** (proprietary) — StudioApp.tsx + both design skills + house rules: the uncopyable style layer

**Learn-only → original synthesis (never ship chunks):**
10. **Apple HIG** — platform idiom judgment, typography hierarchy, accessibility expectations
11. **Material Design 3** — component anatomy, color roles, motion language
12. **Microsoft Fluent** — depth/materials/motion philosophy
13. **NN/g articles** — UX research depth (heuristics, findings, IA)
14. **Butterick's Practical Typography** — typography rules, paraphrased with credit, never reproduced
15. **Laws of UX + Atomic Design (free sites)** — psychology principles and systems methodology, synthesized

**Coverage audit:** layout ✅ (USWDS, GOV.UK, Material, Kandinsky/Klee), typography ✅ (Butterick via synthesis now; Lupton/Bringhurst in Tier 3 later), color ✅ (Material roles, GOV.UK/USWDS palettes; Albers in Tier 3), interaction/motion ✅✅ (proprietary skills are the strongest asset here — better-ui + emil-design-eng are owned, exact, and shippable), accessibility ✅✅ (WCAG + ARIA + USWDS + GOV.UK — the strongest pillar), design systems ✅✅ (USWDS, GOV.UK, Atomic Design via synthesis), content design/microcopy ✅ (GOV.UK content design, OGL). **Known gaps:** (1) **UX research methods** — no open source; NN/g and Baymard are learn-only, so primary-research craft stays thin until Tier 3 or commissioned material; (2) **CRO-adjacent/landing-page design** — Baymard paywalled, Growth.Design learn-only; (3) **brand/identity design** — logo/identity craft has no clean open source, all Tier 3 books. Recommend the monthly M9 sweep hunt OER design-methods textbooks (checking for NC traps) and openly-licensed UX-research courseware.

**Ingest mechanics (same as M9):** store `source_title, author, license, license_url, retrieved_date` per chunk (BY/BY-SA/OGL require license links; OGL requires attribution statement); keep BY-SA chunks in the segregated asset outside the AGPL codebase; WCAG/ARIA chunks verbatim and unmodified per the W3C grant; USWDS — check LICENSE.md per-file at ingest (a few third-party parts are excepted from CC0); never let Tier 3 material touch the shipped corpus — private overlay only; Butterick and other learn-only sources enter only as original paraphrase, never chunks.
