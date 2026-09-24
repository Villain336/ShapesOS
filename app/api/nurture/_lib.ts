// Marketr — R3 nurture API shared guards.
//
// Mirror of the pattern in app/api/attribution/bundles/route.ts:
// requireUser → getOrCreateWorkspace; mutations additionally need editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

export interface NurtureCtx {
  userId: string;
  workspaceId: string;
}

export async function nurtureCtx(): Promise<NurtureCtx | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  return { userId: user.id, workspaceId: workspace.id };
}

export async function requireNurtureEditor(
  ctx: NurtureCtx,
): Promise<null | Response> {
  if (!(await requireWorkspaceRole(ctx.userId, ctx.workspaceId, "editor")))
    return forbidden();
  return null;
}

export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, res: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}

export interface SequenceStatsResult {
  enrolledActive: number;
  sent: number;
  suppressed: number;
}

/** Per-sequence rollup for the list/detail views (kept out of route.ts
 *  because Next only allows handler exports there). */
export async function sequenceStats(
  prisma: {
    sequenceEnrollment: { count(args: unknown): Promise<number> };
    approvalItem: { findMany(args: unknown): Promise<Array<{ id: string }>> };
    outboundMessage: { count(args: unknown): Promise<number> };
  },
  workspaceId: string,
  sequenceId: string,
): Promise<SequenceStatsResult> {
  const [enrolledActive, approvalIds] = await Promise.all([
    prisma.sequenceEnrollment.count({
      where: { workspaceId, sequenceId, status: "active" },
    }),
    prisma.approvalItem.findMany({
      where: {
        workspaceId,
        kind: "sequence_send",
        payload: { path: ["sequenceId"], equals: sequenceId },
      },
      select: { id: true },
    }),
  ]);
  const ids = approvalIds.map((a) => a.id);
  const [sent, suppressed] = ids.length
    ? await Promise.all([
        prisma.outboundMessage.count({
          where: { workspaceId, approvalId: { in: ids }, status: { in: ["queued", "sent", "delivered"] } },
        }),
        prisma.outboundMessage.count({
          where: { workspaceId, approvalId: { in: ids }, status: "suppressed" },
        }),
      ])
    : [0, 0];
  return { enrolledActive, sent, suppressed };
}
