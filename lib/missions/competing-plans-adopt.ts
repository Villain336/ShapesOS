// ShapesOS - adopting a stored competing-plan candidate. GROUNDWORK, NOT WIRED:
// no route or job calls this, and candidates are not persisted anywhere yet.
//
// Mirrors selectPlanAlternative: adoption swaps the DRAFTED plan only, never
// activates the mission and never approves anything. The mission stays
// "planned" and the next approval must name the new revision. The swap is a
// compare-and-set on the mission row (replacePlanIfCurrent), so a concurrent
// approve/select/adopt loses with 409.
//
// Binding: the stored candidate must belong to the SAME workspace and mission as
// the request and must have been composed against the revision the person is
// reviewing. The stored steps are re-validated here (never trusted because they
// were stored) and mapped with tier 0 and no checkpoint, the draft-safe limits.

import { CandidateSchema } from "./competing-plans";
import { MissionError, planRevision, type EngineDeps } from "./engine";
import type { StoredMission } from "./store";
import type { PlanStepDef } from "./templates";

export interface StoredCandidate {
  id: string;
  workspaceId: string;
  missionId: string;
  /** planRevision of the mission plan this candidate was composed against. */
  baseRevision: string;
  /** Unvalidated as far as this module is concerned: re-parsed on adoption. */
  candidate: unknown;
}

/** Pure: candidate -> mission planSnapshot. Throws MissionError(422) when the steps fail the schema. */
export function candidateToSnapshot(templateId: string, candidateId: string, raw: unknown): { templateId: string; alternativeId: string; steps: PlanStepDef[] } {
  const parsed = CandidateSchema.safeParse(raw);
  if (!parsed.success) throw new MissionError("Stored candidate no longer passes plan validation; it was not adopted.", 422);
  const steps: PlanStepDef[] = parsed.data.steps.map((s, i) => ({
    order: i + 1,
    key: s.key,
    title: s.title,
    kind: s.kind,
    executor: s.executor,
    description: s.description,
    tier: 0,
    checkpointAfter: false,
  }));
  return { templateId, alternativeId: `candidate:${candidateId}`, steps };
}

export async function adoptCandidate(
  deps: EngineDeps,
  input: { stored: StoredCandidate; missionId: string; workspaceId: string; userId: string; expectedRevision: string },
): Promise<{ mission: StoredMission; planRevision: string }> {
  const { stored, missionId, workspaceId, userId, expectedRevision } = input;
  if (await deps.isWorkspaceFrozen(workspaceId)) throw new MissionError("Workspace is frozen - mission mutation HALTED. Unfreeze the workspace first.");
  if (await deps.isMissionPaused(missionId, workspaceId)) throw new MissionError("Mission is paused - resume it before mutating.");
  // Tenant and mission binding: a candidate from another workspace or mission is reported as not found.
  if (stored.workspaceId !== workspaceId || stored.missionId !== missionId) throw new MissionError("Candidate not found for this mission.", 404);
  const mission = await deps.store.getMission(missionId, workspaceId);
  if (!mission) throw new MissionError("Mission not found in workspace.", 404);
  if (mission.status !== "planned") throw new MissionError(`The plan can only be changed before it is approved (status "${mission.status}").`, 409);
  const current = planRevision(mission.planSnapshot);
  if (expectedRevision !== current) throw new MissionError("The plan changed since you reviewed it - review the latest plan, then choose.", 409);
  if (stored.baseRevision !== current) throw new MissionError("This candidate was composed against an older plan; compose again.", 409);
  const snapshot = candidateToSnapshot(String((mission.planSnapshot as { templateId?: unknown }).templateId ?? mission.template), stored.id, stored.candidate);
  const next = planRevision(snapshot);
  const replaced = await deps.store.replacePlanIfCurrent(missionId, workspaceId, mission.updatedAt, snapshot);
  if (!replaced) throw new MissionError("The mission changed while you were choosing - review the latest plan, then choose.", 409);
  await deps.store.appendEvent(missionId, workspaceId, {
    actor: userId,
    step: "mission.plan_candidate_adopted",
    observation: { candidateId: stored.id, candidateHash: planRevision(stored.candidate), fromRevision: current, toRevision: next, adoptedBy: userId, note: "Plan swapped before approval. The mission stays planned until this revision is approved." },
  });
  return { mission: replaced, planRevision: next };
}

// ---------------------------------------------------------------------------
// Persistence WITHOUT a new table: candidates are recorded as an event on the
// mission's hash-chained, workspace-scoped (row-level-security) event log.
// Append-only, so a stored candidate cannot be edited afterwards, and the chain
// makes tampering visible. Tenant isolation is the existing mission_events policy.
// Nothing calls recordCandidates yet: only a future, authorized and metered
// generation path would. Role checks belong to that route, not to this module.
// ---------------------------------------------------------------------------

export const CANDIDATES_EVENT_STEP = "mission.plan_candidates_recorded";

/** Records only candidates that pass the schema; returns the event id and per-index stored ids. */
export async function recordCandidates(
  deps: EngineDeps,
  input: { missionId: string; workspaceId: string; userId: string; baseRevision: string; candidates: { lensId: string; candidate: unknown }[] },
): Promise<{ eventId: string; stored: StoredCandidate[] }> {
  const { missionId, workspaceId, userId, baseRevision } = input;
  const mission = await deps.store.getMission(missionId, workspaceId);
  if (!mission) throw new MissionError("Mission not found in workspace.", 404);
  if (planRevision(mission.planSnapshot) !== baseRevision) throw new MissionError("The plan changed while candidates were composed; they were not recorded.", 409);
  const valid = input.candidates.flatMap((c, index) => {
    const parsed = CandidateSchema.safeParse(c.candidate);
    return parsed.success ? [{ index, lensId: c.lensId, candidate: parsed.data }] : [];
  });
  if (valid.length === 0) throw new MissionError("No candidate passed validation; nothing was recorded.", 422);
  const ev = await deps.store.appendEvent(missionId, workspaceId, {
    actor: userId,
    step: CANDIDATES_EVENT_STEP,
    observation: { baseRevision, candidates: valid, note: "Proposals only. Nothing here changes the plan until a person adopts one." },
  });
  return { eventId: ev.id, stored: valid.map((v) => ({ id: `${ev.id}:${v.index}`, workspaceId, missionId, baseRevision, candidate: v.candidate })) };
}

/** Loads a recorded candidate by "<eventId>:<index>" within the mission and workspace, else null. */
export async function loadStoredCandidate(deps: EngineDeps, missionId: string, workspaceId: string, candidateId: string): Promise<StoredCandidate | null> {
  const cut = candidateId.lastIndexOf(":");
  if (cut < 1) return null;
  const eventId = candidateId.slice(0, cut);
  const index = Number(candidateId.slice(cut + 1));
  const events = await deps.store.listEvents(missionId, workspaceId);
  const ev = events.find((e) => e.id === eventId && e.step === CANDIDATES_EVENT_STEP);
  const obs = ev?.observation as { baseRevision?: unknown; candidates?: { index: number; candidate: unknown }[] } | undefined;
  const hit = obs?.candidates?.find((c) => c.index === index);
  if (!ev || !hit || typeof obs?.baseRevision !== "string") return null;
  return { id: candidateId, workspaceId, missionId, baseRevision: obs.baseRevision, candidate: hit.candidate };
}
