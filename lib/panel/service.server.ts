// ShapesOS — Phase 19B (WS=panel): the Dress Rehearsal service.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// One entry point for the routes, the page and the agent tools, so every path
// goes through the same gates: the dress_rehearsal entitlement (Pro and
// above; a 403 with the upgrade message otherwise), the workspace role
// (viewer reads, editor changes), FORCE RLS on every row, and — for anything
// that calls a model — an estimate first and a hard credit cap the person
// confirmed.

import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { requireEntitlement } from "@/lib/billing/entitlements-server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { isCapReached, PanelLedger } from "./budget";
import type { PanelDeps } from "./deps.server";
import { derivePersonaSpec } from "./derive";
import { estimateDerivation, type DeriveEstimate } from "./estimate";
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
