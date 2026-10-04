// ShapesOS — Phase 6 email accounts against the database, as the
// least-privilege app role. DB-backed (scripts/test/db-tests.txt).
//
//   - signup under SIGNUP_MODE=invite is refused without an invite
//   - verify / sign-in / reset links are single use under concurrency
//   - an unverified account can't sign in with a password
//   - a second signup can't plant a password on an unverified address
//   - lockout after repeated wrong passwords
//   - a password reset invalidates every older link
//   - no enumeration: same answers for known and unknown addresses
//   - account deletion removes the account and its links; the GDPR export
//     includes the email record but never the hash
//
// Mail is captured through the deliver seam (a labelled fake; nothing is
// sent). Run: DATABASE_URL=… npx tsx --test lib/auth/email/__tests__/email-auth-db.test.ts

import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { __resetLoginAttempts } from "@/lib/auth/rate-limit";
import { InviteRequiredError } from "@/lib/auth/signup";
import {
  checkEmailPassword,
  consumeSignInLink,
  issueEmailToken,
  requestMagicLink,
  requestPasswordReset,
  resetPassword,
  signUpWithEmail,
  type FlowDeps,
} from "../store";
import { EMAIL_SEND_LIMIT, emailUserId, hashEmailToken } from "../tokens";
import { authorizeEmailLink, authorizeEmailPassword, EmailLockedError, EmailUnverifiedError } from "../authorize";
import { EmailAuthUnavailableError } from "../mail";

const RUN = randomUUID().slice(0, 8);
const DOMAIN = `p6auth-${RUN}.test`;
const WS = `p6-auth-ws-${RUN}`;
const addr = (local: string) => `${local}@${DOMAIN}`;

interface Captured {
  to: string;
  subject: string;
  text: string;
}
let outbox: Captured[] = [];

function deps(extra: Record<string, string> = {}): FlowDeps {
  return {
    env: { NODE_ENV: "test", APP_URL: "https://app.p6auth.test", ...extra } as unknown as NodeJS.ProcessEnv,
    // FAKE delivery (test seam): records the message instead of sending it.
    deliver: async (_via, msg) => {
      outbox.push({ to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

function lastToken(to: string): string {
  const mail = [...outbox].reverse().find((m) => m.to === to && /#token=/.test(m.text));
  assert.ok(mail, `a link was mailed to ${to}`);
  const m = mail!.text.match(/#token=([A-Za-z0-9_-]{43})/);
  assert.ok(m, "the mail carries a token");
  return m![1]!;
}

function req(ip = "203.0.113.50"): Request {
  return new Request("https://app.p6auth.test/api/auth/callback/email-password", { headers: { "x-forwarded-for": ip } });
}

const PW = "tangerine-orbit-42";
const PW2 = "lilac-harbour-77";

before(async () => {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${"p6-auth-owner-" + RUN}, now())`;
  await prisma.workspaceMember.create({
    data: {
      workspaceId: WS,
      email: addr("invitee"),
      role: "viewer",
      inviteToken: `p6-auth-invite-${RUN}`,
      inviteExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

beforeEach(() => {
  outbox = [];
  __resetLoginAttempts();
});

after(async () => {
  await prisma.emailAuthToken.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailAccount.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.userSecurity.deleteMany({ where: { userId: { startsWith: `email:` , endsWith: `@${DOMAIN}` } } });
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("signup", () => {
  it("SIGNUP_MODE=invite refuses an address without an invite, accepts an invitee", async () => {
    const d = deps({ SIGNUP_MODE: "invite" });
    await assert.rejects(
      () => signUpWithEmail({ email: addr("stranger"), password: PW, name: "Stranger", ip: null }, d),
      InviteRequiredError,
    );
    assert.equal(await prisma.emailAccount.count({ where: { email: addr("stranger") } }), 0);
    assert.equal(outbox.length, 0);

    const ok = await signUpWithEmail({ email: addr("INVITEE"), password: PW, name: "Invitee", ip: null }, d);
    assert.equal(ok.ok, true);
    const acct = await prisma.emailAccount.findUniqueOrThrow({ where: { email: addr("invitee") } });
    assert.equal(acct.userId, emailUserId(addr("invitee")));
    assert.equal(acct.emailVerifiedAt, null);
    assert.equal(outbox.length, 1);
    assert.match(outbox[0]!.subject, /Confirm your email/);
  });

  it("refuses weak passwords and bad input before anything is stored", async () => {
    await assert.rejects(() => signUpWithEmail({ email: addr("weak"), password: "password123", name: "W", ip: null }, deps()), /too common/);
    await assert.rejects(() => signUpWithEmail({ email: "nope", password: PW, name: "W", ip: null }, deps()), /valid email/);
    await assert.rejects(() => signUpWithEmail({ email: addr("weak"), password: PW, name: "  ", ip: null }, deps()), /name/);
    assert.equal(await prisma.emailAccount.count({ where: { email: addr("weak") } }), 0);
  });

  it("answers the same for a new, an unverified and a verified address", async () => {
    const a = await signUpWithEmail({ email: addr("same"), password: PW, name: "Same", ip: null }, deps());
    const b = await signUpWithEmail({ email: addr("same"), password: PW, name: "Same", ip: null }, deps());
    await consumeSignInLink(lastToken(addr("same")));
    const c = await signUpWithEmail({ email: addr("same"), password: PW2, name: "Other", ip: null }, deps());
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    // The verified owner gets a note, not a link, and the password is unchanged.
    assert.match(outbox.at(-1)!.subject, /already have/);
    assert.equal((await checkEmailPassword(addr("same"), PW)).status, "ok");
    assert.equal((await checkEmailPassword(addr("same"), PW2)).status, "invalid");
  });

  it("is off (503) in production without a mailer", async () => {
    await assert.rejects(
      () => signUpWithEmail({ email: addr("prod"), password: PW, name: "P", ip: null }, { env: { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv }),
      EmailAuthUnavailableError,
    );
  });
});

describe("verification", () => {
  it("an unverified account can't sign in with a password", async () => {
    await signUpWithEmail({ email: addr("unverified"), password: PW, name: "U", ip: null }, deps());
    assert.equal((await checkEmailPassword(addr("unverified"), PW)).status, "unverified");
    await assert.rejects(() => authorizeEmailPassword({ email: addr("unverified"), password: PW }, req()), EmailUnverifiedError);
    // The wrong password says nothing about verification.
    assert.equal((await checkEmailPassword(addr("unverified"), PW2)).status, "invalid");
  });

  it("a verify link is single use under concurrency, then the password works", async () => {
    await signUpWithEmail({ email: addr("verify"), password: PW, name: "V", ip: null }, deps());
    const token = lastToken(addr("verify"));
    const results = await Promise.all(Array.from({ length: 6 }, () => consumeSignInLink(token)));
    assert.equal(results.filter((r) => r.status === "ok").length, 1, "exactly one use wins");
    assert.equal(results.filter((r) => r.status === "invalid").length, 5);
    const acct = await prisma.emailAccount.findUniqueOrThrow({ where: { email: addr("verify") } });
    assert.ok(acct.emailVerifiedAt);
    assert.equal((await checkEmailPassword(addr("verify"), PW)).status, "ok");
    const user = await authorizeEmailPassword({ email: addr("verify"), password: PW }, req());
    assert.equal(user?.id, emailUserId(addr("verify")));
  });

  it("a second signup can't plant its password on an unverified address", async () => {
    await signUpWithEmail({ email: addr("plant"), password: PW, name: "Owner", ip: null }, deps());
    const ownersLink = lastToken(addr("plant"));
    await signUpWithEmail({ email: addr("plant"), password: PW2, name: "Attacker", ip: null }, deps());
    const attackersLink = lastToken(addr("plant"));
    assert.notEqual(ownersLink, attackersLink);
    assert.equal((await consumeSignInLink(ownersLink)).status, "ok");
    assert.equal((await checkEmailPassword(addr("plant"), PW)).status, "ok");
    assert.equal((await checkEmailPassword(addr("plant"), PW2)).status, "invalid");
    // The other pending verify link was voided.
    assert.equal((await consumeSignInLink(attackersLink)).status, "invalid");
  });

  it("a magic link that verifies an account clears its never-proven password", async () => {
    await signUpWithEmail({ email: addr("cleared"), password: PW2, name: "Someone", ip: null }, deps());
    await requestMagicLink({ email: addr("cleared"), ip: null }, deps());
    assert.equal((await consumeSignInLink(lastToken(addr("cleared")))).status, "ok");
    const acct = await prisma.emailAccount.findUniqueOrThrow({ where: { email: addr("cleared") } });
    assert.ok(acct.emailVerifiedAt);
    assert.equal(acct.passwordHash, null);
    assert.equal((await checkEmailPassword(addr("cleared"), PW2)).status, "invalid");
  });

  it("expired links don't work", async () => {
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("expired")), email: addr("expired"), emailVerifiedAt: new Date() } });
    const token = await issueEmailToken({ email: addr("expired"), purpose: "login", now: new Date(Date.now() - 16 * 60_000) });
    assert.equal((await consumeSignInLink(token)).status, "invalid");
  });
});

describe("magic links", () => {
  it("always answers the same; sign-in links are single use under concurrency", async () => {
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("magic")), email: addr("magic"), name: "M", emailVerifiedAt: new Date() } });
    const known = await requestMagicLink({ email: addr("magic"), ip: null }, deps());
    const unknownInvite = await requestMagicLink({ email: addr("nobody"), ip: null }, deps({ SIGNUP_MODE: "invite" }));
    assert.deepEqual(known, unknownInvite);
    // Invite-only + no invite: nothing is sent and nothing is created.
    assert.equal(outbox.filter((m) => m.to === addr("nobody")).length, 0);
    assert.equal(await prisma.emailAccount.count({ where: { email: addr("nobody") } }), 0);

    const token = lastToken(addr("magic"));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => authorizeEmailLink({ token }, req(`198.51.100.${i + 1}`)).then((u) => u, () => null)),
    );
    const winners = results.filter((u) => u?.id === emailUserId(addr("magic")));
    assert.equal(winners.length, 1, "exactly one sign-in");
  });

  it("open signup: the link creates a verified account on first use, not on request", async () => {
    await requestMagicLink({ email: addr("newbie"), ip: null }, deps());
    assert.equal(await prisma.emailAccount.count({ where: { email: addr("newbie") } }), 0, "typing an address creates nothing");
    assert.match(outbox.at(-1)!.subject, /Finish signing up/);
    const res = await consumeSignInLink(lastToken(addr("newbie")), { env: { SIGNUP_MODE: "open" } as unknown as NodeJS.ProcessEnv });
    assert.equal(res.status, "ok");
    const acct = await prisma.emailAccount.findUniqueOrThrow({ where: { email: addr("newbie") } });
    assert.ok(acct.emailVerifiedAt);
    assert.equal(acct.passwordHash, null);
  });

  it("caps links per address", async () => {
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("flood")), email: addr("flood"), emailVerifiedAt: new Date() } });
    for (let i = 0; i < EMAIL_SEND_LIMIT + 3; i++) await requestMagicLink({ email: addr("flood"), ip: null }, deps());
    assert.equal(outbox.filter((m) => m.to === addr("flood")).length, EMAIL_SEND_LIMIT);
  });

  it("stores only token hashes", async () => {
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("hash")), email: addr("hash"), emailVerifiedAt: new Date() } });
    await requestMagicLink({ email: addr("hash"), ip: null }, deps());
    const token = lastToken(addr("hash"));
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM email_auth_tokens WHERE email = ${addr("hash")} AND (token_hash = ${token} OR token_hash = ${hashEmailToken(token)})`;
    assert.equal(Number(rows[0]!.n), 1);
    const raw = await prisma.emailAuthToken.findFirstOrThrow({ where: { email: addr("hash") } });
    assert.equal(raw.tokenHash, hashEmailToken(token));
  });
});

describe("password sign-in lockout", () => {
  it("locks the address after repeated wrong passwords (even the right one is then refused)", async () => {
    await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" LIKE 'login:%'`;
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("lock")), email: addr("lock"), emailVerifiedAt: new Date() } });
    await resetPasswordDirect(addr("lock"), PW);
    for (let i = 0; i < 5; i++) {
      assert.equal(await authorizeEmailPassword({ email: addr("lock"), password: "wrong-password-" + i }, req(`192.0.2.${i + 1}`)), null);
    }
    await assert.rejects(() => authorizeEmailPassword({ email: addr("lock"), password: PW }, req("192.0.2.99")), EmailLockedError);
    // The lockout is shared in Postgres (Phase 6, rate_limit_buckets): clear
    // both the in-memory and the shared counters to simulate it expiring.
    __resetLoginAttempts();
    await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" LIKE 'login:%'`;
    const user = await authorizeEmailPassword({ email: addr("lock"), password: PW }, req("192.0.2.99"));
    assert.equal(user?.id, emailUserId(addr("lock")));
  });
});

/** Set a password through the real reset flow. */
async function resetPasswordDirect(email: string, password: string) {
  await requestPasswordReset({ email, ip: null }, deps());
  await resetPassword({ token: lastToken(email), password, ip: null }, deps());
}

describe("password reset", () => {
  it("always answers the same; reset invalidates every older link; single use under concurrency", async () => {
    await signUpWithEmail({ email: addr("reset"), password: PW, name: "R", ip: null }, deps());
    await consumeSignInLink(lastToken(addr("reset")));
    const known = await requestPasswordReset({ email: addr("reset"), ip: null }, deps());
    const unknown = await requestPasswordReset({ email: addr("ghost"), ip: null }, deps());
    assert.deepEqual(known, unknown);
    assert.equal(outbox.filter((m) => m.to === addr("ghost")).length, 0);

    const firstReset = lastToken(addr("reset"));
    await requestMagicLink({ email: addr("reset"), ip: null }, deps());
    const loginLink = lastToken(addr("reset"));
    await requestPasswordReset({ email: addr("reset"), ip: null }, deps());
    const secondReset = lastToken(addr("reset"));

    // A weak password doesn't burn the link.
    await assert.rejects(() => resetPassword({ token: secondReset, password: "short", ip: null }, deps()), /at least/);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => resetPassword({ token: secondReset, password: PW2, ip: null }, deps())),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one reset wins");

    assert.equal((await checkEmailPassword(addr("reset"), PW2)).status, "ok");
    assert.equal((await checkEmailPassword(addr("reset"), PW)).status, "invalid");
    await assert.rejects(() => resetPassword({ token: firstReset, password: "another-strong-one-9", ip: null }, deps()), /invalid or has expired/);
    assert.equal((await consumeSignInLink(loginLink)).status, "invalid");
    const open = await prisma.emailAuthToken.count({ where: { email: addr("reset"), usedAt: null } });
    assert.equal(open, 0, "no outstanding links");
  });

  it("a reset link can't be used to sign in, and a sign-in link can't reset", async () => {
    await prisma.emailAccount.create({ data: { userId: emailUserId(addr("cross")), email: addr("cross"), emailVerifiedAt: new Date() } });
    const reset = await issueEmailToken({ email: addr("cross"), purpose: "reset" });
    const login = await issueEmailToken({ email: addr("cross"), purpose: "login" });
    assert.equal((await consumeSignInLink(reset)).status, "invalid");
    await assert.rejects(() => resetPassword({ token: login, password: PW, ip: null }, deps()), /invalid/);
  });
});

describe("account deletion + export", () => {
  it("the export includes the email record without the hash; deletion removes the rows", async () => {
    const email = addr("delete");
    const userId = emailUserId(email);
    await signUpWithEmail({ email, password: PW, name: "Del", ip: null }, deps());
    await consumeSignInLink(lastToken(email));
    await requestMagicLink({ email, ip: null }, deps());

    const { userExport } = await import("@/lib/gdpr/user-export");
    let json = "";
    for await (const chunk of userExport({ id: userId, email, name: "Del" })) json += chunk;
    const data = JSON.parse(json) as { authored: Record<string, Array<Record<string, unknown>>> };
    const rows = data.authored.email_accounts;
    assert.ok(rows && rows.length === 1, "email record exported");
    assert.equal(rows[0]!.email, email);
    assert.ok(!("password_hash" in rows[0]!), "hash never exported");
    assert.ok(!json.includes("scrypt$"), "no hash anywhere in the export");
    assert.ok(!data.authored.email_auth_tokens, "links are not exported");

    const { deleteAccount } = await import("@/lib/gdpr/account-delete");
    await deleteAccount({ userId, email, confirm: email });
    assert.equal(await prisma.emailAccount.count({ where: { email } }), 0);
    assert.equal(await prisma.emailAuthToken.count({ where: { email } }), 0);
    // The deleted account can't sign in any more.
    assert.equal((await checkEmailPassword(email, PW)).status, "invalid");
    const tomb = await prisma.userSecurity.findUnique({ where: { userId } });
    assert.ok(tomb?.accountDeletedAt, "tombstone written");
  });
});
