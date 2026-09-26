# AI-crawler log shipping — for M3 first-party correlation

AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot,
Bytespider) fetch pages **before** engines cite them. Crawler activity in your
own server logs is therefore a *preceding indicator* of AI citation — the
honest first-party anchor behind M3's estimates.

Marketr never scrapes to get this. You ship your logs; Marketr parses them
(`parseServerLog` in `lib/intelligence/geo/first-party.ts`).

## What to ship

Any of these, newest-first:

1. **CDN / edge logs** — Cloudflare, Fastly, AWS CloudFront/Athena exports.
   Easiest: most CDNs can dump to S3 on a schedule.
2. **Origin web-server logs** — nginx `access.log` / Apache combined format.
3. **A filtered tail** — if full logs are heavy, ship only lines whose
   user-agent matches one of: `GPTBot`, `OAI-SearchBot`, `ClaudeBot`,
   `Claude-User`, `PerplexityBot`, `Bytespider`, `Google-Extended`,
   `ChatGPT-User`, `anthropic-ai`, `cohere-ai`.

Minimum useful window: **30 days** (crawl → citation lag is measured in weeks).

## Format

Common Log Format or combined — one request per line, with the user-agent
field intact. Example line we parse:

```
203.0.113.1 - - [26/Sep/2026:10:00:00 +0000] "GET /pricing HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"
```

What we extract per bot: hit counts, first/last seen dates, and the paths
crawled (query strings stripped). Paths tell you *which* pages the engines
are reading — cross-reference with the citation-gap report: pages crawled
but never cited are your highest-leverage fixes.

## Privacy

Logs stay in your workspace (RLS-isolated). Only aggregate bot counts and
path prefixes feed the M3 dashboard — raw IPs are never displayed.

## Coming next

Scheduled ingestion (nightly CDN-export pull) and crawl→citation lag
measurement ("GPTBot fetched /pricing 19 days before Perplexity first cited
it"). Today: manual upload / paste into the first-party tab.
