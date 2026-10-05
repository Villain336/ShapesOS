// ShapesOS Phase 15.2 — the platform-paid calls that used to be unbilled are
// metered (against Postgres as the app role; every vendor is a FAKE — MOCK —
// and the live calls are UNVERIFIED-LIVE):
//   - direct mail at 2× (HOSTED_MARGIN_MULTIPLIER); the send STOPS at the cap
//     (remaining pieces stay queued, nothing charged for them);
//   - sandbox minutes on a paid provider, idempotent per sandbox lifetime;
//   - Twilio voice minutes / transcription / number rental, idempotent;
//     a capped workspace can't buy a number;
//   - Phase 10 intelligence vendor calls at 4× USD (0 on the workspace's
//     own key); GEO prompt runs; a capped workspace is refused before the call;
//   - Context.dev on the PLATFORM key is charged at the budget gate (and a
//     capped workspace is refused, its reservation released);
//   - the studio image route is gated and charged once per image.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test --experimental-test-module-mocks lib/metering/__tests__/metered-gaps-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { setSpendCap, checkCap } from "@/lib/metering/service";

const RUN = randomUUID().slice(0, 8);
const ids = {
  mail: `p15mg-mail-${RUN}`,
  sbx: `p15mg-sbx-${RUN}`,
  calls: `p15mg-calls-${RUN}`,
  intel: `p15mg-intel-${RUN}`,
  intelOwn: `p15mg-intown-${RUN}`,
  ctx: `p15mg-ctx-${RUN}`,
  img: `p15mg-img-${RUN}`,
};
const USER = `p15mg-user-${RUN}`;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: USER, email: "u@x.test" }),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: ids.img } }),
  },
});

const events = (workspaceId: string, action: string) => prisma.usageEvent.findMany({ where: { workspaceId, action } });
const used = async (id: string) => (await prisma.creditBalance.findUnique({ where: { workspaceId: id } }))?.usedCredits ?? 0;

before(async () => {
  for (const id of Object.values(ids)) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER, plan: "starter" } });
  await prisma.workspaceMember.create({ data: { workspaceId: ids.img, userId: USER, role: "editor" } });
});

after(async () => {
  await prisma.$disconnect();
});

describe("direct mail (2×, stops at the cap)", () => {
  it("charges 2× the provider cost per piece and stops the send when the cap is reached", async () => {
    const svc = await import("@/lib/mail/service");
    const ws = ids.mail;
    const pdf = Buffer.from(`%PDF-1.4 p15 ${RUN}`);
    const creative = await prisma.mailCreative.create({
      data: { workspaceId: ws, name: "c", formatTrack: "addressed", size: "4x6", source: "upload", creativeHash: svc.creativeHashFor(pdf), status: "ready" },
    });
    const campaign = await prisma.mailCampaign.create({
      data: { workspaceId: ws, name: "p15 cap", creativeId: creative.id, audienceSource: { kind: "unset" } as unknown as Prisma.InputJsonValue, createdBy: "t" },
    });
    await svc.buildPieces(ws, campaign.id, {
      kind: "csv",
      rows: [1, 2, 3].map((n) => ({ name: `R${n}`, line1: `${n} Main St`, city: "Greensboro", state: "NC", zip: "27401" })),
    });
    await svc.verifyAddresses(ws, campaign.id); // 3 × mail_verification (5) = 15 credits
    const { approval } = await svc.requestApproval(ws, campaign.id, { requestedBy: "t" });
    await svc.decideApproval(ws, approval.id, "approve", "admin");
    // 15 used; leave room for exactly ONE 170-credit piece (85¢ × 2).
    await setSpendCap(ws, { capCredits: 15 + 170 + 50 });
    const out = await svc.executeCampaign(ws, campaign.id);
    assert.equal(out.sent, 1);
    assert.equal(out.stoppedAtCap, true);
    assert.match(out.capMessage ?? "", /Credit cap reached/);
    const charges = await events(ws, "mail_piece");
    assert.equal(charges.length, 1, "only the piece actually sent is charged");
    assert.equal(charges[0].credits, svc.mailPieceCredits(85));
    assert.equal(charges[0].credits, 170);
    assert.equal(await prisma.mailPiece.count({ where: { campaignId: campaign.id, status: "queued" } }), 2, "the rest stay queued");
    assert.equal((await prisma.mailCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "cap_reached");
  });
});

describe("sandbox minutes", () => {
  it("a paid sandbox is charged per started minute once; a Docker sandbox is free", async () => {
    const { createAgentRun } = await import("@/lib/agents/runs/service");
    const { insertSandboxRow, markSandboxDestroyed } = await import("@/lib/sandbox/store");
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    const ws = ids.sbx;
    const runA = await createAgentRun({ workspaceId: ws, kind: "chat", startedBy: USER });
    const runB = await createAgentRun({ workspaceId: ws, kind: "chat", startedBy: USER });
    await insertSandboxRow({ workspaceId: ws, runId: runA.id, provider: "e2b", sandboxId: "sbx-a" });
    await insertSandboxRow({ workspaceId: ws, runId: runB.id, provider: "docker", sandboxId: "sbx-b" });
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await withWorkspaceScope(ws, (tx) =>
      tx.agentRunSandbox.updateMany({ where: { workspaceId: ws, runId: runA.id }, data: { createdAt: minutesAgo(4.5), lastUsedAt: minutesAgo(1) } }),
    );
    assert.equal(await markSandboxDestroyed(ws, runA.id), true);
    assert.equal(await markSandboxDestroyed(ws, runA.id), false, "a second destroy changes nothing");
    assert.equal(await markSandboxDestroyed(ws, runB.id), true);
    const ev = await events(ws, "sandbox_minute");
    assert.equal(ev.length, 1, "docker is not charged; the e2b sandbox once");
    assert.equal(ev[0].credits, 5, "4.5 minutes → 5 started minutes × 1 credit");
    assert.equal(ev[0].keySource, "platform");
  });

  it("billable minutes stop at the idle timeout after the last use", async () => {
    const { sandboxBillableMinutes } = await import("@/lib/sandbox/metering");
    const t0 = new Date("2026-10-05T10:00:00Z");
    assert.equal(
      sandboxBillableMinutes({ createdAt: t0, lastUsedAt: new Date("2026-10-05T10:02:00Z"), endedAt: new Date("2026-10-05T14:00:00Z"), idleSeconds: 600 }),
      12,
      "noticed 4 h late, charged 2 min use + 10 min idle",
    );
  });
});

describe("Twilio voice, transcription and numbers", () => {
  it("a finished live call is charged per started minute, once; transcription once by either path", async () => {
    const ws = ids.calls;
    await prisma.pipeline.create({ data: { workspaceId: ws, name: "Default", stages: [{ id: "new", label: "New" }], isDefault: true } });
    const num = await prisma.callNumber.create({ data: { workspaceId: ws, e164: `+1555${RUN.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`, provider: "twilio", status: "active" } });
    const call = await prisma.call.create({
      data: { workspaceId: ws, numberId: num.id, externalSid: `CA${RUN}`, from: "+15550001111", to: num.e164, startedAt: new Date() },
    });
    const { handleCallStatus } = await import("@/lib/calls/inbound");
    await handleCallStatus({ callSid: call.externalSid, providerStatus: "completed", durationSec: 125 } as never);
    // A retried status callback is a duplicate and never re-charges.
    await handleCallStatus({ callSid: call.externalSid, providerStatus: "completed", durationSec: 125 } as never);
    const voice = await events(ws, "call_minute");
    assert.equal(voice.length, 1);
    assert.equal(voice[0].credits, 3 * 6, "125 s → 3 started minutes × 6 credits");
    const { meterCallTranscription, meterNumberMonth, numberPurchaseDenial } = await import("@/lib/calls/billing");
    await meterCallTranscription({ id: call.id, workspaceId: ws, provider: "twilio", durationSec: 125 });
    await meterCallTranscription({ id: call.id, workspaceId: ws, provider: "twilio", durationSec: 125 });
    const tr = await events(ws, "call_transcription_minute");
    assert.equal(tr.length, 1);
    assert.equal(tr[0].credits, 3 * 20);
    // Number rental: once per number-month.
    await meterNumberMonth({ workspaceId: ws, numberId: num.id, provider: "twilio", month: "2026-10" });
    await meterNumberMonth({ workspaceId: ws, numberId: num.id, provider: "twilio", month: "2026-10" });
    await meterNumberMonth({ workspaceId: ws, numberId: num.id, provider: "fake", month: "2026-11" });
    const rent = await events(ws, "phone_number_month");
    assert.equal(rent.length, 1);
    assert.equal(rent[0].credits, 460);
    // A capped workspace cannot buy another live number.
    await setSpendCap(ws, { capCredits: await used(ws) });
    assert.match((await numberPurchaseDenial(ws, "twilio")) ?? "", /Credit cap reached/);
    assert.equal(await numberPurchaseDenial(ws, "fake"), null, "the fake provider costs nothing");
  });
});

describe("intelligence vendor calls (4×) and GEO prompt runs", () => {
  it("a platform-key vendor call is charged 4× its USD; the workspace's own key is free; GEO prompt runs are charged", async () => {
    const { recordApiMeter } = await import("@/lib/intelligence/providers/meter");
    await recordApiMeter(ids.intel, "serper", "serp_call", 1, 0.07);
    await recordApiMeter(ids.intel, "serper", "serp_call", 1, 0); // a cache hit is free
    await recordApiMeter(ids.intel, "openai", "ai_prompt", 1, 0.001);
    const vendor = await events(ids.intel, "intelligence_vendor_call");
    assert.equal(vendor.length, 1);
    assert.equal(vendor[0].credits, 28, "$0.07 × 4 = 28 credits");
    const geo = await events(ids.intel, "geo_prompt_run");
    assert.equal(geo.length, 1);
    assert.equal(geo[0].credits, 1);

    // The workspace's own Serper key (data_source registry) → no credits.
    const { withWorkspaceScope } = await import("@/lib/substrate/graph/rls");
    await withWorkspaceScope(ids.intelOwn, (tx) =>
      tx.dataSource.create({ data: { workspaceId: ids.intelOwn, type: "serp_vendor", config: { serper: { apiKey: "own-serper" } }, status: "active" } }),
    );
    await recordApiMeter(ids.intelOwn, "serper", "serp_call", 1, 0.07);
    assert.equal((await events(ids.intelOwn, "intelligence_vendor_call")).length, 0);
    assert.equal(
      await withWorkspaceScope(ids.intelOwn, (tx) => tx.apiMeterEntry.count({ where: { workspaceId: ids.intelOwn } })),
      1,
      "the cost row is still kept",
    );
  });

  it("a capped workspace is refused before a paid platform data call", async () => {
    const { assertBudgetAvailable, CreditCapExceeded } = await import("@/lib/intelligence/providers/meter");
    await setSpendCap(ids.intel, { capCredits: await used(ids.intel) });
    await assert.rejects(assertBudgetAvailable(ids.intel, 0.01), (e: unknown) => e instanceof CreditCapExceeded && /Credit cap reached/.test((e as Error).message));
    await assertBudgetAvailable(ids.intel, 0); // a free call still passes
  });
});

describe("Context.dev on the platform key", () => {
  it("is charged at the budget gate; a capped workspace is refused and its reservation released; the workspace's own key is free", async () => {
    const prev = process.env.CONTEXTDEV_API_KEY;
    process.env.CONTEXTDEV_API_KEY = "platform-cd-key";
    try {
      const { checkAndReserve, getDailyBudget } = await import("@/lib/knowledge/contextdev/budget-store");
      const { resolveContextDevKey, storeContextDevKey } = await import("@/lib/knowledge/contextdev/keys");
      assert.equal((await resolveContextDevKey(ids.ctx)).keySource, "platform");
      const ok = await checkAndReserve(ids.ctx, 10);
      assert.equal(ok.decision, "allow");
      const ev = await events(ids.ctx, "contextdev_call");
      assert.equal(ev.length, 1);
      assert.equal(ev[0].credits, 10, "1 credit per Context.dev credit");

      await setSpendCap(ids.ctx, { capCredits: 10 });
      const before = (await getDailyBudget(ids.ctx)).usedToday;
      const denied = await checkAndReserve(ids.ctx, 1);
      assert.equal(denied.decision, "needs_approval");
      assert.match(denied.reason, /Credit cap reached/);
      assert.equal((await getDailyBudget(ids.ctx)).usedToday, before, "the daily reservation was released");

      await storeContextDevKey(USER, ids.ctx, "own-cd-key");
      assert.equal((await resolveContextDevKey(ids.ctx)).keySource, "workspace");
      assert.equal((await checkAndReserve(ids.ctx, 1)).decision, "allow", "own key: not gated by credits");
      assert.equal((await events(ids.ctx, "contextdev_call")).length, 1, "own key: not charged");
    } finally {
      if (prev === undefined) delete process.env.CONTEXTDEV_API_KEY;
      else process.env.CONTEXTDEV_API_KEY = prev;
    }
  });
});

describe("studio image route", () => {
  it("is refused at the cap before OpenAI is asked, and charges each image once", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const realFetch = globalThis.fetch;
    let calls = 0;
    // MOCK OpenAI Images API.
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }], size: "1024x1024", quality: "medium" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env.OPENAI_API_KEY = "sk-platform-images";
    try {
      const route = await import("@/app/api/studio/designs/generate-image/route");
      const post = () =>
        route.POST(new Request("http://local.test/x", { method: "POST", body: JSON.stringify({ prompt: "a red bicycle", size: "square" }) }));
      const ok = await post();
      assert.equal(ok.status, 200);
      const ev = await events(ids.img, "image_generation");
      assert.equal(ev.length, 1);
      assert.equal(ev[0].credits, 22, "medium 1024×1024");
      await setSpendCap(ids.img, { capCredits: 22 });
      assert.equal((await checkCap(ids.img)).allowed, false);
      const before = calls;
      const capped = await post();
      assert.equal(capped.status, 402);
      assert.equal(calls, before, "OpenAI was not asked");
      assert.equal((await events(ids.img, "image_generation")).length, 1);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });
});
