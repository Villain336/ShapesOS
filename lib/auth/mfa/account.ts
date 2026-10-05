// ShapesOS — account-security view + policy helpers shared by the
// /api/account/security routes and the setup page (Phase 4a).

import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { securityStatus } from "./store";

export interface PasskeyView {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(userId: string): Promise<PasskeyView[]> {
  const rows = await prisma.userPasskey.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    deviceType: r.deviceType,
    backedUp: r.backedUp,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Names of the caller's workspaces that require a second factor. */
export async function workspacesRequiringTwoFactor(userId: string): Promise<Array<{ id: string; name: string }>> {
  return prisma.workspace.findMany({
    where: {
      requireTwoFactor: true,
      OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export async function accountSecurityView(userId: string) {
  const [status, passkeys, requiredBy] = await Promise.all([
    securityStatus(userId),
    listPasskeys(userId),
    workspacesRequiringTwoFactor(userId),
  ]);
  return {
    totp: { enabled: status.totp, enabledAt: status.totpEnabledAt?.toISOString() ?? null },
    recoveryCodesRemaining: status.recoveryCodesRemaining,
    passkeys,
    requiredBy,
  };
}

/** SVG QR code for an otpauth:// URI, as a data: URL the page can show in <img>. */
export async function otpauthQrDataUrl(uri: string): Promise<string> {
  const svg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * Removing a factor must not leave someone without any factor while one of
 * their workspaces requires 2FA (they'd lock themselves out of it).
 */
export async function wouldBreakPolicy(userId: string, remaining: { totp: boolean; passkeys: number }): Promise<string | null> {
  if (remaining.totp || remaining.passkeys > 0) return null;
  const required = await workspacesRequiringTwoFactor(userId);
  if (!required.length) return null;
  return `${required.map((w) => w.name).join(", ")} requires two-factor authentication. Add another method before removing this one.`;
}
