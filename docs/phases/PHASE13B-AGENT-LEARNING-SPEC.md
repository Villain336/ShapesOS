# Phase 13B — Agent Learning + Company Intelligence

**Status:** SPEC DRAFT — queued. Starts after Wave A lands (tree frozen at the Wave A commit).
**Decided by Tico:** 2026-09-27 — "Build it as the next phase after Wave A lands," plus "a combo of this and Jasper AI style intelligence layer."
**Goal:** Marketr's agents actually learn and improve over time for each user, and feel as human as possible — persistent, honest, proactive, with judgment that compounds like a sharp employee, not a chatbot that resets every session. The learning loop feeds a Jasper-style company intelligence layer: every agent deeply knows the business it serves.

**The combo thesis:** Jasper's intelligence layer (Brand Voice, knowledge, style guides) is *configured once and static*. Ours is *alive* — the learning loop continuously refines the company intelligence from every interaction, edit, and performance signal. Static setup becomes a living system.

---

## 1. The learning loop (per workspace)

1. **Remember** — every agent interaction captured as an episodic memory: what was asked, what was produced, what happened next. Tenant-isolated (existing `SET LOCAL` RLS).
2. **Feedback signals** — explicit (thumbs up/down on agent outputs) and implicit (the user's *edits* are the richest signal: diff between agent draft and user-final = the lesson; also acceptance-without-edit, regeneration requests).
3. **Preference profile** — per workspace: brand voice, risk tolerance, detail level, channels, definition of "good." Retrieved into every agent prompt automatically so agents stop asking what they should already know.
4. **Consolidation ("sleep")** — nightly per-workspace job: LLM pass over recent episodes → extracts durable lessons ("always lead with the number; cut fluffy intros"), dedupes against existing lessons, decays low-confidence ones, discards noise.
5. **Visible memory** — "What I've learned about you" surface per workspace: view, correct, delete, pause-learning toggle. Learning the user can't inspect is surveillance, not trust.

## 2. Company Intelligence layer (Jasper-style, but alive)

A structured, per-workspace model of the business that every agent draws on — the "what the agent knows about this company." Distinct from episodic memory (§1): this is the *company*, not the *conversation*.

- **Brand Voice engine** — learns tone/style from the user's content samples (site, past campaigns, docs): vocabulary, sentence rhythm, formality, POV, humor. Generates a voice profile the user can tune ("more bold, less corporate"). Applied to every output. Unlike Jasper's one-time setup, ours re-derives continuously from edits and new content.
- **Company knowledge graph** — products/services, pricing, audiences/personas, competitors, messaging pillars, proof points, positioning. Structured, user-editable, agent-readable.
- **Style rules** — hard constraints checked on every output: banned words/phrases, required disclaimers, compliance lines (the "never say X, always say Y" list). Fail-closed: violations block or flag before delivery.
- **Content memory** — everything ever made for this company, retrievable for consistency ("we already ran this angle in March — here's how it performed").
- **Performance feedback** — which content actually worked (engagement, rankings, conversions via the analytics integrations) flows back into what agents recommend. This closes the loop: learn → create → measure → learn.

**How the two systems connect:** the §1 learning loop is the *engine*, the intelligence layer is the *artifact*. Lessons and preference updates from consolidation write into the Brand Voice profile, knowledge graph, and style rules automatically (with user-visible diffs — "I updated your voice profile based on your last 12 edits — review"). The user can always pin/lock any element ("don't touch the voice profile") — pinned elements are read-only to the learner.

## 3. Data model (new Prisma models)

- `AgentEpisode` — workspaceId, agentId, promptSummary, outputSummary, outcome, timestamps. Raw material.
- `AgentFeedback` — episodeId, kind (explicit | edit-diff | accepted | regenerated), signal payload.
- `AgentLesson` — workspaceId, lesson text, confidence, source episode refs, status (active | retired). The durable learnings.
- `WorkspacePreference` — workspaceId, key, value, confidence, updatedAt. Structured prefs (voice, risk, detail…).
- `PersonaProfile` — agentId, voice traits, continuity notes. The "human" layer per persona.

All tenant-scoped; RLS battery extended to the new tables.

## 4. Retrieval integration

- Lessons + preferences + **company intelligence** feed into agent system prompts (Chief Strategy Agent, mission planner, playbook generator, content/brief agents) via the existing Growth Memory recall path — no parallel memory system.
- Layered injection order: style rules (hard constraints) → brand voice → company knowledge → lessons/preferences → episodic context. Hard constraints always win on conflict.
- Episodic continuity in conversation: "last week you decided X" — recall surfaces relevant past decisions unprompted when contextually apt.

## 5. The human layer (five personas)

- Persistent voice definitions per persona (already exist as roles — now with voice, manner, continuity).
- Honesty behaviors: express uncertainty ("my best read is X, I'm not sure about Y"), ask clarifying questions instead of guessing on high-stakes calls, hold opinions when they matter.
- Proactivity: check in when something meaningful changed ("rankings shifted on 3 keywords since Tuesday — want the rundown?"), not just when asked.
- Never sycophantic, never robotic-formal. Match the user's register.

## 6. UI surfaces

- **Settings → Agents → Memory:** the "what I've learned" list — lessons with confidence, edit/delete, pause-learning toggle, per-workspace export.
- **Settings → Brand → Intelligence:** the company intelligence layer — Brand Voice profile (with "review pending updates" diffs from the learner), knowledge graph editor, style rules manager, content history. Pin/lock controls per element.
- **Feedback affordances** on agent outputs: thumbs, and automatic capture when the user edits agent-produced content (draft → final diff stored as feedback).
- **Onboarding hook:** first-run "how do you like to work?" seeds the preference profile so learning isn't cold-start.

## 7. Build order

1. Data model + migrations + RLS on new tables (episodes, feedback, lessons, preferences, personas, **plus company-intelligence models**: `BrandVoiceProfile`, `CompanyKnowledge` entries, `StyleRule`, `ContentRecord`).
2. Company Intelligence layer: voice-profile derivation from samples, knowledge graph CRUD, style-rule enforcement hook on agent outputs.
3. Episode capture (hook into existing agent execution paths — Chief Strategy Agent, missions, playbooks, content).
4. Feedback capture (explicit UI + edit-diff pipeline).
5. Preference profile + prompt injection via Growth Memory recall (layered: rules → voice → knowledge → lessons → episodes).
6. Consolidation job (nightly cron → queue worker; LLM lesson extraction, dedupe, decay; **writes proposed updates to Brand Voice / knowledge / rules as reviewable diffs**).
7. Memory UI + Brand Intelligence UI (Settings → Agents → Memory; Settings → Brand → Intelligence).
8. Persona voice pass on the five personas.
9. Evals: lesson-quality spot checks, preference-retrieval precision, voice-profile fidelity (blind A/B: can the user tell agent output from their own?), "does the agent stop asking known things" acceptance tests.

## 8. Verification (definition of done)

- tsc clean, production build green, full tests green (new suites: consolidation, feedback-diff, RLS on new tables, recall precision, style-rule enforcement).
- Acceptance: after 20 seeded episodes with known preferences, agent outputs reflect them without being re-told; lessons surface in the UI; delete actually deletes (no ghost recall).
- Brand Voice acceptance: blind test — voice profile derived from 5+ samples produces output the user rates "sounds like us" ≥ 4/5; style-rule violations are caught pre-delivery in 100% of seeded violation tests.
- Secret scan clean. Screenshots of the Memory + Brand Intelligence UI. Local-only commit, nothing pushed.

## 9. Sequencing notes

- Runs after Wave A lands. Before Cloudflare migration cutover ideally — the new tables migrate with everything else (Neon pgvector path already planned).
- Growth Memory consolidate job is extended, not replaced. No second memory system.
- Cost: consolidation is one nightly LLM pass per active workspace — cents-scale; flag if workspace count × model cost crosses a threshold (define at build time).
