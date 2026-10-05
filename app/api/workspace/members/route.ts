// Marketr — workspace members API (milestone 11: RBAC; day-1 hardening M5).
// GET  /api/workspace/members            → { members, myRole } (any member)
// POST /api/workspace/members { email, role, confirmSeatCharge? } → invite
//   (admin+; never above the inviter's own role, so only owners invite
//   owners). Creates a pending membership with a single-use token; the
//   invitee claims it via the token link at /invite?token=… (see
//   app/api/workspace/invites/accept).
// Phase 15.3 (pricing): a pending invite reserves a seat. Past the plan's
//   included seats (and any extra seats an admin already approved) the POST
//   answers 402 { code: "seat_confirmation_required", seat } WITHOUT adding
//   anyone, unless the admin re-sends it with confirmSeatCharge: true after
//   seeing the price. Charging for a seat is never automatic. On a plan or
//   deployment where extra seats can't be billed it stays a 403 seat limit.
//   After an add past the included seats the Stripe seat quantity is synced
//   (idempotent; never above what an admin approved).
// All mutations are audit-logged (workspace-scoped).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import {
  getMembership,
  mintInviteToken,
  requireWorkspaceRole,
  forbidden,
  memberChangeError,
} from "@/lib/authz";
import { readJsonBody } from "@/lib/sitefiles/api";
import type { WorkspaceRole } from "@prisma/client";
import { inviteMailChannel, sendInviteEmail } from "@/lib/workspace/invite-mail";
import { entitlementDenied, EntitlementError } from "@/lib/billing/entitlements-server";
import { entitlementSummary, limitUpgradeMessage } from "@/lib/billing/entitlements";
import { seatConfirmationMessage } from "@/lib/billing/seats";
import { checkSeatForNewMember, getSeatSummary, recordSeatApproval, syncSeatsBestEffort } from "@/lib/billing/seats-server";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "editor", "viewer"];

function publicMember(m: {
  id: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
  userId: string | null;
  createdAt: Date;
}) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
    pending: m.userId === null,
    createdAt: m.createdAt.toISOString(),
  };
}

async function audit(
  workspaceId: string,
  actor: string,
  action: "member_added",
  summary: string,
) {
  await prisma.fileChangeLog.create({
    data: {
      projectId: null,
      workspaceId,
      filePath: "(workspace)",
      actor: "user",
      action,
      summary,
      approvedBy: actor,
    },
  });
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) return Response.json({ error: "Forbidden" }, { status: 403 });

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({
    workspace: { id: workspace.id, name: workspace.name },
    myRole: me.role,
    // Phase 3: whether invites go out by email on this deployment.
    inviteEmail: inviteMailChannel() !== null,
    // Phase 4a: the plan's seat limit (null = unlimited). Phase 15.3: on a
    // paid plan this is the INCLUDED seats; `seats` has the full picture.
    seatLimit: entitlementSummary(workspace.plan).limits.seats,
    seats: await getSeatSummary(workspace.id),
    members: members.map(publicMember),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!me) return forbidden("Member management requires the admin role.");

  const body = await readJsonBody<{ email?: string; role?: string; confirmSeatCharge?: unknown }>(req);
  const email = (body?.email ?? "").trim().toLowerCase();
  const role = (body?.role ?? "viewer").trim().toLowerCase() as WorkspaceRole;
  if (!email || !email.includes("@"))
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  if (!VALID_ROLES.includes(role))
    return Response.json({ error: "Invalid role." }, { status: 400 });
  // Phase 1: no inviting above your own role (admins can't invite owners).
  const denial = memberChangeError(me.role, { nextRole: role });
  if (denial) return forbidden(denial);

  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id, email },
  });
  if (existing)
    return Response.json({ error: "That email is already a member." }, { status: 409 });
  // Phase 4a: seats are a plan limit (a pending invite reserves a seat).
  // Phase 15.3: past the included seats an admin confirms the charge first.
  const seat = await checkSeatForNewMember(workspace.id, { confirmed: body?.confirmSeatCharge === true });
  if (seat.kind === "limit") {
    const err = new EntitlementError(`${limitUpgradeMessage("seats", seat.max)} ${seat.reason}`.trim(), "seats");
    return entitlementDenied(err);
  }
  if (seat.kind === "needs_confirmation") {
    return Response.json(
      {
        error: seatConfirmationMessage(seat),
        code: "seat_confirmation_required",
        seat: {
          plan: seat.plan,
          included: seat.included,
          usedAfter: seat.usedAfter,
          extraAfter: seat.extraAfter,
          approvedExtra: seat.approvedExtra,
          newExtraSeats: seat.extraAfter - seat.approvedExtra,
          perSeatCents: seat.perSeatCents,
          interval: seat.interval,
        },
      },
      { status: 402 },
    );
  }

  const member = await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, email, role, ...mintInviteToken() },
  });
  await audit(
    workspace.id,
    user.id,
    "member_added",
    `${user.email ?? user.id} invited ${email} as ${role}`,
  );
  // Phase 15.3: the admin's explicit confirmation raises the approved
  // ceiling (audited with the price), then the seat line follows.
  if (seat.kind === "confirmed") {
    await recordSeatApproval(workspace.id, seat, { userId: user.id, label: user.email ?? user.id });
  }
  const seatSync = seat.kind === "within_plan" ? null : await syncSeatsBestEffort(workspace.id);
  // Day-1 hardening (M5): invites are claimed via a single-use token link,
  // never by bare email match. Phase 3: the link is emailed when the
  // deployment has mail set up; the admin can always copy it as a fallback.
  const inviteUrl = `/invite?token=${member.inviteToken}`;
  const mail = await sendInviteEmail({
    to: email,
    workspaceName: workspace.name,
    inviterName: user.name || user.email || "A teammate",
    role,
    inviteUrl,
    expiresAt: member.inviteExpiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    requestOrigin: new URL(req.url).origin,
  });
  return Response.json({
    ok: true,
    member: publicMember(member),
    inviteUrl,
    emailed: mail.sent,
    ...(mail.sent ? {} : { emailNote: mail.message }),
    ...(seatSync && !seatSync.skipped
      ? { seatSync: { ok: seatSync.ok, quantity: seatSync.result?.quantity ?? null, error: seatSync.error ?? null } }
      : {}),
  });
}
