// ShapesOS — Phase 15.3 pricing: the plan gates on real Postgres, as the
// least-privilege app role.
//   - digital twin: refused on Starter (no feature), refused past Pro's 3
//     sites, allowed on Business, trial and self-hosted past 3;
//   - payroll / POS: creation refused on Starter, allowed on Pro, trial and
//     self-hosted; computing a pay run is refused after a downgrade;
//   - SCIM: the token route refuses a plan without SCIM (Pro) and allows
//     Business; a valid token stops authenticating after a downgrade.
// Session stubbed with node:test mock.module (scripts/test/run.mjs passes
// --experimental-test-module-mocks).
// Run: DATABASE_URL=<app role url> npx tsx --test --experimental-test-module-mocks \
//        lib/billing/__tests__/plan-gates-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { opsCreate, opsEntityDef, type OpsActor } from "@/lib/ops/doctype";
import { EntitlementError } from "@/lib/billing/entitlements";
import { TWIN_SITE_LIMITS } from "@/lib/billing/entitlements";

const PREFIX = "p153gates";
const WS = {
  starter: `${PREFIX}-starter`,
  pro: `${PREFIX}-pro`,
  business: `${PREFIX}-business`,
  trial: `${PREFIX}-trial`,
  self_hosted: `${PREFIX}-self`,
} as const;
const OWNER = `${PREFIX}-owner`;
let sessionWs: string = WS.pro;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: OWNER, email: "owner@gates.test", name: "Owner" }),
    getOrCreateWorkspace: async () => ({ id: sessionWs, name: sessionWs }),
  },
});

const actor = (ws: string): OpsActor => ({ workspaceId: ws, userId: OWNER });

async function create(ws: string, slug: string, body: Record<string, unknown>) {
  const r = await withWorkspaceScope(ws, (tx) => opsCreate(tx, opsEntityDef(slug), actor(ws), body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

const upgrade = (entitlement: string) => (e: unknown) =>
  e instanceof EntitlementError && e.status === 403 && e.entitlement === entitlement && /Upgrade/.test(e.message);

let seq = 0;
async function newSite(ws: string) {
  seq += 1;
  const wh = String((await create(ws, "warehouses", { name: `W${seq}`, code: `GW-${seq}` })).id);
  return create(ws, "twin-sites", { kind: "warehouse", name: `Site ${seq}`, code: `GS-${seq}`, gridW: 10, gridD: 10, warehouseId: wh });
}

// ops_* tables are FORCE RLS: count inside the workspace scope.
const siteCount = (ws: string) => withWorkspaceScope(ws, (tx) => tx.opsSite.count({ where: { workspaceId: ws } }));
const warehouseCount = (ws: string) => withWorkspaceScope(ws, (tx) => tx.opsWarehouse.count({ where: { workspaceId: ws } }));

async function setPlan(ws: string, plan: Plan) {
  await prisma.workspace.update({ where: { id: ws }, data: { plan } });
}

before(async () => {
  for (const [plan, id] of Object.entries(WS)) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, plan, updated_at)
      VALUES (${id}, ${id}, ${OWNER}, ${plan}::"Plan", now())`;
    await prisma.workspaceMember.create({ data: { workspaceId: id, userId: OWNER, role: "owner", email: "owner@gates.test" } });
  }
});

after(async () => {
  for (const id of Object.values(WS)) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`.catch(() => {});
  }
  await prisma.$disconnect();
});

describe("digital twin gate", () => {
  it("Starter has no digital twin: creating a site is refused with an upgrade message", async () => {
    const wh = String((await create(WS.starter, "warehouses", { name: "S", code: "GW-S" })).id);
    await assert.rejects(
      withWorkspaceScope(WS.starter, (tx) =>
        opsCreate(tx, opsEntityDef("twin-sites"), actor(WS.starter), { kind: "warehouse", name: "S", code: "GS-S", gridW: 10, gridD: 10, warehouseId: wh }),
      ),
      upgrade("digital_twin"),
    );
    assert.equal(await siteCount(WS.starter), 0);
    assert.equal(await warehouseCount(WS.starter), 1, "scoped counts see this workspace's rows");
  });

  it("Pro: up to its limit, then refused past it (upgrade to Business)", async () => {
    const max = TWIN_SITE_LIMITS.pro;
    assert.equal(max, 3);
    for (let i = 0; i < max; i++) await newSite(WS.pro);
    await assert.rejects(newSite(WS.pro), (e: unknown) => upgrade("twin_sites")(e) && /Upgrade to Business/.test((e as Error).message));
    assert.equal(await siteCount(WS.pro), max);
  });

  it("Business, trial and self-hosted are not capped", async () => {
    for (const ws of [WS.business, WS.trial, WS.self_hosted]) {
      for (let i = 0; i < 4; i++) await newSite(ws);
      assert.equal(await siteCount(ws), 4, ws);
    }
  });

  it("the sample site is refused up front on Starter (no sample records written)", async () => {
    const { createSampleSite } = await import("@/lib/twin/sample");
    const before = await warehouseCount(WS.starter);
    await assert.rejects(withWorkspaceScope(WS.starter, (tx) => createSampleSite(tx, actor(WS.starter), "store")), upgrade("digital_twin"));
    assert.equal(await warehouseCount(WS.starter), before);
  });
});

describe("payroll and POS gates", () => {
  it("Starter: registers, till sessions, salary structures and pay runs are refused", async () => {
    await assert.rejects(create(WS.starter, "pos-registers", { name: "Till" }), upgrade("pos"));
    await assert.rejects(create(WS.starter, "salary-structures", { name: "Staff" }), upgrade("payroll"));
    await assert.rejects(
      create(WS.starter, "pay-runs", { periodStart: "2026-09-01", periodEnd: "2026-09-14", payDate: "2026-09-15" }),
      upgrade("payroll"),
    );
  });

  it("Pro, trial and self-hosted: the same creations work", async () => {
    for (const ws of [WS.pro, WS.trial, WS.self_hosted]) {
      const reg = await create(ws, "pos-registers", { name: "Till" });
      await create(ws, "pos-sessions", { registerId: String(reg.id), openingCashCents: 10_000 });
      await create(ws, "salary-structures", { name: "Staff" });
      await create(ws, "pay-runs", { periodStart: "2026-09-01", periodEnd: "2026-09-14", payDate: "2026-09-15" });
    }
  });

  it("after a downgrade a pay run can't be (re)computed — but it can still be cancelled", async () => {
    const run = await create(WS.business, "pay-runs", { periodStart: "2026-09-01", periodEnd: "2026-09-14", payDate: "2026-09-15" });
    await setPlan(WS.business, "starter");
    try {
      const { computePayRun, cancelPayRun } = await import("@/lib/ops/payroll/runs");
      await assert.rejects(withWorkspaceScope(WS.business, (tx) => computePayRun(tx, actor(WS.business), String(run.id))), upgrade("payroll"));
      const cancelled = await withWorkspaceScope(WS.business, (tx) => cancelPayRun(tx, actor(WS.business), String(run.id)));
      assert.equal((cancelled as { status?: string }).status ?? "cancelled", "cancelled");
    } finally {
      await setPlan(WS.business, "business");
    }
  });
});

describe("SCIM gate", () => {
  type TokenRoute = typeof import("@/app/api/settings/security/scim-tokens/route");
  let route: TokenRoute;
  const post = (name: string) =>
    new Request("http://x/api/settings/security/scim-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  before(async () => {
    route = await import("@/app/api/settings/security/scim-tokens/route");
  });

  it("the token route refuses a plan without SCIM (Pro) with an upgrade message", async () => {
    sessionWs = WS.pro;
    const res = await route.POST(post("Okta"));
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, "upgrade_required");
    assert.equal(body.entitlement, "scim");
    assert.match(String(body.error), /Upgrade to Business/);
    const list = (await (await route.GET(new Request("http://x/api/settings/security/scim-tokens"))).json()) as Record<string, unknown>;
    assert.equal(list.entitled, false);
    assert.equal(await withWorkspaceScope(WS.pro, (tx) => tx.scimToken.count({ where: { workspaceId: WS.pro } })), 0);
  });

  it("Business mints a token; it stops authenticating once the plan loses SCIM", async () => {
    sessionWs = WS.business;
    const res = await route.POST(post("Okta"));
    assert.equal(res.status, 201);
    const { raw } = (await res.json()) as { raw: string };
    const { requireScimAuth } = await import("@/lib/scim/auth");
    const { ScimError } = await import("@/lib/scim/http");
    const req = () => new Request("http://x/api/scim/v2/Users", { headers: { authorization: `Bearer ${raw}` } });
    const ctx = await requireScimAuth(req());
    assert.equal(ctx.workspaceId, WS.business);
    await setPlan(WS.business, "pro");
    try {
      await assert.rejects(requireScimAuth(req()), (e: unknown) => e instanceof ScimError && e.status === 403);
    } finally {
      await setPlan(WS.business, "business");
    }
    assert.equal((await requireScimAuth(req())).workspaceId, WS.business, "works again on a plan with SCIM");
  });
});
