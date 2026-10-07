// Phase 19B (WS=panel) — friction timelines, verdicts, the panel report and
// the run diff.
// Ported from the prototype's test/timeline.test.ts (12), test/verdicts.test.ts
// (9) and test/aggregate.test.ts (11). Dropped with a reason: the 3 cases
// that tested the prototype's static HTML files (renderTimelineHtml,
// renderPanelReportHtml ×2) — the report is the dashboard's React view now,
// asserted by the browser smoke; and saveTimelineArtifact's local-disk copy
// is replaced by blob refs (its case is ported as "timelines carry blob refs").
// Added: no calibration → no verdict, incomplete walks are withheld, interview
// tracing, the distribution's withheld list, fixes stopping at the cap, diffReports.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { aggregateReport, clusterObjections, diffReports, FIX_CLUSTER_CAP, sectionHeat, SYNTHETIC_DISCLAIMER, type PanelReport } from "../aggregate";
import { PanelLedger } from "../budget";
import { InMemoryMemoryStore } from "../memory";
import { RouterPanelModel } from "../model";
import { buildTimeline, expectedReadingMs } from "../timeline";
import { filterTraceableQuotes, traceQuote, traceToInterviews, type EvidenceItem } from "../trace";
import { NoCalibrationError, renderVerdict, verdictOrWithheld, type PersonaVerdict } from "../verdicts";
import type { WalkthroughResult } from "../walk";
import { mkObs, mkResult, mkSignals, mkStep, SKEPTIC, validSpec } from "./fixtures";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const SHOT = (n: string) => `blob:rehearsal/ws/run-timeline-test/p-dana/${n}`;

function timelineFixture(): WalkthroughResult {
  const steps = [
    mkStep(0, {
      startedAt: 1000,
      endedAt: 21_000,
      intent: { action: "read", target: "Pricing", value: null, finish: null },
      thinkAloud: "The hero was vague about price. Let me find the actual number.",
      observation: mkObs({ type: "read", textExcerpt: words(30), screenshotRef: SHOT("step-0-read.png"), sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }),
      // 20s on 30 words (~8.2s expected) → attention died; rage clicks.
      signals: mkSignals({ dwellMs: 20_000, scrollDepthPct: 20, clicks: 4, rageClickBursts: 1, hoverDwellMs: 500 }),
    }),
    mkStep(1, {
      startedAt: 21_000,
      endedAt: 22_500,
      thinkAloud: "Free trial sounds good, but what happens after 14 days? Hovering.",
      observation: mkObs({ type: "scrolled", screenshotRef: SHOT("step-1-scrolled.png"), sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }),
      signals: mkSignals({ dwellMs: 1500, scrollDepthPct: 25, clicks: 0, hoverDwellMs: 4500 }),
    }),
    mkStep(2, {
      startedAt: 22_500,
      endedAt: 23_300,
      observation: mkObs({ type: "not-found", textExcerpt: "", detail: 'No section matching "Testimonials" found on the page.', sectionMeta: { heading: "Features", url: "https://example.com/#features" } }),
      signals: mkSignals({ dwellMs: 800, scrollDepthPct: 45 }),
    }),
    mkStep(3, {
      startedAt: 23_300,
      endedAt: 24_000,
      thinkAloud: "Maybe the enterprise plan is $500. That is over my budget.",
      observation: mkObs({ type: "clicked", textExcerpt: words(12) }),
      signals: mkSignals({ dwellMs: 700, scrollDepthPct: 60, clicks: 1 }),
      flags: [
        { check: "persona_adherence", passed: false, detail: "Mentions $500, over $100 hard cap" },
        { check: "self_consistency", passed: true, detail: "Budget stance consistent" },
      ],
    }),
    mkStep(4, {
      startedAt: 24_000,
      endedAt: 24_500,
      intent: { action: "finish", target: null, value: null, finish: "bounced" },
      observation: mkObs({ type: "finished", finishSignal: "bounced", textExcerpt: "", screenshotRef: SHOT("step-4-finished.png") }),
      signals: mkSignals({ dwellMs: 500, scrollDepthPct: 90 }),
    }),
  ];
  return { ...mkResult("bounced", steps, "run-timeline-test"), signals: { ...mkResult("bounced", steps).signals, maxScrollDepthPct: 90, dropOff: { url: "https://example.com/" } } };
}

describe("buildTimeline", () => {
  const tl = buildTimeline(timelineFixture());
  const bySummary = (s: string) => tl.events.filter((e) => e.summary.includes(s));

  it("flags rage clicks as friction", () => {
    assert.deepEqual(bySummary("Rage-click").map((e) => [e.kind, e.severity]), [["signal", "friction"]]);
  });
  it("flags a long hover without a click as hesitation", () => {
    const h = bySummary("Hesitation");
    assert.equal(h.length, 1);
    assert.match(h[0]!.detail ?? "", /never committed/);
  });
  it("maps not-found observations to confusion", () => {
    assert.deepEqual(bySummary("Confusion").map((e) => e.stepIndex), [2]);
  });
  it("flags attention death when dwell exceeds 2× expected reading time", () => {
    assert.equal(expectedReadingMs(words(30)), 8182);
    assert.equal(bySummary("Attention died").length, 1);
  });
  it("turns failed checks into friction, stays silent on passed ones", () => {
    const flags = tl.events.filter((e) => e.kind === "flag");
    assert.equal(flags.length, 1);
    assert.match(flags[0]!.summary, /persona_adherence/);
  });
  it("marks the drop-off step critical on a bounced walk", () => {
    assert.equal(tl.criticalCount, 1);
    const crit = tl.events.filter((e) => e.severity === "critical");
    assert.equal(crit[0]!.stepIndex, 4);
    assert.match(crit[0]!.summary, /Bounced/);
  });
  it("rolls sections up", () => {
    const pricing = tl.sections.find((s) => s.name === "Pricing")!;
    assert.deepEqual([pricing.visits, pricing.totalDwellMs, pricing.maxScrollDepth, pricing.frictionCount], [2, 21_500, 25, 3]);
    const features = tl.sections.find((s) => s.name === "Features")!;
    assert.deepEqual([features.visits, features.frictionCount], [1, 1]);
    const page = tl.sections.find((s) => s.name === "(page)")!;
    assert.deepEqual([page.visits, page.frictionCount], [2, 2]);
  });
  it("counts totals and stamps relative timestamps in order", () => {
    assert.equal(tl.frictionCount, 5);
    assert.equal(tl.events[0]!.t, 0);
    for (let i = 1; i < tl.events.length; i++) assert.ok(tl.events[i]!.t >= tl.events[i - 1]!.t);
  });
  it("keeps intent → thought → observation order within a step", () => {
    const kinds = tl.events.filter((e) => e.stepIndex === 0).map((e) => e.kind);
    assert.ok(kinds.indexOf("intent") < kinds.indexOf("thought") && kinds.indexOf("thought") < kinds.indexOf("observation"));
  });
  it("round-trips through JSON losslessly (it is stored as JSON)", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(tl)), tl);
  });
  it("timelines carry the screenshots' blob refs, never local paths", () => {
    const refs = tl.events.flatMap((e) => (e.screenshotRef ? [e.screenshotRef] : []));
    assert.ok(refs.includes(SHOT("step-0-read.png")));
    assert.ok(refs.every((r) => r.startsWith("blob:")));
  });
  it("a cap-stopped walk is marked as such, not counted as a bounce", () => {
    const t2 = buildTimeline({ ...mkResult("cap-stopped", [mkStep(0)]), stopReason: "Run r stopped at its credit cap" });
    assert.equal(t2.criticalCount, 0);
    assert.ok(t2.events.some((e) => e.summary === "Stopped at the run's credit cap"));
  });
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

const verdictAnswer = (input: Record<string, unknown>): MockChatStep => ({ content: [{ type: "tool_use", id: "v", name: "submit_verdict", input }], model: "claude-haiku-4-5", usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const V = (verdict: string, objections: unknown[] = [], extra: Record<string, unknown> = {}) => verdictAnswer({ verdict, confidence: 0.8, rationale: "r", objections, whatWouldChangeMind: [], behaviorSummary: "b", ...extra });

const BOUNCE_STEPS = [
  mkStep(0, {
    thinkAloud: "The pricing is hidden and the checkout button does nothing. I'm done here.",
    observation: mkObs({ type: "read", textExcerpt: "Plans starting soon. Contact sales for details.", sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }),
  }),
  mkStep(1, { thinkAloud: "No real price anywhere. Leaving.", observation: mkObs({ type: "finished", finishSignal: "bounced" }) }),
];

async function storeWithInterview(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await store.addTranscript({ id: "t1", text: "Dana: The onboarding email promised white-glove setup but the wizard just dumps me at a blank dashboard. Pricing that is hidden behind a checkout button makes me leave right away.", createdAt: Date.now() });
  await store.addNode({ id: "t1:reflection:trust:0", transcriptId: "t1", kind: "reflection", lens: "trust-auditor", content: "Distrusts vendors whose setup promises never match the real onboarding experience.", importance: 0.8, chunkIndex: 0 });
  return store;
}

async function verdictFor(script: MockChatStep[], result: WalkthroughResult, opts: { store?: InMemoryMemoryStore; spec?: typeof SKEPTIC } = {}) {
  const provider = new MockLlmProvider({ chatScript: script });
  const ledger = new PanelLedger();
  ledger.beginRun(result.runId, 100);
  const model = new RouterPanelModel(provider, "claude-haiku-4-5", ledger);
  const store = opts.store ?? (await storeWithInterview());
  const args = { model, store, personaSpec: opts.spec ?? SKEPTIC, result, timeline: buildTimeline(result), runId: result.runId };
  return { args, provider, ledger, store };
}

describe("renderVerdict", () => {
  it("a bounce can never be a buy (clamped, and the rationale says so)", async () => {
    const { args } = await verdictFor([V("buy", [{ quote: "The pricing is hidden and the checkout button does nothing", section: "Pricing", severity: "high" }])], mkResult("bounced", BOUNCE_STEPS));
    const v = await renderVerdict(args);
    assert.equal(v.verdict, "no-buy");
    assert.equal(v.clamped, true);
    assert.match(v.rationale, /clamped/);
    assert.equal(v.objections.length, 1);
  });

  it("a 'maybe' on a bounce is left alone", async () => {
    const { args } = await verdictFor([V("maybe")], mkResult("bounced", BOUNCE_STEPS));
    assert.equal((await renderVerdict(args)).verdict, "maybe");
  });

  it("a genuine 'buy' on a checkout attempt is not clamped", async () => {
    const { args } = await verdictFor([V("buy")], mkResult("checkout-attempted", [mkStep(0, { thinkAloud: "The trial signup was smooth and the price felt fair." })]));
    const v = await renderVerdict(args);
    assert.equal(v.verdict, "buy");
    assert.equal(v.clamped, false);
  });

  it("drops invented quotes and counts them", async () => {
    const { args } = await verdictFor(
      [V("buy", [{ quote: "The trial signup was smooth and the price felt fair", section: "Signup", severity: "medium" }, { quote: "Their customer support is rude and refunds are impossible", section: "Support", severity: "high" }])],
      mkResult("checkout-attempted", [mkStep(0, { thinkAloud: "The trial signup was smooth and the price felt fair." })]),
    );
    const v = await renderVerdict(args);
    assert.deepEqual(v.objections.map((o) => o.quote), ["The trial signup was smooth and the price felt fair"]);
    assert.equal(v.droppedQuotes, 1);
  });

  it("an objection traced to the persona's own interview memory cites that transcript", async () => {
    const { args } = await verdictFor([V("no-buy", [{ quote: "Distrusts vendors whose setup promises never match the real onboarding", section: "", severity: "high" }])], mkResult("bounced", BOUNCE_STEPS));
    const v = await renderVerdict(args);
    assert.equal(v.objections[0]!.sourceTranscriptId, "t1");
    assert.equal(v.objections[0]!.section, "(memory)");
  });

  it("each objection carries the real interview words behind it (or null)", async () => {
    const { args } = await verdictFor([V("no-buy", [{ quote: "The pricing is hidden and the checkout button does nothing", section: "Pricing", severity: "high" }])], mkResult("bounced", BOUNCE_STEPS));
    const v = await renderVerdict(args);
    assert.deepEqual(v.objections[0]!.interview, { transcriptId: "t1", excerpt: "Pricing that is hidden behind a checkout button makes me leave right away.", overlap: 4 });
  });

  it("a quote from ANOTHER persona's interview is not evidence (dropped)", async () => {
    const store = await storeWithInterview();
    await store.addTranscript({ id: "t-other", text: "Zebra striped invoices were invented by aliens every Tuesday afternoon.", createdAt: Date.now() });
    const { args } = await verdictFor([V("no-buy", [{ quote: "Zebra striped invoices invented aliens Tuesday", section: "", severity: "high" }])], mkResult("bounced", BOUNCE_STEPS), { store });
    const v = await renderVerdict(args);
    assert.deepEqual(v.objections, []);
    assert.equal(v.droppedQuotes, 1);
  });

  it("stores the verdict in the persona's memory and charges the run", async () => {
    const { args, store, ledger } = await verdictFor([V("maybe")], mkResult("step-capped", [mkStep(0)], "run-v4"));
    await renderVerdict(args);
    const nodes = await store.retrieve("verdict", { k: 10, kinds: ["verdict"], runId: "run-v4", personaKey: "p-dana" });
    assert.equal(JSON.parse(nodes[0]!.node.content).verdict, "maybe");
    assert.equal(ledger.spend("run-v4").callCount, 1);
  });
});

describe("no calibration → no verdict (enforced)", () => {
  it("a persona without an interview gets NoCalibrationError, and no model call is made", async () => {
    const { args, provider } = await verdictFor([V("buy")], mkResult("checkout-attempted", [mkStep(0)]), { spec: validSpec({ sourceTranscriptIds: [] }) });
    await assert.rejects(renderVerdict(args), NoCalibrationError);
    assert.equal(provider.chatCalls.length, 0);
  });

  it("citing a transcript that isn't in the memory stream is not calibration", async () => {
    const { args } = await verdictFor([V("buy")], mkResult("checkout-attempted", [mkStep(0)]), { spec: validSpec({ sourceTranscriptIds: ["t-missing"] }) });
    const out = await verdictOrWithheld(args);
    assert.equal(out.kind, "withheld");
    assert.equal(out.kind === "withheld" && out.reason, "no_calibration");
  });

  it("an incomplete walk (cap-stopped) is withheld without asking the model", async () => {
    const { args, provider } = await verdictFor([V("buy")], { ...mkResult("cap-stopped", [mkStep(0)]), stopReason: "cap" });
    const out = await verdictOrWithheld(args);
    assert.deepEqual(out.kind === "withheld" ? [out.reason, out.detail] : null, ["incomplete_walk", "cap"]);
    assert.equal(provider.chatCalls.length, 0);
  });
});

describe("quote tracing", () => {
  const ev: EvidenceItem[] = [{ text: "The dashboard loads quickly and the reports export to CSV", section: "Dashboard" }];
  it("3 overlapping content words = no trace, 4 = trace", () => {
    assert.equal(traceQuote("dashboard loads quickly", ev), undefined);
    assert.equal(traceQuote("dashboard loads quickly reports", ev), ev[0]);
  });
  it("keeps traceable quotes, drops invented ones", () => {
    const dropped: string[] = [];
    const kept = filterTraceableQuotes([{ quote: "dashboard loads quickly reports", section: "", severity: "low" }, { quote: "support is rude and refunds impossible", section: "", severity: "high" }], ev, (q) => dropped.push(q));
    assert.deepEqual(kept.map((k) => k.section), ["Dashboard"]);
    assert.deepEqual(dropped, ["support is rude and refunds impossible"]);
  });
  it("finds the interview sentence behind a quote, or nothing", () => {
    const chunks = [{ transcriptId: "t9", content: "We pay $49 a month. The annual billing surprise made me cancel the last tool." }];
    assert.equal(traceToInterviews("annual billing surprise made me cancel", chunks)?.excerpt, "The annual billing surprise made me cancel the last tool.");
    assert.equal(traceToInterviews("the mobile app crashes", chunks), null);
  });
});

// ---------------------------------------------------------------------------
// Panel report
// ---------------------------------------------------------------------------

function verdict(personaKey: string, personaName: string, v: PersonaVerdict["verdict"], objections: PersonaVerdict["objections"] = []): { kind: "verdict"; verdict: PersonaVerdict } {
  return { kind: "verdict", verdict: { personaKey, personaName, verdict: v, confidence: 0.5, rationale: "r", objections, whatWouldChangeMind: [], behaviorSummary: "b", droppedQuotes: 0, clamped: false } };
}
const ob = (quote: string, section: string, severity: "low" | "medium" | "high", interview: PersonaVerdict["objections"][number]["interview"] = null, sourceTranscriptId?: string) => ({ quote, section, severity, interview, ...(sourceTranscriptId ? { sourceTranscriptId } : {}) });

const V1 = verdict("p1", "Dana Skeptic", "no-buy", [ob("The pricing is hidden, I can't find the real cost anywhere", "Pricing", "high", { transcriptId: "t1", excerpt: "Hidden pricing makes me leave.", overlap: 3 })]);
const V2 = verdict("p2", "Ben Buyer", "buy", [ob("I can't find the pricing anywhere, the real cost is hidden", "Pricing", "medium", null, "t2")]);
const V3 = verdict("p3", "Cara Maybe", "maybe", [ob("The free trial is too short for evaluation", "Signup", "low")]);

function timelineP1() {
  return buildTimeline(
    mkResult("bounced", [
      mkStep(0, { observation: mkObs({ type: "not-found", detail: "couldn't find the pricing table", sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }), signals: mkSignals({ dwellMs: 5000 }) }),
      mkStep(1, { observation: mkObs({ type: "finished", finishSignal: "bounced", sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }) }),
    ], "run-p1"),
  );
}
function timelineP2() {
  return buildTimeline(
    mkResult("checkout-attempted", [
      mkStep(0, { observation: mkObs({ type: "read", sectionMeta: { heading: "Pricing", url: "https://example.com/#pricing" } }), signals: mkSignals({ dwellMs: 3000, clicks: 4, rageClickBursts: 1 }) }),
      mkStep(1, { observation: mkObs({ type: "scrolled", sectionMeta: { heading: "Signup", url: "https://example.com/#signup" } }), signals: mkSignals({ dwellMs: 2000 }) }),
    ], "run-p2"),
  );
}

describe("distribution", () => {
  it("names the personas in each bucket (never just a percentage) and lists the withheld", async () => {
    const report = await aggregateReport({ outcomes: [V1, V2, V3, { kind: "withheld", personaKey: "p4", personaName: "Ed Manual", reason: "no_calibration", detail: "no interview" }], timelines: [] });
    assert.deepEqual(report.distribution, { buy: ["Ben Buyer"], "no-buy": ["Dana Skeptic"], maybe: ["Cara Maybe"] });
    assert.deepEqual(report.withheld.map((w) => [w.personaName, w.reason]), [["Ed Manual", "no_calibration"]]);
    assert.equal(report.personaCount, 4);
  });
});

describe("objection clustering", () => {
  it("groups near-duplicate objections across personas and keeps the interview words", () => {
    const clusters = clusterObjections([
      { ...V1.verdict.objections[0]!, personaKey: "p1", personaName: "Dana Skeptic" },
      { ...V2.verdict.objections[0]!, personaKey: "p2", personaName: "Ben Buyer" },
      { ...V3.verdict.objections[0]!, personaKey: "p3", personaName: "Cara Maybe" },
    ]);
    assert.equal(clusters.length, 2);
    assert.deepEqual([clusters[0]!.count, clusters[0]!.personaNames, clusters[0]!.sections, clusters[0]!.sourceTranscriptIds], [2, ["Ben Buyer", "Dana Skeptic"], ["Pricing"], ["t1", "t2"]]);
    assert.deepEqual(clusters[0]!.interviewQuotes.map((q) => q.excerpt), ["Hidden pricing makes me leave."]);
    assert.equal(clusters[1]!.count, 1);
  });
  it("ranks by frequency × severity weight", () => {
    const c = clusterObjections([
      { quote: "The dashboard loads so slowly I gave up", section: "App", severity: "low", personaKey: "a", personaName: "A" },
      { quote: "Nobody explains how the free trial converts to paid", section: "Signup", severity: "high", personaKey: "b", personaName: "B" },
    ]);
    assert.match(c[0]!.representativeQuote, /free trial/);
  });
  it("handles empty input", () => {
    assert.deepEqual(clusterObjections([]), []);
  });
});

describe("section heat", () => {
  it("rolls up dwell, friction and bounces per section, most friction first", () => {
    const heat = sectionHeat([timelineP1(), timelineP2()]);
    // Pricing: not-found + critical drop-off (p1) + rage click (p2) = 3; avg dwell ((5000 + 1000) + 3000) / 2.
    assert.deepEqual([heat[0]!.name, heat[0]!.totalFriction, heat[0]!.bounceCount, heat[0]!.avgDwellMs, heat[0]!.personas], ["Pricing", 3, 1, 4500, 2]);
    const signup = heat.find((r) => r.name === "Signup")!;
    assert.deepEqual([signup.totalFriction, signup.bounceCount], [0, 0]);
  });
  it("handles no timelines", () => {
    assert.deepEqual(sectionHeat([]), []);
  });
});

describe("fix suggestions", () => {
  const fix = (s: string): MockChatStep => ({ content: [{ type: "tool_use", id: "f", name: "submit_fix", input: { suggestedFix: s, expectedImpact: "high" } }], model: "claude-haiku-4-5", usage: { inputTokens: 1000, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const six = ["The pricing page hides the real cost behind vague tiers", "Checkout takes too many steps and times out", "Nobody explains how the free trial converts to paid", "The onboarding wizard asks for my credit card upfront", "Support chat never answers during business hours", "The dashboard loads so slowly I gave up waiting"].map((q, i) => verdict(`p${i}`, `Persona ${i}`, "no-buy", [ob(q, "Pricing", "medium")]));

  function fixModel(cap: number) {
    const provider = new MockLlmProvider({ chatScript: [fix("Put the real price above the fold.")] });
    const ledger = new PanelLedger();
    ledger.beginRun("panel", cap);
    return { provider, ledger, model: new RouterPanelModel(provider, "claude-haiku-4-5", ledger) };
  }

  it("one call per cluster, at most 5, addressing the top clusters", async () => {
    const { model, ledger } = fixModel(1000);
    const report = await aggregateReport({ outcomes: six, timelines: [timelineP1()], model, runId: "panel" });
    assert.equal(report.rankedObjections.length, 6);
    assert.equal(report.fixes.length, 5);
    assert.equal(FIX_CLUSTER_CAP, 5);
    assert.equal(ledger.spend("panel").callCount, 5);
    assert.equal(report.fixes[0]!.objection, report.rankedObjections[0]!.representativeQuote);
  });

  it("stops at the credit cap and says how many fixes were skipped", async () => {
    // Each fix reserves ~1 credit worst case; a 2-credit cap allows two.
    const { model } = fixModel(2);
    const report = await aggregateReport({ outcomes: six, timelines: [], model, runId: "panel" });
    assert.equal(report.fixes.length, 2);
    assert.equal(report.fixesSkippedAtCap, 3);
  });

  it("no model, no fixes", async () => {
    assert.deepEqual((await aggregateReport({ outcomes: [V1], timelines: [] })).fixes, []);
  });
});

describe("disclaimer", () => {
  it("every report carries the synthetic disclaimer", async () => {
    const r = await aggregateReport({ outcomes: [V1, V2, V3], timelines: [timelineP1(), timelineP2()] });
    assert.equal(r.syntheticDisclaimer, SYNTHETIC_DISCLAIMER);
    assert.match(r.syntheticDisclaimer, /Not human data/);
  });
});

describe("diffReports (two runs of the same page)", () => {
  it("shows who moved between buckets and how often each objection came up", async () => {
    const before: PanelReport = await aggregateReport({ outcomes: [V1, V2, V3], timelines: [timelineP1()] });
    const after: PanelReport = await aggregateReport({
      outcomes: [verdict("p1", "Dana Skeptic", "maybe"), V2, verdict("p3", "Cara Maybe", "buy", [ob("Annual billing only is a surprise", "Pricing", "medium")])],
      timelines: [timelineP2()],
    });
    const d = diffReports(before, after);
    assert.deepEqual(d.distribution.find((x) => x.bucket === "buy"), { bucket: "buy", before: 1, after: 2, joined: ["Cara Maybe"], left: [] });
    const hidden = d.objections.find((o) => /pricing is hidden/.test(o.quote))!;
    assert.deepEqual([hidden.before, hidden.after, hidden.change], [{ count: 2, of: 3 }, { count: 1, of: 3 }, "fewer"]);
    assert.equal(d.objections.find((o) => /free trial/.test(o.quote))?.change, "gone");
    assert.equal(d.objections.find((o) => /Annual billing/.test(o.quote))?.change, "new");
    assert.equal(d.syntheticDisclaimer, SYNTHETIC_DISCLAIMER);
  });
});
