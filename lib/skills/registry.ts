// Marketr — skills library: built-in registry packs (spec §7 MVP scope).
// Four SKILL.md packs shipped in code. Each pack's skillMd must parse
// cleanly via lib/skills/frontmatter.ts (verified by scripts/verify-m21-skills.mts).
// Declared tool names are aspirational: they name the connector tools a
// skill may invoke, resolved against enabled project data sources at runtime.

import type { RegistryPack } from "./types";

const SEO_AUDIT_MD = `---
name: SEO Audit
description: Run a structured technical and content SEO audit using Marketr data: crawl health, index coverage, page experience, content quality, and internal linking — delivered as a prioritized issue list with impact and effort.
version: 1.2.0
tools:
  - google-search-console.query
  - dataforseo.on_page
---

# SEO Audit

A repeatable audit workflow for technical and content SEO. Use Marketr's
Search Console connector for the ground truth (impressions, clicks,
position, index coverage) and DataForSEO's on-page data for crawl-level
detail. The audit answers one question: what should we fix first, and why.

## When to use

- Onboarding a new project or client: establish a baseline before any work.
- Quarterly health checks: catch regressions in coverage and Core Web Vitals.
- Before a migration, redesign, or platform move: snapshot everything.
- When rankings or traffic drop: triage with data instead of guesses.

Do NOT run a full audit when the user asks for a single fix ("fix this
redirect chain"). Scope the work to the question asked.

## Workflow

### 1. Confirm scope and data access
- Confirm the domain(s) and date range with the user. Default: last 90 days,
  primary domain only.
- Verify the google-search-console.query tool resolves to an enabled data
  source for this project. If the project has no Search Console property
  bound, say so and stop — do not fabricate coverage numbers.

### 2. Coverage and indexation
- Pull the Search Console coverage report. Bucket pages: valid, excluded
  ("crawled — currently not indexed", "discovered — currently not indexed",
  redirects, soft 404s, blocked by robots).
- Flag pages that earn impressions but are excluded from the index.
- Note sitemap vs. indexed deltas; a healthy site indexes within 10-15% of
  submitted URLs.

### 3. Technical crawl
- Run dataforseo.on_page for the top 200 pages by Search Console clicks.
- Check: status codes, canonical mismatches, redirect chains (more than one
  hop), duplicate title tags and meta descriptions, thin pages (under 300
  words with no unique value), missing H1s, broken internal links, images
  missing alt text.
- Check page experience signals: Core Web Vitals failures by template,
  mobile usability errors, HTTPS mixed-content warnings.

### 4. Content and query analysis
- Export queries with high impressions and position 8-20: these are the
  "striking distance" keywords.
- Export pages with high impressions and low CTR relative to position:
  title and meta rewrites, not new content.
- Identify cannibalization: two or more URLs ranking for the same query with
  position worse than 10. Recommend consolidation, not duplication.

### 5. Internal linking
- List the 20 highest-authority pages (most internal and external links) and
  check whether they link to the 20 highest-revenue pages. Orphan money pages
  are the most common missed opportunity in audits.
- Flag orphan pages (no internal links) that rank or convert.

### 6. Prioritize
Score every finding by impact (traffic or revenue at stake) times effort
(hours to fix). Present quick wins (high impact, low effort) first.

## Output format

Deliver the audit as a markdown report with these sections:
1. Executive summary (3-5 sentences: health verdict, top 3 issues, top 3 wins).
2. Prioritized findings table: issue | pages affected | impact | effort | fix.
3. Striking-distance keyword table: query | impressions | position | page.
4. Appendix: raw exports referenced, not pasted.

## Pitfalls

- Do not report vanity metrics as findings ("you have 12,400 indexed pages"
  means nothing without context).
- Do not recommend disavowing links unless there is evidence of a manual
  action — most "toxic backlink" reports are noise.
- Do not audit without Search Console access; third-party estimates are not
  a substitute for the site's own data. Say so explicitly.
- Keep the findings list under 20 items. An audit nobody acts on is a
  document, not a deliverable.
`;

const CONTENT_BRIEF_MD = `---
name: Content Brief
description: Build a SERP-informed content brief for any keyword: search intent, winning angles, outline, word count target, internal link targets, and FAQ questions — ready to hand to a writer.
version: 1.0.0
tools:
  - dataforseo.serp
  - dataforseo.keywords
---

# Content Brief

Turn a target keyword into a brief a writer can execute without guessing.
Every recommendation is grounded in what actually ranks: the brief reverse-
engineers the SERP instead of inventing an angle.

## When to use

- Before writing any new page or post targeting a keyword.
- When refreshing an underperforming page (position 8-30): the brief becomes
  the rewrite plan.
- When a client asks "what should we write about": produce briefs for the
  top striking-distance keywords first.

Do NOT use this skill to write the article itself. The output is the brief;
writing is a separate step with its own review.

## Workflow

### 1. Confirm the keyword and the page
- Confirm the exact target keyword, the URL it should rank on (new or
  existing), and the audience. Default locale is the project's locale.
- If the keyword is ambiguous ("apple"), ask which meaning before proceeding.

### 2. Read the SERP
- Pull the top 10 organic results for the keyword with dataforseo.serp.
- Classify intent: informational, commercial investigation, transactional, or
  navigational. Note the dominant content type: guides, listicles, product
  pages, videos, forums.
- Record the common angle: what do the top 3 all promise? ("cheapest",
  "for beginners", "2026 updated"). The brief's angle must beat it, not copy it.

### 3. Extract the winning structure
- Map the H2/H3 headings across the top 5 results. Headings that appear in
  3 or more are table stakes — the brief must include them.
- Note the median word count of the top 5; set the target at median plus
  20%. Shorter only wins when intent is transactional.
- Collect "People also ask" questions and related searches; these become the
  FAQ section.

### 4. Find the gap
- Identify what none of the top 5 do well: missing examples, outdated data,
  no visuals, weak first-hand experience. That gap is the brief's
  differentiator and goes in the brief's first paragraph.
- Check the project's own content: is there an existing page to consolidate
  instead of creating a competing one?

### 5. Internal links and metadata
- Recommend 3-5 internal link targets from the project's existing pages
  (use the site's sitemap or Marketr's content index), with suggested anchor
  text.
- Draft the title tag (under 60 characters, keyword near the front) and meta
  description (under 155 characters, with the SERP angle).

## Output format

Deliver the brief as markdown:
1. Target keyword, intent classification, recommended angle (2-3 sentences).
2. Outline: H1, then H2s with 1-line notes on what each section must cover.
3. Word count target and why.
4. FAQ questions (5-8, from People Also Ask).
5. Internal link targets with anchor text.
6. Title tag and meta description drafts.
7. "Do not" list: angles and claims to avoid (from the pitfalls below).

## Pitfalls

- Do not brief a keyword with transactional intent as an informational guide;
  mismatched intent never ranks.
- Do not set the word count from a single outlier; use the median of the
  top 5.
- Do not skip the gap analysis — a brief that only copies the SERP produces
  content that only ties the SERP.
- Do not brief keywords the site cannot plausibly win (dominated by domains
  with 10x the authority and no weak result in the top 10). Say so and
  suggest a longer-tail alternative.
`;

const RANK_REPORT_MD = `---
name: Rank Report
description: Compile a client-ready ranking report from Marketr rank tracking: visibility trends, biggest movers, SERP feature wins, and plain-English commentary on what changed and why.
version: 1.0.0
tools:
  - dataforseo.rank_tracking
  - google-search-console.query
---

# Rank Report

Turn raw ranking data into a report a client will actually read. The report
answers three questions: are we up or down, what moved and why, and what
happens next. Numbers without the story are not a report.

## When to use

- Monthly or weekly client reporting cadences.
- After a site change, launch, or Google update: quantify the impact.
- When a client asks "how are we doing": never answer from memory — run
  this workflow.

## Workflow

### 1. Confirm the reporting window
- Default: last 30 days vs. the previous 30 days. Confirm the keyword set:
  default is the project's tracked keywords; the user may narrow to a tag
  or campaign.
- Confirm the client's definition of success up front (rankings, traffic,
  or revenue) — the commentary must speak to it.

### 2. Pull the numbers
- Average position and visibility score for the window vs. prior window.
- Top 10 movers up and down (position change of 3 or more).
- SERP feature presence: featured snippets, AI overviews, local packs,
  image packs — wins and losses.
- Cross-check Search Console clicks and impressions for the same window;
  rankings without traffic context mislead.

### 3. Explain the movers
- For each big mover, check: did the page change? Did a competitor move?
  Was there a Google update in the window? Was it a SERP feature change
  (e.g. an AI overview pushing organics down)?
- Attribute honestly. "Unknown — under investigation" beats a confident
  wrong story. Never invent a Google update.

### 4. Write the commentary
- Lead with the verdict in one sentence: "Visibility is up 12% month over
  month, driven by the services pages."
- Group movers by theme (a template issue, a content refresh, a competitor),
  not as a flat list of 40 keywords.
- End with next steps: what the movement implies we should do this month.

### 5. Sanity-check before sending
- Do the numbers reconcile? Visibility up but clicks down means a SERP
  layout change — call it out, don't hide it.
- Strip internal jargon. The client should not need to know what a
  "cannibalization cluster" is.

## Output format

Deliver the report as markdown:
1. Headline verdict (1-2 sentences) with the visibility delta.
2. Trend summary: visibility, average position, top-3/top-10 counts, this
   window vs. last.
3. Biggest movers table: keyword | page | position change | likely cause.
4. SERP feature wins/losses.
5. Commentary: what changed, why, what next (3-6 short paragraphs).
6. Appendix: full keyword table for the record.

## Pitfalls

- Do not report rankings without traffic: position 1 with zero clicks is a
  keyword problem, not a win.
- Do not cherry-pick the window to make the numbers look good. Fixed
  cadences, fixed windows.
- Do not blame every drop on "the algorithm". Most drops are page-level:
  stale content, a broken template, a faster competitor.
- Do not send a report with unexplained big movers. If you cannot explain
  it, say what you checked and what you will check next.
`;

const COMPETITOR_WATCH_MD = `---
name: Competitor Watch
description: Run competitor gap analysis for a project: keyword gaps, backlink gaps, and content gaps against 2-4 rivals — delivered as an opportunity list ranked by winnability.
version: 1.0.0
tools:
  - dataforseo.keywords
  - dataforseo.backlinks
  - dataforseo.serp
---

# Competitor Watch

Find where competitors win and the project does not — then rank the gaps by
winnability, not size. A gap list of 500 keywords is noise; ten winnable
opportunities is a plan.

## When to use

- Quarterly: refresh the competitive picture for a project.
- When a competitor launches, gets funded, or visibly outranks the project.
- Before planning a content quarter: gaps feed the editorial calendar.
- When the user names a new rival: run a focused pass on that domain only.

## Workflow

### 1. Confirm the competitor set
- Default: the project's tracked competitors in Marketr (2-4 domains).
- Confirm the domains are true SERP competitors, not just business
  competitors. A business rival that never ranks for the project's keywords
  is not a gap source.
- Confirm the comparison scope: same country and language as the project.

### 2. Keyword gap
- Pull keywords where 2 or more competitors rank in the top 10 and the
  project ranks worse than 20 or not at all.
- Filter for winnability: keyword difficulty below the project's realistic
  ceiling, and at least one weak result (forum, thin page, outdated post)
  in the current top 10.
- Tag each gap by intent and by whether it needs a new page or a refresh
  of an existing one.

### 3. Backlink gap
- Pull referring domains linking to 2 or more competitors but not the
  project. Deduplicate by domain, not by link.
- Score prospects: relevance to the project's niche first, authority second.
  A niche-relevant DR-30 link beats an irrelevant DR-70 link.
- Note the link context (guest post, directory, resource page, press) — the
  outreach playbook depends on it.

### 4. Content gap
- Compare content footprints: topics competitors cover with dedicated pages
  that the project covers thinly or not at all.
- Look for format gaps: competitors winning with calculators, templates,
  or original data while the project only publishes text guides.
- Flag competitor pages with high traffic value (traffic times CPC) — those
  are the gaps worth the most.

### 5. Rank by winnability
Score each opportunity: traffic value times winnability (weak SERP,
matching intent, achievable authority) divided by effort. Present the top
10. Everything else goes in an appendix.

## Output format

Deliver the analysis as markdown:
1. Executive summary: the 3 gaps that matter most and why (5 sentences max).
2. Top 10 opportunities table: opportunity | type (keyword/link/content) |
   traffic value | winnability | effort | recommended action.
3. One-paragraph playbook per opportunity: what to build, what to say, who
   to contact.
4. Appendix: full gap exports referenced, not pasted.

## Pitfalls

- Do not confuse business competitors with SERP competitors; the gap
  analysis only works on domains that actually rank.
- Do not chase competitor keywords the project cannot serve (wrong intent,
  wrong audience, wrong product). A gap you cannot fill is not an
  opportunity.
- Do not treat backlink counts as quality. One earned editorial link beats
  fifty directory submissions.
- Do not run this monthly for the same competitor set — gaps move slowly.
  Quarterly, or on a trigger (launch, funding, ranking shake-up).
`;

export const REGISTRY_PACKS: RegistryPack[] = [
  {
    key: "seo-audit",
    name: "SEO Audit",
    description:
      "Run a structured technical and content SEO audit using Marketr data: crawl health, index coverage, page experience, content quality, and internal linking — delivered as a prioritized issue list with impact and effort.",
    version: "1.2.0",
    declaredTools: ["google-search-console.query", "dataforseo.on_page"],
    skillMd: SEO_AUDIT_MD,
  },
  {
    key: "content-brief",
    name: "Content Brief",
    description:
      "Build a SERP-informed content brief for any keyword: search intent, winning angles, outline, word count target, internal link targets, and FAQ questions — ready to hand to a writer.",
    version: "1.0.0",
    declaredTools: ["dataforseo.serp", "dataforseo.keywords"],
    skillMd: CONTENT_BRIEF_MD,
  },
  {
    key: "rank-report",
    name: "Rank Report",
    description:
      "Compile a client-ready ranking report from Marketr rank tracking: visibility trends, biggest movers, SERP feature wins, and plain-English commentary on what changed and why.",
    version: "1.0.0",
    declaredTools: ["dataforseo.rank_tracking", "google-search-console.query"],
    skillMd: RANK_REPORT_MD,
  },
  {
    key: "competitor-watch",
    name: "Competitor Watch",
    description:
      "Run competitor gap analysis for a project: keyword gaps, backlink gaps, and content gaps against 2-4 rivals — delivered as an opportunity list ranked by winnability.",
    version: "1.0.0",
    declaredTools: ["dataforseo.keywords", "dataforseo.backlinks", "dataforseo.serp"],
    skillMd: COMPETITOR_WATCH_MD,
  },
];

/** Registry metadata for listing (no SKILL.md bodies). */
export interface RegistryPackMeta {
  key: string;
  name: string;
  description: string;
  version: string;
  declaredTools: string[];
}

/** List the registry packs (metadata only — bodies stay server-side). */
export function listRegistryPacks(): RegistryPackMeta[] {
  return REGISTRY_PACKS.map(({ key, name, description, version, declaredTools }) => ({
    key,
    name,
    description,
    version,
    declaredTools: [...declaredTools],
  }));
}

/** Look up a registry pack by key. Returns undefined for unknown keys. */
export function getRegistryPack(key: string): RegistryPack | undefined {
  return REGISTRY_PACKS.find((p) => p.key === key);
}
