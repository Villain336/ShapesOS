#!/usr/bin/env tsx
// Marketr — Phase 8 G3 verification battery (SPEC-PHASE8.md §2 G3).
//
// Covers: extensions/indexes/RLS, retrieval quality (nDCG@10 on the ~40
// labeled pairs — hybrid+rerank must beat BM25-only and vector-only),
// ranked recall + provenance, temporal as_of, contradiction
// invalidation (history preserved), cross-workspace isolation,
// decay-to-floor, adversarial anonymization, the unreviewed publication
// gate, secret persistence scan, the Test Lab archive sink, and the
// substrate.context() contract.
//
// Usage: tsx scripts/verify-phase8-memory.mts
// Run 3× and confirm green each time. Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import { recordEpisode, recordFact, recordLearning } from "../lib/substrate/memory/write";
import { recallRanked, memoryRecall, isExactMatchQuery, TUNED_ALPHA_DEFAULT } from "../lib/substrate/memory/recall";
import { scrubJson } from "../lib/substrate/memory/scrub";
import { anonymizeForPlaybook } from "../lib/substrate/memory/anonymize";
import {
  runConsolidationOnce,
  getWorkerIdentity,
} from "../lib/substrate/memory/consolidate";
import { createPrismaMemorySink } from "../lib/substrate/memory/archive-sink";
import {
  listReviewedPatterns,
  listReviewQueue,
  reviewPattern,
} from "../lib/substrate/memory/playbook";
import { withWorkspaceScope, withPlaybookReviewer, countWithoutScope } from "../lib/substrate/memory/rls";
import { withWorkspaceScope as withGraphScope } from "../lib/substrate/graph/rls";
import { substrateContext } from "../lib/substrate/context";
import {
  FIXTURE_DOCS,
  LABELED_PAIRS,
  ndcgAtK,
  type TemporalLabeledPair,
} from "../lib/substrate/memory/fixtures/retrieval-pairs";
import { GROWTH_MEMORY_SINK_SCHEMA, type GrowthLearning } from "../lib/flywheel/testlab/memory-sink";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n## ${title}`);
}

const WS_A = "mem-battery-a";
const WS_B = "mem-battery-b";
const WS_CONTRA = "mem-battery-contra";
const WS_DECAY = "mem-battery-decay";
const WS_CTX = "mem-battery-ctx";
const ALL_WS = [WS_A, WS_B, WS_CONTRA, WS_DECAY, WS_CTX];

async function resetBatteryState() {
  // Playbook rows are global (anonymized patterns) — remove only
  // battery-created ones. FORCE RLS hides unreviewed rows from plain reads,
  // so cleanup runs under the reviewer GUC.
  await withPlaybookReviewer(WS_A, (tx) =>
    tx.playbookLearning.deleteMany({ where: { patternTitle: { startsWith: "battery:" } } }),
  );
  for (const id of ALL_WS) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: `battery ${id}`, ownerUserId: "battery-owner" } });
  }
}

// ---------------------------------------------------------------------------
// 1. extensions, indexes, RLS
// ---------------------------------------------------------------------------

async function checkInfra() {
  section("1. Postgres infra: extensions, indexes, RLS");
  const exts = (await prisma.$queryRawUnsafe(
    `SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm')`,
  )) as Array<{ extname: string }>;
  const names = exts.map((e) => e.extname);
  check("vector extension installed", names.includes("vector"), names.join(","));
  check("pg_trgm extension installed", names.includes("pg_trgm"), names.join(","));

  const idx = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'memory_%'`,
  )) as Array<{ indexname: string }>;
  const idxNames = idx.map((i) => i.indexname);
  check("HNSW embedding indexes", ["memory_episodes","memory_facts","memory_learnings"].every(t => idxNames.some(n => n.includes(t) && n.includes("embedding"))), `${idxNames.length} memory indexes`);
  check("tsvector GIN indexes", idxNames.some((n) => n.includes("tsv")), idxNames.filter((n) => n.includes("tsv")).join(", "));
  check("trigram GIN indexes", idxNames.some((n) => n.includes("trgm")), idxNames.filter((n) => n.includes("trgm")).join(", "));

  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('memory_episodes','memory_facts','memory_learnings','playbook_learnings')`,
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    "FORCE RLS on all memory tables",
    rls.length === 4 && rls.every((r) => r.rowsecurity && r.force_rowsecurity),
    rls.map((r) => `${r.tablename}:${r.force_rowsecurity ? "forced" : "off"}`).join(" "),
  );
  const pols = (await prisma.$queryRawUnsafe(
    `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('memory_episodes','memory_facts','memory_learnings','playbook_learnings')`,
  )) as Array<{ policyname: string }>;
  check("tenant policies present", pols.length >= 7, `${pols.length} policies`);

  // Fail-closed: no workspace → refuse.
  let threw = false;
  try {
    await withWorkspaceScope("", async () => {});
  } catch {
    threw = true;
  }
  check("withWorkspaceScope fail-closed on empty workspace", threw);
}

// ---------------------------------------------------------------------------
// 2. plant fixtures
// ---------------------------------------------------------------------------

const docRowIds = new Map<string, { store: string; id: string }>();

async function plantFixtures() {
  section("2. Planting retrieval fixtures");
  for (const doc of FIXTURE_DOCS) {
    if (doc.store === "episode") {
      const r = await recordEpisode(WS_A, {
        actor: String(doc.extra?.actor ?? "agent"),
        episodeType: (doc.extra?.episodeType as "run" | "session" | "sync" | "agent_call" | undefined) ?? "session",
        summary: `${doc.title}\n${doc.body}`,
      });
      docRowIds.set(doc.key, { store: "episode", id: r.id });
      // Backdate under the tenant scope: FORCE RLS makes unscoped UPDATEs no-ops.
      await withWorkspaceScope(WS_A, (tx) =>
        tx.$executeRawUnsafe(`UPDATE memory_episodes SET started_at = $2 WHERE id = $1`, r.id, new Date(doc.observedAt)),
      );
    } else if (doc.store === "fact") {
      const r = await recordFact(WS_A, {
        predicate: String(doc.extra?.predicate ?? doc.title),
        object: { statement: doc.body },
        confidence: Number(doc.extra?.confidence ?? 0.8),
        origin: (doc.extra?.origin as never) ?? "agent_inferred",
      });
      docRowIds.set(doc.key, { store: "fact", id: r.id });
      await withWorkspaceScope(WS_A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE memory_facts SET created_at = $2, valid_at = $3, invalid_at = $4 WHERE id = $1`,
          r.id,
          new Date(doc.observedAt),
          doc.extra?.validAt ? new Date(String(doc.extra.validAt)) : new Date(doc.observedAt),
          doc.extra?.invalidAt ? new Date(String(doc.extra.invalidAt)) : null,
        ),
      );
    } else {
      const r = await recordLearning(WS_A, {
        hypothesis: doc.title,
        action: doc.body,
        result: /failed/i.test(doc.title) ? "failed" : /inconclusive/i.test(doc.title) ? "inconclusive" : "worked",
        // Fixtures are seeded data, not human assertions.
        source: "import",
        observedAt: new Date(doc.observedAt),
        contextRefs: { fixture: doc.key, ...(doc.extra?.experimentId ? { experimentId: doc.extra.experimentId } : {}) },
      });
      docRowIds.set(doc.key, { store: "learning", id: r.id });
    }
  }
  check("planted fixture docs", docRowIds.size === FIXTURE_DOCS.length, `${docRowIds.size}/${FIXTURE_DOCS.length}`);
  const withEmb = (await withWorkspaceScope(WS_A, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM (SELECT embedding FROM memory_episodes WHERE workspace_id=$1 AND embedding IS NOT NULL UNION ALL SELECT embedding FROM memory_facts WHERE workspace_id=$1 AND embedding IS NOT NULL UNION ALL SELECT embedding FROM memory_learnings WHERE workspace_id=$1 AND embedding IS NOT NULL) s`,
      WS_A,
    ),
  )) as Array<{ n: number }>;
  check("all planted rows have embeddings", withEmb[0]!.n === FIXTURE_DOCS.length, `${withEmb[0]!.n}/${FIXTURE_DOCS.length}`);
}

// ---------------------------------------------------------------------------
// 3. nDCG: α tuning + hybrid+rerank must beat both baselines
// ---------------------------------------------------------------------------

async function checkRetrievalQuality() {
  section("3. Retrieval quality (nDCG@10, 40 labeled pairs)");
  const pairs = LABELED_PAIRS;
  check("labeled pair count ≈40", pairs.length >= 38, `${pairs.length} pairs`);

  async function meanNdcg(alpha: number, skipRerank: boolean, withRerank: boolean): Promise<number> {
    let sum = 0;
    for (const p of pairs) {
      const asOf = (p as TemporalLabeledPair).temporalAsOf
        ? new Date((p as TemporalLabeledPair).temporalAsOf!)
        : undefined;
      const ranked = await recallRanked(WS_A, {
        query: p.query,
        topK: 10,
        alpha,
        skipRerank: withRerank ? false : skipRerank,
        asOf,
      });
      const keys = ranked.map((h) => {
        for (const [k, v] of docRowIds) if (v.id === h.refId) return k;
        return h.refId;
      });
      sum += ndcgAtK(keys, p.graded, 10);
    }
    return sum / pairs.length;
  }

  // Grid-search α on fused scores only (rerank is α-independent per query —
  // it only reorders the top-20 fused pool, so tune α first).
  let bestAlpha = 0.5;
  let bestNdcg = -1;
  const grid: Array<{ alpha: number; ndcg: number }> = [];
  for (let a = 0; a <= 10; a++) {
    const alpha = a / 10;
    const n = await meanNdcg(alpha, true, false);
    grid.push({ alpha, ndcg: n });
    if (n > bestNdcg) {
      bestNdcg = n;
      bestAlpha = alpha;
    }
  }
  console.log("  α grid:", grid.map((g) => `${g.alpha.toFixed(1)}:${g.ndcg.toFixed(3)}`).join(" "));

  const bm25Only = await meanNdcg(0, true, false);
  const vectorOnly = await meanNdcg(1, true, false);
  const hybrid = await meanNdcg(bestAlpha, true, false);
  const hybridRerank = await meanNdcg(bestAlpha, false, true);

  check("tuned α in (0,1) — hybrid actually mixes", bestAlpha > 0 && bestAlpha < 1, `α=${bestAlpha}`);
  // The battery must enforce the PRODUCTION default, not only a dynamically
  // chosen α: DEFAULT_ALPHA (exported as TUNED_ALPHA_DEFAULT) has to match
  // the measured winner, otherwise the shipped config drifts from tuning.
  check(
    "production DEFAULT_ALPHA matches tuned α",
    Math.abs(TUNED_ALPHA_DEFAULT - bestAlpha) <= 0.05,
    `production=${TUNED_ALPHA_DEFAULT} tuned=${bestAlpha}`,
  );
  console.log(`  nDCG@10 — BM25-only: ${bm25Only.toFixed(3)} | vector-only: ${vectorOnly.toFixed(3)} | hybrid(α=${bestAlpha}): ${hybrid.toFixed(3)} | hybrid+rerank: ${hybridRerank.toFixed(3)}`);
  check("hybrid+rerank beats BM25-only", hybridRerank > bm25Only, `${hybridRerank.toFixed(3)} > ${bm25Only.toFixed(3)}`);
  check("hybrid+rerank beats vector-only", hybridRerank > vectorOnly, `${hybridRerank.toFixed(3)} > ${vectorOnly.toFixed(3)}`);

  // Exact-match bypass sanity.
  check("isExactMatchQuery detects experiment IDs", isExactMatchQuery("EXP-1042"));
  const exact = await recallRanked(WS_A, { query: "EXP-1042", topK: 5 });
  check("exact-match bypass returns the experiment doc", exact.length > 0 && exact[0]!.exactMatch, exact[0] ? exact[0].title.slice(0, 50) : "no hits");
}

// ---------------------------------------------------------------------------
// 4. ranked recall + provenance; 5. temporal; 6. contradiction
// ---------------------------------------------------------------------------

async function checkRecallAndTemporal() {
  section("4. Ranked recall + provenance");
  const hits = await memoryRecall(WS_A, { query: "abandoned cart discount email recovery", topK: 5 });
  check("recall returns hits", hits.length > 0, `${hits.length} hits`);
  const top = hits[0]!;
  check("top hit is the cart-email learning", /abandoned-cart email/i.test(top.title), top.title.slice(0, 60));
  check(
    "provenance present",
    Boolean(top.store && top.refId && typeof top.score === "number" && top.observedAt instanceof Date),
    `store=${top.store} score=${top.score.toFixed(3)}`,
  );

  section("5. Temporal as_of (bi-temporal facts)");
  const nowHits = await memoryRecall(WS_A, { query: "brand positioning", topK: 5 });
  const oldHits = await memoryRecall(WS_A, { query: "brand positioning", topK: 5, asOf: new Date("2026-05-01T00:00:00Z") });
  const nowTop = nowHits.find((h) => h.store === "fact");
  const oldTop = oldHits.find((h) => h.store === "fact");
  check("current era → new positioning", Boolean(nowTop && /revenue intelligence/.test(nowTop.body)), nowTop?.body.slice(0, 60) ?? "none");
  check("old era → old positioning", Boolean(oldTop && /affordable analytics/.test(oldTop.body)), oldTop?.body.slice(0, 60) ?? "none");
}

async function checkContradiction() {
  section("6. Contradiction: invalidate + supersede, never delete");
  const first = await recordFact(WS_CONTRA, {
    predicate: "cta_button_color",
    object: { value: "blue", note: "Q1 brand test" },
    origin: "agent_inferred",
    confidence: 0.7,
  });
  await new Promise((r) => setTimeout(r, 20));
  const second = await recordFact(WS_CONTRA, {
    predicate: "cta_button_color",
    object: { value: "green", note: "Q3 re-test won" },
    origin: "agent_inferred",
    confidence: 0.8,
  });
  const report = await runConsolidationOnce(WS_CONTRA);
  const rows = (await withWorkspaceScope(WS_CONTRA, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT id, invalid_at IS NOT NULL AS invalidated, superseded_by_id FROM memory_facts WHERE workspace_id = $1 AND predicate = 'cta_button_color' ORDER BY created_at`,
      WS_CONTRA,
    ),
  )) as Array<{ id: string; invalidated: boolean; superseded_by_id: string | null }>;
  check("both historical rows still exist", rows.length === 2, `${rows.length} rows`);
  const oldRow = rows.find((r) => r.id === first.id)!;
  check("older fact invalidated (not deleted)", oldRow.invalidated, `invalidated=${oldRow.invalidated}`);
  check("superseded_by points at the newer fact", oldRow.superseded_by_id === second.id, `→ ${oldRow.superseded_by_id?.slice(0, 8)}`);
  check("contradiction counted in run report", report.factsInvalidated >= 1, `${report.factsInvalidated}`);
}

// ---------------------------------------------------------------------------
// 7. isolation; 8. decay-to-floor
// ---------------------------------------------------------------------------

async function checkIsolation() {
  section("7. Cross-workspace isolation");
  const unscoped = await countWithoutScope("memory_learnings");
  check("fail-closed: no GUC → zero rows (FORCE RLS)", unscoped === 0, `${unscoped} rows`);
  const hits = await memoryRecall(WS_B, { query: "abandoned cart discount email recovery", topK: 10 });
  check("empty workspace recalls nothing from workspace A", hits.length === 0, `${hits.length} hits`);
  const counts = await withWorkspaceScope(WS_B, async (tx) => ({
    episodes: await tx.memoryEpisode.count(),
    facts: await tx.memoryFact.count(),
    learnings: await tx.memoryLearning.count(),
  }));
  check("RLS-scoped counts are zero in workspace B", counts.episodes + counts.facts + counts.learnings === 0, JSON.stringify(counts));
  // Tenant separation, not absence: the same query scoped to workspace A sees rows.
  const countsA = await withWorkspaceScope(WS_A, async (tx) => ({
    learnings: await tx.memoryLearning.count(),
  }));
  check("RLS-scoped count in workspace A is non-zero", countsA.learnings > 0, `${countsA.learnings} learnings`);
}

async function checkDecay() {
  section("8. Decay-to-floor (user_told survives, inferences fade)");
  const told = await recordFact(WS_DECAY, {
    predicate: "founder_birthday",
    object: { value: "user-told fact" },
    origin: "user_told",
    confidence: 1.0,
  });
  const inferred = await recordFact(WS_DECAY, {
    predicate: "seasonal_guess",
    object: { value: "agent inference from 2025" },
    origin: "agent_inferred",
    confidence: 0.2,
  });
  const old = new Date(Date.now() - 400 * 86400_000).toISOString();
  await withWorkspaceScope(WS_DECAY, (tx) =>
    tx.$executeRawUnsafe(`UPDATE memory_facts SET created_at = $2::timestamptz WHERE id = $1`, told.id, old),
  );
  await withWorkspaceScope(WS_DECAY, (tx) =>
    tx.$executeRawUnsafe(`UPDATE memory_facts SET created_at = $2::timestamptz WHERE id = $1`, inferred.id, old),
  );
  await runConsolidationOnce(WS_DECAY);
  const rows = (await withWorkspaceScope(WS_DECAY, (tx) =>
    tx.$queryRawUnsafe(
      `SELECT id, expired_at IS NOT NULL AS expired FROM memory_facts WHERE workspace_id = $1 AND id IN ($2, $3)`,
      WS_DECAY,
      told.id,
      inferred.id,
    ),
  )) as Array<{ id: string; expired: boolean }>;
  const toldRow = rows.find((r) => r.id === told.id)!;
  const infRow = rows.find((r) => r.id === inferred.id)!;
  check("user_told fact survives decay", !toldRow.expired, `expired=${toldRow.expired}`);
  check("stale low-confidence inference pruned to floor", infRow.expired, `expired=${infRow.expired}`);
  check("pruned row still in history (soft-expire)", rows.length === 2);
}

// ---------------------------------------------------------------------------
// 9. adversarial anonymization
// ---------------------------------------------------------------------------

const ADVERSARIAL = [
  {
    name: "email + phone + spend",
    text: "For acme-corp.com we emailed jane.doe@acme-corp.com and called +1-415-555-0132 after spending $48,200 on Google Ads in March.",
    mustNotContain: ["jane.doe@acme-corp.com", "415-555-0132", "48,200", "acme-corp.com"],
  },
  {
    name: "person name + company + URL",
    text: "Sarah Chen at Brightline Media said the dashboard at https://brightline.internal/reports/q3 drove the decision.",
    mustNotContain: ["Sarah Chen", "Brightline Media", "brightline.internal"],
  },
  {
    name: "API-shaped spend + address",
    text: "Client at 1420 Market Street, Suite 200 spent USD 120000 and their Stripe key sk_live_abc123def456ghi was rotated.",
    // Note: secret-shaped values are the write path's job (test 11); the
    // anonymizer's job here is address + spend figures.
    mustNotContain: ["1420 Market Street", "120000"],
  },
  {
    name: "quarantine: dense PII blob",
    text: "Contact john.smith@example.com or j.smith@example.com, alt jsmith2@example.com; phones 212-555-0100, 212-555-0101; budgets $10k, $20k, $30k.",
    mustNotContain: ["john.smith@example.com", "212-555-0100"],
    expectQuarantine: true,
  },
];

async function checkAnonymization() {
  section("9. Adversarial anonymization");
  for (const adv of ADVERSARIAL) {
    const r = anonymizeForPlaybook("", adv.text);
    if (adv.expectQuarantine) {
      check(`quarantined: ${adv.name}`, r.needsManualReview, r.needsManualReview ? "refused" : `INSERTED (bad): ${r.body.slice(0, 80)}`);
      continue;
    }
    if (r.needsManualReview) {
      check(`anonymized: ${adv.name}`, false, "unexpected quarantine");
      continue;
    }
    const leaked = adv.mustNotContain.filter((s) => r.body.includes(s) || r.title.includes(s));
    check(`anonymized: ${adv.name}`, leaked.length === 0, leaked.length ? `leaked: ${leaked.join(", ")}` : `removed: ${r.removedKinds.join(",")}`);
  }
  // scrubJson unit check: secret-shaped values never persist raw.
  const scrubbed = scrubJson({ apiKey: "sk-ant-oat-1234567890abcdef", nested: { gh: "ghp_abcdefghijklmnopqrstuvwxy1234567890" } });
  const raw = JSON.stringify(scrubbed.value);
  check(
    "scrubJson redacts secret-shaped values",
    scrubbed.redactions >= 2 && !raw.includes("sk-ant-oat") && !raw.includes("ghp_"),
    `${scrubbed.redactions} redactions`,
  );
}

// ---------------------------------------------------------------------------
// 10. unreviewed publication gate
// ---------------------------------------------------------------------------

async function checkPublicationGate() {
  section("10. Playbook publication gate (unreviewed never publishes)");
  // Proposals insert through the reviewer GUC: INSERT is allowed for all,
  // but INSERT ... RETURNING cannot surface an unreviewed row under the
  // reviewed-only SELECT policy, so the reviewer scope is required.
  const created = await withPlaybookReviewer(WS_A, (tx) =>
    tx.playbookLearning.create({
      data: {
        patternTitle: "battery: pending pattern must not publish",
        patternBody: "battery: anonymized description of a tactic",
      },
      select: { id: true },
    }),
  );
  try {
    const published = await listReviewedPatterns({ q: "battery: pending pattern" });
    check("unreviewed pattern invisible in published list", published.length === 0, `${published.length} visible`);
    const queue = await listReviewQueue(WS_A);
    check("unreviewed pattern visible in review queue", queue.some((p) => p.id === created.id), `${queue.length} queued`);
    const ok = await reviewPattern(WS_A, "battery-reviewer", created.id, "approved", "battery approval");
    check("human review approves", ok);
    const publishedAfter = await listReviewedPatterns({ q: "battery: pending pattern" });
    check("approved pattern publishes", publishedAfter.some((p) => p.id === created.id), `${publishedAfter.length} visible`);
    check(
      "reviewer + timestamp stamped",
      Boolean(publishedAfter[0]?.reviewedAt && publishedAfter[0]?.anonymizationReviewedBy),
      publishedAfter[0]?.anonymizationReviewedBy ?? "none",
    );
  } finally {
    await withPlaybookReviewer(WS_A, (tx) => tx.playbookLearning.deleteMany({ where: { id: created.id } }));
  }
}

// ---------------------------------------------------------------------------
// 11. secret persistence scan
// ---------------------------------------------------------------------------

async function checkSecretPersistence() {
  section("11. Secret persistence scan (write path)");
  const rawSummary = [
    "Rotated credentials during the deploy.",
    "OpenAI key sk-ant-oat-1234567890abcdef1234567890 was replaced;",
    "AWS key AKIAIOSFODNN7EXAMPLE removed;",
    "db url https://admin:s3cret-pw@db.internal:5432/app noted;",
    "slack xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx pasted in chat.",
  ].join(" ");
  const ep = await recordEpisode(WS_A, { actor: "agent", episodeType: "session", summary: rawSummary });
  const row = (await withWorkspaceScope(WS_A, (tx) =>
    tx.$queryRawUnsafe(`SELECT summary FROM memory_episodes WHERE id = $1`, ep.id),
  )) as Array<{ summary: string }>;
  const stored = row[0]!.summary;
  const leaked = ["sk-ant-oat", "AKIAIOSFODNN7EXAMPLE", "s3cret-pw", "xoxb-1234"].filter((s) => stored.includes(s));
  check("no secret-shaped values persisted raw", leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(", ")}` : "all redacted");
  check("redaction markers present", stored.includes("[REDACTED"), stored.slice(0, 120));
  const fact = await recordFact(WS_A, {
    predicate: "battery_secret_fact",
    object: { token: "ghp_abcdefghijklmnopqrstuvwxy1234567890", note: "should be scrubbed" },
    origin: "agent_inferred",
  });
  const frow = (await withWorkspaceScope(WS_A, (tx) =>
    tx.$queryRawUnsafe(`SELECT object::text AS o FROM memory_facts WHERE id = $1`, fact.id),
  )) as Array<{ o: string }>;
  check("fact JSON scrubbed before persistence", !frow[0]!.o.includes("ghp_abcdef"), frow[0]!.o.slice(0, 100));
}

// ---------------------------------------------------------------------------
// 12. Test Lab archive sink
// ---------------------------------------------------------------------------

async function checkArchiveSink() {
  section("12. Test Lab archive sink → memory_episodes + memory_learnings");
  const learning: GrowthLearning = {
    schema: GROWTH_MEMORY_SINK_SCHEMA,
    learningId: "learn_battery_001",
    workspaceId: WS_A,
    experimentId: "EXP-BATTERY-1",
    archivedAt: new Date().toISOString(),
    hypothesis: "Battery hypothesis: archiving a closed test writes to Growth Memory.",
    result: {
      verdict: "winner",
      expectedUplift: 0.09,
      credibleInterval: [0.02, 0.16],
      chanceToBeat: 0.97,
      expectedLossRelative: 0.001,
      terminal: true,
    },
    metrics: { primaryMetric: "conversion_rate", guardrailChecks: [] },
    context: {
      channel: "email",
      audience: "trial users",
      variants: [{ id: "a", name: "control" }, { id: "b", name: "treatment" }],
      minRuntimeDays: 21,
      statedMde: 0.05,
      pieIceScore: 7.5,
    },
    followUps: ["Roll out the winner."],
    caveats: [],
  };
  const sink = createPrismaMemorySink();
  const { ref, stored } = await sink.archive(learning);
  check("sink stored", stored, ref);
  const epCount = await withWorkspaceScope(WS_A, (tx) =>
    tx.memoryEpisode.count({ where: { refs: { path: ["learningId"], equals: "learn_battery_001" } } }),
  );
  const learnCount = await withWorkspaceScope(WS_A, (tx) =>
    tx.memoryLearning.count({ where: { contextRefs: { path: ["learningId"], equals: "learn_battery_001" } } }),
  );
  check("archive created a memory_episode", epCount === 1, `${epCount}`);
  check("archive created a memory_learning", learnCount === 1, `${learnCount}`);
  const recalled = await memoryRecall(WS_A, { query: "EXP-BATTERY-1 archiving closed test", topK: 5 });
  check("archived learning is recallable", recalled.some((h) => h.store === "learning"), `${recalled.length} hits`);
}

// ---------------------------------------------------------------------------
// 13. substrate.context() E2E
// ---------------------------------------------------------------------------

async function checkContextContract() {
  section("13. substrate.context() contract (Phase 9 interface)");
  // Plant a graph node + edge so the slice is non-trivial.
  await withGraphScope(WS_CTX, async (tx) => {
    const node = await tx.graphNode.create({
      data: {
        workspaceId: WS_CTX,
        entityType: "competitor",
        canonicalKey: "competitor:acme-rival",
        displayName: "Acme Rival cart-recovery platform",
        asOf: new Date(),
        asOfSource: "battery",
      },
    });
    const node2 = await tx.graphNode.create({
      data: {
        workspaceId: WS_CTX,
        entityType: "channel",
        canonicalKey: "channel:email",
        displayName: "Email marketing channel",
        asOf: new Date(),
        asOfSource: "battery",
      },
    });
    await tx.graphEdge.create({
      data: {
        workspaceId: WS_CTX,
        fromNodeId: node.id,
        toNodeId: node2.id,
        edgeType: "competes_on",
        validAt: new Date(),
      },
    });
  });
  await recordLearning(WS_CTX, {
    hypothesis: "battery: cart recovery via email works",
    action: "battery action",
    result: "worked",
    source: "human",
  });
  const ctx = await substrateContext(WS_CTX, { query: "cart recovery email", topK: 5, graphLimit: 10 });
  check("context returns graph slice", ctx.graph.nodes.length >= 1, `${ctx.graph.nodes.length} nodes`);
  check("context returns connecting edges", ctx.graph.edges.length >= 1, `${ctx.graph.edges.length} edges`);
  check("context returns memories with provenance", ctx.memories.length >= 1 && Boolean(ctx.memories[0]!.refId), `${ctx.memories.length} memories`);
  check(
    "freshness labels on everything",
    ctx.graph.nodes.every((n) => Boolean(n.freshness?.label)) && ctx.memories.every((m) => Boolean(m.freshness?.label)),
  );
  check("budgets reported", ctx.budgets.memories === 5 && ctx.budgets.graphNodes === 10, JSON.stringify(ctx.budgets));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log("# Phase 8 G3 Growth Memory battery");
  console.log(`worker identity: ${getWorkerIdentity()}`);
  const t0 = Date.now();
  await resetBatteryState();
  await checkInfra();
  await plantFixtures();
  await checkRetrievalQuality();
  await checkRecallAndTemporal();
  await checkContradiction();
  await checkIsolation();
  await checkDecay();
  await checkAnonymization();
  await checkPublicationGate();
  await checkSecretPersistence();
  await checkArchiveSink();
  await checkContextContract();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n## summary: ${checks.length - failed.length}/${checks.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("ALL GREEN");
  }
}

main()
  .catch((err) => {
    console.error("battery fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
