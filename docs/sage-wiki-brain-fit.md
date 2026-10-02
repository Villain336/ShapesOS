# sage-wiki × Marketr Knowledge Brain — Fit Analysis

- Date: 2026-09-30. Directed by Tico: "look at sage wiki repo for the brain feature."
- Repo: https://github.com/xoai/sage-wiki (cloned shallow to `~/workspace/research/sage-wiki/`, research only — nothing vendored).
- Vault-private. Never publish.

## What sage-wiki is

A graph memory and knowledge base that AI agents and humans build and query together, grown from Karpathy's "LLM-compiled personal knowledge base" idea. Drop in documents; an LLM compiler turns them into an interlinked wiki plus a knowledge graph. Stack: one Go binary (SQLite default, Postgres/pgvector for scale), Preact + Vite + force-graph web UI, TUI, 19 MCP tools plus generated agent skill files. Agents query via MCP; humans browse Obsidian-native markdown. The headline trick: the graph is a *compile output*, not a second database to keep in sync — and with opt-in "evidenced graph" passes, every relation carries its evidence span, confidence score, and source document.

## License verdict: MIT — COMPATIBLE

`LICENSE` is MIT (Copyright 2026 xoai). MIT is permissive and compatible with Marketr's AGPLv3 + commercial playbook: MIT code can be incorporated into an AGPLv3 project provided the copyright notice is retained. Clean-sourcing discipline holds — but the recommendation below is to borrow *patterns*, not code, so the license question is moot in practice. Do not vendor the binary; research only.

## What the Brain already has locked (do not touch)

- **The galaxy-on-light-space treatment** (Tico, 2026-09-26): 48 luminous source cores + 2,678 chunk sparkles, orbital ring on the hero source, cinematic zoom-out on load, tour button. sage-wiki's viz is a 2D force-graph (dark) — a different aesthetic entirely. The Brain's look is decided.
- **The audit layer**: health strip, source register, activity feed, dossiers. This is the Brain's identity as the corpus command center.
- **The corpus itself** (v9: 339 sources, 5,924 chunks) and the Marketr stack (Next.js/React + Postgres). sage-wiki is a Go binary — stack mismatch makes pattern-borrowing the right granularity.

## Borrowable ideas (learned from, never copied)

### 1. Evidenced graph: every claim traces to its sentence (STRONGEST FIT)
sage-wiki's best idea: relations carry `evidence` (the exact span supporting the edge), `confidence` (0–1), and `source_doc`. A conclusion traces to the sentence that justified it, not to a whole document.
- **Maps to:** the Brain's audit layer + dossiers. The Brain currently has sources → chunks; sage adds the *concept* layer with evidence-bearing edges between them. A dossier could show not just "source X fed chunk Y" but "claim C is supported by these 3 spans at confidence 0.8+."
- **Why it matters for Tico:** this is the "accountant that never guesses" identity made structural for the knowledge layer — provenance down to the sentence is exactly the trust posture the Brain needs as RAG ground truth for every agent in the OS.

### 2. Tiered compilation: index everything fast, compile only what matters
Tier 0 (FTS5 index only, ~5ms, free) → Tier 1 (index + embed) → Tier 2 (deterministic code parse, free) → Tier 3 (full LLM compile: summarize, extract concepts, write articles, build ontology — ~$0.05–0.15/doc). 100K docs go from 139 days to ~5.5 hours to searchable.
- **Maps to:** Brain ingestion economics. v9 is 339 sources; as the corpus grows 10–100×, tiered compile is how LLM spend stays sane. Directly matches Tico's metering mindset — spend the expensive pass only on sources that earn it (usage-promoted or explicitly configured).

### 3. Hybrid retrieval: BM25 + vector + graph proximity, fused
Three channels (lexical FTS5, vector cosine, ≤2-hop graph proximity) fused with weighted RRF, plus LLM query expansion (keyword / semantic / hypothetical-answer variants) with a **strong-signal skip** — if BM25 is already confident, the expansion LLM call is skipped entirely — and position-aware rerank blending (retrieval rank 1–3 keeps 75% weight so the reranker can't demote high-confidence hits).
- **Maps to:** the Brain's RAG grounding. The architecture (channel fusion + cost-saving skip + reranker guardrails) is directly adoptable in the Marketr stack. The strong-signal skip is the kind of cost control Tico wants everywhere.

### 4. Output trust: quarantine unverified claims
New query outputs go to `under_review/`, not into the searchable corpus. Promotion requires grounding verification (score ≥ 0.8) + consensus (3 confirmations). Bi-temporal edges: contradicting a fact *invalidates* the old edge instead of colliding, and `as_of` queries answer "what did we believe in January?"
- **Maps to:** the Brain's audit layer (health strip could show trust states: verified / pending / contradicted) and the corpus's anti-pollution posture. Every agent in the OS grounds on this corpus — a wrong indexed answer compounding into future answers is the exact failure mode to kill.

### 5. Review-gated entity resolution + concept curation
"K8s" and "Kubernetes" merge only after human review — never silently. One global-view pass judges keep/fold/drop per concept; enumerated entities never fold (`mw-3` ≠ `mw-2` at any similarity).
- **Maps to:** the source register. Alias/dedup proposals become review-queue items in the Brain's existing audit UX instead of silent merges. Judgment is the product, not the automation.

## What it doesn't replace

- The galaxy visualization (locked; different aesthetic, and the Brain's two-tier node semantics — source cores vs chunk sparkles — already parallel sage's doc-dots vs concept-dots; that's validation, not a gap).
- The audit layer's UX (sage has trust *mechanics*, not the Brain's health-strip/register/feed/dossier *surface*).
- The agent substrate (sage's 19 MCP tools are Go-side; Marketr's agents run on its own stack — FastMCP stays, Composio is the action layer).
- The corpus and its chunking (v9 is the asset; sage's ~800-token chunking is a reference point, not a migration target).

## Recommendation: borrow patterns, build natively

**Do not fork or vendor sage-wiki.** The stack mismatch (Go binary vs Next.js/TS + Postgres) plus the locked visual direction make a fork the wrong move. Instead: spec a **Brain v2 upgrade** implementing the five ideas above natively in the Marketr stack, in this order — (1) evidenced graph + per-claim citations in dossiers, (2) tiered ingestion, (3) hybrid retrieval with the strong-signal skip, (4) output-trust quarantine in the audit layer, (5) review-gated entity resolution in the source register. MIT license means even direct ports of the *algorithms* (RRF fusion weights, tier definitions) are clean — but reimplement, don't copy-paste.
