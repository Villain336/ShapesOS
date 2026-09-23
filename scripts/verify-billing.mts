// Marketr — Stripe billing adversarial battery (Phase C gap-fill, track G2).
//
// Run: DATABASE_URL=<postgres> npx tsx scripts/verify-billing.mts
// Run 3x green before calling this done. Fully offline: Stripe signature
// verification uses the SDK's constructEvent with test secrets (pure
// crypto, no network); checkout creation uses an injected fake client.
//
// Covers THREAT-MODEL-BILLING.md abuse cases:
//   B1 webhook forgery (bad/missing signature, tampered payload)
//   B2 webhook replay incl. concurrent double-delivery (exactly-once)
//   B3 session-ID confusion across workspaces
//   B4 amount tampering (unknown amount, credit mismatch, bad currency, unpaid)
//   B5 opt-in privilege (non-admin toggle denied via the real route authz path)
//   B6 test/live key confusion (static: no mode flag; secrets from env only)
//   B7 unconfigured Stripe fail-closed (plain language, never half-initialized)
//   B8 stolen session IDs are useless without a valid signature (covered by B1+B3)
// Plus: pack table vs spec Appendix A, overage rate display, purchaseTopUp /
// billOverage fail-closed semantics, default opt-out, purchase history, no
// key material in errors.
//
// NOTE: battery workspaces are uniquely named per run (zz-bill-battery-*)
// and left in place, matching the metering battery convention.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

// Test Stripe keys live ONLY in-process (never shell env, never committed).
const SK_TEST = "sk_test_battery_4eC39HqLyjWDarjtT1zdp7dc";
const WHSEC_TEST = "whsec_test_battery_8e5f3a1b2c4d6e7f8a9b0c1d2e3f4a5b";

import { randomUUID } from "node:crypto";
import Stripe from "stripe";

const { prisma } = await import("@/lib/prisma");
const billing = await import("@/lib/metering/billing");
const {
  StripeBillingSink,
  BillingNotConfiguredError,
  TOP_UP_PACKS,
  OVERAGE_RATE_DISPLAY,
  packById,
  setAutoOverage,
  getTopUpHistory,
  getBillingStatus,
} = billing;
const { setOverageForUser } = await import("@/app/api/billing/overage/route");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const RUN = `zz-bill-battery-${Date.now()}-${process.pid}`;
const uid = (s: string) => `batt-${process.pid}-${randomUUID().slice(0, 8)}-${s}`;

async function makeWorkspace(plan: "starter" | "pro" | "agency" | "self_hosted" = "starter") {
  return prisma.workspace.create({
    data: { name: `${RUN}-ws-${randomUUID().slice(0, 6)}`, ownerUserId: uid("owner"), plan },
  });
}
async function addMember(workspaceId: string, userId: string, role: "owner" | "admin" | "editor" | "viewer") {
  return prisma.workspaceMember.create({ data: { workspaceId, userId, role } });
}
async function purchasedOf(workspaceId: string) {
  const bal = await prisma.creditBalance.findUnique({ where: { workspaceId } });
  return bal?.purchasedCredits ?? 0;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const wsA = await makeWorkspace();
const wsB = await makeWorkspace();
const adminA = uid("adminA");
const viewerA = uid("viewerA");
const outsider = uid("outsider");
await addMember(wsA.id, adminA, "admin");
await addMember(wsA.id, viewerA, "viewer");

const stripe = new Stripe(SK_TEST);
function sign(payload: string): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC_TEST });
}
function sessionPayload(opts: {
  sessionId: string;
  workspaceId?: string;
  amountTotal?: number;
  currency?: string;
  paymentStatus?: string;
  packCredits?: string;
}): string {
  const obj: Record<string, unknown> = {
    id: opts.sessionId,
    object: "checkout.session",
    payment_status: opts.paymentStatus ?? "paid",
    amount_total: opts.amountTotal ?? 5000,
    currency: opts.currency ?? "usd",
    metadata: {
      packId: "topup-5000",
      packCredits: opts.packCredits ?? "5000",
      packPriceCents: String(opts.amountTotal ?? 5000),
    },
  };
  if (opts.workspaceId !== undefined) (obj.metadata as Record<string, string>).workspaceId = opts.workspaceId;
  return JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type: "checkout.session.completed",
    data: { object: obj },
  });
}
const sink = () => new StripeBillingSink({ secretKey: SK_TEST, webhookSecret: WHSEC_TEST });

// ── Pack table vs spec Appendix A ────────────────────────────────────────────
console.log("pack table");
check("two packs", TOP_UP_PACKS.length === 2);
check(
  "$50=5,000 / $200=22,000 (10% bonus)",
  TOP_UP_PACKS[0].priceCents === 5000 && TOP_UP_PACKS[0].credits === 5000 &&
    TOP_UP_PACKS[1].priceCents === 20000 && TOP_UP_PACKS[1].credits === 22000,
);
check("overage rate displays $0.012/credit", OVERAGE_RATE_DISPLAY === "$0.012/credit", OVERAGE_RATE_DISPLAY);
let threwUnknown = false;
try { packById("nope"); } catch { threwUnknown = true; }
check("unknown packId throws", threwUnknown);

// ── B7: unconfigured fail-closed ─────────────────────────────────────────────
console.log("unconfigured fail-closed");
{
  const dead = new StripeBillingSink({ secretKey: null, webhookSecret: null });
  const expectNotConfigured = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      check(name, false, "did not throw");
    } catch (e) {
      check(
        name,
        e instanceof BillingNotConfiguredError && /not configured/i.test(e.message) &&
          !e.message.includes("sk_") && !e.message.includes("whsec_"),
        e instanceof Error ? e.message.slice(0, 80) : "?",
      );
    }
  };
  await expectNotConfigured("createTopUpCheckout unconfigured", () =>
    dead.createTopUpCheckout({ workspaceId: wsA.id, packId: "topup-5000", successUrl: "https://x/s", cancelUrl: "https://x/c" }));
  await expectNotConfigured("handleWebhook unconfigured", () => dead.handleWebhook("{}", "sig"));
  await expectNotConfigured("purchaseTopUp unconfigured", () => dead.purchaseTopUp(wsA.id, 5000));
  await expectNotConfigured("billOverage unconfigured", () => dead.billOverage(wsA.id, 10, new Date()));
  // Half of the pair configured is still not configured.
  const half = new StripeBillingSink({ secretKey: SK_TEST, webhookSecret: null });
  await expectNotConfigured("webhook secret missing still fails closed", () => half.handleWebhook("{}", "sig"));
}

// ── createTopUpCheckout binds the authorized workspace ───────────────────────
console.log("checkout creation");
{
  let captured: Record<string, unknown> = {};
  const fake = new Stripe(SK_TEST) as unknown as Record<string, unknown>;
  fake.checkout = {
    sessions: {
      create: async (params: Record<string, unknown>) => {
        captured = params;
        return { id: "cs_test_bound123", url: "https://checkout.stripe.com/pay/cs_test_bound123" };
      },
    },
  };
  const s = new StripeBillingSink({ secretKey: SK_TEST, webhookSecret: WHSEC_TEST, client: fake as unknown as Stripe });
  const res = await s.createTopUpCheckout({
    workspaceId: wsA.id,
    packId: "topup-5000",
    successUrl: "https://app/usage?topup=success",
    cancelUrl: "https://app/usage?topup=cancelled",
  });
  check("returns checkout url + session id", res.url.includes("checkout.stripe.com") && res.sessionId === "cs_test_bound123");
  const md = (captured.metadata ?? {}) as Record<string, string>;
  check("metadata.workspaceId = authorized workspace", md.workspaceId === wsA.id, md.workspaceId);
  check("metadata carries pack credits", md.packCredits === "5000" && md.packPriceCents === "5000");
  check("mode=payment usd 5000", (captured.mode as string) === "payment" &&
    ((captured.line_items as Array<Record<string, Record<string, number | string>>>)[0].price_data.unit_amount as number) === 5000);
  let threw = false;
  try {
    await s.createTopUpCheckout({ workspaceId: wsA.id, packId: "bogus", successUrl: "https://a", cancelUrl: "https://b" });
  } catch { threw = true; }
  check("unknown pack rejected at checkout creation", threw);
  threw = false;
  try {
    await s.createTopUpCheckout({ workspaceId: wsA.id, packId: "topup-5000", successUrl: "javascript:alert(1)", cancelUrl: "https://b" });
  } catch { threw = true; }
  check("non-http(s) successUrl rejected", threw);
}

// ── B1: webhook forgery ──────────────────────────────────────────────────────
console.log("webhook forgery");
{
  const before = await purchasedOf(wsA.id);
  const payload = sessionPayload({ sessionId: `cs_test_forge_${randomUUID().slice(0, 8)}`, workspaceId: wsA.id });
  const r1 = await sink().handleWebhook(payload, "t=123,v1=deadbeef");
  check("bad signature rejected", !r1.ok && r1.reason === "invalid_signature");
  const r2 = await sink().handleWebhook(payload, null);
  check("missing signature rejected", !r2.ok && r2.reason === "missing_signature");
  // Tamper after signing.
  const tampered = payload.replace("5000", "5001");
  const r3 = await sink().handleWebhook(tampered, sign(payload));
  check("tampered payload rejected", !r3.ok && r3.reason === "invalid_signature");
  // Signed with the WRONG secret (e.g. test secret against live endpoint).
  const wrongSecretSig = new Stripe(SK_TEST).webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
  const r4 = await sink().handleWebhook(payload, wrongSecretSig);
  check("wrong-secret signature rejected", !r4.ok && r4.reason === "invalid_signature");
  check("nothing applied on forgery", (await purchasedOf(wsA.id)) === before);
  check("no key material in rejection", !JSON.stringify(r1).includes(WHSEC_TEST));
}

// ── B2: replay idempotency (incl. concurrent) ─────────────────────────────────
console.log("replay idempotency");
{
  const sid = `cs_test_replay_${randomUUID().slice(0, 8)}`;
  const payload = sessionPayload({ sessionId: sid, workspaceId: wsA.id });
  const sig = sign(payload);
  const before = await purchasedOf(wsA.id);
  const r1 = await sink().handleWebhook(payload, sig);
  check("first delivery applies", r1.ok && r1.applied?.credits === 5000 && r1.applied?.alreadyApplied === false);
  check("ledger credited once", (await purchasedOf(wsA.id)) === before + 5000);
  const r2 = await sink().handleWebhook(payload, sig);
  check("replay returns already_applied", r2.ok && r2.applied?.alreadyApplied === true);
  check("replay does not double-apply", (await purchasedOf(wsA.id)) === before + 5000);
  // Concurrent double-delivery.
  const sid2 = `cs_test_race_${randomUUID().slice(0, 8)}`;
  const p2 = sessionPayload({ sessionId: sid2, workspaceId: wsA.id });
  const sig2 = sign(p2);
  const mid = await purchasedOf(wsA.id);
  const [c1, c2] = await Promise.all([sink().handleWebhook(p2, sig2), sink().handleWebhook(p2, sig2)]);
  const fresh = [c1, c2].filter((r) => r.ok && r.applied?.alreadyApplied === false).length;
  check("concurrent pair: exactly one fresh application", fresh === 1, JSON.stringify([c1.applied, c2.applied]));
  check("concurrent pair: ledger credited once", (await purchasedOf(wsA.id)) === mid + 5000);
}

// ── B3: cross-workspace session confusion ─────────────────────────────────────
console.log("cross-workspace");
{
  // Same session id already applied to wsA (from the replay test above use a fresh one).
  const sid = `cs_test_xws_${randomUUID().slice(0, 8)}`;
  const pA = sessionPayload({ sessionId: sid, workspaceId: wsA.id });
  const rA = await sink().handleWebhook(pA, sign(pA));
  check("session applied to wsA", rA.ok && rA.applied?.workspaceId === wsA.id);
  const beforeB = await purchasedOf(wsB.id);
  // Attacker re-signs the same session id with wsB metadata (valid signature,
  // wrong workspace binding) — must be rejected, never cross-applied.
  const pB = sessionPayload({ sessionId: sid, workspaceId: wsB.id });
  const rB = await sink().handleWebhook(pB, sign(pB));
  check("cross-workspace session application rejected", !rB.ok && rB.reason === "workspace_mismatch", rB.reason);
  check("wsB balance untouched", (await purchasedOf(wsB.id)) === beforeB);
  // Missing workspace metadata.
  const pNoWs = sessionPayload({ sessionId: `cs_test_nows_${randomUUID().slice(0, 8)}` });
  const rNoWs = await sink().handleWebhook(pNoWs, sign(pNoWs));
  check("missing workspace metadata rejected", !rNoWs.ok && rNoWs.reason === "missing_workspace");
}

// ── B4: amount tampering ──────────────────────────────────────────────────────
console.log("amount tampering");
{
  const mk = (over: Parameters<typeof sessionPayload>[0]) => {
    const p = sessionPayload(over);
    return sink().handleWebhook(p, sign(p));
  };
  const before = await purchasedOf(wsA.id);
  const r1 = await mk({ sessionId: `cs_test_amt1_${randomUUID().slice(0, 8)}`, workspaceId: wsA.id, amountTotal: 9999 });
  check("unknown amount rejected", !r1.ok && r1.reason === "unknown_amount", r1.reason);
  const r2 = await mk({ sessionId: `cs_test_amt2_${randomUUID().slice(0, 8)}`, workspaceId: wsA.id, amountTotal: 5000, packCredits: "22000" });
  check("credit mismatch rejected", !r2.ok && r2.reason === "credit_mismatch", r2.reason);
  const r3 = await mk({ sessionId: `cs_test_amt3_${randomUUID().slice(0, 8)}`, workspaceId: wsA.id, currency: "eur" });
  check("non-usd currency rejected", !r3.ok && r3.reason === "bad_currency", r3.reason);
  const r4 = await mk({ sessionId: `cs_test_amt4_${randomUUID().slice(0, 8)}`, workspaceId: wsA.id, paymentStatus: "unpaid" });
  check("unpaid session ignored", r4.ok && r4.ignored === true);
  const r5 = await sink().handleWebhook(
    JSON.stringify({ id: "evt_x", object: "event", type: "charge.succeeded", data: { object: {} } }),
    sign(JSON.stringify({ id: "evt_x", object: "event", type: "charge.succeeded", data: { object: {} } })),
  );
  check("non-checkout event ignored", r5.ok && r5.ignored === true);
  check("nothing applied on amount abuse", (await purchasedOf(wsA.id)) === before);
  // The $200 pack applies 22,000 (bonus) — paid amount is the authority.
  const sid = `cs_test_big_${randomUUID().slice(0, 8)}`;
  const pBig = JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sid,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 20000,
        currency: "usd",
        metadata: { workspaceId: wsA.id, packId: "topup-22000", packCredits: "22000", packPriceCents: "20000" },
      },
    },
  });
  const rBig = await sink().handleWebhook(pBig, sign(pBig));
  check("$200 pack credits 22,000", rBig.ok && rBig.applied?.credits === 22000, JSON.stringify(rBig.applied));
}

// ── B5: opt-in privilege ──────────────────────────────────────────────────────
console.log("overage opt-in privilege");
{
  const rOut = await setOverageForUser({ userId: outsider, workspaceId: wsA.id, enabled: true });
  check("outsider denied (404)", rOut.status === 404, String(rOut.status));
  const rView = await setOverageForUser({ userId: viewerA, workspaceId: wsA.id, enabled: true });
  check("viewer denied (403)", rView.status === 403, String(rView.status));
  const capBefore = await prisma.spendCap.findUnique({ where: { workspaceId: wsA.id } });
  const rAdmin = await setOverageForUser({ userId: adminA, workspaceId: wsA.id, enabled: true });
  check("admin can opt in", rAdmin.status === 200 && (rAdmin.body as { autoOverage: boolean }).autoOverage === true);
  const capOn = await prisma.spendCap.findUnique({ where: { workspaceId: wsA.id } });
  check("opt-in sets autoOverage flag", capOn?.autoOverage === true);
  const audit = await prisma.fileChangeLog.findFirst({
    where: { workspaceId: wsA.id, filePath: "billing/auto-overage" },
    orderBy: { createdAt: "desc" },
  });
  check("toggle is audit-logged", !!audit && audit.summary.includes("auto-overage") && audit.summary.includes("opted in"));
  const rOff = await setOverageForUser({ userId: adminA, workspaceId: wsA.id, enabled: false });
  check("admin can opt out", rOff.status === 200 && (rOff.body as { autoOverage: boolean }).autoOverage === false);
  const capOff = await prisma.spendCap.findUnique({ where: { workspaceId: wsA.id } });
  check("opt-out clears autoOverage (hard cap default)", capOff?.autoOverage === false);
  void capBefore;
}

// ── Default opt-out + status/history ──────────────────────────────────────────
console.log("defaults and history");
{
  const wsC = await makeWorkspace();
  const st = await getBillingStatus(wsC.id);
  check("auto-overage defaults off", st.autoOverage === false);
  check("status exposes no secrets", !JSON.stringify(st).match(/sk_test|whsec/i));
  check("status carries packs", st.packs.length === 2);
  const hist = await getTopUpHistory(wsA.id);
  check("purchase history lists applied top-ups", hist.length >= 3 && hist.every((h) => h.credits > 0 && h.amountCents > 0));
  check("history newest-first", hist.every((h, i, a) => i === 0 || a[i - 1].appliedAt >= h.appliedAt));
  // setAutoOverage bridge (no Stripe needed — it flips metering state).
  const t = await setAutoOverage({ workspaceId: wsC.id, enabled: true, actorId: "battery" });
  check("setAutoOverage bridge enables", t.autoOverage === true);
  const t2 = await setAutoOverage({ workspaceId: wsC.id, enabled: false });
  check("setAutoOverage bridge disables", t2.autoOverage === false);
}

// ── purchaseTopUp / billOverage fail-closed semantics ──────────────────────────
console.log("sink interface semantics");
{
  const s = sink();
  let m1 = "";
  try { await s.purchaseTopUp(wsA.id, 5000); } catch (e) { m1 = e instanceof Error ? e.message : ""; }
  check("purchaseTopUp directs to Checkout", /createTopUpCheckout/i.test(m1), m1.slice(0, 60));
  let m2 = "";
  try { await s.billOverage(wsA.id, 100, new Date()); } catch (e) { m2 = e instanceof Error ? e.message : ""; }
  check("billOverage fails closed (follow-up)", /not yet wired/i.test(m2), m2.slice(0, 60));
  check("sink name is stripe", s.name === "stripe");
}

// ── B6: no mode flag to confuse (static) ───────────────────────────────────────
console.log("mode confusion (static)");
{
  const src = await import("node:fs").then((fs) => fs.readFileSync("lib/metering/billing.ts", "utf8"));
  check("no test/live mode flag in billing.ts", !/testmode|isLiveMode|stripeMode/i.test(src));
  check("secrets only from env", /process\.env\.STRIPE_SECRET_KEY/.test(src) && /process\.env\.STRIPE_WEBHOOK_SECRET/.test(src));
}

await prisma.$disconnect();
console.log(`\nverify-billing: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join("; "));
  process.exit(1);
}
