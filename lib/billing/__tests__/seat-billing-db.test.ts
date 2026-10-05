// ShapesOS — Phase 15.3 pricing: extra seats as a Stripe QUANTITY line, on
// real Postgres as the least-privilege app role, against a FAKE Stripe.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ FAKE STRIPE CLIENT — a labelled test double, NOT Stripe. No network.     │
// │ It implements only the calls seat sync makes, with the request shapes    │
// │ documented at stripe.com/docs/api:                                       │
// │   GET    /v1/subscriptions/:id                 subscriptions.retrieve     │
// │   POST   /v1/subscription_items                subscriptionItems.create   │
// │          {subscription, price, quantity, proration_behavior}              │
// │   POST   /v1/subscription_items/:id            subscriptionItems.update   │
// │          {quantity, price?, proration_behavior}                           │
// │   DELETE /v1/subscription_items/:id            subscriptionItems.del      │
// │          {proration_behavior}                                             │
// │ and Stripe's Idempotency-Key rule: a repeated key replays the first      │
// │ response without applying the request again. Live behaviour is           │
// │ UNVERIFIED until test-mode keys exist.                                   │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Proves: sync is idempotent (no write when in step; retries and concurrent
// syncs never double-charge); adding a member past the included seats is
// refused (402, nothing added, nothing charged) without the admin's
// confirmation and allowed with it; removing a member lowers the quantity;
// SCIM can use approved seats but is refused past them; a downgrade never
// raises the quantity above what an admin approved; a paid plan without a
// billable subscription keeps the included seats as a hard limit.
// Run: DATABASE_URL=<app role url> npx tsx --test --experimental-test-module-mocks \
//        lib/billing/__tests__/seat-billing-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";

// Billing "configured" with obviously fake values — every Stripe call goes to the fake below.
process.env.STRIPE_SECRET_KEY = "sk_test_FAKE_seat_billing_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_FAKE_seat_billing";
process.env.STRIPE_PRICE_PRO = "price_FAKE_pro_month";
process.env.STRIPE_PRICE_SEAT_PRO = "price_FAKE_seat_pro_month";
process.env.STRIPE_PRICE_STARTER = "price_FAKE_starter_month";
process.env.STRIPE_PRICE_SEAT_STARTER = "price_FAKE_seat_starter_month";

const WS = "p153seats-pro";
const WS_NOSUB = "p153seats-nosub";
const OWNER = "p153seats-owner";
const SUB_ID = "sub_FAKE_p153";
let sessionWs = WS;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: OWNER, email: "owner@seats.test", name: "Owner" }),
    getOrCreateWorkspace: async () => ({ id: sessionWs, name: sessionWs }),
  },
});

// ── FAKE Stripe (see banner) ────────────────────────────────────────────────
interface FakeItem {
  id: string;
  object: "subscription_item";
  price: { id: string; recurring: { interval: "month" | "year" } };
  quantity: number;
}
interface Call {
  method: "retrieve" | "create" | "update" | "del";
  id?: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  replayed: boolean;
}
class FakeStripeForSeats {
  readonly label = "FAKE Stripe client (tests only)";
  calls: Call[] = [];
  private seq = 0;
  private idem = new Map<string, unknown>();
  sub = {
    id: SUB_ID,
    object: "subscription",
    customer: "cus_FAKE_p153",
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        { id: "si_FAKE_base", object: "subscription_item", price: { id: "price_FAKE_pro_month", recurring: { interval: "month" } }, quantity: 1 },
      ] as FakeItem[],
    },
  };
  private once<T>(key: string | undefined, apply: () => T): { value: T; replayed: boolean } {
    if (key && this.idem.has(key)) return { value: this.idem.get(key) as T, replayed: true };
    const value = apply();
    if (key) this.idem.set(key, value);
    return { value, replayed: false };
  }
  writes() {
    return this.calls.filter((c) => c.method !== "retrieve" && !c.replayed);
  }
  seatItem() {
    return this.sub.items.data.find((i) => i.price.id.startsWith("price_FAKE_seat_")) ?? null;
  }
  subscriptions = {
    retrieve: async (id: string) => {
      this.calls.push({ method: "retrieve", id, replayed: false });
      assert.equal(id, SUB_ID);
      return structuredClone(this.sub);
    },
  };
  subscriptionItems = {
    create: async (params: { subscription: string; price: string; quantity: number; proration_behavior?: string }, opts?: { idempotencyKey?: string }) => {
      const r = this.once(opts?.idempotencyKey, () => {
        const item: FakeItem = { id: `si_FAKE_${++this.seq}`, object: "subscription_item", price: { id: params.price, recurring: { interval: "month" } }, quantity: params.quantity };
        this.sub.items.data.push(item);
        return structuredClone(item);
      });
      this.calls.push({ method: "create", params, idempotencyKey: opts?.idempotencyKey, replayed: r.replayed });
      return r.value;
    },
    update: async (id: string, params: { quantity?: number; price?: string; proration_behavior?: string }, opts?: { idempotencyKey?: string }) => {
      const r = this.once(opts?.idempotencyKey, () => {
        const item = this.sub.items.data.find((i) => i.id === id);
        if (!item) throw new Error(`FAKE Stripe: no such subscription item ${id}`);
        if (params.quantity !== undefined) item.quantity = params.quantity;
        if (params.price) item.price = { id: params.price, recurring: { interval: "month" } };
        return structuredClone(item);
      });
      this.calls.push({ method: "update", id, params, idempotencyKey: opts?.idempotencyKey, replayed: r.replayed });
      return r.value;
    },
    del: async (id: string, params?: { proration_behavior?: string }, opts?: { idempotencyKey?: string }) => {
      const r = this.once(opts?.idempotencyKey, () => {
        this.sub.items.data = this.sub.items.data.filter((i) => i.id !== id);
        return { id, object: "subscription_item", deleted: true };
      });
      this.calls.push({ method: "del", id, params, idempotencyKey: opts?.idempotencyKey, replayed: r.replayed });
      return r.value;
    },
  };
}

const fake = new FakeStripeForSeats();

type MembersRoute = typeof import("@/app/api/workspace/members/route");
type MemberRoute = typeof import("@/app/api/workspace/members/[id]/route");
let members: MembersRoute;
let memberById: MemberRoute;

const post = (body: unknown) =>
  new Request("http://x/api/workspace/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

const memberCount = (ws = WS) => prisma.workspaceMember.count({ where: { workspaceId: ws } });
const billing = () => prisma.billingWorkspace.findUniqueOrThrow({ where: { workspaceId: WS } });

before(async () => {
  for (const id of [WS, WS_NOSUB]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, plan, updated_at)
      VALUES (${id}, ${id}, ${OWNER}, 'pro'::"Plan", now())`;
    await prisma.workspaceMember.create({ data: { workspaceId: id, userId: OWNER, role: "owner", email: "owner@seats.test" } });
    // Fill Pro's 10 included seats (owner + 9).
    for (let i = 1; i <= 9; i++) {
      await prisma.workspaceMember.create({ data: { workspaceId: id, role: "editor", email: `m${i}@seats.test` } });
    }
  }
  await prisma.billingWorkspace.create({ data: { workspaceId: WS, stripeCustomerId: "cus_FAKE_p153" } });
  await prisma.$executeRaw`INSERT INTO billing_subscriptions
      (workspace_id, stripe_subscription_id, stripe_customer_id, plan_id, status, billing_interval)
    VALUES (${WS}, ${SUB_ID}, ${"cus_FAKE_p153"}, 'pro', 'active', 'month')`;

  const { seatBillingRuntime } = await import("../seats-server");
  const { StripeBillingSink } = await import("@/lib/metering/billing");
  seatBillingRuntime.makeSink = () =>
    new StripeBillingSink({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      client: fake as unknown as Stripe,
    });
  members = await import("@/app/api/workspace/members/route");
  memberById = await import("@/app/api/workspace/members/[id]/route");
});

after(async () => {
  for (const id of [WS, WS_NOSUB]) {
    await prisma.$executeRaw`DELETE FROM file_change_log WHERE workspace_id = ${id}`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`.catch(() => {});
  }
  await prisma.$disconnect();
});

describe("seat quantity sync (FAKE Stripe)", () => {
  it("within the included seats: in step, nothing written to Stripe", async () => {
    const { syncSeatQuantityWith } = await import("@/lib/metering/billing");
    const r = await syncSeatQuantityWith(fake as unknown as Stripe, WS);
    assert.equal(r.status, "unchanged");
    assert.equal(r.quantity, 0);
    assert.equal(fake.writes().length, 0);
  });
});

describe("adding a member past the included seats", () => {
  it("is refused without the admin's confirmation: 402, nobody added, nothing charged", async () => {
    sessionWs = WS;
    const res = await members.POST(post({ email: "eleven@seats.test", role: "editor" }));
    assert.equal(res.status, 402);
    const body = (await res.json()) as { code: string; error: string; seat: Record<string, unknown> };
    assert.equal(body.code, "seat_confirmation_required");
    assert.equal(body.seat.included, 10);
    assert.equal(body.seat.newExtraSeats, 1);
    assert.equal(body.seat.perSeatCents, 1_900);
    assert.match(body.error, /\$19 per seat per month/);
    assert.equal(await memberCount(), 10, "nobody was added");
    assert.equal((await billing()).approvedExtraSeats, 0, "nothing approved");
    assert.equal(fake.writes().length, 0, "nothing sent to Stripe");
  });

  it("is allowed with the confirmation: member added, ceiling raised, one quantity line created", async () => {
    const res = await members.POST(post({ email: "eleven@seats.test", role: "editor", confirmSeatCharge: true }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { seatSync?: { ok: boolean; quantity: number } };
    assert.deepEqual(body.seatSync, { ok: true, quantity: 1, error: null });
    assert.equal(await memberCount(), 11);
    const bw = await billing();
    assert.equal(bw.approvedExtraSeats, 1);
    assert.equal(bw.billedExtraSeats, 1);
    const writes = fake.writes();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "create");
    assert.deepEqual(writes[0].params, {
      subscription: SUB_ID,
      price: "price_FAKE_seat_pro_month",
      quantity: 1,
      proration_behavior: "create_prorations",
    });
    assert.equal(writes[0].idempotencyKey, "seats:sub_FAKE_p153:v1:q1:price_FAKE_seat_pro_month");
    const audit = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "seat_charge_confirmed" } });
    assert.equal(audit.length, 1, "the confirmation is audit-logged");
    assert.match(audit[0].summary, /confirmed 1 extra seat at \$19 per seat per month/);
  });

  it("re-running the sync (a retry, a replayed webhook) never double-charges", async () => {
    const { syncSeatQuantityWith } = await import("@/lib/metering/billing");
    const before = fake.writes().length;
    for (let i = 0; i < 3; i++) {
      const r = await syncSeatQuantityWith(fake as unknown as Stripe, WS);
      assert.equal(r.status, "unchanged");
      assert.equal(r.quantity, 1);
    }
    assert.equal(fake.writes().length, before);
    assert.equal(fake.seatItem()?.quantity, 1);
  });

  it("concurrent syncs after a change send one effective update (same idempotency key)", async () => {
    // An admin approved 2 extra seats; a 12th member arrives (within the approval).
    await prisma.billingWorkspace.update({ where: { workspaceId: WS }, data: { approvedExtraSeats: 2 } });
    await prisma.workspaceMember.create({ data: { workspaceId: WS, role: "viewer", email: "twelve@seats.test" } });
    const { syncSeatQuantityWith } = await import("@/lib/metering/billing");
    const before = fake.writes().length;
    const results = await Promise.all([1, 2, 3].map(() => syncSeatQuantityWith(fake as unknown as Stripe, WS)));
    for (const r of results) assert.equal(r.quantity, 2);
    const applied = fake.writes().slice(before);
    assert.equal(applied.length, 1, "exactly one update applied");
    assert.deepEqual(applied[0].params, { quantity: 2, proration_behavior: "create_prorations" });
    assert.equal(fake.seatItem()?.quantity, 2);
    assert.equal((await billing()).billedExtraSeats, 2);
  });

  it("past the approved ceiling a further add asks again (only the NEW seat is quoted)", async () => {
    const res = await members.POST(post({ email: "thirteen@seats.test", role: "viewer" }));
    assert.equal(res.status, 402);
    const body = (await res.json()) as { seat: { newExtraSeats: number; extraAfter: number; approvedExtra: number } };
    assert.deepEqual([body.seat.newExtraSeats, body.seat.extraAfter, body.seat.approvedExtra], [1, 3, 2]);
    assert.equal(await memberCount(), 12);
  });
});

describe("removing members and automated provisioning", () => {
  it("removing a member lowers the quantity (no confirmation needed to pay less)", async () => {
    const twelve = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: WS, email: "twelve@seats.test" } });
    const res = await memberById.DELETE(post({}), { params: Promise.resolve({ id: twelve.id }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { seatSync?: { ok: boolean; quantity: number } };
    assert.equal(body.seatSync?.quantity, 1);
    assert.equal(fake.seatItem()?.quantity, 1);
  });

  it("SCIM may use seats an admin approved, and is refused (403, not charged) past them", async () => {
    const { createUser } = await import("@/lib/scim/service");
    const { ScimError } = await import("@/lib/scim/http");
    const ctx = { workspaceId: WS, tokenId: "tok_test" };
    // 11 members, 2 approved extra → one more fits.
    await createUser(ctx, "http://x/api/scim/v2", { userName: "scim1@seats.test", emails: [{ value: "scim1@seats.test", primary: true }] });
    assert.equal(await memberCount(), 12);
    assert.equal(fake.seatItem()?.quantity, 2);
    const writesBefore = fake.writes().length;
    await assert.rejects(
      createUser(ctx, "http://x/api/scim/v2", { userName: "scim2@seats.test", emails: [{ value: "scim2@seats.test", primary: true }] }),
      (e: unknown) => e instanceof ScimError && e.status === 403 && /approve more extra seats/.test(e.message),
    );
    assert.equal(await memberCount(), 12);
    assert.equal(fake.writes().length, writesBefore, "nothing charged");
  });

  it("a downgrade never bills more seats than an admin approved", async () => {
    // Pro (10 included) → Starter (3 included): 9 members are now "extra", 2 approved.
    await prisma.workspace.update({ where: { id: WS }, data: { plan: "starter" } });
    try {
      const { syncSeatQuantityWith } = await import("@/lib/metering/billing");
      const r = await syncSeatQuantityWith(fake as unknown as Stripe, WS);
      assert.equal(r.quantity, 2, "capped at the approved 2, not 9");
      assert.equal(fake.seatItem()?.quantity, 2);
      assert.equal(fake.seatItem()?.price.id, "price_FAKE_seat_starter_month", "seat line moved to the new plan's seat price");
      const { getSeatSummary } = await import("../seats-server");
      const s = await getSeatSummary(WS);
      assert.equal(s.unapprovedExtra, 7, "billing shows the members not covered");
    } finally {
      await prisma.workspace.update({ where: { id: WS }, data: { plan: "pro" } });
    }
  });

  it("raising the approved ceiling in Billing needs the confirmation", async () => {
    const { setApprovedExtraSeats } = await import("../seats-server");
    const actor = { userId: OWNER, label: "owner@seats.test" };
    await assert.rejects(setApprovedExtraSeats(WS, 5, { confirmed: false, actor }), (e: unknown) => (e as { code?: string }).code === "seat_confirmation_required");
    assert.equal((await billing()).approvedExtraSeats, 2);
    await assert.rejects(setApprovedExtraSeats(WS, 1, { confirmed: true, actor }), /in use — remove members first/);
    const s = await setApprovedExtraSeats(WS, 5, { confirmed: true, actor });
    assert.equal(s.approvedExtra, 5);
    assert.equal(s.targetExtra, 2, "approving seats bills nothing until they are used");
    assert.equal(fake.seatItem()?.quantity, 2);
  });
});

describe("no billable subscription", () => {
  it("a paid plan without a subscription keeps the included seats as a hard limit (403, never a charge)", async () => {
    sessionWs = WS_NOSUB;
    try {
      for (const confirmSeatCharge of [false, true]) {
        const res = await members.POST(post({ email: "eleven@nosub.test", role: "editor", confirmSeatCharge }));
        assert.equal(res.status, 403);
        const body = (await res.json()) as { code: string; error: string };
        assert.equal(body.code, "upgrade_required");
        assert.match(body.error, /no active paid subscription/);
      }
      assert.equal(await memberCount(WS_NOSUB), 10);
    } finally {
      sessionWs = WS;
    }
  });
});
