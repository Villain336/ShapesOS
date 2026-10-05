// ShapesOS Phase 10 (ops-core) — workspace users as ops assignees.
//
// There is no User table: people are Auth.js subjects with a
// WorkspaceMember row. Task assignees, deal owners, ticket assignees,
// timesheet users and team-member links all store that subject id and are
// validated here against the workspace's ACTIVE (claimed) memberships.

import type { Prisma } from "@prisma/client";
import { OpsError } from "./doctype";

type Tx = Prisma.TransactionClient;

export interface WorkspacePerson {
  userId: string;
  name: string;
  email: string | null;
  role: string;
}

export async function listWorkspacePeople(tx: Tx, workspaceId: string): Promise<WorkspacePerson[]> {
  const rows = await tx.workspaceMember.findMany({
    where: { workspaceId, userId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { userId: true, name: true, email: true, role: true },
  });
  return rows.map((r) => ({ userId: r.userId!, name: r.name ?? r.email ?? r.userId!, email: r.email, role: r.role }));
}

/** 422 unless userId is a claimed member of the workspace. */
export async function assertWorkspaceUser(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  const m = await (tx as unknown as {
    workspaceMember: { findFirst(a: unknown): Promise<{ id: string } | null> };
  }).workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } });
  if (!m) throw new OpsError(422, `User "${userId}" is not a member of this workspace`);
}
