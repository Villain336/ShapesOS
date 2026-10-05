// ShapesOS — server-side, single-use, expiring auth challenges (Phase 4a).
//
// One table (auth_challenges) holds:
//   webauthn_reg   passkey registration challenge (bound to the user)
//   webauthn_auth  passkey sign-in / re-auth challenge (usernameless: no user)
//   mfa_proof      a short-lived proof minted right after a factor was
//                  enrolled, so the current session can be upgraded to
//                  "second factor passed" without asking for a second code
//                  (stored as a SHA-256 of the secret handed to the client)
//
// consumeChallenge() is the only way to read one back and it is atomic: one
// UPDATE … WHERE consumed_at IS NULL AND expires_at > now() — two concurrent
// consumers can never both win, and an expired challenge never verifies.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type ChallengeKind = "webauthn_reg" | "webauthn_auth" | "mfa_proof";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_PROOF_TTL_MS = 2 * 60 * 1000;

export interface StoredChallenge {
  id: string;
  kind: string;
  userId: string | null;
  challenge: string;
  expiresAt: Date;
}

/** Store a challenge; also sweeps long-expired rows (cheap, indexed). */
export async function createChallenge(input: {
  kind: ChallengeKind;
  userId?: string | null;
  challenge: string;
  ttlMs: number;
  now?: Date;
}): Promise<StoredChallenge> {
  const now = input.now ?? new Date();
  await prisma.authChallenge
    .deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } })
    .catch(() => {});
  return prisma.authChallenge.create({
    data: {
      kind: input.kind,
      userId: input.userId ?? null,
      challenge: input.challenge,
      expiresAt: new Date(now.getTime() + input.ttlMs),
    },
    select: { id: true, kind: true, userId: true, challenge: true, expiresAt: true },
  });
}

/**
 * Consume a challenge exactly once. Returns it when it exists, matches kind
 * (and user, when given), is unexpired and was not used; null otherwise.
 * A consumed challenge stays consumed even if the caller's verification then
 * fails — a challenge is never reusable.
 */
export async function consumeChallenge(input: {
  id: string;
  kind: ChallengeKind;
  userId?: string | null;
  now?: Date;
}): Promise<StoredChallenge | null> {
  if (!input.id || typeof input.id !== "string") return null;
  const now = input.now ?? new Date();
  const where = {
    id: input.id,
    kind: input.kind,
    consumedAt: null,
    expiresAt: { gt: now },
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
  };
  const res = await prisma.authChallenge.updateMany({ where, data: { consumedAt: now } });
  if (res.count !== 1) return null;
  return prisma.authChallenge.findUnique({
    where: { id: input.id },
    select: { id: true, kind: true, userId: true, challenge: true, expiresAt: true },
  });
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Mint an enrollment proof for `userId`. Returns the "<id>.<secret>" string to hand the client once. */
export async function mintMfaProof(userId: string, method: "otp" | "passkey", now?: Date): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  const row = await createChallenge({
    kind: "mfa_proof",
    userId,
    challenge: `${method}:${sha256(secret)}`,
    ttlMs: MFA_PROOF_TTL_MS,
    now,
  });
  return `${row.id}.${secret}`;
}

/** Redeem an enrollment proof for `userId`. Returns the method it proves, or null. */
export async function redeemMfaProof(userId: string, proof: string, now?: Date): Promise<"otp" | "passkey" | null> {
  const dot = proof.indexOf(".");
  if (dot <= 0) return null;
  const id = proof.slice(0, dot);
  const secret = proof.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  const row = await consumeChallenge({ id, kind: "mfa_proof", userId, now });
  if (!row) return null;
  const [method, hash] = row.challenge.split(":");
  const a = Buffer.from(hash ?? "", "hex");
  const b = Buffer.from(sha256(secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return method === "passkey" ? "passkey" : "otp";
}
