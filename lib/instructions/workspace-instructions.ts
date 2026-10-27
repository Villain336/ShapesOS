// ShapesOS Phase 25 - shared workspace instructions.
//
// Admin-written guidance ("how this team likes work done") that is included in
// agent context. It is GUIDANCE, not enforcement: a model can ignore or
// misread it, and nothing here changes an approval, spend, role or security
// gate. Append-only revisions give an audit trail (who, when, what); the
// current text is the highest revision. Writes use optimistic concurrency
// (expectedRevision) and the unique (workspace, revision) key closes the race.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

import { INSTRUCTIONS_MAX_CHARS, renderInstructionsBlock } from "./render";

export { INSTRUCTIONS_MAX_CHARS, renderInstructionsBlock };

export interface InstructionsView {
  revision: number;
  body: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface InstructionRevisionView {
  revision: number;
  body: string;
  createdAt: string;
  createdBy: string;
}

const EMPTY: InstructionsView = { revision: 0, body: "", updatedAt: null, updatedBy: null };

export class InstructionsConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super("INSTRUCTIONS_CONFLICT");
  }
}

export async function getInstructions(workspaceId: string): Promise<InstructionsView> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceInstructionRevision.findFirst({ where: { workspaceId }, orderBy: { revision: "desc" } }),
  );
  if (!row) return EMPTY;
  return { revision: row.revision, body: row.body, updatedAt: row.createdAt.toISOString(), updatedBy: row.createdByLabel ?? row.createdBy };
}

export async function listInstructionRevisions(workspaceId: string, limit = 20): Promise<InstructionRevisionView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceInstructionRevision.findMany({ where: { workspaceId }, orderBy: { revision: "desc" }, take: Math.min(Math.max(limit, 1), 50) }),
  );
  return rows.map((r) => ({ revision: r.revision, body: r.body, createdAt: r.createdAt.toISOString(), createdBy: r.createdByLabel ?? r.createdBy }));
}

/** Append a revision. `expectedRevision` is what the editor last saw (0 = none yet). */
export async function setInstructions(input: {
  workspaceId: string;
  userId: string;
  userLabel?: string | null;
  body: string;
  expectedRevision: number;
}): Promise<InstructionsView> {
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (body.length > INSTRUCTIONS_MAX_CHARS) throw new Error("INSTRUCTIONS_TOO_LONG");
  try {
    const row = await withWorkspaceScope(input.workspaceId, async (tx) => {
      const cur = await tx.workspaceInstructionRevision.findFirst({
        where: { workspaceId: input.workspaceId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const currentRevision = cur?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) throw new InstructionsConflictError(currentRevision);
      return tx.workspaceInstructionRevision.create({
        data: {
          workspaceId: input.workspaceId,
          revision: currentRevision + 1,
          body,
          createdBy: input.userId,
          createdByLabel: input.userLabel ?? null,
        },
      });
    });
    return { revision: row.revision, body: row.body, updatedAt: row.createdAt.toISOString(), updatedBy: row.createdByLabel ?? row.createdBy };
  } catch (err) {
    if (err instanceof InstructionsConflictError) throw err;
    // Two writers raced past the read: the unique key rejected the loser.
    if ((err as { code?: string })?.code === "P2002") throw new InstructionsConflictError(input.expectedRevision + 1);
    throw err;
  }
}

/** Context section for a workspace; "" when unset or on any read failure (never blocks a turn). */
export async function loadInstructionsBlock(workspaceId: string): Promise<string> {
  try {
    const cur = await getInstructions(workspaceId);
    return renderInstructionsBlock(cur.body);
  } catch {
    return "";
  }
}

