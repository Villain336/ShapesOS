// ShapesOS — Phase 15.2: agency credit pooling (membership management).
//
// The Agency plan's included credits are ONE pool shared by the agency's
// client workspaces (lib/billing/plans.ts creditsPooled). A client workspace
// joins by pointing workspaces.credit_pool_owner_id at the agency workspace;
// from then on meter() / checkCap() / the LLM spend gate charge and cap the
// AGENCY's balance (lib/metering/service.ts resolvePoolWorkspaceId), the 80%
// alert goes to the agency, and the usage rows stay attributed to the client.
//
// Rules (fail closed):
//   - the pool owner must be on the Agency plan and not itself pooled;
//   - a workspace cannot pool into itself, and a workspace that is already
//     the owner of a pool cannot join another (one level only);
//   - the actor must be admin+ in BOTH workspaces (an agency cannot pull in
//     a stranger's workspace; a client cannot attach itself to an agency);
//   - leaving needs admin+ in the client OR the pool owner.
// Usage already charged stays where it was charged (the ledger is immutable).

import { prisma } from "@/lib/prisma";
import { requireWorkspaceRole } from "@/lib/authz";
import { BadRequestError, ForbiddenError } from "@/lib/api/errors";

export interface PoolMember {
  workspaceId: string;
  name: string;
  plan: string;
}

export async function joinCreditPool(args: {
  poolWorkspaceId: string;
  clientWorkspaceId: string;
  actorUserId: string;
}): Promise<void> {
  const { poolWorkspaceId, clientWorkspaceId, actorUserId } = args;
  if (poolWorkspaceId === clientWorkspaceId) {
    throw new BadRequestError("A workspace cannot pool credits into itself.");
  }
  const [pool, client] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: poolWorkspaceId }, select: { id: true, plan: true, creditPoolOwnerId: true } }),
    prisma.workspace.findUnique({
      where: { id: clientWorkspaceId },
      select: { id: true, creditPoolOwnerId: true, _count: { select: { creditPoolMembers: true } } },
    }),
  ]);
  if (!pool || !client) throw new BadRequestError("Workspace not found.");
  if (pool.plan !== "agency") throw new BadRequestError("Only a workspace on the Agency plan can pool credits for client workspaces.");
  if (pool.creditPoolOwnerId) throw new BadRequestError("This workspace spends another agency's pool; it cannot host one.");
  if (client._count.creditPoolMembers > 0) {
    throw new BadRequestError("That workspace hosts its own credit pool; it cannot join another pool.");
  }
  const [a, b] = await Promise.all([
    requireWorkspaceRole(actorUserId, poolWorkspaceId, "admin"),
    requireWorkspaceRole(actorUserId, clientWorkspaceId, "admin"),
  ]);
  if (!a || !b) throw new ForbiddenError("You need to be an admin of both workspaces to pool their credits.");
  await prisma.workspace.update({ where: { id: clientWorkspaceId }, data: { creditPoolOwnerId: poolWorkspaceId } });
}

export async function leaveCreditPool(args: { clientWorkspaceId: string; actorUserId: string }): Promise<void> {
  const client = await prisma.workspace.findUnique({
    where: { id: args.clientWorkspaceId },
    select: { id: true, creditPoolOwnerId: true },
  });
  if (!client) throw new BadRequestError("Workspace not found.");
  if (!client.creditPoolOwnerId) return;
  const [inClient, inPool] = await Promise.all([
    requireWorkspaceRole(args.actorUserId, client.id, "admin"),
    requireWorkspaceRole(args.actorUserId, client.creditPoolOwnerId, "admin"),
  ]);
  if (!inClient && !inPool) throw new ForbiddenError("You need to be an admin of the client or the agency workspace.");
  await prisma.workspace.update({ where: { id: client.id }, data: { creditPoolOwnerId: null } });
}

/** The client workspaces spending this workspace's pool. */
export async function listPoolMembers(poolWorkspaceId: string): Promise<PoolMember[]> {
  const rows = await prisma.workspace.findMany({
    where: { creditPoolOwnerId: poolWorkspaceId },
    select: { id: true, name: true, plan: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({ workspaceId: r.id, name: r.name, plan: r.plan }));
}

/**
 * Workspaces the actor administers that could join this pool (not the pool
 * itself, not already in a pool, not hosting a pool).
 */
export async function poolCandidates(poolWorkspaceId: string, actorUserId: string): Promise<PoolMember[]> {
  const rows = await prisma.workspace.findMany({
    where: {
      id: { not: poolWorkspaceId },
      creditPoolOwnerId: null,
      creditPoolMembers: { none: {} },
      OR: [{ ownerUserId: actorUserId }, { members: { some: { userId: actorUserId, role: { in: ["owner", "admin"] } } } }],
    },
    select: { id: true, name: true, plan: true },
    orderBy: { name: "asc" },
    take: 200,
  });
  return rows.map((r) => ({ workspaceId: r.id, name: r.name, plan: r.plan }));
}
