# M9 Source Candidates — awaiting human approval

Standing monthly sweep (directive from Tico, 2026-09-26). Vetted candidates for the M9 expert corpus.
**Nothing here is ingested until Tico approves.** Never modify `M9-CORPUS-SOURCES.md` from this job.

Tier key (SPEC-PHASE10.md §M9): Tier 1 = official platform (ship only where license permits);
Tier 1S = learn → original synthesized playbooks; Tier 2 = openly-licensed/PD (shippable w/ attribution);
Tier 2-adjacent = free practitioner pubs (learn + synthesize; short attributed quotation only);
Tier 3 = paywalled (private overlay only; never ships).

---

## Sweep 2026-10-01 (first monthly sweep; corpus baseline = M9-CORPUS-SOURCES.md compiled 2026-09-26)

### Tier 2 — openly-licensed / public-domain (shippable)

| # | Title | Author/Org | URL | License evidence | What Marketr learns | Added |
|---|---|---|---|---|---|---|
| C1 | **Propaganda** (1928) | Edward Bernays | https://archive.org/details/bernays-edward-l.-propaganda-1928-1936_202107/mode/2up | **US public domain** — entered PD 2024-01-01 (95-yr term elapsed; renewal filed 1955 consistent with that term). Corroborated by publisher Irving Books (2026 ed.): "The original 1928 text is in the public domain in the United States"; Internet Archive PDM item. | The foundational PR/persuasion framework — "invisible government," engineering consent, opinion-shaping at scale; ancestor of influencer marketing, brand narrative, and audience psychographics |
| C2 | **Crystallizing Public Opinion** (1923) | Edward Bernays | https://archive.org/details/edward-bernays-texts | **US public domain** (pre-1929 publication). Corroborated by Project Gutenberg #61364 (copyright=false flag) and the Bernays rights audit at https://github.com/slimydog21/antiek/blob/HEAD/docs/operator_gate_actions.md | The first systematic PR methodology — counsel on public relations, mapping stakeholders, campaign architecture; the working manual behind Propaganda's theory |
| C3 | **FTC Endorsement Guides** (revised June 2023) — Guides Concerning the Use of Endorsements and Testimonials in Advertising | U.S. Federal Trade Commission | https://www.ftc.gov/news-events/topics/truth-advertising/advertisement-endorsements | **US public domain** (17 U.S.C. §105 — federal government work), same basis as SBA/FTC entries already in corpus | Influencer/testimonial disclosure rules — material-connection disclosure, fake reviews as endorsements, "unavoidable" disclosure standard; compliance layer for UGC/testimonial features |
| C4 | **FTC Rule on the Use of Consumer Reviews and Testimonials** (16 CFR Part 465; effective 2024-10-21) + staff Q&A | U.S. Federal Trade Commission | http://ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers | **US public domain** (17 U.S.C. §105). Final rule published 89 Fed. Reg. 68034 (Aug 22, 2024) | Enforceable review-marketing law — bans fake reviews, review suppression, buying reviews, fake social indicators; civil penalties up to ~$51,744/violation; the guardrail reference for Marketr's review/testimonial workflows |
| C5 | **marketing-skills** (170+ agent skills: SEO, content, paid ads, channels, platforms, strategies, analytics) | kostja94 | https://github.com/kostja94/marketing-skills | **MIT** — license field verified on the GitHub repo page (created 2026-02-26; 1,004 stars, 139 forks; distinct work from coreyhaines31/marketingskills, not a derivative) [skill-depth spot-review still recommended, as with marketingskills] | Operational marketing workflows incl. GEO and AI-traffic-tracking skills — fills the corpus's known gap (modern growth/AI-search frameworks have no safe open source) |

### Tier 2-adjacent — free practitioner publications (learn + synthesize; never bulk-ingest)

| # | Title | Author/Org | URL | License evidence | What Marketr learns | Added |
|---|---|---|---|---|---|---|
| C6 | **SparkToro blog & research** | Rand Fishkin / SparkToro | https://sparktoro.com/ | Free to read; all rights reserved — learn-only → original synthesis | Audience research methodology — where audiences actually spend attention (podcasts, newsletters, socials); the "zero-click content" doctrine; anti-SEO-groupthink measurement |
| C7 | **First Round Review** | First Round (VC) | https://review.firstround.com/ | Free to read; all rights reserved — learn-only → original synthesis | Operator-grade startup marketing — Superhuman's PMF engine, positioning/narrative, GTM playbooks from founders who did it |
| C8 | **Lenny's Newsletter** | Lenny Rachitsky | https://www.lennysnewsletter.com/ | Free essays alongside a paid tier — learn from free content only → original synthesis | Growth/product craft — growth loops, pricing, onboarding, PLG tactics from top-operator interviews; modern counterpart to the Tier 3 Reforge/Demand Curve layer |
| C9 | **Marketing Examples** | Harry Dry | https://marketingexamples.com/ | Free to read; all rights reserved — learn-only → original synthesis | Real-world marketing case studies with teardowns (copy, landing pages, SEO, pricing pages) — 100k+ readers; concrete "show don't tell" tactic library |
| C10 | **VeryGoodCopy** (207+ micro-lessons) | Eddie Shleyner | https://www.verygoodcopy.com/eddie-shleyner | Free to read; all rights reserved — learn-only → original synthesis | Conversion copywriting micro-lessons — one persuasion principle per essay; complements Copyhackers' tutorial depth with bite-size craft |
| C11 | **Reforge blog** (free articles) | Reforge / Brian Balfour et al. | https://www.reforge.com/blog | Free articles; the paid curriculum stays Tier 3 — learn-only → original synthesis | Free shadow of the Tier 3 Reforge course — retention curves, positioning-narrative, growth models; highest-signal free operator writing on growth |

### Rejected (do NOT ingest)

| # | Title | Author/Org | URL seen | Reason |
|---|---|---|---|---|
| R1 | "Free PDF" mirrors of **The Marketing Book** (Baker & Hart, in-copyright) | pirate mirrors (e.g. firebaseapp.com hosts) | surfaced in 2026-10-01 sweep | Ripped/pirated PDFs of an in-copyright work — the 🚫Never category (Anthropic $1.5B settlement pattern). Rejected on sight. |

### Existing-source refresh notes (not new candidates)

- **Google Search Central docs** (corpus Tier 1 #1, CC-BY 4.0): September 2026 changelog adds VideoObject `creator` property (Sep 24), local-business query support in aggregator/supplier units (Sep 18), Search profile badge guide (Sep 16), regional-differences documentation (Sep 8). Changelog: https://developers.google.com/search/updates — re-crawl on next corpus update; no tier change.
- **FTC Green Guides update**: still pending as of Sept 2026 (expected "next year" per trade press) — watch-list for the November sweep.

### Sweep 2026-10-01 — coverage notes

- No new CC-BY marketing textbooks found on Open Textbook Library / Pressbooks this cycle; the corpus already holds the known CC-BY set (Grayson, Burnett, Lumen MKTG 1010). Wikibooks has no substantive marketing textbook.
- GitHub skill repos triaged but excluded: `ranjith-unofficial/claude-sync` (explicit derivative of coreyhaines31/marketingskills — redundant), `gengirish/social-media-agency` (mirror of kostja94/marketing-skills — redundant), `leadmagic/gtm-skills`, `gtmwithkate/gtm-frameworks-gtm-skills`, `shawhint/non-coding-skills`, `urbancodesllc-lgtm/ai-marketing-claude` (unclear licenses, derivative content), `sujanbhuiyan/skills` growth-strategy-playbook (MIT but a single narrow playbook — low marginal value), `mahmoudmetwally97/protoflio` growth-marketing-os (license of the assets themselves [UNVERIFIED]).
- Meta Blueprint / Skillshop / TikTok / LinkedIn / Bing academies: no license changes found this cycle — all remain learn-only (Tier 1/1S).
