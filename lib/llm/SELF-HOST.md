# Marketr — self-host LLM path & ZDR posture (Phase D)

## Self-host (recommended): Qwen3.8-27B via vLLM

Apache 2.0, fits a single 24 GB GPU via vLLM, exposes an OpenAI-compatible
endpoint, validated single-shot tool calling. Wire it in:

```bash
LLM_SELF_HOST=1
LLM_BASE_URL=http://localhost:8000/v1   # your vLLM server
LLM_API_KEY=dummy                       # vLLM default; any non-empty value
LLM_MODEL_BULK=qwen3.8-27b              # or your served model name
LLM_MODEL_BACKGROUND=qwen3.8-27b
LLM_MODEL_COPY=qwen3.8-27b              # see caveat below
```

Behavior with `LLM_SELF_HOST=1`:
- The ZDR allow-list is bypassed for the OpenAI-compatible adapter (your data
  never leaves your box, so vendor retention terms don't apply).
- The hard block-list (`deepseek`, `gemini`) still applies — those families
  stay unroutable even self-hosted.
- Qwen-class models are *only* routable with `LLM_SELF_HOST=1`. Without it,
  `qwen*` falls back to mock: Alibaba Model Studio retention terms are
  unverified, so cloud-hosted Qwen must never receive client data silently.

**Caveat (do not skip): marketing-copy quality for Qwen3.8-27B is UNVERIFIED.**
Run `npx tsx scripts/benchmark-qwen-copy.mts` against your endpoint before
routing client-facing copy to it. The script scores structure/heuristics only —
it is not a quality proof. Until you are satisfied, keep `LLM_MODEL_COPY`
pointed at the hosted default (`claude-haiku-4-5`).

## API fallback for chained tool sequences

The self-host model is validated for single-shot tool calling, not long
chained agentic sequences. For the agent loop / skill runs, keep an API
fallback available: if `getLlmProviderFor("bulk").generate()` throws on the
self-hosted endpoint, callers may retry once against the hosted bulk default
(`gpt-5-nano`) before failing. This is a caller-side pattern, intentionally
not built into the router — the router never silently substitutes vendors
(T2). Implement the retry where the loop lives (`lib/chat/agent.ts`,
`lib/seo/autopilot-service.ts`) when self-host is adopted.

## ZDR posture

- Code routes hosted traffic **only** to ZDR-eligible models
  (`lib/llm/router.ts`: `ANTHROPIC_ZDR_MODELS`, `OPENAI_ZDR_MODELS`).
- "ZDR-eligible" ≠ "ZDR active". OpenAI ZDR requires an approved ZDR request
  on the API org — **that is a process step for Tico, not code.** Anthropic
  ZDR requires a qualified commercial org. Until those approvals land, API
  traffic is under the vendors' default retention (no training on API data;
  ~30-day abuse-monitoring retention).
- "Zero data retention" is the agency-tier selling point: it becomes true when
  (a) the approvals above are in place and (b) the account is configured with
  `store:false` (OpenAI) / ZDR-enabled org (Anthropic). Code is ready for that
  day; it does not claim it today.
- Self-hosted (`LLM_SELF_HOST=1`) is ZDR-by-construction: prompts never leave
  the operator's infrastructure.
