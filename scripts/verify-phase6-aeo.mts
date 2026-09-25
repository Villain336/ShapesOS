// Marketr — Phase 6 AEO fixture E2E battery (A1).
//
// Run: npx tsx scripts/verify-phase6-aeo.mts
// Run 3x green before calling this done.
//
// Full fixture run: 20 prompts × 4 engines × N=3 reps through the REAL
// orchestrator (executeRunPlan) with fake engine clients + fake nano
// judge, in-memory mention sink. Verifies:
//   - run plan = prompt × engine × rep (N=3, engine-major)
//   - monthly cost envelope: binding constraint is the $5/brand cap
//     (withinEnvelope, flagged if breached). SPEC §2 says "≈$1–5/mo"
//     at 30 prompts; the validated model prices 30 prompts at ~$0.96/mo
//     (nano-class gens + nano judge) — the ≈ was approximate, the $5 cap
//     is the enforced invariant.
//   - per-engine scoring only — no composite exists or is computable
//   - fake mode default; real engine path throws NotConfiguredError
//   - per-engine spread is the metric (divergence disclosed)

import {
  AEO_ENGINES, createFakeEngineClient, resolveEngineClient,
  NANO_GEN_COST_USD, JUDGE_CALL_COST_USD,
} from "../lib/authority/aeo/engines";
import {
  buildRunPlan, estimateRunCost, executeRunPlan,
  createMemoryMentionSink, AEO_REPS_DEFAULT,
} from "../lib/authority/aeo/run";
import { scorePerEngine } from "../lib/authority/aeo/scoring";
import { resolveJudge } from "../lib/authority/aeo/judge";
import { computeSourceImpact } from "../lib/authority/aeo/impact";
import { NotConfiguredError } from "../lib/authority/fake";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}

const PROMPTS = Array.from({ length: 20 }, (_, i) =>
  `What is the best CRM for a ${["startup", "agency", "law firm", "clinic"][i % 4]} with ${10 + i} staff? (q${i})`);

async function main() {
  console.log("Phase 6 AEO fixture E2E battery");

  // --- 1. Run plan shape ----------------------------------------------------
  console.log("\n[run plan]");
  if (AEO_REPS_DEFAULT === 3) ok("N=3 reps default");
  else bad("reps", String(AEO_REPS_DEFAULT));
  const plan = buildRunPlan(PROMPTS.length, AEO_ENGINES, 3);
  if (plan.length === 20 * 4 * 3) ok(`plan = 240 jobs (20×4×3)`);
  else bad("plan size", String(plan.length));
  const perEngine = new Map(plan.map((j) => [j.engine, 0]));
  for (const j of plan) perEngine.set(j.engine, (perEngine.get(j.engine) ?? 0) + 1);
  if ([...perEngine.values()].every((n) => n === 60)) ok("60 jobs per engine (20 prompts × 3 reps)");
  else bad("per-engine jobs", JSON.stringify([...perEngine]));
  const reps = new Set(plan.filter((j) => j.engine === "openai" && j.promptIdx === 0).map((j) => j.rep));
  if (reps.size === 3) ok("3 reps per prompt per engine");
  else bad("reps", String(reps.size));

  // --- 2. Cost envelope ------------------------------------------------------
  // Binding invariant: monthly cost stays under the $5/brand cap; breaches
  // are flagged, never hidden. (SPEC §2 "≈$1–5/mo" at 30 prompts was
  // approximate — the validated model prices 30 prompts at ~$0.96/mo.)
  console.log("\n[cost envelope]");
  const est = estimateRunCost({ promptCount: 20 });
  const est30 = estimateRunCost({ promptCount: 30 });
  console.log(`  weekly $${est.weeklyUsd.toFixed(4)} → monthly $${est.monthlyUsd.toFixed(4)} (envelope $${est.envelopeUsd})`);
  console.log(`  spec reference (30 prompts): $${est30.monthlyUsd.toFixed(2)}/mo`);
  if (est.monthlyUsd > 0 && est.monthlyUsd <= 5) ok(`monthly $${est.monthlyUsd.toFixed(2)}/brand under $5 cap`);
  else bad("envelope", `$${est.monthlyUsd.toFixed(2)}`);
  if (est.withinEnvelope && est.envelopeUsd === 5) ok("withinEnvelope true, $5 envelope");
  else bad("withinEnvelope", String(est.withinEnvelope));
  // A runaway prompt set must FLAG, not hide, the breach.
  const big = estimateRunCost({ promptCount: 500 });
  if (!big.withinEnvelope) ok(`500-prompt run flagged: $${big.monthlyUsd.toFixed(2)}/mo over envelope`);
  else bad("breach flag", "not flagged");

  // --- 3. Full fixture execution ----------------------------------------------
  console.log("\n[fixture run]");
  const t0 = Date.now();
  const clients = Object.fromEntries(
    AEO_ENGINES.map((e) => [e, createFakeEngineClient(e, { brand: "Acme", ownedDomain: "acme.example.com" })]),
  ) as Record<(typeof AEO_ENGINES)[number], ReturnType<typeof createFakeEngineClient>>;
  const judge = resolveJudge({ fake: true });
  if (judge.name === "fake-nano-judge") ok("fake nano judge default");
  else bad("judge", judge.name);
  const sink = createMemoryMentionSink();
  const result = await executeRunPlan(
    { engineClients: clients, judge, sink, brand: "Acme" },
    plan, PROMPTS, est,
  );
  console.log(`  ${result.generations} generations in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (result.mentionsRecorded === 240) ok("240 mentions recorded");
  else bad("mentions", String(result.mentionsRecorded));
  if (!result.envelopeFlagged) ok("envelope not flagged on standard run");
  else bad("envelope flag", "flagged incorrectly");

  // --- 4. Per-engine scoring, no composite --------------------------------------
  console.log("\n[per-engine scoring]");
  const byEngine = Object.fromEntries(AEO_ENGINES.map((e) => [e, [] as never[]]));
  for (const m of sink.mentions) {
    const engine = plan.find((j) => j.promptIdx === m.promptIdx && j.rep === m.rep);
    void engine;
  }
  // Rebuild per-engine mention lists from the sink (engine is in the job plan order).
  const engineMentions: Record<string, never[]> = Object.fromEntries(AEO_ENGINES.map((e) => [e, []]));
  sink.mentions.forEach((m, i) => { engineMentions[plan[i].engine].push(m as never); });
  const scores = scorePerEngine(engineMentions as never, "Acme");
  let scored = 0;
  for (const e of AEO_ENGINES) {
    const s = scores[e];
    if (s && typeof s.mentionRate === "number") { scored += 1; ok(`${e}: mentionRate ${s.mentionRate.toFixed(0)}%`); }
    else bad(`${e} score`, "missing");
  }
  if (scored === 4) ok("all four engines scored independently");
  // The module deliberately exports no cross-engine blending function.
  const scoringSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("lib/authority/aeo/scoring.ts", "utf8"));
  const codeOnly = scoringSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (!/average\s*\(|blend\w*\s*\(|composite/i.test(codeOnly)) {
    ok("no composite/average/blend function in scoring module");
  } else bad("composite", "blending code found");
  void byEngine;

  // --- 5. Source impact ---------------------------------------------------------
  console.log("\n[source impact]");
  // Source impact is per-engine too (no cross-engine blending).
  const impactByEngine = AEO_ENGINES.map((e) =>
    computeSourceImpact(e, engineMentions[e] as never[]));
  const totalRows = impactByEngine.reduce((n, rows) => n + rows.length, 0);
  if (totalRows > 0) ok(`${totalRows} source-impact rows across 4 engines`);
  else bad("source impact", "empty");
  const owned = impactByEngine.flat().find((r) => r.domain === "acme.example.com");
  if (owned) ok("owned domain appears in source impact");
  else bad("owned domain", "missing");

  // --- 6. Fake-first honesty ------------------------------------------------------
  console.log("\n[fake-first]");
  const fakeClient = resolveEngineClient("openai", {});
  if (fakeClient.fake) ok("engine client fake by default");
  else bad("engine fake", "not fake");
  try {
    resolveEngineClient("openai", { apiKey: "sk_test_x" });
    bad("real engine path", "did not throw");
  } catch (err) {
    if (err instanceof NotConfiguredError) ok("real engine without real adapter → NotConfiguredError");
    else bad("real engine path", String(err));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log("FAILURES:", failures); process.exit(1); }
  console.log("AEO BATTERY GREEN");
}

main().catch((err) => { console.error("battery crashed:", err); process.exit(2); });
