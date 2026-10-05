# M9 Expert-Corpus Source List — "Marketr, expert from day 1"

Compiled 2026-09-26. Licensing verified against Sept 2026 sources; [UNVERIFIED] marks single-source items.
Binding tiers (from docs/specs/SPEC-PHASE10.md §M9):
- **Tier 1** — official platform materials. Free to learn from; shippable ONLY where the license permits.
- **Tier 2** — openly-licensed / public-domain. Shippable into the corpus with attribution.
- **Tier 3** — paywalled courses & books. Private-deployment overlay ONLY (Tico's buy list). Never ships.
- 🚫 **Never** — ripped/pirated PDFs in the shipped product (the Anthropic $1.5B settlement pattern).

## Headline licensing finding

Of all official platform academies, **only Google Search Central is under an explicit open license (CC-BY 4.0)** permitting ingestion into a shipped RAG corpus. Every other platform academy is "free to learn from, NOT licensed to redistribute/ingest" — Meta, Google Skillshop, TikTok, LinkedIn, X, Pinterest, Snapchat, YouTube, Amazon, Reddit all reserve rights; **HubSpot Academy explicitly bans copying its content** and **Salesforce Trailhead explicitly bans scraping for AI-model training**. Practical consequence: the shipped corpus is built from Tier 2 sources; platform courses feed it only via original synthesis (learn → write original playbooks), never verbatim chunks.

## TIER 1 — Official platform materials

| # | Source | Org | Cost/Access | What Marketr learns | Licensing caveat |
|---|---|---|---|---|---|
| 1 | **Google Search Central documentation** (incl. SEO Starter Guide) | Google | Free, active 2026 | SEO ground truth: crawl/index, helpful content, spam policies, structured data | ✅ **CC-BY 4.0** — the one green light. Ingest + redistribute with attribution |
| 2 | **Meta Blueprint** | Meta | Free courses; certs ~$150 | Paid-social buying, strategy, measurement, creative across FB/IG/Messenger/WhatsApp | ❌ Not licensed to redistribute; ToS bars automated collection. Learn-only → original synthesis |
| 3 | **Google Skillshop** | Google | Free certs; active 2026 | Google Ads (Search/Display/Video/Shopping/Apps), Analytics, Business Profile | ❌ Google ToS: personal, non-commercial license only. Learn-only |
| 4 | **Bing Webmaster Guidelines** | Microsoft | Free; rewritten 2026 with GEO + Copilot grounding controls | Bing crawling/quality rules; AI-grounding controls — unique GEO signal | ❌ Presumptive all-rights-reserved [page-level terms UNVERIFIED]. Learn-only |
| 5 | **TikTok Academy** | TikTok | Free; active 2026 | TikTok ad products, creative best practices, Shop ads | ❌ ToS explicitly forbids copying/reproduction. Learn-only |
| 6 | **LinkedIn Marketing Labs** | LinkedIn | Free courses/certs [2026 status UNVERIFIED] | B2B ads: targeting, measurement, creative | ❌ Rights reserved; copying prohibited. Learn-only |
| 7 | **HubSpot Academy** | HubSpot | Free; active 2026 | Inbound, content, SEO, email — best-structured free marketing curriculum | 🚫 **Explicitly bans copying/derivative works** (ToS §6.1). Learn-only, and carefully |
| 8 | **Salesforce Trailhead** (marketing tracks) | Salesforce | Free; active 2026 | Marketing Cloud, engagement/email, personalization | 🚫 **Explicitly bans scraping for AI-model training.** Learn-only, and carefully |

Also free to learn from (lower signal, not individually listed): X for Business/Flight School, Pinterest Academy, Snapchat for Business, YouTube Creator Academy, Amazon Ads Learning Console, Reddit for Business — all all-rights-reserved.

## TIER 2 — Openly-licensed / public-domain (shippable)

| # | Source | Author/Org | License | What Marketr learns |
|---|---|---|---|---|
| 9 | **Scientific Advertising** (1923) | Claude Hopkins | **US public domain** | Measurable direct-response discipline — headlines, sampling, specificity; the ancestor of A/B testing and CRO |
| 10 | **My Life in Advertising** (1927) | Claude Hopkins | **US public domain** (entered PD Jan 2023) | Worked campaign case studies with real budgets — Schlitz, Pepsodent, Quaker Oats |
| 11 | **The Psychology of Advertising** (1903/1908) | Walter Dill Scott | **US public domain** | First application of psychology to advertising — suggestion, emotion, attention, habit; ancestor of behavioral marketing |
| 12 | **The Business of Advertising** (1915) | Earnest Elmo Calkins | **US public domain** | Full-funnel 1910s practice — media types, agency process, message coherence; early integrated-marketing argument |
| 13 | **Foundations in Digital Marketing** (2023) | Rochelle Grayson / BCcampus | **CC-BY 4.0** | **Best modern safe source:** storytelling, SEO/SEM, content, paid, social, email, attribution, CRO, analytics, AI trends — with frameworks, tools, KPIs per channel |
| 14 | **Introducing Marketing** (2011) | John Burnett / Global Text Project | **CC-BY 3.0** | Classical marketing foundations — strategy, consumer behavior, marketing mix — in modern language, peer-reviewed |
| 15 | **SBA Business Guide — Marketing & Sales** | U.S. Small Business Administration | **US public domain** (17 USC §105) | SMB-practical marketing plans, market research, online marketing, pricing — written for real small businesses |
| 16 | **.com Disclosures** (FTC staff guidance) | U.S. Federal Trade Commission | **US public domain** | "Clear and conspicuous" disclosure rules for digital/social ads — the compliance reference Marketr's guardrails need |
| 17 | **Wikipedia marketing clusters** | Wikimedia | **CC-BY-SA 4.0** | Definitional/conceptual breadth across every sub-discipline — fastest way to seed concept coverage. ⚠️ Share-alike: keep as separately-licensed data asset, tag chunks with source+license at ingest |
| 18 | **marketing-without-money** (GitHub) | edljx | **CC0** | Zero-budget growth playbook — content, email, social, SEO, community, PR, launches. Spot-review before weighting highly [depth UNVERIFIED] |
| 19 | **marketingskills** (GitHub, ~50k stars) | coreyhaines31 | **MIT** | Operational marketing skills — CRO, copy, SEO, analytics, growth engineering as agent-skill markdown |
| 20 | **Introduction to Marketing I** (MKTG 1010) | NSCC & Lumen Learning | **CC-BY 4.0** [direct URL UNVERIFIED] | Faculty-reviewed intro courseware — service-dominant logic, marketing metrics |

**Tier 2-adjacent — free practitioner publications (learn + synthesize; short attributed quotation under fair use only, NOT bulk ingestion):**
| # | Source | What Marketr learns |
|---|---|---|
| 21 | **CXL blog** | Practitioner CRO/experimentation articles — the free shadow of the paywalled CXL curriculum |
| 22 | **Copyhackers blog** (Joanna Wiebe) | Conversion copywriting tutorials — free shadow of Copy School |
| 23 | **Demand Curve blog** | Playbook-style startup acquisition articles — free shadow of the paid playbooks |
| 24 | **Ahrefs blog / Academy** | SEO tactics and studies — high-signal free practitioner content |

**Rejected as ambiguous/unsafe (do NOT ingest):** OpenStax *Principles of Marketing* (CC BY-NC-SA **plus** explicit "may not be used in the training of large language models" clause); MIT OCW (BY-NC-SA site-wide); Saylor Academy eMarketing (BY-NC-SA); Seth Godin books (all-rights-reserved; free manifestos are BY-NC-ND); Moz Beginner's Guide to SEO (license ambiguous — old PDF said CC BY-SA, current site © Moz); BCcampus *Principles of Marketing* H5P ed., Schechter *Social Media & Reputation Management*, Kwantlen *IMC Guide* (all BY-NC-SA). **NC is the recurring trap** — fine for education, poison for the commercial tier.

## TIER 3 — Paywalled courses & books (private overlay ONLY; Tico's buy list)

**Courses (7):**
| # | Course | Org / Price (2026) | What Marketr learns |
|---|---|---|---|
| 25 | **Reforge** | $1,995/yr individual | Growth/product-marketing/AI strategy via operator frameworks (retention curves, activation, experiment velocity) |
| 26 | **CXL Institute** (+ AI Native Marketer cohort, $999) | ~$289–299/mo | CRO, experimentation, digital psychology, B2B marketing; the AI cohort teaches AI research/workflow systems |
| 27 | **Maven** (cohort marketplace) | Per-course, ~$499–1,999 | Live operator-led cohorts — growth, marketing, AI product |
| 28 | **Copy School** (Copyhackers) | $1,497/yr | Conversion copywriting with templates and copy reviews — 10x Emails, Landing Pages, Pricing Pages |
| 29 | **Demand Curve** | $83–100/mo | 40+ startup acquisition playbooks — SEO, paid, email, CRO, retention |
| 30 | **Blueprint Training** (Ryan Stewart) | $6,999+ | Technical SEO, link building, agency operations |
| 31 | **Section** (Head of AI bootcamp) | Free tier; bootcamp $5,000 | AI fluency/transformation playbooks for business leaders |

**Books (23) — the canon, all in-copyright → Tier 3:**
- *Positioning & strategy:* **Positioning** (Ries & Trout, 1981) — own one word in the mind; **The 22 Immutable Laws of Marketing** (Ries & Trout, 1993) — rapid strategy heuristics; **Play Bigger** (Lochhead et al., 2016) — category design; **Obviously Awesome** (Dunford, 2019) — positioning as a 10-step process; **Alchemy** (Sutherland, 2019) — behavioral-economics lens, psycho-logic over logic.
- *Direct response & copy:* **Breakthrough Advertising** (Schwartz, 1966) — mass desire, stages of awareness/sophistication; **The Boron Letters** (Halbert) — list-first relationship copy; **Ogilvy on Advertising** (1983) — research-backed ad principles; **The Adweek Copywriting Handbook** (Sugarman) — copy flow and psychological triggers; **Cashvertising** (Whitman, 2008) — 41 persuasion triggers as an audit checklist.
- *Growth & experimentation:* **Traction** (Weinberg/Mares, 2014) — the 19-channel bullseye, find the ONE channel; **The Lean Startup** (Ries, 2011) — build-measure-learn culture; **Lean Analytics** (Yoskovitz/Croll, 2013) — one-metric-that-matters by stage; **$100M Leads** (Hormozi, 2023) — acquisition operating system.
- *Story/brand:* **Building a StoryBrand** (Miller, 2017) — SB7, customer-as-hero messaging; **This Is Marketing** (Godin, 2018) — minimum viable audience, permission; **Made to Stick** (Heath, 2007) — SUCCESs message design; **Contagious** (Berger, 2013) — STEPPS word-of-mouth engineering.
- *Pricing:* **$100M Offers** (Hormozi, 2021) — the value equation and guarantees; **Priceless** (Poundstone, 2010) — anchoring, decoys, price perception; **Monetizing Innovation** (Ramanujam/Tacke, 2016) — willingness-to-pay before building.
- *B2B/SaaS:* **Crossing the Chasm** (Moore) — early-adopter vs. mainstream messaging; **The Mom Test** (Fitzpatrick, 2013) — interview discipline that kills false positives.
- *Psychology:* **Influence** (Cialdini; 2021 expanded ed. adds "unity"); **Predictably Irrational** (Ariely, 2008) — decoys, anchoring, why rational models fail.

**Rights notes:** *Scientific Advertising* and *My Life in Advertising* are public domain (in Tier 2 above). **Hormozi's books: free ≠ redistributable** — verified copyright pages state "All rights reserved"; his free digital distribution is a personal-use license → Tier 3 only, never ship. Annotated PD reprints: annotations are copyrighted, original text is not — use Internet Archive scans.

## DAY-1 SEED SET — the 15 sources to ingest first

**Shipped corpus (ingest verbatim, with attribution metadata):**
1. **Google Search Central docs** (CC-BY 4.0) — SEO ground truth, the backbone
2. **Foundations in Digital Marketing** — Grayson (CC-BY 4.0) — the single best modern full-stack source
3. **Scientific Advertising** — Hopkins (PD) — direct-response discipline
4. **My Life in Advertising** — Hopkins (PD) — case-study depth
5. **Introducing Marketing** — Burnett (CC-BY 3.0) — classical foundations
6. **The Psychology of Advertising** — Scott (PD) — consumer-psychology roots
7. **SBA Marketing & Sales guides** (PD) — SMB practical playbooks
8. **FTC .com Disclosures** (PD) — compliance guardrails
9. **Wikipedia marketing clusters** (BY-SA, segregated asset) — conceptual breadth
10. **marketingskills** GitHub (MIT) — operational tactics
11. **marketing-without-money** (CC0) — zero-budget growth tactics

**Learn-only → original playbook synthesis (never ship chunks):**
12. **Meta Blueprint** — paid-social tactics (highest-signal platform course)
13. **Google Skillshop** — Google Ads mechanics
14. **TikTok Academy + LinkedIn Marketing Labs** — short-form and B2B paid
15. **CXL blog + Copyhackers blog** — CRO and conversion-copy depth

**Coverage audit:** SEO ✅ (Search Central), paid search/social ✅ (Blueprint, Skillshop, TikTok, LinkedIn — via synthesis), content/copy ✅ (Copyhackers, StoryBrand-pattern via Tier 3 later), CRO/experimentation ✅ (CXL), growth strategy ✅ (Traction-patterns via Tier 3 later; marketing-without-money now), compliance ✅ (FTC), SMB practicality ✅ (SBA). **Known gap:** expert paid-media/SEM depth and modern growth frameworks have no safe open source — plan to commission or license that layer, or let Tier 3 (Reforge/CXL/Demand Curve) fill it in the private overlay.

**Ingest mechanics (for the M9 build):** store `source_title, author, license, license_url, retrieved_date` per chunk (BY/BY-SA require license links); keep BY-SA chunks in a separately-licensed data asset outside the AGPL codebase; never let Tier 3 material touch the shipped corpus — private overlay only.
