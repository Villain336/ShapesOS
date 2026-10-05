// ShapesOS Phase 4a — DB test: two-factor + passkeys against real Postgres.
//   - TOTP secrets sealed at rest; enrollment confirm; replay protection
//     (incl. two concurrent uses of one code → exactly one wins)
//   - recovery codes hashed and single use
//   - auth challenges: single use, expiry, kind/user binding; enrollment proofs
//   - WebAuthn with a software authenticator: registration, usernameless
//     sign-in, challenge single use + expiry, user binding, counter
//   - the "two-factor" provider takes its subject from the session cookie and
//     ties wrong codes into the login lockout
//   - the workspace require-2FA policy at the session guard (getMembership)
// Run: DATABASE_URL=… npx tsx --test lib/auth/mfa/__tests__/mfa-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { encode } from "next-auth/jwt";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { prisma } from "@/lib/prisma";
import { totpCode } from "../totp";
import {
  confirmTotpEnrollment,
  consumeRecoveryCode,
  startTotpEnrollment,
  verifySecondFactorCode,
  verifyUserTotp,
  factorSummary,
} from "../store";
import { consumeChallenge, createChallenge, mintMfaProof, redeemMfaProof } from "../challenge";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../webauthn";
import { authorizeTwoFactor, SecondFactorLockedError } from "../authorize";
import { __resetLoginAttempts } from "@/lib/auth/rate-limit";

// The lockout is shared in Postgres (Phase 6, rate_limit_buckets) when
// DATABASE_URL is set, so a reset clears both stores.
async function resetLockouts(): Promise<void> {
  __resetLoginAttempts();
  await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" LIKE 'login:%'`;
}
import { __setSessionMfaStateForTests } from "../policy";
import { getMembership, requireWorkspaceRole } from "@/lib/authz";

const RUN = randomUUID().slice(0, 8);
const STARTED = new Date(Date.now() - 1000);
const U1 = `p4idn-u1-${RUN}`;
const U2 = `p4idn-u2-${RUN}`;
const U3 = `p4idn-u3-${RUN}`;
const WS = `p4idn-ws-${RUN}`;
const ORIGIN = "https://shapes.example.com";
const RP_ID = "shapes.example.com";
const AUTH_SECRET = "p4idn-auth-secret-0123456789abcdef0123456789";

before(async () => {
  process.env.MARKETR_CREDENTIALS_KEY = randomBytes(32).toString("hex");
  process.env.APP_URL = ORIGIN;
  process.env.AUTH_SECRET = AUTH_SECRET;
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: U1 } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: U1, role: "owner" },
      { workspaceId: WS, userId: U2, role: "editor" },
    ],
  });
});

after(async () => {
  __setSessionMfaStateForTests(undefined);
  const users = [U1, U2, U3];
  await prisma.userRecoveryCode.deleteMany({ where: { userId: { in: users } } });
  await prisma.userPasskey.deleteMany({ where: { userId: { in: users } } });
  await prisma.userSecurity.deleteMany({ where: { userId: { in: users } } });
  await prisma.authChallenge.deleteMany({ where: { userId: { in: users } } });
  // Usernameless sign-in challenges carry no user.
  await prisma.authChallenge.deleteMany({ where: { userId: null, createdAt: { gte: STARTED } } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A tiny software authenticator (ES256, "none" attestation).
// ---------------------------------------------------------------------------
const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

class SoftAuthenticator {
  readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credId = randomBytes(16);
  counter = 0;

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
      ]),
    );
  }

  register(challenge: string, origin = ORIGIN) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const cose = Buffer.from(this.cosePublicKey());
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, cose]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  assert(challenge: string, origin = ORIGIN) {
    this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), counter]);
    const signer = createSign("SHA256");
    signer.update(Buffer.concat([authData, sha256(clientDataJSON)]));
    const signature = signer.sign(this.keys.privateKey); // DER, as WebAuthn expects
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}

// ---------------------------------------------------------------------------

let secret = "";
let recoveryCodes: string[] = [];

describe("TOTP + recovery codes (DB)", () => {
  it("enrolls with the secret sealed at rest and confirms with a code", async () => {
    const started = await startTotpEnrollment(U1, { email: "u1@example.com", name: "U One" });
    secret = started.secret;
    const row = await prisma.userSecurity.findUniqueOrThrow({ where: { userId: U1 } });
    assert.ok(row.totpPendingEnc?.startsWith("v2:"), "pending secret is envelope-encrypted");
    assert.ok(!row.totpPendingEnc!.includes(secret));

    assert.deepEqual(await confirmTotpEnrollment(U1, "000000"), { ok: false, reason: "invalid" });
    const res = await confirmTotpEnrollment(U1, totpCode(secret));
    assert.equal(res.ok, true);
    recoveryCodes = res.ok ? res.recoveryCodes : [];
    assert.equal(recoveryCodes.length, 10);

    const after = await prisma.userSecurity.findUniqueOrThrow({ where: { userId: U1 } });
    assert.ok(after.totpEnabledAt);
    assert.ok(after.totpSecretEnc?.startsWith("v2:"));
    assert.equal(after.totpPendingEnc, null);
    const stored = await prisma.userRecoveryCode.findMany({ where: { userId: U1 } });
    assert.equal(stored.length, 10);
    for (const s of stored) assert.ok(!recoveryCodes.some((c) => s.codeHash.includes(c.replace(/-/g, ""))), "only hashes stored");
    assert.deepEqual(await factorSummary(U1), { totp: true, passkeys: 0 });
  });

  it("the code used to confirm enrollment can't be replayed at sign-in", async () => {
    assert.equal(await verifyUserTotp(U1, totpCode(secret)), false);
  });

  it("a fresh code works once; the same code again is a replay", async () => {
    const t = new Date(Date.now() + 30_000);
    const code = totpCode(secret, t.getTime());
    assert.equal(await verifyUserTotp(U1, code, t), true);
    assert.equal(await verifyUserTotp(U1, code, t), false);
  });

  it("two concurrent uses of one code: exactly one wins", async () => {
    const t = new Date(Date.now() + 60_000);
    const code = totpCode(secret, t.getTime());
    const results = await Promise.all([verifyUserTotp(U1, code, t), verifyUserTotp(U1, code, t), verifyUserTotp(U1, code, t)]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("recovery codes are single use", async () => {
    const [a, b] = recoveryCodes;
    assert.equal(await consumeRecoveryCode(U1, a), true);
    assert.equal(await consumeRecoveryCode(U1, a), false, "second use refused");
    assert.equal(await consumeRecoveryCode(U2, b), false, "another user can't use it");
    assert.equal(await verifySecondFactorCode(U1, b.toUpperCase()), "recovery");
    assert.equal(await verifySecondFactorCode(U1, b), null);
    assert.equal(await prisma.userRecoveryCode.count({ where: { userId: U1, usedAt: null } }), 8);
  });
});

describe("auth challenges (DB)", () => {
  it("single use, expiring, kind- and user-bound", async () => {
    const c = await createChallenge({ kind: "webauthn_auth", userId: U1, challenge: "abc", ttlMs: 60_000 });
    assert.equal(await consumeChallenge({ id: c.id, kind: "webauthn_reg" }), null, "wrong kind");
    assert.equal(await consumeChallenge({ id: c.id, kind: "webauthn_auth", userId: U2 }), null, "wrong user");
    assert.equal((await consumeChallenge({ id: c.id, kind: "webauthn_auth", userId: U1 }))?.challenge, "abc");
    assert.equal(await consumeChallenge({ id: c.id, kind: "webauthn_auth", userId: U1 }), null, "already used");

    const old = await createChallenge({ kind: "webauthn_auth", userId: U1, challenge: "x", ttlMs: 1_000, now: new Date(Date.now() - 5_000) });
    assert.equal(await consumeChallenge({ id: old.id, kind: "webauthn_auth" }), null, "expired");
  });

  it("enrollment proofs redeem once, for their own user only", async () => {
    const proof = await mintMfaProof(U1, "otp");
    assert.equal(await redeemMfaProof(U2, proof), null);
    // A wrong-user attempt doesn't burn it (the user binding is in the WHERE).
    assert.equal(await redeemMfaProof(U1, proof), "otp");
    assert.equal(await redeemMfaProof(U1, proof), null);
    const p2 = await mintMfaProof(U1, "passkey");
    const tampered = p2.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
    assert.equal(await redeemMfaProof(U1, tampered), null);
  });
});

describe("passkeys (DB, software authenticator)", () => {
  const auth = new SoftAuthenticator();

  it("registers a passkey (challenge single use)", async () => {
    const { challengeId, options } = await passkeyRegistrationOptions(U2, { email: "u2@example.com", name: "U Two" });
    assert.equal(options.rp.id, RP_ID);
    assert.equal(options.authenticatorSelection?.userVerification, "required");
    const response = auth.register(options.challenge);
    const res = await verifyPasskeyRegistration({
      userId: U2,
      challengeId,
      response: response as never,
      name: "Laptop",
      profile: { email: "u2@example.com", name: "U Two" },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const again = await verifyPasskeyRegistration({
      userId: U2,
      challengeId,
      response: response as never,
      name: "Laptop",
      profile: {},
    });
    assert.deepEqual(again, { ok: false, reason: "challenge" });
    assert.deepEqual(await factorSummary(U2), { totp: false, passkeys: 1 });
  });

  it("a registration challenge for one user can't register for another", async () => {
    const { challengeId, options } = await passkeyRegistrationOptions(U2, { email: "u2@example.com" });
    const other = new SoftAuthenticator();
    const res = await verifyPasskeyRegistration({ userId: U1, challengeId, response: other.register(options.challenge) as never, name: "x", profile: {} });
    assert.deepEqual(res, { ok: false, reason: "challenge" });
  });

  it("usernameless sign-in verifies, bumps the counter, and the challenge is single use", async () => {
    const { challengeId, options } = await passkeyAuthenticationOptions(null);
    assert.equal(options.allowCredentials?.length ?? 0, 0, "usernameless: no allow-list");
    const assertion = auth.assert(options.challenge);
    const ok = await verifyPasskeyAuthentication({ challengeId, response: assertion as never });
    assert.equal(ok?.userId, U2);
    assert.equal(ok?.email, "u2@example.com");
    const row = await prisma.userPasskey.findFirstOrThrow({ where: { userId: U2 } });
    assert.equal(Number(row.counter), auth.counter);
    assert.ok(row.lastUsedAt);
    // Replaying the same signed assertion: the challenge is spent.
    assert.equal(await verifyPasskeyAuthentication({ challengeId, response: assertion as never }), null);
  });

  it("an expired challenge never verifies", async () => {
    const { challengeId, options } = await passkeyAuthenticationOptions(null);
    await prisma.authChallenge.update({ where: { id: challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await verifyPasskeyAuthentication({ challengeId, response: auth.assert(options.challenge) as never }), null);
  });

  it("a challenge bound to one user can't be answered with another user's passkey", async () => {
    const { challengeId, options } = await passkeyAuthenticationOptions(U1);
    assert.equal(await verifyPasskeyAuthentication({ challengeId, response: auth.assert(options.challenge) as never }), null);
  });

  it("a signature over a different challenge or origin fails", async () => {
    const a = await passkeyAuthenticationOptions(null);
    assert.equal(await verifyPasskeyAuthentication({ challengeId: a.challengeId, response: auth.assert("bm90LXRoaXMtb25l") as never }), null);
    const b = await passkeyAuthenticationOptions(null);
    assert.equal(
      await verifyPasskeyAuthentication({ challengeId: b.challengeId, response: auth.assert(b.options.challenge, "https://evil.example") as never }),
      null,
    );
  });
});

describe("two-factor provider (DB)", () => {
  const cookie = async (token: Record<string, unknown>) =>
    `authjs.session-token=${await encode({ token, secret: AUTH_SECRET, salt: "authjs.session-token" })}`;
  const request = (c?: string) =>
    new Request("http://localhost:3000/api/auth/callback/two-factor", {
      method: "POST",
      headers: { ...(c ? { cookie: c } : {}), "x-forwarded-for": "198.51.100.7" },
    });

  it("completes a pending sign-in with a code; the subject comes from the cookie", async () => {
    await resetLockouts();
    // Fresh enrollment so the next step's code is inside the ±1 window.
    const s3 = (await startTotpEnrollment(U3, { email: "u3@example.com" })).secret;
    assert.equal((await confirmTotpEnrollment(U3, totpCode(s3))).ok, true);
    const now = Math.floor(Date.now() / 1000);
    const c = await cookie({ mfaPendingSub: U3, mfaPendingExp: now + 300, email: "u3@example.com", amr: ["pwd"] });
    const code = totpCode(s3, Date.now() + 30_000);
    // A subject in the form is ignored: only the cookie names the user.
    const user = await authorizeTwoFactor({ code, userId: U2 }, request(c));
    assert.ok(user, "next-step code completes the pending sign-in");
    assert.equal(user.id, U3);
    assert.equal(user.email, "u3@example.com");
    assert.equal(user.mfa.secondFactor, "otp");
    assert.equal(user.mfa.firstFactor, "pwd");
    // The same code can't complete a second sign-in.
    assert.equal(await authorizeTwoFactor({ code }, request(c)), null);

    const c1 = await cookie({ mfaPendingSub: U1, mfaPendingExp: now + 300 });
    const viaRecovery = await authorizeTwoFactor({ code: recoveryCodes[5] }, request(c1));
    assert.equal(viaRecovery?.id, U1);
    assert.equal(viaRecovery?.mfa.secondFactor, "recovery");
    // An expired pending token can't be completed.
    const stale = await cookie({ mfaPendingSub: U1, mfaPendingExp: now - 1 });
    assert.equal(await authorizeTwoFactor({ code: recoveryCodes[8] }, request(stale)), null);
  });

  it("no session cookie → nothing to complete", async () => {
    assert.equal(await authorizeTwoFactor({ code: recoveryCodes[6] }, request()), null);
  });

  it("wrong codes trip the shared login lockout", async () => {
    await resetLockouts();
    const now = Math.floor(Date.now() / 1000);
    const c = await cookie({ mfaPendingSub: U1, mfaPendingExp: now + 300 });
    for (let i = 0; i < 5; i++) assert.equal(await authorizeTwoFactor({ code: "000000" }, request(c)), null);
    await assert.rejects(() => authorizeTwoFactor({ code: recoveryCodes[7] }, request(c)), SecondFactorLockedError);
    await resetLockouts();
  });
});

describe("workspace require-2FA policy at the session guard (DB)", () => {
  it("off: membership resolves as before", async () => {
    __setSessionMfaStateForTests({ userId: U2, twoFactor: false });
    assert.equal((await getMembership(U2, WS))?.role, "editor");
  });

  it("on: the member's session without a second factor is denied; with one it passes", async () => {
    await prisma.workspace.update({ where: { id: WS }, data: { requireTwoFactor: true } });
    __setSessionMfaStateForTests({ userId: U2, twoFactor: false });
    assert.equal(await getMembership(U2, WS), null);
    assert.equal(await requireWorkspaceRole(U2, WS, "viewer"), null);
    __setSessionMfaStateForTests({ userId: U2, twoFactor: true });
    assert.equal((await requireWorkspaceRole(U2, WS, "editor"))?.role, "editor");
    // No browser session for this person (MCP key / cron path): not applied.
    __setSessionMfaStateForTests(null);
    assert.equal((await getMembership(U2, WS))?.role, "editor");
    __setSessionMfaStateForTests(undefined);
    await prisma.workspace.update({ where: { id: WS }, data: { requireTwoFactor: false } });
  });
});
