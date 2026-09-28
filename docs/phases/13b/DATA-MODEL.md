# Phase 13B — Data Model Decision Record

**Worker 1 (schema authority) · 2026-09-27 · migration `20260927232000_phase13b_intelligence`**

All later Phase 13B workers MUST read the **Contract** section at the bottom before touching these models.

## Governing principle: no second memory system

Growth Memory (`lib/substrate/memory/`) already provides three stores with
tenant isolation, bi-temporality, embeddings, and a nightly consolidation
job. Phase 13B *extends* that substrate — it does not duplicate it. The
rule applied to every candidate model: **reuse a memory store unless the
fit is demonstrably bad.** Spec §3's `AgentEpisode`/`AgentLesson`/
`WorkspacePreference` were evaluated against that rule; only genuinely
structural artifacts (company-intelligence documents) got new tables.

---

## Mapping decisions

### 1. AgentEpisode → `memory_episodes` (episodeType `"agent_call"`) — NO new model

**Fit: good.** The episodic store is the immutable "what happened" log
(spec §9.4: application code never UPDATEs/DELETEs). An agent interaction —
prompt in, output out, outcome — maps exactly:

| AgentEpisode field | memory_episodes mapping |
|---|---|
| workspaceId | workspaceId |
| agentId | `actor` (e.g. `"business-strategist"`) |
| promptSummary | `summary` (human-readable one-liner) + `refs.promptSummary` |
| outputSummary | `refs.outputSummary` |
| outcome | `refs.outcome` |
| timestamps | `startedAt` / `endedAt` |

Use `recordEpisode(workspaceId, { episodeType: "agent_call", actor, summary, refs, ... })`
from `lib/substrate/memory/write.ts`. A separate `AgentEpisode` table would
duplicate the episodic store with a worse audit story (no consolidation
sweep, no recall integration). **Worker 3 (episode capture): hook the
existing agent execution paths to `recordEpisode` with `episodeType:
"agent_call"` — do not invent another write path.**

### 2. AgentLesson → `memory_learnings` (source `"consolidation"`) — NO new model

**Fit: good.** `memory_learnings` is the procedural store ("what worked /
failed / when", the F3 sink schema). A durable lesson is a learning:

| AgentLesson field | memory_learnings mapping |
|---|---|
| workspaceId | workspaceId |
| lesson text | `hypothesis` |
| (action that produced it) | `action` (e.g. `"consolidation pass 2026-09-27"` or the user edit it came from) |
| confidence | `metricDelta.confidence` (JSON extensibility point — documented here, not ad hoc) |
| source episode refs | `sourceEpisodeId` + `contextRefs` |
| status active \| retired | `invalidatedAt` NULL vs set — retire = invalidate, **NEVER delete** |

The `MemoryLearningSource` enum gained **`consolidation`** (both in
`prisma/schema.prisma` and the `MemoryLearningSource` union in
`lib/substrate/memory/types.ts`), because the existing sources
(`test_lab|reallocation|campaign|human|import`) describe *where* a learning
came from, and consolidation is a new source. **Worker 6 (consolidation):
write lessons via `recordLearning` with `source: "consolidation"`; retire
via invalidation, never `delete`.**

### 3. WorkspacePreference → `memory_facts` (`predicate = "pref:<key>"`) — NO new model

**Fit: good.** The semantic store is distilled, bi-temporal truth — exactly
the lifecycle of a preference (it drifts; old values are history, not
deleted). Convention:

- `subjectNodeId = NULL` (**deviation from the brief**: the brief said
  `subjectNodeId="workspace"`, but the FK to `graph_nodes` would reject a
  literal `"workspace"` id — NULL + the `pref:` predicate namespace is the
  honest convention),
- `predicate = "pref:<key>"` (keys: `voice_style`, `risk_tolerance`,
  `detail_level`, `channels`, `definition_of_good`, `learning_paused`),
- `object = { value, pinned? }` — `pinned: true` = read-only to the
  learner (user-pinned prefs are never overwritten by worker 6),
- `origin = "user_told"` for user-set/onboarding prefs (decay-to-floor
  survivor), `"agent_inferred"` for learner-derived,
- updates = **supersede chain** (new row + `invalidatedAt`/`expiredAt` +
  `supersededById` on the old row), never in-place edit.

Helper module: **`lib/substrate/memory/preferences.ts`** —
`getPreference(tx, workspaceId, key)`, `setPreference(workspaceId, key,
value, { confidence, pinned, origin, sourceEpisodeId })`,
`getLearningPaused(tx, workspaceId)`, `setLearningPaused(workspaceId,
paused)`, `listPreferences(workspaceId)`, `PREF_KEYS`. **Workers 5
(prompt injection) and 7 (Memory UI) use this module — never raw
`memoryFact` queries for prefs.**

### 4. LearningPause → `memory_facts` (`predicate = "pref:learning_paused"`) — NO new model

**Fit: good; deviation from the brief (no `LearningPause` table).** The
pause-learning toggle is a preference — a dedicated table would be a mini
preference system duplicating `memory_facts`' confidence / bi-temporal /
pin semantics, i.e. exactly the "second system" the spec forbids. Stored
as `pref:learning_paused` with `object = { value: bool, pausedAt }` and
`origin = "user_told"` (explicit user action). Access via
`getLearningPaused` / `setLearningPaused` in `preferences.ts`.

---

## New models (structured company-intelligence artifacts — NOT memory)

These six are documents with taxonomy, pin/lock, and reviewable learner
diffs. Memory is the *engine*; these are the *artifacts* (spec §2). All
six: `workspace_id NOT NULL`, `ON DELETE CASCADE` to `workspaces`,
**FORCE ROW LEVEL SECURITY** with the `app.workspace_id` GUC
(fail-closed — see the migration's `DO $$` block), index on
`(workspaceId, createdAt)` where sensible.

| Model → table | Purpose | Key fields |
|---|---|---|
| `AgentFeedback` → `agent_feedback` | Feedback signals on agent-call episodes — the learning loop's richest raw material (spec §1) | `episodeId?` → `memory_episodes` (SetNull), `agentId`, `kind: FeedbackKind` (`explicit_up\|explicit_down\|edit_diff\|accepted\|regenerated`), `signal: Json` |
| `BrandVoiceProfile` → `brand_voice_profiles` | The living Brand Voice (spec §2) | `workspaceId` **unique**, `dimensions: Json` (`{vocabulary, rhythm, formality, pov, humor, doExamples, dontExamples}`), `derivedFrom: Json` (provenance of samples), `confidence`, `pinnedByUser` (learner read-only when true), `pendingUpdates: Json?` (learner proposals — applied only on user accept) |
| `CompanyKnowledge` → `company_knowledge` | Knowledge graph entries (spec §2) | `kind: KnowledgeKind` (`product\|pricing\|audience\|competitor\|pillar\|proof\|positioning\|other`), `title`, `body: Json` (shape per kind — see contract), `confidence`, `pinned` (learner may not modify), `sourceEpisodeId?` → `memory_episodes`, `validFrom`/`validTo` (validity eras; history kept) |
| `StyleRule` → `style_rules` | Hard constraints checked on every output pre-delivery (spec §2) | `kind: StyleRuleKind` (`ban\|require\|disclaimer\|tone`), `pattern` (phrase/regex), `replacement?`, `severity: StyleRuleSeverity` (`block` = refuse delivery, `flag` = warn), `pinned`, `active` (learner proposals arrive `active=false`, go live only on accept), `source` (`"user"\|"onboarding"\|"consolidation"`) |
| `ContentRecord` → `content_records` | Content memory for consistency + performance (spec §2) | `kind: String` (free taxonomy: `blog_post`, `email`, `social_post`, `ad`, `landing`, `video_script`, … — kinds grow faster than enums), `title`, `bodyRef?` (pointer to the artifact — body NOT duplicated here), `angle?`, `channel?`, `performance: Json?` (`{impressions, clicks, conversions, rankDelta, …}` — fed by analytics; null until measured) |
| `PersonaProfile` → `persona_profiles` | The human layer per persona (spec §5) | `@@unique([workspaceId, agentId])` (**deviation from the brief's "agentId unique"**: uniqueness must be per workspace or every workspace but the first couldn't define its own voice for the same persona — incoherent under tenant scoping), `voice: Json` (`{register, manner, quirks[], taboos[]}`), `continuityNotes`, `uncertaintyStyle` |

`MemoryEpisode` gained two back-relations: `feedback: AgentFeedback[]`
(`"FeedbackSourceEpisode"`) and `knowledge: CompanyKnowledge[]`
(`"KnowledgeSourceEpisode"`); `Workspace` gained all six back-relations.

### Why these six are tables and not memory stores (the borderline cases)

- `AgentFeedback`: not "what happened" (episodes) and not "distilled
  truth" (facts) — it is a *signal about* an episode with a structured
  kind + payload. Forcing it into `refs` JSON would lose queryability
  (`@@index([workspaceId, kind])`) the consolidation job needs.
- `CompanyKnowledge`: entries are user-editable documents with a kind
  taxonomy, pins, and validity eras — richer than a semantic triple, and
  worker 2 builds CRUD + enforcement directly on them.
- `ContentRecord`: curated artifacts with angle/channel/performance —
  not the immutable what-happened log. (`bodyRef` keeps the body in the
  editor/asset store; the record is the index.)
- `BrandVoiceProfile` / `StyleRule` / `PersonaProfile`: single-active
  documents with reviewable-diff semantics (`pendingUpdates`,
  `active=false` proposals) — a pattern memory stores don't have.

---

## RLS approach

Identical to the Phase 8 pattern (`prisma/migrations/20260925180000_phase8_memory/migration.sql`):
`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`
(constrains the table owner too), one `FOR ALL` policy
`<table>_tenant_isolation` with
`USING (workspace_id = current_setting('app.workspace_id', true))` and
`WITH CHECK (...)` — reads AND writes are tenant-bound. All access goes
through `withWorkspaceScope()` in `lib/substrate/memory/rls.ts`; sessions
without the GUC see zero rows (fail-closed).

**New battery:** `scripts/verify-phase13b-rls.mts` (`tsx
scripts/verify-phase13b-rls.mts`, exits 1 on failure) — 25 checks:
FORCE RLS on all six tables; no-GUC reads return zero per table;
cross-workspace read returns zero (including the three memory-mapped
conventions); cross-workspace INSERT blocked on all six tables;
unscoped UPDATE is a no-op; mapping conventions round-trip
(agent_call episodes, consolidation learnings, `pref:*` facts,
pause toggle); uniqueness contracts (one voice profile per workspace,
`(workspaceId, agentId)` personas, same agentId allowed in another
workspace).

---

## Contract — READ THIS BEFORE TOUCHING THE NEW MODELS

### Exact model names (Prisma client)

`prisma.agentFeedback`, `prisma.brandVoiceProfile`,
`prisma.companyKnowledge`, `prisma.styleRule`,
`prisma.contentRecord`, `prisma.personaProfile`
(tables: `agent_feedback`, `brand_voice_profiles`, `company_knowledge`,
`style_rules`, `content_records`, `persona_profiles`).

### Exact field names (camelCase in Prisma, snake_case in SQL)

- `AgentFeedback`: `id, workspaceId, episodeId?, episode?, agentId,
  kind: FeedbackKind, signal: Json, createdAt`
- `BrandVoiceProfile`: `id, workspaceId (unique), dimensions: Json,
  derivedFrom: Json, confidence: Float, pinnedByUser: Boolean,
  pendingUpdates: Json?, createdAt, updatedAt`
- `CompanyKnowledge`: `id, workspaceId, kind: KnowledgeKind, title,
  body: Json, confidence: Float, pinned: Boolean,
  sourceEpisodeId?, sourceEpisode?, validFrom?, validTo?,
  createdAt, updatedAt`
- `StyleRule`: `id, workspaceId, kind: StyleRuleKind, pattern,
  replacement?, severity: StyleRuleSeverity, pinned: Boolean,
  active: Boolean, source: String, createdAt, updatedAt`
- `ContentRecord`: `id, workspaceId, kind: String, title, bodyRef?,
  angle?, channel?, performance: Json?, createdAt`
- `PersonaProfile`: `id, workspaceId, agentId, voice: Json,
  continuityNotes, uncertaintyStyle, createdAt, updatedAt`

### Import paths

- `import { withWorkspaceScope, countWithoutScope } from
  "@/lib/substrate/memory/rls"` — every read/write.
- `import { recordEpisode, recordLearning } from
  "@/lib/substrate/memory/write"` — episodes & lessons (NOT new tables).
- `import { getPreference, setPreference, getLearningPaused,
  setLearningPaused, listPreferences, PREF_KEYS } from
  "@/lib/substrate/memory/preferences"` — prefs & pause toggle.
- `import type { MemoryLearningSource } from
  "@/lib/substrate/memory/types"` — now includes `"consolidation"`.

### JSON shape conventions (do not invent new ones)

- `BrandVoiceProfile.dimensions`: `{ vocabulary: string[], rhythm:
  string, formality: string, pov: string, humor: string, doExamples:
  string[], dontExamples: string[] }`
- `BrandVoiceProfile.derivedFrom`: `{ samples: string[], editCount:
  number, lastDerivedAt: string }`
- `BrandVoiceProfile.pendingUpdates`: `{ proposedAt: string,
  dimensions: <partial dimensions>, rationale: string }` — applied to
  `dimensions` only on explicit user accept.
- `CompanyKnowledge.body` per kind: `product → { summary, features[],
  url? }`, `pricing → { tiers[], notes? }`, `audience → { segments[],
  painPoints[] }`, `competitor → { strengths[], weaknesses[], url? }`,
  `pillar → { statement, proofIds[] }`, `proof → { claim, evidence,
  sourceUrl? }`, `positioning → { statement, differentiators[] }`,
  `other → { … }`.
- `AgentFeedback.signal` per kind: `explicit_up/down → { source:
  "ui" }`, `edit_diff → { before, after, diffStats }`, `accepted → {
  withEdits: boolean }`, `regenerated → { reason? }`.
- `ContentRecord.kind` values: `blog_post | email | social_post | ad |
  landing | video_script | …` (open string).
- `ContentRecord.performance`: `{ impressions?, clicks?,
  conversions?, rankDelta?, … }` — whatever the analytics integrations
  provide; null until measured.
- `PersonaProfile.agentId` — the five canonical Phase-12 keys
  (`lib/expert/personas/index.ts`): `business-strategist`,
  `agents-orchestrator`, `multi-agent-systems-architect`,
  `workflow-architect`, `studio-producer`.

### Rules

1. **Every** query on these tables goes through `withWorkspaceScope`.
   No exceptions — the battery proves fail-closed.
2. Lessons → `recordLearning({…, source: "consolidation"})`; retire
   lessons by setting `invalidatedAt`, never `delete`.
3. Preferences → `preferences.ts` helpers only; **check
   `getPreference().pinned` before any learner write** — pinned prefs
   and pinned voice/knowledge/style elements are read-only to the
   learner.
4. Learner proposals to `BrandVoiceProfile` go in `pendingUpdates`;
   new `StyleRule`s from the learner start `active=false`. The user
   accepts in the UI (worker 7). Nothing auto-applies.
5. `AgentFeedback.signal` must be scrubbed like episodes — no raw
   secrets (see `lib/substrate/memory/scrub.ts`).
