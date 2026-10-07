// ShapesOS — Phase 19B (WS=panel): the Dress Rehearsal service.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// One entry point for the routes, the page and the agent tools, so every path
// goes through the same gates: the dress_rehearsal entitlement (Pro and
// above; a 403 with the upgrade message otherwise), the workspace role
// (viewer reads, editor changes), FORCE RLS on every row, and — for anything
// that calls a model — an estimate first and a hard credit cap the person
// confirmed.

import { randomUUID } from "node:crypto";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { requireEntitlement } from "@/lib/billing/entitlements-server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { isCapReached, PanelLedger } from "./budget";
import type { PanelDeps } from "./deps.server";
import { derivePersonaSpec } from "./derive";
import { clampStepCap, DEFAULT_STEP_CAP, estimateDerivation, estimateRun, MAX_PERSONAS_PER_RUN, type DeriveEstimate, type RunEstimate } from "./estimate";
import { diffReports, distributionVerdicts, type PanelReport, type ReportDiff } from "./aggregate";
import type { Intent } from "./intents";
import type { Observation } from "./pagemaster";
import { PanelTargetSchema, targetLabel, type PanelTarget } from "./targets";
import type { FrictionTimeline } from "./timeline";
import { calibrationScore, compareRunWithLaunch } from "./validator";
import type { VerdictObjection } from "./verdicts";
import type { StepFlag, StepSignals } from "./walk";
import { importTranscriptFile, TranscriptImportError, TRANSCRIPT_MAX_CHARS } from "./import";
import { applyFounderEdits, isCalibratedSpec, parsePersonaSpec, PersonaValidationError, type PersonaEdits, type PersonaSpec } from "./persona";
import { runReflections } from "./reflections";
import { PgMemoryStore } from "./store.server";

export interface PanelActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/** Entitlement first (403 + upgrade message), then the role. */
export async function gate(actor: PanelActor, min: WorkspaceRole): Promise<void> {
  await requireEntitlement(actor.workspaceId, "dress_rehearsal");
  if (!roleAtLeast(actor.role, min)) throw new HttpError(403, min === "editor" ? "Only editors can change Dress Rehearsal." : "You can't open Dress Rehearsal in this workspace.");
}

const scoped = <T>(actor: PanelActor, fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(actor.workspaceId, fn);

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export interface InterviewView {
  id: string;
  title: string;
  interviewee: string | null;
  source: string;
  sourceRef: string | null;
  charCount: number;
  createdAt: string;
}

function interviewView(r: { id: string; title: string; interviewee: string | null; source: string; sourceRef: string | null; charCount: number; createdAt: Date }): InterviewView {
  return { id: r.id, title: r.title, interviewee: r.interviewee, source: r.source, sourceRef: r.sourceRef, charCount: r.charCount, createdAt: r.createdAt.toISOString() };
}

export async function listInterviews(actor: PanelActor): Promise<InterviewView[]> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.panelTranscript.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 200 }));
  return rows.map(interviewView);
}

export interface AddInterviewInput {
  title: string;
  text: string;
  interviewee?: string | null;
  source?: "upload" | "paste" | "meet" | "note";
  sourceRef?: string | null;
}

/** Store an interview verbatim and chunk it into the memory stream. */
export async function addInterview(actor: PanelActor, input: AddInterviewInput, deps: Pick<PanelDeps, "embed">): Promise<InterviewView> {
  await gate(actor, "editor");
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new HttpError(400, "That interview is empty.");
  if (text.length > TRANSCRIPT_MAX_CHARS) throw new HttpError(400, `That interview is too long (${text.length} characters; the limit is ${TRANSCRIPT_MAX_CHARS}). Split it into parts.`);
  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const store = new PgMemoryStore(actor.workspaceId, { embed: deps.embed, createdBy: actor.userId });
  await store.addTranscript(
    { id, text, title: input.title.trim().slice(0, 200) || "Interview", ...(input.interviewee ? { interviewee: input.interviewee.trim().slice(0, 120) } : {}), createdAt: Date.now() },
    {},
    { source: input.source ?? "paste", sourceRef: input.sourceRef ?? null },
  );
  const row = await scoped(actor, (tx) => tx.panelTranscript.findFirstOrThrow({ where: { id, workspaceId: actor.workspaceId } }));
  return interviewView(row);
}

export async function importInterviewFile(actor: PanelActor, input: { filename: string; bytes: Buffer; interviewee?: string | null }, deps: Pick<PanelDeps, "embed">): Promise<InterviewView> {
  await gate(actor, "editor");
  let text: string;
  try {
    text = (await importTranscriptFile(input.filename, input.bytes)).text;
  } catch (err) {
    if (err instanceof TranscriptImportError) throw new HttpError(400, err.message);
    throw err;
  }
  return addInterview(actor, { title: input.filename.slice(0, 200), text, interviewee: input.interviewee ?? null, source: "upload", sourceRef: input.filename.slice(0, 200) }, deps);
}

/** Reuse a Meet (18.2) transcript the person can see. */
export async function importInterviewFromMeeting(actor: PanelActor, meetingId: string, deps: Pick<PanelDeps, "embed">): Promise<InterviewView> {
  await gate(actor, "editor");
  const { getMeeting } = await import("@/lib/comms/meet/meet.server");
  const m = await getMeeting({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role, name: null, email: null }, meetingId);
  if (!m.transcript?.trim()) throw new HttpError(400, "That meeting has no transcript yet. Add or transcribe one in Meet first.");
  return addInterview(actor, { title: m.title, text: m.transcript, source: "meet", sourceRef: meetingId }, deps);
}

/** Reuse a Note the person can read (a private note stays its owner's). */
export async function importInterviewFromNote(actor: PanelActor, noteId: string, deps: Pick<PanelDeps, "embed">): Promise<InterviewView> {
  await gate(actor, "editor");
  const { readNoteText } = await import("@/lib/notes/service");
  const note = await readNoteText(actor, noteId, TRANSCRIPT_MAX_CHARS);
  if (!note) throw new HttpError(404, "Note not found.");
  return addInterview(actor, { title: note.title, text: note.text, source: "note", sourceRef: noteId }, deps);
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export interface PersonaView {
  id: string;
  name: string;
  status: "active" | "vetoed";
  calibrated: boolean;
  origin: "interviews" | "manual";
  spec: PersonaSpec;
  sourceTranscriptIds: string[];
  droppedObjections: string[];
  editedAt: string | null;
  createdAt: string;
}

type PersonaRow = { id: string; name: string; status: string; calibrated: boolean; origin: string; spec: unknown; sourceTranscriptIds: string[]; droppedObjections: unknown; editedAt: Date | null; createdAt: Date };

function personaView(r: PersonaRow): PersonaView {
  return {
    id: r.id,
    name: r.name,
    status: r.status === "vetoed" ? "vetoed" : "active",
    calibrated: r.calibrated,
    origin: r.origin === "manual" ? "manual" : "interviews",
    spec: r.spec as PersonaSpec,
    sourceTranscriptIds: r.sourceTranscriptIds,
    droppedObjections: Array.isArray(r.droppedObjections) ? (r.droppedObjections as string[]) : [],
    editedAt: r.editedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listPersonas(actor: PanelActor): Promise<PersonaView[]> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.panelPersona.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" }, take: 200 }));
  return rows.map(personaView);
}

async function interviewChars(actor: PanelActor, transcriptIds: string[]): Promise<Array<{ id: string; charCount: number }>> {
  const ids = [...new Set(transcriptIds)].slice(0, 20);
  const rows = await scoped(actor, (tx) => tx.panelTranscript.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids } }, select: { id: true, charCount: true } }));
  if (rows.length !== ids.length) throw new HttpError(404, "One of those interviews wasn't found.");
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

export async function estimatePersonaDerivation(actor: PanelActor, transcriptIds: string[], deps: Pick<PanelDeps, "pricingModel">): Promise<DeriveEstimate> {
  await gate(actor, "editor");
  if (transcriptIds.length === 0) throw new HttpError(400, "Pick at least one interview.");
  const rows = await interviewChars(actor, transcriptIds);
  const { model } = await deps.pricingModel(actor.workspaceId);
  return estimateDerivation(model, rows.map((r) => r.charCount));
}

export interface DeriveResult {
  personas: PersonaView[];
  spentCredits: number;
  capCredits: number;
  stoppedAtCap: boolean;
  /** Objections the model proposed that the interviews didn't support (dropped). */
  droppedObjections: string[];
}

/**
 * Reflect on each interview and derive one persona from it, under the
 * confirmed credit cap. A cap stop keeps the personas derived so far.
 */
export async function derivePersonas(actor: PanelActor, input: { transcriptIds: string[]; capCredits: number }, deps: Pick<PanelDeps, "modelFor" | "embed">): Promise<DeriveResult> {
  await gate(actor, "editor");
  if (input.transcriptIds.length === 0) throw new HttpError(400, "Pick at least one interview.");
  const cap = Math.floor(Number(input.capCredits));
  if (!Number.isFinite(cap) || cap < 0) throw new HttpError(400, "Set a credit cap (0 or more).");
  await interviewChars(actor, input.transcriptIds);
  const ledgerRun = `derive-${randomUUID()}`;
  const ledger = new PanelLedger();
  ledger.beginRun(ledgerRun, cap);
  const model = await deps.modelFor(actor.workspaceId, ledger, actor.userId);
  const store = new PgMemoryStore(actor.workspaceId, { embed: deps.embed, createdBy: actor.userId });
  const personas: PersonaView[] = [];
  const dropped: string[] = [];
  let stoppedAtCap = false;
  for (const transcriptId of [...new Set(input.transcriptIds)]) {
    try {
      await runReflections({ model, store, transcriptId, runId: ledgerRun });
      const { spec, droppedObjections } = await derivePersonaSpec({ model, store, transcriptId, runId: ledgerRun });
      dropped.push(...droppedObjections);
      const row = await scoped(actor, (tx) =>
        tx.panelPersona.create({
          data: { workspaceId: actor.workspaceId, name: spec.identity.name.slice(0, 120), spec, sourceTranscriptIds: spec.sourceTranscriptIds, calibrated: isCalibratedSpec(spec), origin: "interviews", droppedObjections, createdBy: actor.userId },
        }),
      );
      personas.push(personaView(row));
    } catch (err) {
      if (isCapReached(err)) {
        stoppedAtCap = true;
        break;
      }
      throw err;
    }
  }
  return { personas, spentCredits: ledger.spend(ledgerRun).spentCredits, capCredits: cap, stoppedAtCap, droppedObjections: dropped };
}

/** A persona written by hand: valid, uncalibrated unless it cites interviews of this workspace. */
export async function addManualPersona(actor: PanelActor, rawSpec: unknown): Promise<PersonaView> {
  await gate(actor, "editor");
  let spec: PersonaSpec;
  try {
    spec = parsePersonaSpec(rawSpec);
  } catch (err) {
    if (err instanceof PersonaValidationError) throw new HttpError(400, err.message);
    throw err;
  }
  if (spec.sourceTranscriptIds.length > 0) await interviewChars(actor, spec.sourceTranscriptIds);
  const row = await scoped(actor, (tx) =>
    tx.panelPersona.create({ data: { workspaceId: actor.workspaceId, name: spec.identity.name.slice(0, 120), spec, sourceTranscriptIds: spec.sourceTranscriptIds, calibrated: isCalibratedSpec(spec), origin: "manual", createdBy: actor.userId } }),
  );
  return personaView(row);
}

async function personaRow(actor: PanelActor, id: string) {
  const row = await scoped(actor, (tx) => tx.panelPersona.findFirst({ where: { id, workspaceId: actor.workspaceId } }));
  if (!row) throw new HttpError(404, "Persona not found.");
  return row;
}

/** The founder's edit handle; a bad edit is a 400 naming the field. */
export async function editPersona(actor: PanelActor, id: string, edits: PersonaEdits): Promise<PersonaView> {
  await gate(actor, "editor");
  const row = await personaRow(actor, id);
  let spec: PersonaSpec;
  try {
    spec = applyFounderEdits(row.spec as PersonaSpec, edits);
  } catch (err) {
    if (err instanceof PersonaValidationError) throw new HttpError(400, err.message);
    throw err;
  }
  if (edits.sourceTranscriptIds && spec.sourceTranscriptIds.length > 0) await interviewChars(actor, spec.sourceTranscriptIds);
  const updated = await scoped(actor, (tx) =>
    tx.panelPersona.update({ where: { id: row.id }, data: { spec, name: spec.identity.name.slice(0, 120), sourceTranscriptIds: spec.sourceTranscriptIds, calibrated: isCalibratedSpec(spec), editedBy: actor.userId, editedAt: new Date() } }),
  );
  return personaView(updated);
}

/** Veto (a vetoed persona never walks) or bring a persona back. */
export async function setPersonaStatus(actor: PanelActor, id: string, status: "active" | "vetoed"): Promise<PersonaView> {
  await gate(actor, "editor");
  const row = await personaRow(actor, id);
  const updated = await scoped(actor, (tx) => tx.panelPersona.update({ where: { id: row.id }, data: { status, editedBy: actor.userId, editedAt: new Date() } }));
  return personaView(updated);
}

// ---------------------------------------------------------------------------
// Runs (page walk)
// ---------------------------------------------------------------------------

export interface RunReport extends PanelReport {
  /** "live" or "fake" — a fake-model run says so on every screen. */
  modelKind: "live" | "fake";
  model: string;
  spend: { estimateCredits: number; capCredits: number; spentCredits: number; calls: number; byPurpose: Record<string, { calls: number; credits: number }>; cacheHits: number };
}

export interface PersonaSnapshot {
  key: string;
  name: string;
  spec: PersonaSpec;
  calibrated: boolean;
}

export interface RunView {
  id: string;
  mode: string;
  status: string;
  target: PanelTarget;
  targetLabel: string;
  personas: Array<{ key: string; name: string; calibrated: boolean }>;
  stepCap: number;
  model: string;
  modelKind: "live" | "fake";
  estimateCredits: number;
  capCredits: number;
  spentCredits: number;
  callCount: number;
  stopReason: string | null;
  report: RunReport | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type RunRow = {
  id: string;
  mode: string;
  status: string;
  target: unknown;
  targetLabel: string;
  personaSnapshot: unknown;
  stepCap: number;
  model: string;
  modelKind: string;
  estimateCredits: number;
  capCredits: number;
  spentCredits: number;
  callCount: number;
  stopReason: string | null;
  report: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export function runView(r: RunRow): RunView {
  const snap = (Array.isArray(r.personaSnapshot) ? r.personaSnapshot : []) as PersonaSnapshot[];
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    target: r.target as PanelTarget,
    targetLabel: r.targetLabel,
    personas: snap.map((p) => ({ key: p.key, name: p.name, calibrated: p.calibrated })),
    stepCap: r.stepCap,
    model: r.model,
    modelKind: r.modelKind === "fake" ? "fake" : "live",
    estimateCredits: r.estimateCredits,
    capCredits: r.capCredits,
    spentCredits: r.spentCredits,
    callCount: r.callCount,
    stopReason: r.stopReason,
    report: (r.report as RunReport | null) ?? null,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** The active personas a run would use, in the order asked. */
async function runPersonas(actor: PanelActor, personaIds: string[]): Promise<PersonaSnapshot[]> {
  const ids = [...new Set(personaIds)];
  if (ids.length === 0) throw new HttpError(400, "Pick at least one persona.");
  if (ids.length > MAX_PERSONAS_PER_RUN) throw new HttpError(400, `A run takes at most ${MAX_PERSONAS_PER_RUN} personas.`);
  const rows = await scoped(actor, (tx) => tx.panelPersona.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids } } }));
  if (rows.length !== ids.length) throw new HttpError(404, "One of those personas wasn't found.");
  const vetoed = rows.filter((r) => r.status === "vetoed");
  if (vetoed.length) throw new HttpError(400, `${vetoed.map((v) => v.name).join(", ")} ${vetoed.length === 1 ? "is" : "are"} vetoed. Bring ${vetoed.length === 1 ? "it" : "them"} back or leave ${vetoed.length === 1 ? "it" : "them"} out.`);
  return ids.map((id) => {
    const r = rows.find((x) => x.id === id)!;
    return { key: r.id, name: r.name, spec: r.spec as PersonaSpec, calibrated: r.calibrated };
  });
}

export async function estimatePageWalk(actor: PanelActor, input: { personaIds: string[]; stepCap?: number }, deps: Pick<PanelDeps, "pricingModel">): Promise<RunEstimate & { modelKind: "live" | "fake" }> {
  await gate(actor, "viewer");
  const personas = await runPersonas(actor, input.personaIds);
  const pm = await deps.pricingModel(actor.workspaceId);
  return { ...estimateRun(pm.model, personas.length, clampStepCap(input.stepCap ?? DEFAULT_STEP_CAP)), modelKind: pm.kind };
}

/** Check a target exists in this workspace (and a URL passes the SSRF guard); returns its label. */
async function checkTarget(actor: PanelActor, raw: unknown, deps: Pick<PanelDeps, "checkUrl">): Promise<{ target: PanelTarget; label: string }> {
  const parsed = PanelTargetSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Pick what to walk: a URL, a landing page or a site.");
  const target = parsed.data;
  if (target.kind === "url") {
    try {
      const url = String(await deps.checkUrl(target.url) ?? target.url);
      return { target: { kind: "url", url: /^https?:/.test(url) ? url : target.url }, label: target.url };
    } catch (err) {
      throw new HttpError(400, `That URL can't be walked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (target.kind === "landing_page") {
    const d = await scoped(actor, (tx) => tx.pageDraft.findFirst({ where: { id: target.pageDraftId, workspaceId: actor.workspaceId }, select: { name: true } }));
    if (!d) throw new HttpError(404, "Landing page not found.");
    return { target, label: targetLabel(target, { pageDraft: d.name }) };
  }
  const { prisma } = await import("@/lib/prisma");
  const site = await prisma.site.findFirst({ where: { id: target.siteId, project: { workspaceId: actor.workspaceId } }, select: { name: true } });
  if (!site) throw new HttpError(404, "Site not found.");
  return { target, label: targetLabel(target, { site: site.name }) };
}

export interface StartPageWalkInput {
  target: unknown;
  personaIds: string[];
  stepCap?: number;
  /** The HARD cap the person confirmed (credits). */
  capCredits: number;
  /** The person saw the estimate and confirmed the cap. */
  confirmed: boolean;
}

/** Create the run (with its estimate and confirmed cap) and queue it on the worker. */
export async function startPageWalk(actor: PanelActor, input: StartPageWalkInput, deps: Pick<PanelDeps, "pricingModel" | "checkUrl" | "enqueueRun">): Promise<RunView> {
  await gate(actor, "editor");
  if (input.confirmed !== true) throw new HttpError(400, "Confirm the credit cap before the run starts.");
  const cap = Math.floor(Number(input.capCredits));
  if (!Number.isFinite(cap) || cap < 1) throw new HttpError(400, "The cap must be at least 1 credit.");
  const { target, label } = await checkTarget(actor, input.target, deps);
  const personas = await runPersonas(actor, input.personaIds);
  const pm = await deps.pricingModel(actor.workspaceId);
  const estimate = estimateRun(pm.model, personas.length, clampStepCap(input.stepCap ?? DEFAULT_STEP_CAP));
  const row = await scoped(actor, (tx) =>
    tx.panelRun.create({
      data: {
        workspaceId: actor.workspaceId,
        mode: "page_walk",
        status: "queued",
        target,
        targetLabel: label.slice(0, 300),
        personaIds: personas.map((p) => p.key),
        personaSnapshot: personas as unknown as Prisma.InputJsonValue,
        stepCap: estimate.stepCap,
        model: pm.model,
        modelKind: pm.kind,
        estimateCredits: estimate.total,
        capCredits: cap,
        confirmedBy: actor.userId,
      },
    }),
  );
  const jobId = await deps.enqueueRun(actor.workspaceId, row.id);
  const withJob = await scoped(actor, (tx) => tx.panelRun.update({ where: { id: row.id }, data: { jobId } }));
  return runView(withJob);
}

export async function listRuns(actor: PanelActor, limit = 50, opts: { withReports?: boolean } = {}): Promise<RunView[]> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.panelRun.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 200) }));
  return rows.map((r) => (opts.withReports ? runView(r) : { ...runView(r), report: null }));
}

export interface StepView {
  personaKey: string;
  personaName: string;
  stepIndex: number;
  intent: Intent | null;
  thinkAloud: string;
  observation: Observation;
  signals: StepSignals;
  flags: StepFlag[];
  screenshotRef: string | null;
}

export interface VerdictView {
  personaKey: string;
  personaName: string;
  outcome: string;
  verdict: "buy" | "no-buy" | "maybe" | null;
  withheldReason: string | null;
  confidence: number | null;
  rationale: string;
  objections: VerdictObjection[];
  whatWouldChangeMind: string[];
  behaviorSummary: string;
  timeline: FrictionTimeline;
  traceRef: string | null;
}

export interface CalibrationView {
  predictedRate: number;
  predictedN: number;
  actualConversions: number;
  actualVisitors: number;
  actualRate: number;
  z: number;
  pValue: number;
  verdict: string;
  absError: number;
}

async function runRow(actor: PanelActor, id: string) {
  const row = await scoped(actor, (tx) => tx.panelRun.findFirst({ where: { id, workspaceId: actor.workspaceId } }));
  if (!row) throw new HttpError(404, "Run not found.");
  return row;
}

export async function getRun(actor: PanelActor, id: string): Promise<{ run: RunView; steps: StepView[]; verdicts: VerdictView[]; calibration: CalibrationView | null }> {
  await gate(actor, "viewer");
  const row = await runRow(actor, id);
  const [steps, verdicts, cal] = await scoped(actor, (tx) =>
    Promise.all([
      tx.panelStep.findMany({ where: { runId: id, workspaceId: actor.workspaceId }, orderBy: [{ personaName: "asc" }, { stepIndex: "asc" }] }),
      tx.panelVerdict.findMany({ where: { runId: id, workspaceId: actor.workspaceId }, orderBy: { personaName: "asc" } }),
      tx.panelCalibration.findFirst({ where: { runId: id, workspaceId: actor.workspaceId } }),
    ]),
  );
  return {
    run: runView(row),
    steps: steps.map((s) => ({
      personaKey: s.personaKey,
      personaName: s.personaName,
      stepIndex: s.stepIndex,
      intent: (s.intent as Intent | null) ?? null,
      thinkAloud: s.thinkAloud,
      observation: s.observation as unknown as Observation,
      signals: s.signals as unknown as StepSignals,
      flags: (s.flags as unknown as StepFlag[]) ?? [],
      screenshotRef: s.screenshotRef,
    })),
    verdicts: verdicts.map((v) => ({
      personaKey: v.personaKey,
      personaName: v.personaName,
      outcome: v.outcome,
      verdict: (v.verdict as VerdictView["verdict"]) ?? null,
      withheldReason: v.withheldReason,
      confidence: v.confidence,
      rationale: v.rationale,
      objections: v.objections as unknown as VerdictObjection[],
      whatWouldChangeMind: v.whatWouldChangeMind as unknown as string[],
      behaviorSummary: v.behaviorSummary,
      timeline: v.timeline as unknown as FrictionTimeline,
      traceRef: v.traceRef,
    })),
    calibration: cal ? calibrationView(cal) : null,
  };
}

function calibrationView(c: CalibrationView): CalibrationView {
  return { predictedRate: c.predictedRate, predictedN: c.predictedN, actualConversions: c.actualConversions, actualVisitors: c.actualVisitors, actualRate: c.actualRate, z: c.z, pValue: c.pValue, verdict: c.verdict, absError: c.absError };
}

export async function diffRuns(actor: PanelActor, beforeId: string, afterId: string): Promise<ReportDiff> {
  await gate(actor, "viewer");
  const [a, b] = [runView(await runRow(actor, beforeId)), runView(await runRow(actor, afterId))];
  if (!a.report || !b.report) throw new HttpError(409, "Both runs need a report before they can be compared.");
  return diffReports(a.report, b.report);
}

export interface CalibrationSummary {
  launches: number;
  /** Mean absolute error of predicted vs real conversion (null before the first launch). */
  score: number | null;
  entries: Array<CalibrationView & { runId: string; targetLabel: string }>;
}

export async function calibrationSummary(actor: PanelActor): Promise<CalibrationSummary> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.panelCalibration.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, include: { run: { select: { targetLabel: true } } } }));
  return {
    launches: rows.length,
    score: rows.length ? calibrationScore(rows) : null,
    entries: rows.map((r) => ({ ...calibrationView(r), runId: r.runId, targetLabel: r.run.targetLabel })),
  };
}

/** Enter what really converted after launch; the run's calibration and the workspace score update. */
export async function recordLaunch(actor: PanelActor, runId: string, input: { conversions: number; visitors: number }): Promise<{ calibration: CalibrationView; summary: CalibrationSummary }> {
  await gate(actor, "editor");
  const run = runView(await runRow(actor, runId));
  if (!run.report) throw new HttpError(409, "This run has no report yet.");
  let cmp;
  try {
    cmp = compareRunWithLaunch({ predicted: distributionVerdicts(run.report.distribution), conversions: Number(input.conversions), visitors: Number(input.visitors) });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const data = {
    predictedRate: cmp.predictedRate,
    predictedN: cmp.n,
    actualConversions: Number(input.conversions),
    actualVisitors: Number(input.visitors),
    actualRate: cmp.actualRate,
    z: cmp.z,
    pValue: cmp.pValue,
    verdict: cmp.verdict,
    absError: Math.abs(cmp.delta),
    enteredBy: actor.userId,
  };
  const saved = await scoped(actor, (tx) => tx.panelCalibration.upsert({ where: { runId }, create: { workspaceId: actor.workspaceId, runId, ...data }, update: data }));
  return { calibration: calibrationView(saved), summary: await calibrationSummary(actor) };
}
