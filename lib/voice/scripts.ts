// Marketr — Phase 13D Worker A: CallScript lifecycle + AI-disclosure gate.
//
// Draft-first lineage (spec): scripts move draft → in_review → approved /
// rejected. ONLY status='approved' scripts may attach to a live session —
// enforced in sessions.ts gate (c). Approval is human: approvedBy/approvedAt
// are stamped by the reviewer (the scripts page is the legal-review
// surface).
//
// The AI disclosure check is load-bearing: every call opening must disclose
// the AI identity ("Hi, I'm an AI assistant calling on behalf of X"). The
// pure `hasAiDisclosure` function below is the single definition of "has a
// disclosure", used by the approval flow (warn) and the session gate
// (refuse). Sessions refuse a script whose opening lacks it.

import { Prisma, type CallScript } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export type ScriptStatus = "draft" | "in_review" | "approved" | "rejected" | "archived";

export interface ScriptBody {
  opening: string;
  branches?: Array<{ if: string; then: string }>;
  objectionHandlers?: Array<{ objection: string; response: string }>;
  closing?: string;
}

export interface ScriptListItem {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  version: number;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  updatedAt: Date;
  hasDisclosure: boolean;
  _count: { sessions: number };
}

// ---------------------------------------------------------------------------
// AI disclosure detection — pure, DB-free, test-covered.
// ---------------------------------------------------------------------------

/** AI-identity markers: the caller must say it is an AI/automated system. */
const AI_IDENTITY =
  /artificial intelligence|\bAI\b|automated (assistant|system|caller)|virtual assistant|digital assistant|robot caller|synthetic voice/i;
/** Disclosure-context markers: calling on someone's behalf. */
const OUTBOUND_CONTEXT =
  /calling on behalf of|reaching out on behalf of|on behalf of|from [A-Za-z][\w .&-]{1,60} (this|today)|this is [^.]{1,80} calling/i;

/**
 * True when the opening discloses AI identity in an outbound context.
 * Examples that PASS: "Hi, I'm an AI assistant calling on behalf of Acme."
 * Examples that FAIL: "Hi, I'm calling on behalf of Acme." (no AI identity),
 * "Hi, I'm an AI assistant." (no outbound context — inbound-safe but not a
 * disclosure for outbound calls).
 */
export function hasAiDisclosure(opening: string): boolean {
  const text = (opening ?? "").trim();
  if (text.length === 0) return false;
  return AI_IDENTITY.test(text) && OUTBOUND_CONTEXT.test(text);
}

/** Pure: may this script ever attach to a live session? Only approved ones. */
export function canAttachToLiveSession(
  script: Pick<CallScript, "status">,
): boolean {
  return script.status === "approved";
}

/** Non-blocking warning shown on the legal-review surface. */
export function disclosureWarning(body: ScriptBody): string | null {
  if (!hasAiDisclosure(body.opening)) {
    return "Opening is missing the AI-identity disclosure (e.g. \"Hi, I'm an AI assistant calling on behalf of {company}\"). The session gate will refuse to attach this script until it is fixed.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle (all tenant-scoped)
// ---------------------------------------------------------------------------

function toScriptBody(v: unknown): ScriptBody {
  const b = (v ?? {}) as Partial<ScriptBody>;
  return {
    opening: String(b.opening ?? ""),
    branches: Array.isArray(b.branches) ? b.branches : [],
    objectionHandlers: Array.isArray(b.objectionHandlers) ? b.objectionHandlers : [],
    closing: b.closing ? String(b.closing) : undefined,
  };
}

export async function listScripts(
  workspaceId: string,
  opts?: { agentId?: string; status?: string },
): Promise<ScriptListItem[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findMany({
      where: {
        workspaceId,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
      },
      orderBy: { updatedAt: "desc" },
      include: {
        agent: { select: { name: true } },
        _count: { select: { sessions: true } },
      },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agent.name,
    name: r.name,
    version: r.version,
    status: r.status,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    updatedAt: r.updatedAt,
    hasDisclosure: hasAiDisclosure(toScriptBody(r.body).opening),
    _count: r._count,
  }));
}

export async function getScript(
  workspaceId: string,
  scriptId: string,
): Promise<(CallScript & { agentName: string }) | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({
      where: { id: scriptId, workspaceId },
      include: { agent: { select: { name: true } } },
    }),
  );
  if (!row) return null;
  return { ...row, agentName: row.agent.name };
}

export async function createDraftScript(
  workspaceId: string,
  input: { agentId: string; name: string; body: ScriptBody },
): Promise<CallScript> {
  if (!input.name.trim()) throw new BadRequestError("Script name is required.");
  if (!toScriptBody(input.body).opening.trim())
    throw new BadRequestError("Script opening is required.");
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.create({
      data: {
        workspaceId,
        agentId: input.agentId,
        name: input.name.trim(),
        body: json(toScriptBody(input.body)),
        status: "draft",
      },
    }),
  );
}

export async function updateDraftScript(
  workspaceId: string,
  scriptId: string,
  patch: { name?: string; body?: ScriptBody },
): Promise<CallScript> {
  // Only drafts can be edited; approved scripts get a new version instead.
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({ where: { id: scriptId, workspaceId } }),
  );
  if (!current) throw new NotFoundError("Script not found.");
  if (current.status !== "draft")
    throw new ConflictError("Only draft scripts can be edited — create a new version instead.");
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.update({
      where: { id: scriptId, workspaceId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.body !== undefined ? { body: json(toScriptBody(patch.body)) } : {}),
      },
    }),
  );
}

/** Draft → in_review: puts the script in the legal-review queue. */
export async function submitForReview(
  workspaceId: string,
  scriptId: string,
): Promise<CallScript> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({ where: { id: scriptId, workspaceId } }),
  );
  if (!current) throw new NotFoundError("Script not found.");
  if (current.status !== "draft" && current.status !== "rejected")
    throw new ConflictError(`Cannot submit a ${current.status} script for review.`);
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.update({
      where: { id: scriptId, workspaceId },
      data: { status: "in_review" },
    }),
  );
}

/**
 * Human approval: stamps approvedBy/approvedAt. WARNING — the gate does not
 * re-check disclosure here (the UI surfaces the warning); `requestSession`
 * re-validates disclosure at attach time, so an approved-but-undisclosed
 * script can never dial.
 */
export async function approveScript(
  workspaceId: string,
  scriptId: string,
  approvedBy: string,
): Promise<CallScript> {
  if (!approvedBy.trim()) throw new BadRequestError("approvedBy (human reviewer) is required.");
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({ where: { id: scriptId, workspaceId } }),
  );
  if (!current) throw new NotFoundError("Script not found.");
  if (current.status !== "in_review" && current.status !== "draft")
    throw new ConflictError(`Cannot approve a ${current.status} script.`);
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.update({
      where: { id: scriptId, workspaceId },
      data: {
        status: "approved",
        approvedBy: approvedBy.trim(),
        approvedAt: new Date(),
      },
    }),
  );
}

export async function rejectScript(
  workspaceId: string,
  scriptId: string,
  reason?: string,
): Promise<CallScript> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({ where: { id: scriptId, workspaceId } }),
  );
  if (!current) throw new NotFoundError("Script not found.");
  if (current.status !== "in_review" && current.status !== "draft")
    throw new ConflictError(`Cannot reject a ${current.status} script.`);
  void reason;
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.update({
      where: { id: scriptId, workspaceId },
      data: { status: "rejected", approvedBy: null, approvedAt: null },
    }),
  );
}

/**
 * New version of a script: freezes the current row (archived) and creates a
 * fresh draft. New objection branches flag for review — the new draft must
 * pass the full review cycle before it can attach to any session.
 */
export async function newScriptVersion(
  workspaceId: string,
  scriptId: string,
  body: ScriptBody,
): Promise<CallScript> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({ where: { id: scriptId, workspaceId } }),
  );
  if (!current) throw new NotFoundError("Script not found.");
  return withWorkspaceScope(workspaceId, async (tx) => {
    // Already inside the scope transaction — no nested $transaction.
    await tx.callScript.update({
      where: { id: scriptId, workspaceId },
      data: { status: "archived" },
    });
    return tx.callScript.create({
      data: {
        workspaceId,
        agentId: current.agentId,
        name: current.name,
        version: current.version + 1,
        body: json(toScriptBody(body)),
        status: "draft",
      },
    });
  });
}
