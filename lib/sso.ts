// Marketr — SSO domain-based auto-provisioning (milestone 11).
//
// When SSO_WORKSPACE_ID + SSO_DOMAIN are set, a user signing in via the OIDC
// or SAML provider whose email domain matches SSO_DOMAIN is added to that
// workspace with SSO_DEFAULT_ROLE (default "editor") instead of getting a
// personal workspace.
//
// Day-1 hardening (M4/M5):
//   - auto-provisioning requires a VERIFIED email claim (email_verified=true);
//     a lax IdP asserting someone else's address can no longer walk in.
//   - SSO_DEFAULT_ROLE can never be "owner" (clamped to viewer/editor/admin).
//   - pending invites are claimed via single-use token links (/invite?token=…),
//     never by bare email match — no auto-linking happens here.

import { prisma } from "./prisma";
import type { WorkspaceRole } from "@prisma/client";
import { planHasFeature } from "./billing/entitlements";
import { seatProvisioningRefusal } from "./billing/seats";

// Owner is deliberately excluded: SSO must never mint owners.
const SSO_ROLES: WorkspaceRole[] = ["viewer", "editor", "admin"];

export function ssoAutoProvisioningConfigured(): boolean {
  return Boolean(
    (process.env.SSO_WORKSPACE_ID ?? "").trim() &&
      (process.env.SSO_DOMAIN ?? "").trim(),
  );
}

function defaultSsoRole(): WorkspaceRole {
  const r = (process.env.SSO_DEFAULT_ROLE ?? "editor").trim().toLowerCase();
  return (SSO_ROLES as string[]).includes(r) ? (r as WorkspaceRole) : "editor";
}

export async function provisionSsoUser(
  userId: string,
  email: string,
  emailVerified: boolean,
) {
  // Fail closed: without a verified email claim, no provisioning at all.
  if (!emailVerified) return;
  if (!ssoAutoProvisioningConfigured()) return;

  const normalized = email.trim().toLowerCase();
  const domain = (process.env.SSO_DOMAIN ?? "").trim().toLowerCase();
  const workspaceId = (process.env.SSO_WORKSPACE_ID ?? "").trim();
  if (!normalized.endsWith(`@${domain}`)) return;

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return;
  // Phase 4a: SSO auto-provisioning is a plan entitlement.
  if (!planHasFeature(workspace.plan, "sso")) return;

  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
  });
  if (existing) return;

  // Phase 15.3 (pricing): auto-provisioning can't confirm a seat charge.
  // Past the included seats (and any extra seats an admin approved) the user
  // is not provisioned — an admin adds them in Members (confirming the seat).
  // Lazy: keeps Stripe/billing out of the auth module graph (auth.ts imports this file).
  const { checkSeatForNewMember, syncSeatsBestEffort } = await import("./billing/seats-server");
  const seat = await checkSeatForNewMember(workspaceId, { confirmed: false });
  const refusal = seatProvisioningRefusal(seat);
  if (refusal) {
    console.warn(`[sso] not auto-provisioning ${normalized} into ${workspaceId}: ${refusal}`);
    return;
  }

  // If the user holds a pending token invite for this workspace, leave it
  // alone — claiming stays an explicit token-link action.
  await prisma.workspaceMember.create({
    data: {
      workspaceId,
      userId,
      email: normalized,
      role: defaultSsoRole(),
    },
  });
  if (seat.kind === "within_approved") await syncSeatsBestEffort(workspaceId);
}
