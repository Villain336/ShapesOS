# Marketr hosted-tier raw cost research — third-party API unit prices

Date checked: 2026-09-22. Raw vendor costs only — no credit modeling, no markup.
Rule used: every figure below is either from an official vendor page or corroborated by 2+ independent sources. Guesses are flagged, not presented.

## DataForSEO

| # | API / endpoint | Unit | Price USD | Source URL | Date checked |
|---|---|---|---|---|---|
| 1a | SERP API — Google Organic, Standard Normal queue | per 1,000 SERPs (10 results each) | $0.60 | https://www.searchcans.com/alternative/dataforseo/ (cites DataForSEO pricing page, checked 2026-08-28); https://github.com/gna8586/serp-api-comparison/blob/HEAD/README.md | 2026-09-22 |
| 1b | SERP API — Google Organic, Priority queue | per 1,000 SERPs | $1.20 | same as above | 2026-09-22 |
| 1c | SERP API — Google Organic, Live | per 1,000 SERPs | $2.00 | same as above; also https://apiserpent.com/blog/best-pixel-position-api-providers-2026 | 2026-09-22 |
| 2 | Keywords Data API — Google Ads search volume, live | per task (up to 1,000 keywords per task) | $0.09 | https://meikuio.com/dataforseo-review/ (read 2026-09-01); https://github.com/mcerqua/jam-skills/blob/HEAD/dataforseo/SKILL.md | 2026-09-22 |
| 3 | DataForSEO Labs — ranked keywords (Google), live | per 1,000 tasks + per 1,000 items | $12.00 per 1,000 tasks ($0.012/task) + $0.12 per 1,000 items ($0.00012/item) | https://dataforseo.com/apis/dataforseo-labs-api (official, "ALL OTHER ENDPOINTS") | 2026-09-22 |
| 4 | DataForSEO Labs — keyword ideas (Google), live | per 1,000 tasks + per 1,000 items | $12.00 per 1,000 tasks ($0.012/task) + $0.12 per 1,000 items ($0.00012/item) | https://dataforseo.com/apis/dataforseo-labs-api (official, "ALL OTHER ENDPOINTS") | 2026-09-22 |
| 5 | On-Page API — instant pages | per 1,000 pages crawled | $0.15 ($0.00015/page) | https://dataforseo.com/apis/on-page-api (official) | 2026-09-22 |
| 6 | Backlinks API — summary, live | per 1,000 requests | $24.00 per 1,000 requests ($0.024/request) + $0.036 per 1,000 rows ($0.000036/row; summary returns ~0 rows) | https://github.com/seziro-team/agentsean/blob/HEAD/research/09-thirdparty-apis.md; $0.024/request corroborated by https://github.com/mcerqua/jam-skills/blob/HEAD/dataforseo/SKILL.md and https://github.com/celados/gkit/blob/HEAD/packages/gkit/docs/providers/dataforseo/backlinks.md (cost model 24036 micros = $0.024036/request) | 2026-09-22 |
| 7 | Rank Tracking API | n/a — NOT a separate product | Rank checks are SERP API calls; DataForSEO publishes a "develop your own Rank Tracking tool with DataForSEO APIs" guide built on the SERP API. Use row 1a–1c costs. | https://dataforseo.com/apis/on-page-api (mentions rank-tracker guide) | 2026-09-22 |

## OpenAI

| # | Model | Unit | Price USD | Source URL | Date checked |
|---|---|---|---|---|---|
| 8a | gpt-4o-mini — input | per 1M tokens | $0.15 | http://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence (official announcement); re-verified 2026-09-22 at https://www.economize.cloud/resources/open-ai/pricing/gpt-4o-mini/ | 2026-09-22 |
| 8b | gpt-4o-mini — output | per 1M tokens | $0.60 | same as above | 2026-09-22 |

## DataForSEO billing mechanics (relevant to metering design)

- **Minimum top-up: $50.** Trial credit: $1 on registration. No monthly fee, no monthly minimums (the old $100/mo commitment was removed 2026-07-01).
- **Credits never expire** (per help center, corroborated by multiple sources).
- **Rate update 2026-07-01:** most APIs rose ~20% (Backlinks, Labs, Domain Analytics, Content Analysis +20%; On-Page +18%; Business Data +16%; Merchant +50%). SERP API and Search Intent were NOT in the update — unchanged. Pre-update references still floating around (e.g. Keywords Data live at $0.075, Backlinks at $0.02/req, On-Page at $0.000125/page) undercount today's prices by ~20%.
- **Backlinks access:** since 2026-07-01 the separate add-on subscription is gone — pay-as-you-go, no activation gate.
- **No published volume tiers found.** DataForSEO prices flat pay-as-you-go per task; no official volume-discount ladder surfaced in this pass. (Couldn't verify whether enterprise/custom deals exist — check with their sales for committed-volume pricing.)
- **Cost multipliers to model:** SERP `calculate_rectangles` doubles the call; keyword special operators (`site:`, `filetype:`) multiply SERP cost ×5; Labs `include_clickstream_data` doubles the request; On-Page `enable_browser_rendering` is $0.0051/page vs $0.00015 basic (34×).

## Couldn't verify

- Exact current prices on dataforseo.com/pricing/* subpages (SERP, Keywords Data, Backlinks): the official pricing pages failed to load in this session, so rows 1a–1c, 2, and 6 rest on corroborating third-party sources quoting those pages (see Source URL column). Spot-check against the official pages before finalizing the credit table.
- Whether DataForSEO offers committed-volume/enterprise discounts (not published).
- OpenAI cached-input pricing for gpt-4o-mini ($0.075/1M per economize.cloud, third-party — not needed for the credit table, noted only).
