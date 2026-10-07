// Phase 19B (WS=panel) — a page walk run end to end against real Postgres
// (app role), a REAL headless Chromium (the existing recorder) and a local
// fixture page (the prototype's "TaskTide" landing page, stored as a landing
// page and served to the browser from the database), with the labelled FAKE
// model (deterministic, nothing spent) and the FAKE 384-d embedder:
//   - estimate → confirm → queued job → the worker runs it: personas walk in
//     parallel (2 browsers), steps + screenshots (blob storage) + traces,
//     verdicts read off the walks, the report (distribution, traced quotes,
//     section heat, fixes) — a hand-made persona gets no verdict;
//   - a tight cap stops the run cleanly: an honest partial result, spent ≤ cap;
//   - the track record: entering real conversions creates the calibration and
//     the workspace's calibration score follows every change;
//   - the diff between the two runs; another workspace can't read either.
// Needs Chromium (CI: `npx playwright install chromium` in the DB job).
// Run: DATABASE_URL=<app role> npx tsx --test lib/panel/__tests__/run-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { blobGet, parseBlobRef, resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { defaultAgentJobHandlers } from "@/lib/agents/queue/handlers";
import { lexicalTestEmbedder } from "../memory";
import { testPanelDeps } from "../deps.server";
import { runPanelRun } from "../runner.server";
import {
  addInterview,
  addManualPersona,
  calibrationSummary,
  derivePersonas,
  diffRuns,
  estimatePageWalk,
  getRun,
  recordLaunch,
  startPageWalk,
  type PanelActor,
} from "../service.server";
import { INTERVIEW_TEXT, validSpec } from "./fixtures";

const RUN = randomUUID().slice(0, 8);
const WS = `p19brun-${RUN}`;
const WS2 = `p19brun2-${RUN}`;
const ED = `p19brun-ed-${RUN}`;
const ed: PanelActor = { workspaceId: WS, userId: ED, role: "editor" };
const BLOB_DIR = mkdtempSync(join(tmpdir(), "p19b-run-blobs-"));
const deps = testPanelDeps({ embed: lexicalTestEmbedder });
const FIXTURE = readFileSync(join(__dirname, "fixtures", "landing.html"), "utf8");

let draftId = "";
let personaIds: string[] = [];
let fullRunId = "";
let cappedRunId = "";

before(async () => {
  process.env.MARKETR_BLOB_DIR = BLOB_DIR;
  process.env.MARKETR_MAX_BROWSER_RECORDINGS = "2";
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Run ${RUN}`, ownerUserId: ED, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS2, name: `Other ${RUN}`, ownerUserId: `x-${RUN}`, plan: "pro" } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` } });
  const draft = await withWorkspaceScope(WS, (tx) => tx.pageDraft.create({ data: { workspaceId: WS, name: "TaskTide launch", kind: "landing", html: FIXTURE, createdBy: ED } }));
  draftId = draft.id;
  const priya = await addInterview(ed, { title: "Priya call", text: INTERVIEW_TEXT, interviewee: "Priya Nair" }, deps);
  const sam = await addInterview(
    ed,
    { title: "Sam call", interviewee: "Sam Ortiz", text: "Interviewer: What matters to you?\nSam Ortiz: I'm the founder of a two-person studio and I pay with my own money. I can never go above $30 a month. Annual billing is a non-starter for me because cash flow is tight." },
    deps,
  );
  const derived = await derivePersonas(ed, { transcriptIds: [priya.id, sam.id], capCredits: 1000 }, deps);
  const manual = await addManualPersona(ed, validSpec({ identity: { name: "Manual Mo", role: "Buyer" }, sourceTranscriptIds: [] }));
  personaIds = [...derived.personas.map((p) => p.id), manual.id];
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.$disconnect();
  rmSync(BLOB_DIR, { recursive: true, force: true });
});

describe("a page walk run", () => {
  it("the estimate comes first, from the cap maths", async () => {
    const e = await estimatePageWalk(ed, { personaIds, stepCap: 6 }, deps);
    assert.equal(e.personas, 3);
    assert.equal(e.stepCap, 6);
    assert.ok(e.total > 0);
    assert.match(e.formula, /^3 personas × \(6 steps/);
  });

  it("nothing starts without the person's confirmation and a cap", async () => {
    const target = { kind: "landing_page" as const, pageDraftId: draftId };
    await assert.rejects(startPageWalk(ed, { target, personaIds, stepCap: 6, capCredits: 500, confirmed: false }, deps), /Confirm the credit cap/);
    await assert.rejects(startPageWalk(ed, { target, personaIds, stepCap: 6, capCredits: 0, confirmed: true }, deps), /at least 1 credit/);
    await assert.rejects(startPageWalk(ed, { target: { kind: "landing_page", pageDraftId: "nope" }, personaIds, stepCap: 6, capCredits: 500, confirmed: true }, deps), /Landing page not found/);
  });

  it("queues, then the worker walks every persona and writes the report", async () => {
    const run = await startPageWalk(ed, { target: { kind: "landing_page", pageDraftId: draftId }, personaIds, stepCap: 6, capCredits: 500, confirmed: true }, deps);
    fullRunId = run.id;
    assert.deepEqual([run.status, run.capCredits, run.modelKind], ["queued", 500, "fake"]);
    assert.ok(run.estimateCredits > 0);

    const out = await runPanelRun(WS, run.id, deps);
    assert.equal(out.status, "completed");
    const detail = await getRun(ed, run.id);
    const report = detail.run.report!;
    assert.match(report.syntheticDisclaimer, /Synthetic panel output/);
    // Priya ($100 budget) can afford $49 and tries the signup; Sam ($30 hard cap) bounces.
    assert.deepEqual(report.distribution, { buy: ["Priya Nair"], "no-buy": ["Sam Ortiz"], maybe: [] });
    assert.deepEqual(report.withheld.map((w) => [w.personaName, w.reason]), [["Manual Mo", "no_calibration"]]);
    assert.ok(report.rankedObjections.some((c) => c.interviewQuotes.length > 0), "objections traced to the interviews");
    assert.ok(report.sectionHeat.some((h) => h.name === "Pricing"));
    assert.ok(report.fixes.length >= 1);
    assert.ok(detail.run.spentCredits > 0 && detail.run.spentCredits <= 500);
    assert.equal(detail.run.status, "completed");
  });

  it("each persona's steps are stored with screenshots in blob storage and a trace", async () => {
    const detail = await getRun(ed, fullRunId);
    const sam = detail.verdicts.find((v) => v.personaName === "Sam Ortiz")!;
    assert.equal(sam.outcome, "bounced");
    const samSteps = detail.steps.filter((s) => s.personaKey === sam.personaKey);
    assert.deepEqual(samSteps.map((s) => s.observation.type), ["read", "finished"]);
    const ref = samSteps[0]!.screenshotRef!;
    const loc = parseBlobRef(ref);
    assert.equal(loc?.namespace, "rehearsal");
    const png = await blobGet("rehearsal", loc!.path);
    assert.equal(png?.subarray(1, 4).toString("latin1"), "PNG");
    assert.ok(sam.traceRef?.startsWith("blob:rehearsal/"));
    // The real page's text reached the persona — never invented.
    assert.match(samSteps[0]!.observation.textExcerpt, /Billed annually/);
  });

  it("a tight cap stops the run cleanly with an honest partial result", async () => {
    const run = await startPageWalk(ed, { target: { kind: "landing_page", pageDraftId: draftId }, personaIds, stepCap: 6, capCredits: 4, confirmed: true }, deps);
    cappedRunId = run.id;
    const out = await runPanelRun(WS, run.id, deps);
    assert.equal(out.status, "partial");
    const detail = await getRun(ed, run.id);
    assert.ok(detail.run.spentCredits <= 4, `spent ${detail.run.spentCredits} of 4`);
    assert.match(detail.run.stopReason ?? "", /credit cap/);
    assert.ok(detail.run.report!.withheld.some((w) => w.reason === "incomplete_walk"));
  });

  it("the track record: real conversions create the calibration and the score follows every change", async () => {
    // Run 1 predicted buy + no-buy = 1 of 2 = 0.5. 30 of 1,000 visitors converted = 0.03 → |0.5 − 0.03| = 0.47.
    const first = await recordLaunch(ed, fullRunId, { conversions: 30, visitors: 1000 });
    assert.equal(first.calibration.predictedRate, 0.5);
    assert.ok(Math.abs(first.summary.score! - 0.47) < 1e-9);
    assert.equal(first.summary.launches, 1);
    // Re-entered: 100 of 1,000 = 0.1 → 0.4.
    const second = await recordLaunch(ed, fullRunId, { conversions: 100, visitors: 1000 });
    assert.ok(Math.abs(second.summary.score! - 0.4) < 1e-9);
    assert.ok(Math.abs((await calibrationSummary(ed)).score! - 0.4) < 1e-9);
    await assert.rejects(recordLaunch(ed, fullRunId, { conversions: 5, visitors: 2 }), /between 0 and visitors/);
  });

  it("diffs two runs of the same page", async () => {
    const d = await diffRuns(ed, fullRunId, cappedRunId);
    const buy = d.distribution.find((x) => x.bucket === "buy")!;
    assert.deepEqual([buy.before, buy.left], [1, ["Priya Nair"]]);
  });

  it("another workspace can't read the run", async () => {
    await assert.rejects(getRun({ workspaceId: WS2, userId: `x-${RUN}`, role: "owner" }, fullRunId), /Run not found/);
  });

  it("the worker's panel_run handler refuses another workspace's payload, and a second claim never spends again", async () => {
    const handler = defaultAgentJobHandlers.panel_run!;
    await assert.rejects(handler({ id: "j", workspaceId: WS2, kind: "panel_run", payload: { workspaceId: WS, panelRunId: fullRunId }, attempts: 1, maxAttempts: 2, runId: null }, { signal: new AbortController().signal, workerId: "w" }), /another workspace/);
    await withWorkspaceScope(WS, (tx) => tx.panelRun.update({ where: { id: cappedRunId }, data: { status: "running" } }));
    const out = await runPanelRun(WS, cappedRunId, deps);
    assert.equal(out.status, "partial");
    assert.match((await getRun(ed, cappedRunId)).run.stopReason ?? "", /interrupted/);
  });
});
