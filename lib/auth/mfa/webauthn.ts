// ShapesOS — passkeys (WebAuthn) via @simplewebauthn/server (Phase 4a).
//
// Relying party: rpID = hostname of the app's public URL, origin = its
// origin. Resolved from APP_URL, then AUTH_URL, then NEXTAUTH_URL; in
// production with none of them set, passkeys fail closed (an rpID guessed
// from request headers could be steered by a spoofed Host). Dev falls back
// to http://localhost:3000.
//
// Challenges live server-side (auth_challenges), expire after 5 minutes and
// are consumed BEFORE verification, so each one is good for exactly one
// attempt. User verification (PIN/biometric) is required on every ceremony,
// which is what lets a passkey stand in for password + second factor.

import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { WEBAUTHN_CHALLENGE_TTL_MS, consumeChallenge, createChallenge } from "./challenge";

export const RP_NAME = "ShapesOS";
export const MAX_PASSKEYS_PER_USER = 20;

export interface RelyingParty {
  rpID: string;
  origin: string;
}

/** rpID/origin from APP_URL → AUTH_URL → NEXTAUTH_URL (see header). */
export function relyingParty(env: NodeJS.ProcessEnv = process.env): RelyingParty {
  const raw = [env.APP_URL, env.AUTH_URL, env.NEXTAUTH_URL].map((v) => (v ?? "").trim()).find(Boolean);
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("Passkeys need APP_URL (or AUTH_URL) set to the app's public URL.");
    }
    return { rpID: "localhost", origin: "http://localhost:3000" };
  }
  const url = new URL(raw);
  return { rpID: url.hostname, origin: url.origin };
}

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/** The user's stable WebAuthn user handle (random, never PII), created on first use. */
async function userHandle(userId: string, profile: { email?: string | null; name?: string | null }): Promise<Uint8Array> {
  const existing = await prisma.userSecurity.findUnique({ where: { userId }, select: { webauthnUserHandle: true } });
  if (existing?.webauthnUserHandle) return new Uint8Array(Buffer.from(existing.webauthnUserHandle, "base64url"));
  const handle = b64url(randomBytes(32));
  await prisma.userSecurity.upsert({
    where: { userId },
    create: { userId, email: profile.email ?? null, name: profile.name ?? null, webauthnUserHandle: handle },
    update: { webauthnUserHandle: handle },
  });
  return new Uint8Array(Buffer.from(handle, "base64url"));
}

export async function passkeyRegistrationOptions(
  userId: string,
  profile: { email?: string | null; name?: string | null },
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const rp = relyingParty();
  const existing = await prisma.userPasskey.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });
  if (existing.length >= MAX_PASSKEYS_PER_USER) throw new Error("Passkey limit reached");
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: profile.email || profile.name || userId,
    userDisplayName: profile.name || profile.email || "",
    userID: (await userHandle(userId, profile)) as Parameters<typeof generateRegistrationOptions>[0]["userID"],
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  const row = await createChallenge({
    kind: "webauthn_reg",
    userId,
    challenge: options.challenge,
    ttlMs: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  return { challengeId: row.id, options };
}

export type PasskeyRegistrationResult =
  | { ok: true; passkey: { id: string; name: string; createdAt: Date } }
  | { ok: false; reason: "challenge" | "verification" | "duplicate" };

export async function verifyPasskeyRegistration(input: {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
  profile: { email?: string | null; name?: string | null };
}): Promise<PasskeyRegistrationResult> {
  const challenge = await consumeChallenge({ id: input.challengeId, kind: "webauthn_reg", userId: input.userId });
  if (!challenge) return { ok: false, reason: "challenge" };
  const rp = relyingParty();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: "verification" };
  }
  if (!verification.verified) return { ok: false, reason: "verification" };
  const info = verification.registrationInfo;
  const dup = await prisma.userPasskey.findUnique({ where: { credentialId: info.credential.id }, select: { id: true } });
  if (dup) return { ok: false, reason: "duplicate" };
  const row = await prisma.userPasskey.create({
    data: {
      userId: input.userId,
      email: input.profile.email ?? null,
      userName: input.profile.name ?? null,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: BigInt(info.credential.counter),
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid,
      name: input.name,
    },
    select: { id: true, name: true, createdAt: true },
  });
  return { ok: true, passkey: row };
}

/**
 * Sign-in / re-auth options. With `userId`, only that user's credentials are
 * allowed (second factor, re-auth); without, the browser offers any
 * discoverable passkey for this site (usernameless sign-in).
 */
export async function passkeyAuthenticationOptions(
  userId?: string | null,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const rp = relyingParty();
  const allow = userId
    ? await prisma.userPasskey.findMany({ where: { userId }, select: { credentialId: true, transports: true } })
    : [];
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
    allowCredentials: allow.map((c) => ({ id: c.credentialId, transports: c.transports })),
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  const row = await createChallenge({
    kind: "webauthn_auth",
    userId: userId ?? null,
    challenge: options.challenge,
    ttlMs: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  return { challengeId: row.id, options };
}

export interface VerifiedPasskey {
  id: string;
  userId: string;
  email: string | null;
  userName: string | null;
}

/** Verify a sign-in assertion. Returns the passkey's owner, or null. */
export async function verifyPasskeyAuthentication(input: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<VerifiedPasskey | null> {
  // Consume first: the challenge is spent whatever happens next.
  const challenge = await consumeChallenge({ id: input.challengeId, kind: "webauthn_auth" });
  if (!challenge) return null;
  const credentialId = typeof input.response?.id === "string" ? input.response.id : "";
  if (!credentialId) return null;
  const passkey = await prisma.userPasskey.findUnique({ where: { credentialId } });
  if (!passkey) return null;
  // A challenge issued for one user's credentials can't sign in another user.
  if (challenge.userId && challenge.userId !== passkey.userId) return null;
  const rp = relyingParty();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey) as Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["publicKey"],
        counter: Number(passkey.counter),
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  await prisma.userPasskey.update({
    where: { id: passkey.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
  });
  return { id: passkey.id, userId: passkey.userId, email: passkey.email, userName: passkey.userName };
}
