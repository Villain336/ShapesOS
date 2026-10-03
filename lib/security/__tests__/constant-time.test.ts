// ShapesOS — Phase 1: constant-time secret compares + auth before body
// validation on the scheduler event endpoint.
// Unit (no DB): the session is stubbed (signed out) with node:test
// mock.module (scripts/test/run.mjs passes the flag).

import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { bearerMatches, safeEqual } from "../constant-time";

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => null,
    getOrCreateWorkspace: async () => {
      throw new Error("no session in this test");
    },
  },
});

describe("safeEqual / bearerMatches", () => {
  it("equality semantics", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", ""), true);
  });

  it("bearer header must match exactly; an unset secret never matches", () => {
    assert.equal(bearerMatches("Bearer s3cret", "s3cret"), true);
    assert.equal(bearerMatches("Bearer s3cret", " s3cret "), true);
    assert.equal(bearerMatches("Bearer s3cre", "s3cret"), false);
    assert.equal(bearerMatches("bearer s3cret", "s3cret"), false);
    assert.equal(bearerMatches("Bearer ", ""), false);
    assert.equal(bearerMatches("Bearer undefined", undefined), false);
    assert.equal(bearerMatches(null, "s3cret"), false);
  });

  it("the audited routes no longer compare secrets with ===", () => {
    for (const f of [
      "lib/cron/gate.ts",
      "app/api/scheduler/events/route.ts",
      "app/api/calls/reminders/run/route.ts",
      "app/api/cron/alerts/route.ts",
      "app/api/cron/reports/route.ts",
      "app/api/cron/fix-agent/route.ts",
      "app/api/rankings/check/route.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /===\s*`Bearer/, f);
      assert.match(src, /bearerMatches\(/, f);
    }
  });
});

describe("cron + scheduler + reminders gates", () => {
  const prev = { CRON_SECRET: process.env.CRON_SECRET, REMINDERS_CRON_SECRET: process.env.REMINDERS_CRON_SECRET };
  before(() => {
    process.env.CRON_SECRET = "cron-secret-value";
    process.env.REMINDERS_CRON_SECRET = "reminders-secret-value";
  });
  after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const req = (auth: string | null, body?: unknown) =>
    new Request("http://x/api", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("cronGate: right secret passes, near-miss and missing are 401", async () => {
    const { cronGate } = await import("@/lib/cron/gate");
    const okGate = await cronGate(req("Bearer cron-secret-value"));
    assert.ok(!(okGate instanceof Response) && okGate.isCron);
    for (const h of ["Bearer cron-secret-valuE", "Bearer cron-secret-valu", null]) {
      const r = await cronGate(req(h));
      assert.ok(r instanceof Response);
      assert.equal(r.status, 401);
    }
  });

  it("scheduler/events: an anonymous invalid body gets 401, not a schema error", async () => {
    const route = await import("@/app/api/scheduler/events/route");
    let r = (await route.POST(req(null, { nonsense: true }) as unknown as NextRequest))!;
    assert.equal(r.status, 401);
    const text = await r.text();
    assert.doesNotMatch(text, /source|payload|issues/);
    r = (await route.POST(req("Bearer wrong", { nonsense: true }) as unknown as NextRequest))!;
    assert.equal(r.status, 401);
    // Authenticated service call with a bad body: now validation runs.
    r = (await route.POST(req("Bearer cron-secret-value", { nonsense: true }) as unknown as NextRequest))!;
    assert.equal(r.status, 400);
  });

  it("calls/reminders/run: wrong bearer is 401", async () => {
    const route = await import("@/app/api/calls/reminders/run/route");
    const r = await route.POST(req("Bearer reminders-secret-valuX"));
    assert.equal(r.status, 401);
  });
});
