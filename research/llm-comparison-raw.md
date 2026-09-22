# LLM comparison — raw research for Marketr

**Checked:** 2026-09-22 via web search. Nothing below is from training memory.
**Marketr context:** the LLM layer is OpenAI-compatible (`LLM_BASE_URL` + `LLM_MODEL`), so any OpenAI-compatible endpoint works. Workloads: marketing copy (articles, briefs — quality matters), agent loop with tool calling (reliability matters), summarization (bulk — cost matters).

## 1. Price table (USD per 1M tokens, standard tier)

| # | Provider | Model (current name, Sept 2026) | Input | Output | Context | Source |
|---|---|---|---|---|---|---|
| 1 | OpenAI | `gpt-5-nano` | $0.05 | $0.40 | 400K (conflicting reports — see §6) | https://openrouter.ai/openai/gpt-5-nano ; https://tokenmix.ai/blog/gpt-5-nano-benchmarks-api-access-use-cases-2026 |
| 1b | OpenAI | `gpt-5-nano:flex` (flex/deprioritized tier) | $0.02 | $0.20 | 400K | https://www.requesty.ai/models/openai/gpt-5-nano-flex |
| 1c | OpenAI | `gpt-5.6-luna` | $0.20 | $1.20 | ~400K (5.6 family) | https://www.cloudzero.com/blog/openai-pricing/ (updated 2026-09-04); https://github.com/parhumm/product-excellence/blob/HEAD/docs/researches/api-pricing-claude-openai.md |
| 1d | OpenAI | `gpt-5.4-nano` | $0.20 | $1.25 | 400K | https://vibecodedthis.com/blog/gpt-5-4-mini-nano-openai-small-models-coding/ ; https://github.com/jadaross/bower/blob/HEAD/docs/research/model-pricing.md |
| 1e | OpenAI | `gpt-4o-mini` (still served) | $0.15 | $0.60 | 128K | https://www.clawrouters.com/blog/claude-haiku-4-5-api-pricing-2026 ; https://ainexustools.online/blog/ai-api-pricing-comparison-2026/ |
| 1f | OpenAI | `gpt-4.1-nano` | $0.10 | $0.40 | 1M | https://github.com/launchpadlab/ai-bank/blob/HEAD/resources/documentation/choosing_claude_openai_models_and_effort.md |
| 2 | Anthropic | `claude-haiku-4-5` | $1.00 | $5.00 | 200K (see §6) | https://www.clawrouters.com/blog/claude-haiku-4-5-api-pricing-2026 ; https://platform.claude.com/docs/en/about-claude/pricing (via https://github.com/chaitanyagiri/munder-difflin/blob/HEAD/blog/src/posts/how-much-does-claude-code-cost.md) |
| 3 | Google | `gemini-3.8-flash` | $0.75 | $3.75 | 1M | https://ai.google.dev/gemini-api/docs/pricing (via https://github.com/graysonhyc/ai-guides/blob/HEAD/guides/gemini-38-flash-vs-claude-opus-5-benchmark-report.md ; https://abhs.in/blog/google-gemini-3-8-flash-fairwind-cyber-075-pricing-developer-guide-2026) |
| 3b | Google | `gemini-3.5-flash-lite` | $0.30 | $2.50 | 1M | https://aiseoshift.com/blog/gemini-pricing-2026/ |
| 3c | Google | `gemini-2.5-flash-lite` | $0.10 | $0.40 | 1M | https://aiseoshift.com/blog/gemini-pricing-2026/ ; https://anotherwrapper.com/tools/llm-pricing |
| 4 | DeepSeek | `deepseek-flash` (V4.1 Flash) | $0.30 peak / $0.15 off-peak | $1.20 peak / $0.60 off-peak | 1M | https://benchlm.ai/deepseek/api-pricing ; https://felloai.com/deepseek-pricing/ |
| 4b | DeepSeek | `deepseek-v4-pro` | $1.32 peak / $0.66 off-peak | $3.96 peak / $1.98 off-peak | 1M | https://benchlm.ai/deepseek/api-pricing ; https://www.morphllm.com/deepseek-api |
| 5 | Alibaba (Qwen) | `qwen3.5-flash` (Model Studio) | $0.10 | $0.40 | 1M | http://benchlm.ai/alibaba/api-pricing |
| 5b | Alibaba (Qwen) | `qwen3.5-plus` | $0.40 ($0.50 above 256K input) | $2.40 | 1M | http://benchlm.ai/alibaba/api-pricing |
| 5c | Alibaba (Qwen) | `qwen3.8-max` | $2.00 | $6.00 | 1M | https://www.techrepublic.com/article/news-alibaba-qwen3-8-max-pricing-open-weights/ |

**Price notes:**
- **DeepSeek peak hours:** 01:00–04:00 and 06:00–10:00 UTC; all other hours off-peak (50% of peak). Pre-2026-08-16 flat rates ($0.14/$0.28 flash) are stale — do not use them. Source: https://techjacksolutions.com/ai-tools/deepseek/deepseek-pricing/
- **Gemini 3.8 Flash is introductory:** $0.75/$3.75 through 2026-12-31, then $1.50/$7.50 from 2027-01-01 per Google's published schedule. Budget 2027 at the higher band. Source: https://github.com/brainmox/agent-365/blob/HEAD/journal/2026/09/2026-09-04-intro-price-launch-window.md
- **OpenAI cached input** is 10% of standard on GPT-5 family; Batch API is 50% off. Anthropic cache reads are 10% of input. These matter for agent loops with repeated system prompts.
- **Gemini 3.1 Pro** has a standing long-context surcharge: prompts over 200K tokens double input to $4/M and lift output to $18/M. Source: https://www.cloudzero.com/blog/token-based-pricing/

## 2. Tool / function-calling quality

| Model | Tool-calling support | Evidence |
|---|---|---|
| gpt-5-nano | Yes — tools, tool_choice, structured outputs (JSON schema) | https://openrouter.ai/openai/gpt-5-nano |
| gpt-5.4-nano / mini | Yes — function calling, MCP, structured outputs | https://vibecodedthis.com/blog/gpt-5-4-mini-nano-openai-small-models-coding/ |
| claude-haiku-4-5 | Mature tool-use API; strong community reputation for instruction-following and agentic reliability in its tier | General community consensus (e.g. https://www.clawrouters.com/blog/claude-haiku-4-5-api-pricing-2026 — "delivers noticeably stronger instruction-following"); specific BFCL scores for Haiku 4.5 not verified (§6) |
| gemini-3.8-flash | Engineered for "long-running agentic loops"; DeepSWE v1.1 71–73.7% (near Claude Opus 5's 74%), MCP Atlas 83.6% (3.5 Flash) | https://evrimagaci.org/gpt/google-unveils-gemini-38-flash-amid-ai-rivalry-545028 ; https://tradingkey.com/analysis/stocks/us-stocks/262147019-gemini-3-8-flash-google-ai-agent-coding-cybersecurity-token-pricing-tradingkey |
| deepseek-flash (V4.1) | Open-source SOTA in agentic coding (V4, vendor-reported); widely used as Claude Code alternative via Anthropic-compatible endpoint | https://www.cloudzero.com/blog/deepseek-pricing/ ; https://github.com/mshadmanrahman/claudecode-guide/blob/HEAD/content/docs/foundations/alternative-models.mdx |
| qwen3.5-flash / plus | Function calling supported; Qwen3.7-Max scored 75.0 on BFCL-V4 ("function calling leader" in its class) | https://github.com/kzinmr/ai-topics-cn/blob/HEAD/wiki/research/findings-qwen-2026-05-26.md ; https://github.com/MemberJunction/MJ/pull/2650 |

## 3. Marketing-copy quality reputation

- **Claude (Haiku 4.5 / Sonnet 5 / Opus 5):** the consistent winner in 2026 copywriting comparisons. An April 2026 benchmark called Claude "still the best raw writing model for natural tone, long-form coherence, and low-edit drafts"; a 47-client-project test found Claude drafts needed less editing and won on B2B conversion. Opus 5 tops the EQ-Bench Creative Writing board. Caveat: these tests skew toward the larger Claude models; Haiku 4.5 inherits the family style but specific long-form benchmarks for Haiku 4.5 were not verified. Sources: https://medium.com/@kagendoluckyann/claude-vs-chatgpt-for-copywriting-in-2026-i-tested-both-for-47-client-projects-6d2f0f663bc1 ; https://max-productive.ai/blog/best-llm-for-writing/
- **GPT-5.6 Sol:** tests stronger than Claude on outlines, briefs, and SEO structure; weaker on voice/prose. The max-productive.ai ranking recommends GPT-5.6 Sol for briefs/structure with Claude doing the prose pass. Source: https://max-productive.ai/blog/best-llm-for-writing/
- **Gemini 3.1 Pro:** "near-frontier drafts at roughly a fifth of Claude's token price" — the recommended volume drafter. Source: https://max-productive.ai/blog/best-llm-for-writing/
- **DeepSeek / Qwen cheap tiers:** no 2026 source found specifically benchmarking their long-form marketing copy against Claude/GPT. Community reputation is strong for code and reasoning, mixed-to-quiet on marketing prose. Flagged as unverified — test before committing copy workloads.

## 4. Privacy / zero-data-retention posture (matters for agency client data)

| Provider | ZDR / retention posture | Source |
|---|---|---|
| OpenAI | ZDR available for eligible API customers (approval-based); reaffirmed 2026-08-19 with "Private Safety Processing". Default API: no training on API data unless opted in; 30-day abuse-monitoring retention. ZDR forces `store:false`, rules out background mode/extended caching. | https://di1.ai/2026/08/22/openai-reaffirms-zero-data-retention-and-previews-cross-sess/ ; https://7minai.com/news/openai-zdr-private-safety-processing/ |
| Anthropic | ZDR available for qualified commercial API orgs (Messages API, token counting). Default 30-day retention (reducible). **Caveat:** frontier "covered models" (Fable 5/5.1, Mythos 5/5.1) mandate 30-day retention and are excluded from ZDR; Haiku 4.5 / Sonnet 5 / Opus 5 are ZDR-eligible. Enterprise Frontier Safeguards (announced 2026-09-01) move safety logs into customer cloud. | https://thenexusforge.net/claude-api-data-policy/ ; https://innfactory.ai/en/ai-models/anthropic-claude/ ; https://vantagepoint.io/blog/ai/anthropic-enterprise-frontier-safeguards-zero-obligation |
| Google (Gemini) | ZDR offered on an enterprise/request basis (default ~30-day abuse-monitoring retention). **Caveat:** the free API tier may use content to improve products — never use the free tier for client data. Vertex AI has stronger contractual data handling. | https://github.com/jnamaya/safi/commit/ad38ece56bbdd35c60cb9937af3e2d8fd474edf8 ; https://aiseoshift.com/blog/gemini-pricing-2026/ |
| DeepSeek | **No ZDR. Hosted in China; analyses report API data may be used for training.** Not suitable for agency client data without legal review. | https://github.com/jnamaya/safi/commit/ad38ece56bbdd35c60cb9937af3e2d8fd474edf8 |
| Alibaba (Qwen) | Data-retention terms for Model Studio international not verified in this pass — **flagged**. Treat as unverified; review the Model Studio terms before routing client data. | — |

## 5. OpenAI-compatibility (drop-in for Marketr's `LLM_BASE_URL` design)

| Provider | OpenAI-compatible endpoint | Notes |
|---|---|---|
| OpenAI | Yes (native) | — |
| DeepSeek | Yes — `https://api.deepseek.com`, OpenAI wire format, change base URL + model name | https://www.morphllm.com/deepseek-api |
| Qwen | Yes — DashScope/Model Studio exposes OpenAI-compatible mode (`DASHSCOPE_BASE_URL`, `DASHSCOPE_API_KEY`) | https://www.marktechpost.com/2026/09/18/alibaba-qwen-releases-qwen3-8-omni-flash/ |
| Google | Yes — `generativelanguage.googleapis.com/v1beta/openai/` OpenAI-compat path exists; native SDK is separate | General knowledge — verify against ai.google.dev before wiring |
| Anthropic | **No** — native Messages API. Third-party adapters (e.g. via LiteLLM/OpenRouter) can bridge it, but it is not a base-URL swap | General knowledge |

## 6. Self-host pick: Qwen3.8-27B

- **Weights:** released 2026-08-14, **Apache 2.0**. 27B dense multimodal.
- **Single-GPU fit:** quantizes to ~14–17GB at 4-bit → fits a 24GB consumer GPU (e.g. RTX 4090). 262K context (practical length depends on runtime/memory).
- **Quality in its class:** Artificial Analysis Intelligence Index 52 vs 38 for Qwen3.6-27B and 35 for Meta's Muse Glimmer 30B — "not a close race in its size class."
- **Tool calling:** validated — structured tool calling and tool-eval-bench 92.3/100 measured on real hardware (vLLM + NVFP4, NVIDIA forums guide); vLLM measured 18/18 native calls correct in one benchmark; one independent benchmark scored it 8.3/10 on tool-calling with a fail on multi-turn chaining (T2). Honest read: good single-shot tool use, weaker on long chained tool sequences than frontier APIs.
- **Copy quality:** the sources found benchmark coding/reasoning/agentic — **no verified marketing-copy evaluation**. Test on Marketr's brief/article prompts before trusting it with client-facing prose.
- **Serving:** vLLM (production), Ollama / llama.cpp / SGLang all have community guides; OpenAI-compatible endpoints via vLLM drop into Marketr's `LLM_BASE_URL` design.
- Sources: https://github.com/pinggy-io/pinggy_website/blob/HEAD/content/blog/best_open_source_self_hosted_llms_for_coding.md ; https://forums.developer.nvidia.com/t/qwen3-8-27b-nvfp4-on-single-dual-dgx-spark-sglang-dflash2-fully-openai-compatible/380732 ; https://github.com/aachtenberg/cfoperator/blob/HEAD/benchmarks/qwen3.8-27b-vs-gemma4-26b.md ; https://alphasignal.ai/news/prismml-squeezes-qwen3-8-27b-into-5-9-gb-with-98-performance-retained
- **Runners-up:** GLM-5.3-Flash (MIT, 320B/18B MoE, 1M ctx — needs an 8-GPU node, not single-GPU); DeepSeek V4 Flash quantized (dual RTX 4090s, not single).

## 7. Couldn't verify / conflicts

1. **gpt-5-nano context window:** OpenRouter lists 400K; Requesty/Azure lists 200K for the Azure deployment; tokenmix.ai says 400K context with 8,192 typical max output while Requesty says 128K max output. Treat 400K context as likely, max output as uncertain.
2. **claude-haiku-4-5 context window:** priced consistently at $1/$5 everywhere, but no source in this pass stated its exact context window. Older Haiku generations were 200K; do not assume — check Anthropic's model docs.
3. **Haiku 4.5 long-form copy benchmarks:** family reputation is strong; model-specific copy benchmarks not found.
4. **DeepSeek V4 Pro current rate:** sources disagree between the old flat $0.435/$0.87 and the new peak/off-peak $1.32/$3.96 / $0.66/$1.98 (post-2026-08-16). The peak/off-peak structure is the newer official posture; spot-check api-docs.deepseek.com before budgeting.
5. **Qwen Model Studio data retention terms:** not verified.
6. **Google OpenAI-compat endpoint specifics:** existence is well-established but not re-verified against current docs in this pass.
7. **Marketing-copy benchmarks for DeepSeek/Qwen cheap tiers:** not found — test in-house.

## 8. Bottom-line picks for Marketr

- **Cheapest API:** `gpt-5-nano` at **$0.05/$0.40** (standard tier; `$0.02/$0.20` on the flex/deprioritized tier). Non-OpenAI floor: Qwen3.5 Flash and Gemini 2.5 Flash-Lite at $0.10/$0.40. Note this is ~3× cheaper than the gpt-4o-mini ($0.15/$0.60) the spec's credit table was modeled on — the table's ~4× markup absorbs it as margin.
- **Best quality-per-dollar:** `deepseek-flash` (V4.1) at **$0.15/$0.60 off-peak** ($0.30/$1.20 peak), 1M context, near-frontier quality, open weights (MIT) — **but** no ZDR and China-hosted, which is a real problem for agency client data. **Privacy-safe runner-up:** `gpt-5.6-luna` at **$0.20/$1.20** with OpenAI ZDR available on approval.
- **Copy-quality pick (client-facing prose):** Claude Haiku 4.5 ($1.00/$5.00) — the writing reputation is unmatched in the cheap tier. Since Marketr value-prices AI content actions (15 credits = $0.15/article vs ~$0.001 raw LLM cost), the model choice barely moves unit economics — route copy generation to the best writer, bulk summarization to the cheapest reliable model.
- **Self-host pick:** Qwen3.8-27B (Apache 2.0, single 24GB GPU, validated tool calling) — best fit for the "private workspace / no data leaves the box" story; keep an API model as fallback for chained tool sequences and untested copy workloads.
