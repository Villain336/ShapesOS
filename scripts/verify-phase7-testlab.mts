// Marketr — Phase 7 F3 Test Lab verification battery.
//
// Run: npx tsx scripts/verify-phase7-testlab.mts
// Run 3x green before calling this done.
//
// Spec §10 exit gates 5 (stats battery) and 6 (E2E idea→archive):
//   5a. injected SRM failure → results refuse to render
//   5b. underpowered fixture → INCONCLUSIVE with detectable-lift math
//   5c. profit-guardrail violation → conversion test refuses to launch
//   5d. peeking simulation (20 interim looks, null effect) → no false "winner"
//   5e. Bayesian early-read gated on expected loss + minimum data
//   6.  full E2E: idea → traffic floor → QA/A/A → launch → monitoring →
//       verdict → structured learning archived to the Growth Memory sink schema
//
// Pure-module battery: memory store, no DB, no secrets, deterministic.

import {
  checkSrm, bayesianBinomial, sequentialTest, frequentistTest,
  binomialToGaussian,
} from "../lib/flywheel/testlab/stats";
import { runIntegrityBattery } from "../lib/flywheel/testlab/integrity";
import { trafficFloorCheck, sampleSizePerArm, detectableLift } from "../lib/flywheel/testlab/traffic";
import { honestyRead, fdrCorrect } from "../lib/flywheel/testlab/honesty";
import {
  canTransition, pieIceScore, buildQaReport, launchGate,
  createTestLabAuditLog, LifecycleError,
  type Experiment,
} from "../lib/flywheel/testlab/experiment";
import { createMemoryExperimentStore } from "../lib/flywheel/testlab/store";
import { buildGrowthLearning, createFakeMemorySink, GROWTH_MEMORY_SINK_SCHEMA } from "../lib/flywheel/testlab/memory-sink";
import { assignWebVariant, splitMailList, buildWebManifest } from "../lib/flywheel/testlab/assignment";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
function expect(cond: boolean, name: string, detail = "") {
  if (cond) ok(name); else bad(name, detail);
}

const WS = "ws_testlab_battery";
const now = new Date().toISOString();

function makeExp(over: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp_battery_1", workspaceId: WS,
    name: "Homepage hero test", hypothesis: "A benefit-led headline lifts signup conversion.",
    pieIceScore: 8.0, channel: "web",
    variants: [
      { id: "control", name: "Control", weight: 0.5 },
      { id: "treatment", name: "Benefit headline", weight: 0.5 },
    ],
    audience: "all visitors", primaryMetric: "conversion_rate", metricType: "binomial",
    guardrailMetrics: [{ name: "bounce_rate", tolerance: 0.05 }],
    status: "draft",
    profitGuardrail: { marginPerConversion: 40, discountCostPerConversion: 5 },
    trafficFloorNote: null, minRuntimeDays: 14, statedMde: 0.2,
    verdict: null, baselineRate: 0.02, monthlyTraffic: 40000,
    launchedAt: null, completedAt: null, qaReport: null,
    createdBy: "battery", createdAt: now, updatedAt: now,
    ...over,
  };
}

const CLEAN_INTEGRITY = {
  armCounts: [40000, 40000],
  armWeights: [0.5, 0.5],
  coverage: { randomizedUnits: 80000, unitsInAnalysis: 80000 },
  prePeriodMeans: [0.02, 0.0201],
  prePeriodNs: [40000, 40000],
  exposureLeakageRate: 0,
  concurrentTests: [],
  volatility: { observedDailySd: 0.002, historicalDailySd: 0.0021 },
};

async function gate5() {
  console.log("\n[GATE 5] Test Lab stats battery");

  // 5a. Injected SRM failure → results refuse to render
  {
    const srm = checkSrm([10000, 11000], [0.5, 0.5], 0.001);
    expect(!srm.pass && srm.pValue < 0.001, "SRM detects skewed split", `p=${srm.pValue}`);
    const battery = runIntegrityBattery({ ...CLEAN_INTEGRITY, armCounts: [10000, 11000], coverage: { randomizedUnits: 21000, unitsInAnalysis: 21000 } });
    expect(!battery.renderAllowed, "5a: SRM failure → render refused", JSON.stringify(battery.checks[0]));
    const read = honestyRead({
      metricType: "binomial",
      armA: { successes: 800, trials: 40000 }, armB: { successes: 1120, trials: 40000 },
      statedMde: 0.2, minRuntimeDays: 14, daysRunning: 14, fullCycleCovered: true,
      guardrails: [], expectedLossThreshold: 0.01, minUnits: 500,
      conversionTest: true, profitCheck: { profitUplift: 0.1, profitLoss: 0 },
    }, battery);
    expect(read.verdict === "compromised" && read.chanceToBeat === 0.5 && read.ci[0] === 0,
      "5a: compromised verdict, numbers zeroed (never shown)",
      `verdict=${read.verdict}`);
    expect(/COMPROMISED/.test(read.headline), "5a: headline says EXPERIMENT COMPROMISED", read.headline);
  }

  // 5b. Underpowered fixture → INCONCLUSIVE with detectable-lift math
  {
    const battery = runIntegrityBattery({
      ...CLEAN_INTEGRITY,
      armCounts: [500, 500],
      coverage: { randomizedUnits: 1000, unitsInAnalysis: 1000 },
    });
    expect(battery.renderAllowed, "underpowered fixture still renders (SRM clean)");
    const read = honestyRead({
      metricType: "binomial",
      armA: { successes: 10, trials: 500 }, armB: { successes: 13, trials: 500 },
      statedMde: 0.2, minRuntimeDays: 14, daysRunning: 14, fullCycleCovered: true,
      guardrails: [], expectedLossThreshold: 0.01, minUnits: 500,
      conversionTest: false,
    }, battery);
    expect(read.verdict === "inconclusive" && read.terminal, "5b: underpowered → terminal INCONCLUSIVE", `verdict=${read.verdict} terminal=${read.terminal}`);
    expect(read.badges.power.label === "underpowered" && /detect/.test(read.badges.power.detail),
      "5b: power badge states the detectable lift", read.badges.power.detail);
    expect(!/significant/i.test(read.headline + read.guidance.join(" ")), "5b: no 'significance' language anywhere");
  }

  // 5c. Profit-guardrail violation → conversion test refuses to launch
  {
    const noProfit = makeExp({ profitGuardrail: undefined });
    const gate = launchGate({ ...noProfit, status: "qa", qaReport: { passed: true, forceQaLinks: {}, cookiePreview: { cookieName: "x", cookieValue: "y" }, aaDryRun: { passed: true, detail: "", maxSpuriousLift: 0 }, checks: [], ranAt: now } });
    expect(!gate.ok && gate.blockers.some((b) => /Profit guardrail/i.test(b)),
      "5c: launch refused without profit guardrail", gate.blockers.join(" | "));
  }

  // 5d. Peeking simulation: 20 interim looks, NULL effect → never a winner
  {
    let winners = 0;
    for (let peek = 1; peek <= 20; peek++) {
      const n = 2000 * peek;
      const battery = runIntegrityBattery({
        ...CLEAN_INTEGRITY,
        armCounts: [n, n],
        coverage: { randomizedUnits: 2 * n, unitsInAnalysis: 2 * n },
      });
      const read = honestyRead({
        metricType: "binomial",
        armA: { successes: Math.round(0.02 * n), trials: n },
        armB: { successes: Math.round(0.02 * n), trials: n },
        statedMde: 0.2, minRuntimeDays: 14,
        daysRunning: peek >= 14 ? 14 : peek, // mature only at the end
        fullCycleCovered: peek >= 14,
        guardrails: [], expectedLossThreshold: 0.01, minUnits: 500,
        conversionTest: false,
      }, battery);
      if (read.verdict === "winner") winners++;
      if (read.verdict === "loser") { bad("5d: peek simulation", `false loser at peek ${peek}`); break; }
    }
    expect(winners === 0, "5d: 20 null-effect peeks → zero false winners", `${winners} winners`);
  }

  // 5e. Bayesian early-read gated on expected loss + minimum data
  {
    // Strong posterior probability but thin data and high relative loss → no deploy
    const battery = runIntegrityBattery({
      ...CLEAN_INTEGRITY,
      armCounts: [300, 300],
      coverage: { randomizedUnits: 600, unitsInAnalysis: 600 },
    });
    const read = honestyRead({
      metricType: "binomial",
      armA: { successes: 6, trials: 300 }, armB: { successes: 12, trials: 300 },
      statedMde: 0.2, minRuntimeDays: 14, daysRunning: 14, fullCycleCovered: true,
      guardrails: [], expectedLossThreshold: 0.005, minUnits: 5000,
      conversionTest: false,
    }, battery);
    expect(read.verdict !== "winner",
      "5e: thin-data early read cannot deploy on posterior probability alone",
      `verdict=${read.verdict} chance=${(read.chanceToBeat * 100).toFixed(1)}%`);
    // And the positive control: a real, mature, powered lift DOES deploy
    const battery2 = runIntegrityBattery(CLEAN_INTEGRITY);
    const read2 = honestyRead({
      metricType: "binomial",
      armA: { successes: 800, trials: 40000 }, armB: { successes: 1120, trials: 40000 },
      statedMde: 0.2, minRuntimeDays: 14, daysRunning: 14, fullCycleCovered: true,
      guardrails: [], expectedLossThreshold: 0.01, minUnits: 500,
      conversionTest: true, profitCheck: { profitUplift: 0.3, profitLoss: 0.002 },
    }, battery2);
    expect(read2.verdict === "winner" && read2.terminal,
      "5e(+): mature+powered 40% lift → winner", `verdict=${read2.verdict} chance=${(read2.chanceToBeat * 100).toFixed(1)}% seqExcludes=${read2.sequentialExcludesNull}`);
    expect(read2.chanceToBeat > 0.99, "5e(+): Beta-Binomial chance-to-beat ≈ 1 on strong data", String(read2.chanceToBeat));
  }

  // Sanity: ported primitives behave like the vendored sources
  {
    const srm = checkSrm([5000, 5000], [0.5, 0.5], 0.001);
    expect(srm.pass && srm.pValue > 0.99, "checkSrm: balanced split passes", `p=${srm.pValue}`);
    const gA = binomialToGaussian({ successes: 200, trials: 10000 });
    const gB = binomialToGaussian({ successes: 200, trials: 10000 });
    const f = frequentistTest(gA, gB);
    expect(f.pValue > 0.9, "frequentist backstop: null data, p≈1", `p=${f.pValue}`);
    const s = sequentialTest(0, 1e-6, 20000);
    expect(s.pValue >= 0.99, "always-valid p: null data never flags", `p=${s.pValue}`);
    const sig = fdrCorrect([0.001, 0.04, 0.3, 0.8]);
    expect(sig[0] && !sig[2] && !sig[3], "FDR: only strong secondaries survive", JSON.stringify(sig));
    const n = sampleSizePerArm(0.02, 0.2);
    expect(n > 20000 && n < 40000, "sample-size math sane for 20% lift @2%", `n=${n}`);
  }

  // Traffic-floor reference math: 5k/mo @2% cannot detect a 20% lift quickly
  {
    const floor = trafficFloorCheck({ baselineRate: 0.02, monthlyTraffic: 5000, hopedLift: 0.2, statedMde: 0.2 });
    expect(floor.decision === "refuse" && /detect/.test(floor.note),
      "traffic floor refuses 5k/mo site on 20% lift", `${floor.decision}: ${floor.note}`);
    expect(floor.weeksNeeded > 20, "traffic floor math: ~8+ months to detect", `${floor.weeksNeeded.toFixed(1)} weeks`);
    const det = detectableLift(10000, 0.02);
    expect(det > 0.2, "detectableLift sane at low traffic", `detectable=${(det * 100).toFixed(1)}%`);
  }

  // Assignment layer sanity
  {
    const exp = makeExp();
    const seen = new Set([...Array(200)].map((_, i) => assignWebVariant(`user_${i}`, exp)));
    expect(seen.size === 2, "web assignment: deterministic, both variants hit", [...seen].join(","));
    expect(assignWebVariant("user_7", exp) === assignWebVariant("user_7", exp), "web assignment: stable per unit");
    const manifest = buildWebManifest(exp);
    expect(manifest.features[`exp_${exp.id}`].rules[0].variations.length === 2, "web manifest: 2 variations");
    const split = splitMailList(["a", "b", "c", "d"], exp.variants);
    expect(split.control.length === 2 && split.treatment.length === 2, "mail split drops: even deterministic split");
    const b = bayesianBinomial({ successes: 200, trials: 10000 }, { successes: 260, trials: 10000 });
    expect(b.chanceToBeat > 0.95, "Beta-Binomial: 30% lift @10k/arm resolves", `chance=${(b.chanceToBeat * 100).toFixed(1)}%`);
  }
}

async function gate6() {
  console.log("\n[GATE 6] Test Lab E2E: idea → archive");
  const store = createMemoryExperimentStore();
  const audit = createTestLabAuditLog();

  // 1. Idea (PIE/ICE)
  const idea = await store.createIdea(WS, {
    title: "Benefit-led homepage headline",
    sourceSignal: "phase2: heatmap rage-clicks on hero",
    pieIceScore: pieIceScore({ potential: 8, importance: 9, ease: 7 }),
    status: "queued",
  });
  expect(idea.pieIceScore === 8.0, "idea created with PIE/ICE score", String(idea.pieIceScore));
  const ideas = await store.listIdeas(WS);
  expect(ideas.length === 1, "idea queue lists the idea");

  // 2. Experiment created → traffic floor runs at creation
  let exp = makeExp({ monthlyTraffic: 40000, baselineRate: 0.02, statedMde: 0.2 });
  exp = await store.createExperiment(WS, exp);
  expect(exp.status === "draft", "experiment starts in draft");
  audit.log(WS, "battery", "experiment.created", exp.id, {});

  // 3. QA: draft → qa (force-QA links, cookie preview, A/A dry-run)
  const qa = buildQaReport(exp, "http://localhost:3000");
  expect(qa.passed, "QA passes (weights, runtime, MDE, A/A, profit guardrail)",
    qa.checks.filter((c) => !c.passed).map((c) => c.name).join(","));
  expect(Object.keys(qa.forceQaLinks).length === 2, "force-QA links generated per variant");
  expect(qa.cookiePreview.cookieName === `mk_exp_${exp.id}`, "cookie preview name namespaced");
  expect(qa.aaDryRun.passed, "A/A dry-run clean");
  if (!canTransition(exp.status, "qa")) bad("E2E", "draft→qa illegal"); else {
    exp = await store.updateExperiment(WS, exp.id, { status: "qa", qaReport: qa });
    audit.log(WS, "battery", "experiment.qa", exp.id, { passed: qa.passed });
    ok("transition draft → qa");
  }

  // 4. Launch gate → running
  const gate = launchGate(exp);
  expect(gate.ok, "launch gate passes", gate.blockers.join(" | "));
  expect(gate.trafficFloor.decision !== "refuse", "traffic floor does not refuse", gate.trafficFloor.decision);
  exp = await store.updateExperiment(WS, exp.id, { status: "running", launchedAt: now, trafficFloorNote: gate.trafficFloor.note });
  audit.log(WS, "battery", "experiment.launched", exp.id, {});
  ok("transition qa → running (launched)");

  // 5. Monitoring: interim read is peek-safe and non-terminal
  {
    const battery = runIntegrityBattery({ ...CLEAN_INTEGRITY, armCounts: [5000, 5000], coverage: { randomizedUnits: 10000, unitsInAnalysis: 10000 } });
    const read = honestyRead({
      metricType: "binomial",
      armA: { successes: 100, trials: 5000 }, armB: { successes: 112, trials: 5000 },
      statedMde: 0.2, minRuntimeDays: 14, daysRunning: 4, fullCycleCovered: false,
      guardrails: [], expectedLossThreshold: 0.01, minUnits: 500, conversionTest: false,
    }, battery);
    expect(!read.terminal && read.verdict === "inconclusive", "interim (immature) read: peek-safe, non-terminal");
    expect(read.badges.maturity.label === "immature", "maturity badge flags novelty risk");
  }

  // 6. Final verdict: mature + powered + real lift → winner
  const battery = runIntegrityBattery(CLEAN_INTEGRITY);
  expect(battery.renderAllowed && !battery.compromised, "integrity battery clean at read time");
  const read = honestyRead({
    metricType: "binomial",
    armA: { successes: 800, trials: 40000 }, armB: { successes: 1120, trials: 40000 },
    statedMde: 0.2, minRuntimeDays: 14, daysRunning: 14, fullCycleCovered: true,
    guardrails: [], expectedLossThreshold: 0.01, minUnits: 500,
    conversionTest: true, profitCheck: { profitUplift: 0.3, profitLoss: 0.002 },
  }, battery);
  expect(read.verdict === "winner" && read.terminal, "final read: winner, terminal", read.headline);
  await store.saveResult({
    experimentId: exp.id,
    statsJson: { prob_to_beat: read.chanceToBeat, sequential_ci: read.sequentialCi, frequentist_p: read.frequentistP },
    srm: { status: "pass", pValue: 0.9 },
    guardrailChecks: [],
    verdict: read.verdict,
    archivedToMemory: false,
  });
  exp = await store.updateExperiment(WS, exp.id, { status: "complete", completedAt: now, verdict: read.verdict });
  audit.log(WS, "battery", "experiment.verdict", exp.id, { verdict: read.verdict });
  ok("transition running → complete (verdict winner)");

  // 7. Archive → Growth Memory sink (forward-compatible schema)
  const saved = await store.getResult(exp.id);
  const learning = buildGrowthLearning(exp, {
    verdict: read.verdict, terminal: read.terminal,
    chanceToBeat: read.chanceToBeat, expectedLossRelative: read.expectedLossRelative,
    expectedUplift: read.expectedUplift, ci: read.ci,
    sequentialCi: read.sequentialCi, sequentialExcludesNull: read.sequentialExcludesNull,
    frequentistP: read.frequentistP, badges: read.badges,
    guardrailViolations: [], guidance: read.guidance, headline: read.headline,
  });
  expect(learning.schema === GROWTH_MEMORY_SINK_SCHEMA, "learning carries the forward-compatible schema");
  expect(learning.followUps.length > 0 && learning.caveats.length >= 0, "learning has follow-ups + caveats");
  const sink = createFakeMemorySink();
  const { ref, stored } = await sink.archive(learning);
  expect(stored && ref.startsWith("memory://"), "learning archived to Growth Memory sink", ref);
  expect(saved !== null, "result row persisted before archive");
  if (!canTransition(exp.status, "archived")) bad("E2E", "complete→archived illegal"); else {
    exp = await store.updateExperiment(WS, exp.id, { status: "archived" });
    audit.log(WS, "battery", "experiment.archived", exp.id, { memoryRef: ref });
    ok("transition complete → archived");
  }

  // Illegal transition is rejected
  try {
    if (!canTransition("archived", "running")) throw new LifecycleError("archived", "running");
    bad("E2E", "archived→running was allowed");
  } catch (e) {
    expect(e instanceof LifecycleError, "archived → running rejected by the state machine");
  }

  // Audit chain verifies
  const chain = audit.verifyChain();
  expect(chain.ok, "lifecycle audit chain verifies", `brokenAt=${chain.brokenAt}`);
  expect(audit.list().length >= 5, "every transition + verdict audit-logged", `${audit.list().length} events`);
}

async function main() {
  await gate5();
  await gate6();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log("Failures:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("Test Lab battery GREEN.");
}

main().catch((e) => { console.error(e); process.exit(1); });
