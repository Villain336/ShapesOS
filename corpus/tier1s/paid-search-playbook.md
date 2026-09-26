<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Google Skillshop (learn-only; personal, non-commercial license).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  Ideas and standard Google Ads mechanics expressed in Marketr's own words,
  with factual attribution to the source of the knowledge.
-->

# Paid Search Campaign Playbook

*Original synthesis of knowledge learned from Google Skillshop. Marketr-original words; factual attribution to Google's official curriculum.*

## Account structure: the money tree

A well-built Google Ads account is a hierarchy, and structure is strategy:

- **Account → Campaigns → Ad groups → Keywords + Ads.** Budgets and settings live at the campaign level; intent lives at the ad group level.
- **Segment campaigns by intent and economics, not by vibes.** Brand terms (people searching your name) get their own campaign — they convert cheapest and must be measured separately from non-brand. Non-brand splits further by theme: product lines, use cases, problem queries. A campaign that mixes "buy CRM software" with "what is a CRM" will report a blended CPA that hides both a star and a money pit.
- **Ad groups are tight.** Five to twenty closely related keywords per ad group, all served by ads written specifically for that theme. "Tight ad groups" is the oldest working advice in paid search and still the highest-ROI structural fix for messy accounts.

## Keyword match types and the modern doctrine

- **Exact match** — the query means the same as your keyword. Highest control, smallest reach.
- **Phrase match** — the query contains your keyword's meaning in order. The workhorse for most accounts.
- **Broad match** — the query is related by meaning, including synonyms and intent the system infers. Largest reach, least control.

Modern doctrine: broad match paired with Smart Bidding (conversion-based bidding) is the default starting point Google's own curriculum pushes, because the bidding algorithm now uses the full auction context — device, time, query nuance, user signals — that keyword-level bid tweaks never could. But broad match without guardrails is a budget fire. Rules:

1. **Start with phrase/exact for learning**, graduate winning themes to broad match with Smart Bidding once you have 30+ conversions in 30 days (the volume Smart Bidding needs to stabilize).
2. **Negative keywords are a weekly habit.** Mine the search-terms report every week; add negatives for irrelevant themes (jobs, free, DIY, competitors you don't want to bid on). A neglected negative list is the #1 source of wasted spend in mature accounts.
3. **Never bid on a keyword you wouldn't defend in a meeting.** Broad match will find queries you'd never imagine; the search-terms report is where you find them.

## Quality Score: the hidden multiplier

Every keyword carries a Quality Score (1–10) built from expected click-through rate, ad relevance, and landing-page experience. It matters because it multiplies your bid in the auction — a high score means you pay less for the same position. In practice:

- **Ad relevance:** the ad must contain the searcher's language. Dynamic keyword insertion helps at scale, but well-written RSA headlines pinned by theme beat generic copy.
- **Landing-page experience:** the page must deliver what the ad promised, load fast, and work on mobile. Sending paid traffic to a slow homepage is the most expensive page on the internet.
- **Expected CTR:** history matters. New accounts should bid on their tightest themes first to build CTR history, then expand.

## Responsive search ads: write the system a menu

RSAs take up to 15 headlines and 4 descriptions and assemble combinations automatically. Give the system good raw material:

- **Write headlines that cover distinct angles**: keyword echo, benefit, social proof, offer, urgency, differentiator. Don't write 15 versions of the same sentence.
- **Pin sparingly.** Pinning headline 1 to your brand or offer is fine; pinning everything defeats the assembly logic.
- **Ad strength is a guide, not a grade.** "Excellent" ad strength with terrible business results is still terrible. Judge by conversions.

## Bidding: let the machine bid, you set the target

- **Maximize conversions** (optionally with a target CPA) for lead-gen and e-commerce with clean conversion tracking.
- **Maximize conversion value** (optionally with a target ROAS) when order values vary — a $20 sale and a $2,000 sale are not the same conversion.
- **Manual CPC is a learning tool**, not a long-term strategy. Use it to gather initial data on a tight theme, then hand the wheel to Smart Bidding.
- **Portfolio bid strategies** let multiple campaigns share one target — useful when individual campaigns are too small for the 30-conversions/month stability threshold.

## Campaign types beyond Search

- **Performance Max** runs across all Google inventory (Search, YouTube, Display, Discover, Gmail, Maps) from one campaign. It finds incremental volume beyond what Search captures — but it needs asset variety (text, image, video), audience signals to start from, and brand-exclusion controls so it doesn't just harvest your brand traffic and claim the credit. Always measure PMax incrementality separately.
- **Video (YouTube)** is the cheapest reach on the platform and the best storytelling surface. Use skippable in-stream for consideration, bumper ads for frequency, and always run a brand-lift or search-lift read on video spend.
- **Shopping** lives or dies on the product feed: titles that match search language, correct categorization, competitive pricing, and review stars. Feed optimization is the highest-ROI activity in Shopping accounts.

## Measurement hygiene

1. **One conversion action per business outcome**, with values set. Duplicate or misnamed conversions corrupt Smart Bidding.
2. **Import offline conversions** (CRM closed-won) for B2B — optimizing to form-fills optimizes to tire-kickers; optimizing to revenue optimizes to customers.
3. **Attribution:** data-driven attribution is the default and usually right; check the model comparison report before overriding.
4. **Change history + annotations.** Every bid, budget, or structure change gets a note. Debugging a CPA spike is impossible without knowing what changed when.

*Attribution: strategic knowledge learned from Google Skillshop (Google). Playbook text is Marketr-original.*
