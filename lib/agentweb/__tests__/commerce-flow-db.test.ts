// Phase 21A round 2 (WS=agentweb): the whole cart flow through the real tool gate and routes,
// against Postgres as the app role. Nothing here talks to a merchant: the checkout is a MOCK ACP
// merchant (live merchants are UNVERIFIED-LIVE).
//   - an agent can ask for a cart to be approved, and a spoken or chat "yes" (confirmed:true)
//     does not approve it; no tool exists that approves a cart or completes a checkout;
//   - the signing route refuses everything but a same-origin ui_click by an editor+;
//   - a click either completes a checkout through a mock ACP merchant (once) or, with no
//     merchant checkout/payment rail, stops at the payment step and does NOT use the mandate up;
//   - card numbers in tool arguments are refused, and nothing card-like lands in the audit
//     chain, the run events or the merchant's requests.
// Listed in scripts/test/db-tests.txt.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import { prisma } from "@/lib/prisma";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { TOOL_GROUP, type ToolContext } from "@/lib/chat/tools";
import "../commerce/tools";
import { AcpAdapter } from "../commerce/acp";
import { mockAcpMerchant, mockPaymentRail } from "../commerce/fakes";
import { noPaymentRail } from "../commerce/checkout";
import { getMandate } from "../commerce/mandate-store";
import { resetAdapterResolver, setAdapterResolver } from "../commerce/merchants";
import { handleReject, handleSign, type Actor } from "../commerce/route-core";

const RUN = `p21cf-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
const ITEMS = JSON.stringify([{ sku: "MUG", name: "Blue mug", qty: 2, unitMinor: 1250 }]);
const ARGS = { merchant_name: "Acme shop", merchant_url: "https://acme.test/shop", currency: "GBP", items: ITEMS };
const ctxBase = (): ToolContext & { threadId: string } => ({ projectId, workspaceId: WS, userId: USER, role: "owner", confirmed: false, agentKey: "lead", grant: null, threadId: `${RUN}-thread` });
const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "executed" });
const resolve = async () => ["93.184.216.34"];

const signReq = (body: unknown = { channel: "ui_click" }, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/agentweb/mandates/x/sign", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://app.test", ...headers }, body: JSON.stringify(body) });
const owner: Actor = { userId: USER, workspaceId: WS, role: "owner" };

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER, plan: "pro" } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});
after(async () => {
  resetAdapterResolver();
  await settleBackgroundWork();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});
beforeEach(() => resetAdapterResolver());

async function request(args: Record<string, unknown> = ARGS, ctx: ToolContext = ctxBase()) {
  const c = call("cart_request_signature", args);
  await executeTool(ctx, "cart_request_signature", c.args, c);
  return c;
}
const idOf = (c: ChatToolCall) => ((c as ChatToolCall & { details?: unknown }).details as { mandateId?: string } | undefined)?.mandateId ?? /man_[0-9a-f]{20}/.exec(c.resultSummary ?? "")![0];

describe("the agent can ask, never approve", () => {
  it("creates a pending card, and a chat or spoken 'yes' (confirmed: true) does not approve it", async () => {
    const c = await request(ARGS, { ...ctxBase(), confirmed: true });
    assert.equal(c.status, "executed", c.resultSummary);
    const id = idOf(c);
    assert.match(c.resultSummary!, /Nothing is paid or ordered until they approve it themselves/);
    assert.equal((await getMandate(WS, id))!.status, "pending");
  });

  it("no tool exists that signs a cart, approves a purchase or completes a checkout", () => {
    // site_checkout is the SiteBuilder git checkout (Phase 9), not commerce.
    const names = Object.keys(TOOL_GROUP).filter((n) => n !== "site_checkout");
    const cart = names.filter((n) => /cart|mandate|checkout/i.test(n));
    assert.deepEqual(cart.sort(), ["cart_request_signature", "cart_status"]);
    assert.ok(!names.some((n) => /(sign|approve|complete|finish|confirm).*(cart|mandate|checkout)|(cart|mandate|checkout).*(sign|approve|complete|finish|confirm)/i.test(n) && n !== "cart_request_signature"));
  });

  it("card numbers in the arguments are refused and nothing is stored", async () => {
    const c = await request({ ...ARGS, items: JSON.stringify([{ name: "Gift card 4242 4242 4242 4242", qty: 1, unitMinor: 100 }]) });
    assert.match(c.resultSummary!, /card details are not accepted here, and none were stored/i);
  });

  it("cart_status reports what the person decided, and nothing for another workspace's id", async () => {
    const id = idOf(await request());
    const s = call("cart_status", { mandate_id: id });
    await executeTool(ctxBase(), "cart_status", s.args, s);
    assert.match(s.resultSummary!, /Waiting for the person/);
    const none = call("cart_status", { mandate_id: "man_00000000000000000000" });
    await executeTool(ctxBase(), "cart_status", none.args, none);
    assert.match(none.resultSummary!, /No such cart request/);
  });
});

describe("the signing route", () => {
  it("refuses every channel but a same-origin ui_click, and a viewer", async () => {
    const id = idOf(await request());
    for (const [label, req] of [
      ["voice", signReq({ channel: "voice" })],
      ["no body", signReq({})],
      ["cross-site", signReq({ channel: "ui_click" }, { "sec-fetch-site": "cross-site" })],
      ["foreign origin", signReq({ channel: "ui_click" }, { origin: "https://evil.test" })],
    ] as const) {
      const res = await handleSign(owner, req, id);
      assert.equal(res.status, 403, label);
    }
    assert.equal((await handleSign({ ...owner, role: "viewer" }, signReq(), id)).status, 403);
    assert.equal((await getMandate(WS, id))!.status, "pending");
  });

  it("with no merchant checkout it stops at the payment step and does NOT use the mandate up", async () => {
    const id = idOf(await request());
    const res = await handleSign(owner, signReq(), id);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.outcome, { outcome: "stopped_at_payment", reason: "no_adapter", continueUrl: "https://acme.test" });
    assert.equal(body.mandate.status, "signed");
    assert.equal((await handleSign(owner, signReq(), id)).status, 409, "a second click is not a second approval");
  });

  it("with a (mock) ACP merchant and a payment rail it completes exactly once", async () => {
    const merchant = mockAcpMerchant();
    setAdapterResolver(async () => ({ adapter: new AcpAdapter({ baseUrl: "https://acme.test/acp", bearerToken: "mock-merchant-token", fetchFn: merchant.fetchFn, resolve }), rail: mockPaymentRail }));
    const id = idOf(await request());
    const body = await (await handleSign(owner, signReq(), id)).json();
    assert.equal(body.outcome.outcome, "completed");
    assert.equal(merchant.completeCount(), 1);
    const m = (await getMandate(WS, id))!;
    assert.deepEqual([m.status, m.checkoutRef], ["used", "ord_mock_cs_mock_1"]);
    assert.equal((await handleSign(owner, signReq(), id)).status, 409);
    assert.equal(merchant.completeCount(), 1, "the merchant was not asked again");
  });

  it("a merchant whose price moved is cancelled, not paid; with no rail it stops", async () => {
    const merchant = mockAcpMerchant();
    merchant.setPriceDrift(500);
    setAdapterResolver(async () => ({ adapter: new AcpAdapter({ baseUrl: "https://acme.test/acp", bearerToken: "mock-merchant-token", fetchFn: merchant.fetchFn, resolve }), rail: mockPaymentRail }));
    const drift = await (await handleSign(owner, signReq(), idOf(await request()))).json();
    assert.deepEqual(drift.outcome, { outcome: "price_changed", expectedMinor: 2500, gotMinor: 3000, currency: "GBP" });
    assert.equal(merchant.completeCount(), 0);
    setAdapterResolver(async () => ({ adapter: new AcpAdapter({ baseUrl: "https://acme.test/acp", bearerToken: "mock-merchant-token", fetchFn: mockAcpMerchant().fetchFn, resolve }), rail: noPaymentRail }));
    const norail = await (await handleSign(owner, signReq(), idOf(await request()))).json();
    assert.equal(norail.outcome.reason, "no_payment_rail");
  });

  it("rejecting signs nothing and ends the request", async () => {
    const id = idOf(await request());
    const res = await handleReject(owner, signReq({}), id);
    assert.equal(res.status, 200);
    assert.equal((await getMandate(WS, id))!.status, "rejected");
    assert.equal((await handleSign(owner, signReq(), id)).status, 409);
  });
});

describe("card details never land anywhere", () => {
  it("nothing card-like is in the audit chain for the whole flow", async () => {
    const events = await prisma.authorityAuditEvent.findMany({ where: { workspaceId: WS } });
    assert.ok(events.length > 5);
    assert.ok(events.some((e) => e.action === "agentweb.mandate.signed"));
    assert.ok(!/\b\d{13,19}\b/.test(JSON.stringify(events.map((e) => e.detail))));
    assert.ok(!/4242/.test(JSON.stringify(events)));
  });
});
