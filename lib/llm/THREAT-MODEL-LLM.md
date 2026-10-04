# Marketr — Direction B LLM routing threat model (Phase D)

Written before code, 2026-09-22. Scope: `lib/llm/anthropic.ts`, `lib/llm/router.ts`,
call-site rewiring to `getLlmProviderFor(workload)`, `scripts/benchmark-qwen-copy.mts`.

## Trust boundary

Prompts carry agency client data (keywords, site content, briefs). The router
decides which vendor receives that data. A misroute is a data-exfiltration-grade
event, not a cost event. Threats are ordered by severity.

## T1 — Client data routed to a non-ZDR / disqualified vendor (CRITICAL)

Abuse: `LLM_MODEL_COPY=deepseek-flash` (or any `gemini-*`, Alibaba Model Studio
model with unverified retention terms) is set in `.env`, on a host, or by an
attacker with env access. Agency client briefs flow to a vendor with no ZDR
(DeepSeek: China-hosted, reported training on API data) or unverified terms.

Mitigations (all in `router.ts`):
- **Hard block-list, checked before anything else:** any model string matching
  `/deepseek|gemini|qwen/i` (case-insensitive) → reject, loud `console.warn`,
  fall back to mock. Gemini-flash is blocked as a *cost-basis* regression guard
  (intro pricing doubles 2027-01-01 — never anchor to it) and DeepSeek/Qwen as
  data-residency guards.
- **Per-provider ZDR allow-list:** Anthropic accepts only ZDR-eligible models
  (`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5` — the "covered models"
  Fable/Mythos that mandate 30-day retention are absent by construction).
  OpenAI accepts only `gpt-5-nano`, `gpt-5.4-nano`, `gpt-5-nano:flex`
  (ZDR approval is a process step for Tico; the allow-list keeps ZDR-eligible
  models the only ones code can reach).
- **Unknown model strings fail closed to mock**, never to a guessed provider.
- Battery `scripts/verify-llm-routing.mts` asserts the block-list and
  allow-list behavior on every run.

## T2 — Model substitution via env override (HIGH)

Abuse: an attacker (or a careless deploy) sets `LLM_MODEL_COPY` to a frontier
model (`claude-opus-5` at $15/$75 per 1M) — cost blowout against value-priced
credits (an AI article sells for 15 credits = $0.15; Opus-class output cost
destroys the 93.7% margin the credit table assumes). Or sets it to a
non-existent model → every copy call 404s → silent outage.

Mitigations:
- One config surface: `LLM_MODEL_COPY` / `LLM_MODEL_BULK` / `LLM_MODEL_BACKGROUND`
  only. Legacy `LLM_MODEL` is honored *only* as a bulk-workload override with a
  deprecation warning, so an old env file cannot silently redirect copy traffic.
- Allow-lists bound the blast radius: only listed models can be selected at all.
- `llmStatus()` reports the resolved model per workload, so substitution is
  visible in Settings → Providers and in every API response that returns it.

## T3 — API-key leakage in logs, errors, tool results, status (HIGH)

Abuse: `ANTHROPIC_API_KEY` (or `LLM_API_KEY`/`OPENAI_API_KEY`) appears in a
thrown error, a `console.warn` about model fallback, an `llmStatus()` payload
rendered in the dashboard, an audit row, or an MCP tool result.

Mitigations:
- Adapters hold the key in a `private readonly` field and never interpolate it
  into messages. Error strings contain the provider name and HTTP status only.
- `llmStatus()` returns `{ name, isLive, configured, model }` per workload —
  `configured` is a boolean, never the key or a prefix of it.
- The Anthropic SDK is constructed with `apiKey` in code only; no key material
  is written to tool descriptions (MCP treats descriptions as untrusted input).
- Battery asserts: status JSON, fallback warnings, and error paths contain no
  substring of any configured key.

## T4 — Per-call cost blowout (MEDIUM)

Abuse: no token caps on `generate()` — a runaway agent loop or a giant prompt
(up to context-window size) multiplies cost. Credit table assumes ~2k/1.5k
tokens per article; nothing enforces that.

Mitigations (this phase):
- Router documents per-workload expected token envelopes; `generate()` takes an
  optional `{ maxTokens }` — copy workload defaults to a sane ceiling, bulk
  lower. Callers exceeding it get a clear error, not a surprise bill.
- Fail-closed on unknown models prevents the worst blowout class (T2).
- Future work (not this phase): per-workspace token budgets tied to the
  metering ledger (Phase C `UsageEvent` has integer credits; token accounting
  is a documented follow-up).

## T5 — Prompt injection through routed model output (MEDIUM)

Abuse: model output from one workload is fed as trusted input to another
(e.g. a drafted article containing "ignore previous instructions" is later
summarized by the bulk provider and acted on by the agent loop).

Mitigations:
- `LlmProvider.generate()` returns plain text; no call site executes it.
  Documented contract: **LLM output is data, never instructions** — the agent
  loop must re-validate any model-produced plan against the user's grants
  before acting (same rule as Phase B's declared-tool gating).
- Mock provider output is labeled `> **Mock draft**` so it can never be
  mistaken for a trusted draft downstream.

## T6 — ZDR posture drift (MEDIUM)

Abuse: a future contributor adds a new model to an allow-list without checking
ZDR eligibility, or swaps a default to a non-eligible model.

Mitigations:
- Allow-lists live in one place (`router.ts`) with a comment citing the ZDR
  eligibility source per entry. Adding a model requires touching that list —
  greppable and reviewable.
- Defaults are fixed to ZDR-eligible models; env override cannot widen the
  allow-list, only select within it.
- OpenAI ZDR approval is a **process step for Tico**, not code — documented in
  `lib/llm/SELF-HOST.md`; code never claims ZDR is active, only that the
  selected models are ZDR-*eligible*.

## T7 — Mock-vs-live confusion in UI status (LOW)

Abuse: operator believes real drafts are flowing while the mock serves labeled
placeholders (or vice versa), e.g. after a bad key silently falls back.

Mitigations:
- Fallback to mock always emits a loud `console.warn` naming the workload and
  the rejected model string (never the key).
- `llmStatus()` reports per-workload `{ name, isLive, configured, model }`;
  `isLive=false` is unambiguous. Existing `!llmStatus().isLive` mock-banner
  checks keep working.

## T8 — Benchmark skeleton misread as quality proof (LOW)

`scripts/benchmark-qwen-copy.mts` scores heuristics (structure, keyword
coverage, length) — it explicitly does NOT measure copy quality. The script's
header and output both state this so a passing score is never presented as
"Qwen is good enough for client copy."

## Phase 6 additions (2026-10-04): reliability, failover, single-key mode

### Adapter reliability (`openai.ts`, `anthropic.ts`, `errors.ts`)
- Every adapter error is an `LlmProviderError` with a `kind`:
  `rate_limit` (429) / `server` (5xx, unreadable body) / `timeout` /
  `network` are **retryable**; `client` (other 4xx) and `empty` are not.
  Messages carry provider, HTTP status and a whitelisted machine code only —
  never the key and never the response body (OpenAI echoes partial keys in
  auth-error text) (T3).
- OpenAI-compatible: per-attempt timeout (120 s; 15 min for `:flex`;
  `LLM_TIMEOUT_MS` overrides), the caller's AbortSignal (Phase 5 Stop) is
  combined with it and surfaces as the abort itself. ONE bounded retry with
  backoff, honouring `Retry-After` / `retry-after-ms` up to 30 s — a longer
  wait hands over to failover instead of stalling a run.
- GPT-5 family / o-series: no `temperature`, `max_completion_tokens` instead
  of `max_tokens`. `gpt-5-nano:flex` is sent as `gpt-5-nano` with
  `service_tier: "flex"`. Self-host keeps `max_tokens` + `temperature` and
  never strips a `:tag` (Ollama names use one).
- Anthropic: SDK retries bounded to 1 (it honours Retry-After), 120 s
  timeout, errors classified the same way.

### T9 — Cross-vendor failover sends the prompt to a second vendor (MEDIUM)
Abuse: a failover silently routes client data to a vendor the operator did
not choose, or to a blocked / non-ZDR model.

Mitigations (`router.ts`, `failover.ts`):
- Fallback model = the other family's default for the same workload
  (`FAMILY_WORKLOAD_DEFAULTS`), and it must pass `isRoutableHostedModel`:
  the hard block-list AND the ZDR allow-list. A blocked or unlisted model is
  never a fallback (battery asserts every family default is routable).
- Armed only when that family's key is configured — both vendors were
  deliberately configured by the operator.
- Fires only on retryable errors, after the adapter's own retry; never on
  the caller's abort and never on other 4xx (a rejected request is not
  re-sent to anyone).
- Every failover logs `[llm-router] workload=… model="…" failed: <kind>
  (HTTP n) → failing over to "…"` (no key material); the last event per
  workload is kept in-process (`lastFailover`). `llmRoutingStatus()`
  shows the armed failover model per workload in Settings → Providers.
- Off with `LLM_FAILOVER=0`, and never with `LLM_SELF_HOST=1` (a self-host
  operator chose to keep prompts on-box; see SELF-HOST.md).

### T10 — Single-key mode substitutes a model (LOW)
With one key, workloads whose model came from the **default** use the other
family's default instead of mock (e.g. only `OPENAI_API_KEY`: copy runs on
`gpt-5.4-nano`). Bounds:
- Applies to `source: "default"` only. An explicit `LLM_MODEL_*` (or legacy
  `LLM_MODEL`) is never swapped — it still falls back to mock, loudly (T2).
- The substitute passes the same block-list + ZDR allow-list check.
- Not applied with `LLM_SELF_HOST=1`.
- Visible: `llmRoutingStatus()[w].singleKey` explains the swap, and the
  Settings → Providers "What's running on mock data" list is built from the
  same status plus real env checks (`lib/providers/mock-inventory.ts`).
- Key lookup uses the first NON-EMPTY of `LLM_API_KEY` / `OPENAI_API_KEY`:
  an empty `LLM_API_KEY=""` copied from `.env.example` used to mask
  `OPENAI_API_KEY` (`??`), silently putting every OpenAI workload on mock.

## Out of scope (documented, not built)

- Token-level metering against the Phase C ledger.
- Per-workspace model allow-lists / admin UI for routing config.
- Live adapter testing (Tico's separate track; this phase is offline/mock-only).
  Phase 6 adapter behaviour is proven against stub fetches / fake providers
  only (`lib/llm/__tests__`); it is UNVERIFIED against the live APIs.
- `chat()`, tool use, streaming, new allow-listed models: Phase 7.
