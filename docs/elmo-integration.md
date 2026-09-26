# Elmo × Marketr M3 — integration guide

**Status:** optional sidecar for self-hosters. Marketr's M3 AI-visibility layer
works standalone (its own versioned prompt panels + N-rep runner in
`lib/intelligence/geo/`, official LLM provider APIs, BYO keys). This doc
describes how a self-hoster can *also* run the Elmo Docker sidecar and point
Marketr at its REST API.

## What Elmo is (verified 2026-09-26)

- Public repo: **github.com/elmohq/elmo** — MIT-licensed (Copyright 2026 Blue
  Whale Software, LLC), actively developed (~1,036 commits, 23 releases).
- Self-hostable via Docker Compose; has a REST API; stores raw engine output
  in PostgreSQL.
- Marketr's license posture: MIT is AGPL-compatible, so referencing its API
  from Marketr (AGPLv3 + commercial) is clean. **We do NOT vendor the Elmo
  monorepo** — the sidecar is a separate deployment you run yourself.

## CRITICAL DEVIATION — documented, enforced

Elmo's default worker uses **scraping providers that capture consumer chat
UIs** (ChatGPT, Perplexity web surfaces, etc.). Marketr's SPEC-PHASE10 §2
boundary map **forbids scraping chat UIs** — hard line, no exceptions,
enforced in M7's legal-boundary tests.

Therefore, when pointing Marketr at Elmo, you MUST configure Elmo in
**direct model API mode only**:

- Use Elmo's provider integrations for **OpenAI / Anthropic / Mistral /
  OpenRouter** (official APIs, your own keys) **with web search enabled**
  where the provider supports it.
- **Disable every scraping-based provider** in the Elmo worker config.
  If an Elmo release ever removes the direct-API path, stop using the sidecar
  — Marketr's built-in runner (`lib/intelligence/geo/runner.ts`) remains the
  supported path and never scrapes.

Marketr's side of this is enforced in code: `resolveGeoEngine()` only
constructs official-API providers (OpenAI, Anthropic native SDK, Gemini and
Perplexity via their official OpenAI-compatible endpoints). There is no code
path — and no configuration flag — that reaches a chat UI.

## Methodology mapping (Elmo concepts → M3 concepts)

| Elmo | Marketr M3 |
|---|---|
| Prompt library / tracking sets | `geo_prompt_panel` — versioned, frozen 12–25 buyer prompts, never swapped weekly |
| Scheduled checks | `cadence` on the panel + `/api/intelligence/geo/run` (operator/scheduler trigger) |
| Raw engine responses in Postgres | `geo_observation` — raw per-rep rows, never aggregated at write time |
| Visibility dashboards | `/dashboard/intelligence/ai-visibility` — per-engine ranges with Wilson 95% CI, N-rep stability, leader-flip rate, `unstable_share > 30%` flag. **No single AI-visibility score exists, by design.** |
| — | First-party correlation (GSC AI-Overview impressions, GA4 AI-referrer traffic, AI-crawler log parsing) and citation-gap → brief handoffs — M3-only, no Elmo equivalent |

## Sidecar setup (self-hosters)

1. Clone and start Elmo per its own README (Docker Compose; bring your own
   Postgres or use its bundled one).
2. In Elmo's worker/provider config, **enable only direct-API providers**
   (OpenAI/Anthropic/Mistral/OpenRouter) and **disable all scraping
   providers**. Verify by checking Elmo's worker logs: you should see API
   calls, never browser-automation traffic.
3. Point Elmo at the same prompt sets you freeze in Marketr's panels (export
   from `/api/intelligence/geo/panels`) so the two systems measure the same
   questions.
4. Treat Elmo's numbers as a **second opinion**, not ground truth: M3's
   honest-labeling contract (per-engine Wilson CIs, stability scores) applies
   to any Elmo-sourced data you import. If Elmo reports a single blended
   score, ignore it — the per-engine spread is the metric.

## FAQ

**Can the hosted Marketr use the Elmo sidecar?** No — the hosted product only
ships Marketr's built-in runner (official APIs, BYO keys). The sidecar is a
self-host option.

**What if I need engines Elmo covers that M3 doesn't?** Extend
`GEO_ENGINES`/`GEO_ENGINE_MODELS` in `lib/intelligence/geo/panels.ts` with an
official-API provider. Never add a scraping provider — the §2 boundary is
structural.
