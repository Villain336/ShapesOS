// ShapesOS — Phase 1: media approval OTP hardening.
//   crypto.randomInt codes, attempt limit, bound to approval + approver,
//   single-use, and never returned by the mint route.
// Unit (no DB): the route's session guard and approval store are stubbed with
// node:test mock.module (scripts/test/run.mjs passes the flag).

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";
import { OTP_MAX_ATTEMPTS, OtpChallengeStore } from "../safety";
import { deliverApprovalOtp } from "../otp";

const BIND = { approvalId: "appr_1", approverId: "user_owner" };

describe("OtpChallengeStore", () => {
  it("6-digit codes from crypto, never Math.random", () => {
    const orig = Math.random;
    Math.random = () => {
      throw new Error("Math.random used");
    };
    try {
      const store = new OtpChallengeStore();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const { code } = store.mint(BIND);
        assert.match(code, /^\d{6}$/);
        codes.add(code);
      }
      assert.ok(codes.size > 40);
    } finally {
      Math.random = orig;
    }
  });

  it("is bound to the approval AND the approver", () => {
    const store = new OtpChallengeStore();
    const { challengeId, code } = store.mint(BIND);
    assert.equal(store.verify(challengeId, code, { ...BIND, approvalId: "appr_other" }), false);
    assert.equal(store.verify(challengeId, code, { ...BIND, approverId: "user_other" }), false);
    assert.equal(store.verify(challengeId, code, BIND), true);
  });

  it("single-use", () => {
    const store = new OtpChallengeStore();
    const { challengeId, code } = store.mint(BIND);
    assert.equal(store.verify(challengeId, code, BIND), true);
    assert.equal(store.verify(challengeId, code, BIND), false);
  });

  it(`burns the challenge after ${OTP_MAX_ATTEMPTS} wrong guesses`, () => {
    const store = new OtpChallengeStore();
    const { challengeId, code } = store.mint(BIND);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) assert.equal(store.verify(challengeId, wrong, BIND), false);
    assert.equal(store.verify(challengeId, code, BIND), false);
  });

  it("a few wrong guesses below the limit still allow the right code", () => {
    const store = new OtpChallengeStore();
    const { challengeId, code } = store.mint(BIND);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) store.verify(challengeId, wrong, BIND);
    assert.equal(store.verify(challengeId, code, BIND), true);
  });

  it("expires", () => {
    const store = new OtpChallengeStore();
    const { challengeId, code, expiresAt } = store.mint(BIND, 10);
    assert.equal(store.verify(challengeId, code, BIND, new Date(expiresAt.getTime() + 1)), false);
  });
});

describe("deliverApprovalOtp", () => {
  it("production without SMTP fails closed", async () => {
    const r = await deliverApprovalOtp({
      to: "o@x.test",
      code: "123456",
      approvalId: "a",
      expiresAt: new Date(Date.now() + 600_000),
      env: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    });
    assert.equal(r.ok, false);
  });
});

describe("POST /api/media/approvals/:id/otp never returns the code", () => {
  const infos: string[] = [];
  const origInfo = console.info;
  console.info = (...args: unknown[]) => {
    infos.push(args.map(String).join(" "));
  };
  after(() => {
    console.info = origInfo;
  });

  mock.module("@/app/api/media/_lib", {
    namedExports: {
      mediaGuard: async () => ({ userId: "user_owner", email: "o@x.test", workspaceId: "ws", mediaRole: "owner" }),
      requireMediaOwner: () => null,
      safetyError: (e: unknown) => Response.json({ error: String(e) }, { status: 422 }),
    },
  });
  mock.module("@/lib/media/db", {
    namedExports: {
      safetyTablesReady: async () => true,
      mediaStores: () => ({
        approvals: {
          get: async (id: string, ws: string) => (id === "appr_1" && ws === "ws" ? { id, status: "pending" } : null),
        },
      }),
    },
  });

  it("response has no code; the delivered code verifies only for this approval + approver", async () => {
    const prevEnv = { SMTP_HOST: process.env.SMTP_HOST, NODE_ENV: process.env.NODE_ENV };
    delete process.env.SMTP_HOST;
    const route = await import("@/app/api/media/approvals/[id]/otp/route");
    const { otpChallenges } = await import("@/lib/media/otp");
    const res = await route.POST(new Request("http://x", { method: "POST" }) as never, {
      params: Promise.resolve({ id: "appr_1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["challengeId", "delivery", "expiresAt"]);
    assert.equal(body.delivery, "dev-console");
    const line = infos.find((l) => l.includes("appr_1"));
    const code = /code (\d{6})/.exec(line ?? "")?.[1];
    assert.ok(code, "dev delivery printed the code server-side");
    assert.equal(JSON.stringify(body).includes(code!), false);
    assert.equal(otpChallenges.verify(String(body.challengeId), code!, { approvalId: "appr_1", approverId: "someone" }), false);
    assert.equal(otpChallenges.verify(String(body.challengeId), code!, { approvalId: "appr_1", approverId: "user_owner" }), true);

    const missing = await route.POST(new Request("http://x", { method: "POST" }) as never, {
      params: Promise.resolve({ id: "appr_nope" }),
    });
    assert.equal(missing.status, 404);
    if (prevEnv.SMTP_HOST !== undefined) process.env.SMTP_HOST = prevEnv.SMTP_HOST;
  });
});
