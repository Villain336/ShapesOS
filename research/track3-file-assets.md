# TRACK 3 — File/Asset Knowledge Systems Landscape
**Research date:** 2026-09-22 · **Status:** READ-ONLY research, no code, no purchases · **Vault-private**

How do products let users bring existing files into an agent's context — connectors vs. upload, indexing/RAG vs. attach/reference — and what open-source pieces could Marketr borrow?

---

## 1. How products get files into agent context

### 1a. Managed AI products (consumer/prosumer)

**ChatGPT — Projects + custom GPTs (OpenAI)**
- **Pattern:** Manual upload per-Project "knowledge files" + per-chat attachments. Also "connectors" on business plans (admin-configured) and GPTs' Knowledge retrieval.
- **Limits (as reported, see flags):** Free: Projects since Sept 2025, 5 files/project; Plus ($20/mo): ~25 files/project; Edu/Pro/Business/Enterprise: ~40 files/project.
- **Retrieval:** File search / RAG over project files; per-chat uploads are one-shot context, project files persist across chats.
- **Citation:** Reported as spotty — summarization is decent, citations sometimes hallucinated (per Elephas comparison).
- **Who:** OpenAI. **Adoption:** hundreds of millions of weekly users globally (public figure; exact current number not re-verified today). **Pricing:** Free / Go $8 / Plus $20 / Pro $100–$200.

**Claude — Projects knowledge (Anthropic)**
- **Pattern:** Upload into a Project's Knowledge section (persists across every chat in the project); per-chat attachments up to 20 files.
- **Limits:** 30 MB per file; unlimited file count on paid as long as content fits context, **RAG auto-scales knowledge ~10× when it approaches the context limit** on paid plans (Pro/Max/Team/Enterprise). Free: 5 projects, no RAG scaling.
- **Sharing/permissions:** Team/Enterprise projects shareable with per-member view/edit levels. Projects are flat — they don't nest, and one project can't read another's knowledge.
- **Types:** PDF, DOCX, CSV, TXT, HTML, ODT, RTF, EPUB, JSON, XLSX (text extraction; images in docs aren't read). Chat uploads: 500 MB/file, multimodal.
- **Who:** Anthropic. **Pricing:** Free / Pro $20 / Max $100+ / Team $25–30 seat.

**NotebookLM / Gemini Notebook (Google)**
- **Pattern:** Source-based notebooks — the purest "reference not retrieve" model: upload or link sources (Docs, PDFs, URLs, YouTube, audio), chat is grounded *only* on them. Local RAG per notebook.
- **Limits:** Free: 100 notebooks, 50 sources/notebook, 50 chats/day; Google AI Plus ($4.99): 200 notebooks, 100 sources; Pro ($19.99): 500 notebooks, 300 sources; Ultra ($99.99–199.99): up to 600 sources, 5,000 chats/day. Also bundled free in Google Workspace business tiers.
- **Citation:** Inline source citations + audio/video overviews (podcast-style briefings).
- **Who:** Google. **Adoption:** very large — Google's flagship AI research product, free tier extremely generous (50 sources/notebook free vs. ChatGPT's 5).

**Perplexity (Perplexity AI)**
- **Pattern:** File attachments on queries + **Spaces** (per-project collections with custom instructions). Inline citations on every answer are the signature feature.
- **Limits:** File uploads on Pro ($20/mo); document analysis reported as less comprehensive than ChatGPT Projects.
- **Citation:** Inline, clickable citations — best-in-class provenance UX among consumer products.

### 1b. Enterprise knowledge products

**Dust (dust.tt — Paris, founded 2023)**
- **Pattern:** Connector-first (100+ connectors: Slack, Notion, GitHub, Google Drive, Salesforce, Zendesk, Jira, Confluence, HubSpot, BigQuery, Snowflake) + upload; model-agnostic agents (OpenAI/Anthropic/Google/Mistral) grounded on synced company data. Exposed via REST API, MCP servers (client + server side), Slack/Chrome/Raycast/CLI.
- **Core is open source (MIT)** at `dust-tt/dust` — **1,472 stars** (verified via GitHub API today).
- **Pricing:** Pro 29 EUR/user/mo, Enterprise (100+ seats) custom. SOC 2 Type II / GDPR / HIPAA-ready, EU residency.
- **Permissions:** Connectors sync with source permissions; per-user scoping. (Detailed ACL mechanics not verified from primary docs in this pass — flagged.)

**Glean (founded 2019)**
- **Pattern:** 275+ connectors crawl and index workplace systems into a central store; semantic + keyword hybrid search; RAG answers grounded in the index.
- **Permissions:** Permission-aware indexing is the benchmark implementation — source ACLs (users/groups per doc) synced at ingest, identity resolution across systems, **filter-then-rank at query time** (only visible docs are ever scored; never post-filter, never ask the LLM to withhold). Revocation must propagate faster than content changes — ACLs on a tighter sync loop than content. Filtered even at typeahead/facet level (counts of hidden results are themselves a leak).
- **Who built it:** Arvind Jain (ex-Google, co-founder of Rubrik). **Adoption:** $4.6B valuation (reported 2025-era figure; current number not re-verified today). **Pricing:** quote-based enterprise only.
- **Limitation to note:** indexing-based = staleness lag (minutes–hours); central copy = larger security surface vs. federated retrieval.

**Guru (getguru.com)**
- **Pattern:** "Cards" (verified knowledge units) with owner + verification interval + auto-stale-flagging; **Knowledge Agents** answer with citations restricted to verified content; 100+ source connectors with permission-aware ingestion; **MCP server** exposing governed knowledge to other AI tools (Claude, ChatGPT, Cursor, Copilot).
- **Permissions:** Permission-aware answers; automated DLP/PII redaction before indexing; RBAC, SSO/SCIM.
- **Pricing: ⚠️ sources conflict** — older trackers show Starter ~$10/user/mo, AI plan ~$20/user/mo; 2026 reviews (eesel.ai, aiproductivity.ai) report **fully enterprise, no public pricing, no free tier, ~$25/seat floor historically**, plus usage-based **AI Credits**. Flag as unresolved.
- **Adoption:** TrustRadius 9.0/10; positioned mid-market → enterprise support/HR/sales teams.

---

## 2. Permission models & provenance — the patterns that matter

| System | Permission enforcement | Provenance/citation |
|---|---|---|
| Glean | Index-time ACL sync, per-user filter-then-rank, tight revocation loop | Source links on results |
| Dust | Connector-scoped sync, per-user access | Citations from synced docs (via RAG) |
| Guru | Permission-aware ingestion, DLP redaction, verified-only answers | Citations restricted to verified Cards |
| Claude Projects | Uploader-owned files; per-member view/edit on shared projects | Manual, model-generated |
| ChatGPT Projects | Uploader-owned; Teams/Business workspace connectors admin-scoped | Spotty (hallucinated citations reported) |
| NotebookLM | Notebook-level (your sources, your access) | Inline source citations |
| Perplexity | Space-level (your uploads) | Inline citations — best consumer UX |

**Design takeaways for Marketr:**
1. **Filter-then-rank is mandatory** — permission filtering happens in the retrieval layer before scoring, never as post-processing or by prompting the LLM. (Glean's model is the reference.)
2. **ACL sync frequency must exceed content sync frequency** — a permission revoked must disappear from results before the re-crawl finishes; revocation lag is a security bug, not a freshness bug.
3. **Two scoping tiers recur everywhere:** workspace/org-level (connectors: Drive/Notion/S3) vs. project-level (uploaded files scoped to one client project). Manual uploads are inherently "uploader owns" — the ACL problem only appears with connectors, where each connector's per-document ACL must be normalized to a unified principal model (same human across Google/Slack/Jira) and expanded/cached group memberships.
4. **Citations are the trust currency:** Perplexity, NotebookLM, and Guru all make source citations first-class. Anything Marketr retrieves should carry `source_file + page/section + connector` metadata back to the answer.

---

## 3. Notable open-source implementations

All star counts **verified via GitHub API on 2026-09-22**:

| Project | Stars | License | What it is / relevance to Marketr |
|---|---|---|---|
| **Dify** (`langgenius/dify`) | **156,848** | Apache 2.0 | Agentic workflows + RAG pipelines + knowledge bases with rich model/tool support; collaborative. Largest OSS AI-app platform by stars. Reference architecture for knowledge + agent + tooling in one product. |
| **Open WebUI** (`open-webui/open-webui`) | **152,795** | MIT/BSD-style | User-friendly LLM interface, Ollama/OpenAI backends, built-in RAG ("Knowledge"/collections), Pipelines plugin system, TTS/STT, image gen. Closest OSS analog to a hosted chat+knowledge product UI. |
| **AnythingLLM** (`Mintplex-Labs/anything-llm`) | **66,321** | MIT | The RAG-workspace specialist: drag-drop doc ingestion, built-in LanceDB (9+ vector DB options), workspace isolation + RBAC, multi-user, no-code agent builder, native MCP. Desktop free forever; Docker self-host free; Cloud Basic $50/mo (<5 users, <100 docs), Pro $99/mo, Enterprise custom. 30+ LLM providers, embeddable widget, Community Hub. YC-backed. **Strongest single OSS reference for Marketr's file/workspace design.** |
| **LlamaIndex** (`run-llama/llama_index`) | **52,275** | MIT | Document-processing/RAG framework — ingestion, parsing, indexing, query engines. A toolkit, not an app; what you'd build Marketr's RAG on. |
| **Khoj** (`khoj-ai/khoj`) | **37,461** | **AGPL-3.0** | Self-hostable "AI second brain": semantic search over personal docs, web answers, custom agents, scheduled automations, local or cloud LLMs. License matches Marketr's AGPLv3 posture. |
| **Haystack** (`deepset-ai/haystack`) | **26,579** | Apache 2.0 | Production RAG orchestration framework (deepset, Berlin) — pipelines, evaluation, hybrid retrieval. Framework, not app. |
| **Dust core** (`dust-tt/dust`) | **1,472** | MIT | The enterprise connector+agent platform's actual codebase is OSS — useful as a connector-implementation reference despite low stars (stars concentrate on the hosted product). |

**Adoption evidence (beyond stars):** AnythingLLM is repeatedly cited as the most-used self-hosted RAG workspace in 2026 comparisons (~139K–153K is Open WebUI; AnythingLLM ~60–66K; both cited as the two dominant self-hosted AI interfaces). Dify is the most-starred AI app-builder on GitHub overall in this category. All four show active 2026 release cadence per review sources.

---

## 4. Vector DB / embedding options for self-hosted RAG (brief)

Consensus from 2026 production comparisons (aifoss.dev, dev.to, awesome-rag-production):

| Engine | When to use | Notes |
|---|---|---|
| **pgvector** | Already run Postgres; <1M–10M vectors | One `CREATE EXTENSION`; ACID with app data; SQL filtering; HNSW capped at 2000 dims; degrades past ~50M vectors. **Default choice if Marketr's app DB is Postgres** (no new infra). |
| **Qdrant** | Production RAG with 1M+ vectors, heavy metadata filtering | Apache 2.0; Rust; single Docker container; native payload pre-filtering; scalar quantization (4× memory); sparse+dense hybrid. Most-recommended dedicated vector DB for new projects. |
| **Weaviate** | Hybrid keyword+vector out of the box | Built-in BM25 + vector in one query. |
| **LanceDB** | Embedded/desktop use | What AnythingLLM ships by default; no server. |
| **Chroma** | Prototypes only | Falls apart under concurrent load — don't ship on it. |
| **Milvus** | 50M–500M+ vectors | Multi-service ops (etcd, MinIO) — heavyweight for Marketr's scale. |

**Embedding models (not re-verified today):** OpenAI `text-embedding-3-large` truncated to 1536 dims via Matryoshka is the common pragmatic pick (~98–99% retrieval quality retained); open options (nomic-embed, BGE) for fully local. Re-embedding cost on model change is real — schema must allow re-indexing.

---

## 5. Synthesis for Marketr

**Recurring architecture across all winners:**
1. **Two ingestion paths:** (a) manual upload → project-scoped knowledge, (b) OAuth connectors (Drive/Notion/Dropbox/S3) → workspace-scoped, permission-synced knowledge. Marketr needs both — agencies live in Drive/Notion, client projects need upload.
2. **RAG, not context-stuffing, at scale:** Claude auto-RAG at ~10× context, AnythingLLM/Dify/Open WebUI all RAG-first. Small files can go straight to context; large libraries must index.
3. **Workspace vs. project scoping is universal:** every system has the org/workspace layer (connectors, teams) and the project layer (files, instructions). Marketr's "workspace + per-project" requirement matches industry shape exactly.
4. **Citations + provenance metadata are non-negotiable:** chunk → `source_doc, connector, page/section, retrieval_score` surfaced with answers. This is what separates "AI search" from "chatbot with files."
5. **The hard part is permissions, not embeddings:** filter-then-rank, ACL sync faster than content sync, unified principal identity, per-permission-set caching. For v1, connector sync with source-ACL honoring (Drive ACLs via API) + project-level upload isolation gets Marketr to "safe enough"; full Glean-style permission mirroring is a later milestone.
6. **OSS building blocks:** AnythingLLM's ingestion/workspace model is the closest product reference; LlamaIndex or Haystack for the pipeline; pgvector for v1 (zero new infra) with a Qdrant migration path; Open WebUI's Knowledge/collections UX for the project-level file UI pattern.

---

## 6. What could not be verified / flagged

- **Guru pricing:** sources conflict (self-serve $10–25/seat historical vs. 2026 "enterprise-only, no public pricing, usage-based AI credits"). Treat as unresolved; needs direct check of getguru.com pricing page.
- **ChatGPT Projects file limits:** sources disagree (Free 5 / Plus 25 / Pro-Business-Enterprise 40 per one 2026 wiki; another comparison says Plus/Teams 20). Limits shift often; verify against OpenAI help center before speccing.
- **Dust connector ACL mechanics:** described as permission-scoped sync across sources, but the exact ACL-mirroring implementation wasn't verified against dust-tt/dust primary docs in this pass.
- **Dify hosted pricing tiers:** not verified (self-host is free; cloud pricing not checked).
- **NotebookLM citation UX details and current model/pricing:** limits verified via a 2026 comparison wiki citing Google's limits page; not re-checked against Google's official page today.
- **Valuation/adoption figures** (Glean $4.6B, "hundreds of millions" ChatGPT users) are reported figures from 2025–2026 sources, not re-verified today.
- **Embeddings/benchmark claims** (Matryoshka 98–99% retention, p95 latency tables) come from community benchmarks, not independent verification.
- Open-source license of Open WebUI noted as MIT/BSD-style from comparison tables; the repo's actual LICENSE file wasn't opened today — confirm before reusing code.
