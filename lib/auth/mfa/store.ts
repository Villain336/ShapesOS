// ShapesOS — second-factor persistence (Phase 4a).
//
// TOTP secrets are sealed with the credential envelope (AES-256-GCM,
// MARKETR_CREDENTIALS_KEY — lib/sitefiles/crypto.ts) and only ever decrypted
// here, server-side. Recovery codes are stored as SHA-256 hashes. Every
// verification that must not be repeatable is a single conditional UPDATE:
//   TOTP     totp_last_step < step  (replay protection, RFC 6238 §5.2)
//   recovery used_at IS NULL        (single use)

import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/sitefiles/crypto";
import { generateTotpSecret, looksLikeTotp, otpauthUri, verifyTotp } from "./totp";
import { generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode } from "./recovery";
import type { FactorSummary } from "./session-token";

/** An enrollment not confirmed within this window must be restarted. */
export const TOTP_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export interface SecurityStatus extends FactorSummary {
  totpEnabledAt: Date | null;
  recoveryCodesRemaining: number;
}

export async function factorSummary(userId: string): Promise<FactorSummary> {
  const [sec, passkeys] = await Promise.all([
    prisma.userSecurity.findUnique({ where: { userId }, select: { totpEnabledAt: true } }),
    prisma.userPasskey.count({ where: { userId } }),
  ]);
  return { totp: !!sec?.totpEnabledAt, passkeys };
}

export async function securityStatus(userId: string): Promise<SecurityStatus> {
  const [sec, passkeys, recoveryCodesRemaining] = await Promise.all([
    prisma.userSecurity.findUnique({ where: { userId }, select: { totpEnabledAt: true } }),
    prisma.userPasskey.count({ where: { userId } }),
    prisma.userRecoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  return {
    totp: !!sec?.totpEnabledAt,
    totpEnabledAt: sec?.totpEnabledAt ?? null,
    passkeys,
    recoveryCodesRemaining,
  };
}

/** Keep the profile snapshot fresh (passkey sign-in restores name/email from it). */
export async function touchProfile(userId: string, profile: { email?: string | null; name?: string | null }) {
  await prisma.userSecurity.upsert({
    where: { userId },
    create: { userId, email: profile.email ?? null, name: profile.name ?? null },
    update: { email: profile.email ?? undefined, name: profile.name ?? undefined },
  });
}

/** Begin (or restart) TOTP enrollment. Returns the secret to show once. */
export async function startTotpEnrollment(
  userId: string,
  profile: { email?: string | null; name?: string | null },
  now: Date = new Date(),
): Promise<{ secret: string; uri: string }> {
  const existing = await prisma.userSecurity.findUnique({ where: { userId }, select: { totpEnabledAt: true } });
  if (existing?.totpEnabledAt) throw new Error("TOTP is already enabled");
  const secret = generateTotpSecret();
  const enc = encryptSecret(secret);
  await prisma.userSecurity.upsert({
    where: { userId },
    create: { userId, email: profile.email ?? null, name: profile.name ?? null, totpPendingEnc: enc, totpPendingAt: now },
    update: { totpPendingEnc: enc, totpPendingAt: now },
  });
  return { secret, uri: otpauthUri({ secret, accountName: profile.email || profile.name || userId }) };
}

/**
 * Confirm enrollment with a code from the app. On success TOTP is enabled,
 * the step is recorded (so the confirming code can't be replayed at sign-in)
 * and 10 fresh recovery codes are returned — shown once.
 */
export async function confirmTotpEnrollment(
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: "no_enrollment" | "expired" | "invalid" }> {
  const sec = await prisma.userSecurity.findUnique({
    where: { userId },
    select: { totpPendingEnc: true, totpPendingAt: true, totpEnabledAt: true },
  });
  if (!sec?.totpPendingEnc || !sec.totpPendingAt || sec.totpEnabledAt) return { ok: false, reason: "no_enrollment" };
  if (now.getTime() - sec.totpPendingAt.getTime() > TOTP_ENROLLMENT_TTL_MS) return { ok: false, reason: "expired" };
  const secret = decryptSecret(sec.totpPendingEnc);
  const result = verifyTotp(secret, code, { nowMs: now.getTime() });
  if (!result.ok) return { ok: false, reason: "invalid" };
  const codes = generateRecoveryCodes();
  const promoted = await prisma.$transaction(async (tx) => {
    const res = await tx.userSecurity.updateMany({
      where: { userId, totpEnabledAt: null, totpPendingEnc: sec.totpPendingEnc },
      data: {
        totpSecretEnc: sec.totpPendingEnc,
        totpEnabledAt: now,
        totpLastStep: BigInt(result.step),
        totpPendingEnc: null,
        totpPendingAt: null,
      },
    });
    if (res.count !== 1) return false;
    await tx.userRecoveryCode.deleteMany({ where: { userId } });
    await tx.userRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) });
    return true;
  });
  if (!promoted) return { ok: false, reason: "no_enrollment" };
  return { ok: true, recoveryCodes: codes };
}

/** Verify a TOTP code for an enrolled user, consuming its time step (no replay). */
export async function verifyUserTotp(userId: string, code: string, now: Date = new Date()): Promise<boolean> {
  const sec = await prisma.userSecurity.findUnique({
    where: { userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!sec?.totpSecretEnc || !sec.totpEnabledAt) return false;
  const lastStep = sec.totpLastStep === null ? null : Number(sec.totpLastStep);
  const result = verifyTotp(decryptSecret(sec.totpSecretEnc), code, { nowMs: now.getTime(), lastStep });
  if (!result.ok) return false;
  // Atomic: a concurrent request with the same code loses here.
  const res = await prisma.userSecurity.updateMany({
    where: {
      userId,
      totpEnabledAt: { not: null },
      OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(result.step) } }],
    },
    data: { totpLastStep: BigInt(result.step) },
  });
  return res.count === 1;
}

/** Consume one recovery code (single use). */
export async function consumeRecoveryCode(userId: string, code: string, now: Date = new Date()): Promise<boolean> {
  if (!looksLikeRecoveryCode(code)) return false;
  const res = await prisma.userRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
    data: { usedAt: now },
  });
  if (res.count !== 1) return false;
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: null,
        filePath: "(auth)",
        actor: "user",
        action: "security_recovery_code_used",
        summary: "a recovery code was used to complete a second-factor check",
        approvedBy: userId,
      },
    })
    .catch(() => {});
  return true;
}

/**
 * Verify a typed second-factor code: a 6-digit TOTP code, else a recovery
 * code. Returns the method that passed, or null.
 */
export async function verifySecondFactorCode(
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<"otp" | "recovery" | null> {
  if (looksLikeTotp(code)) return (await verifyUserTotp(userId, code, now)) ? "otp" : null;
  if (looksLikeRecoveryCode(code)) return (await consumeRecoveryCode(userId, code, now)) ? "recovery" : null;
  return null;
}

/** Remove TOTP and its recovery codes. */
export async function disableTotp(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.userSecurity.updateMany({
      where: { userId },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpPendingEnc: null, totpPendingAt: null },
    }),
    prisma.userRecoveryCode.deleteMany({ where: { userId } }),
  ]);
}

/** Replace every recovery code (old ones stop working). Shown once. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.userRecoveryCode.deleteMany({ where: { userId } }),
    prisma.userRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) }),
  ]);
  return codes;
}

/** User-level security audit row (no workspace; the actor is the user). */
export async function auditSecurity(
  userId: string,
  action:
    | "security_2fa_enabled"
    | "security_2fa_disabled"
    | "security_recovery_codes_regenerated"
    | "security_passkey_added"
    | "security_passkey_removed",
  summary: string,
): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: { projectId: null, workspaceId: null, filePath: "(auth)", actor: "user", action, summary: summary.slice(0, 500), approvedBy: userId },
    })
    .catch(() => {});
}
