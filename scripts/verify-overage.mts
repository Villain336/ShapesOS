// Marketr — overage invoicing adversarial battery (hosted Stripe track).
//
// Run: DATABASE_URL=<redacted>
// Run 3x green before calling this done. Fully offline: Stripe signature
// verification uses the SDK's constructEvent with test secrets (pure
// crypto, no network); all other Stripe calls use an injected fake client.
//
// Covers THREAT-MODEL-BILLING.md abuse cases:
//   B9  overage accrual only under auto-overage; hard cap still blocks;
//       overage_credits marked factually (exact split, incl. straddle)
//   B10 customer-id binding (setup + invoice webhooks)
//   B11 payment-method hijacking; setup replay exactly-once; no card →
//       auto-overage enable denied (402, plain language)
//   B12 invoice replay / double-finalize (sequential + concurrent)
//   B13 webhook ordering: unknown invoice ignored; failed → surfaced;
//       signature still verified first
//   B15 threshold gaming: sub-$5 carries forward, never forgiven
// Plus: invoice items exactly match accrued overage; zero-overage months
// skipped; cross-workspace isolation; unconfigured fail-closed;
// billOverage completed-month vs in-progress semantics.
//
// NOTE: battery workspaces are uniquely named per run (zz-overage-battery-*)
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
  OverageCardRequiredError,
  hasPaymentMethod,
  getOverageState,
  overageCentsFor,
  MIN_OVERAGE_INVOICE_CENTS,
  OVERAGE_CENTS_PER_CREDIT,
} = billing;
const { meter } = await import("@/lib/metering/service");
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

const RUN = `zz-overage-battery-${Date.now()}-${process.pid}`;
// Short run-unique token for fake Stripe ids (must be unique per run so
// invoice rows from prior runs on a shared DB never collide).
const RUNID = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const uid = (s: string) => `batt-${process.pid}-${randomUUID().slice(0, 8)}-${s}`;

async function makeWorkspace(plan: "starter" | "pro" | "agency" | "self_hosted" = "starter") {
  return prisma.workspace.create({
    data: { name: `${RUN}-ws-${randomUUID().slice(0, 6)}`, ownerUserId: uid("owner"), plan },
  });
}
async function addMember(workspaceId: string, userId: string, role: "owner" | "admin" | "editor" | "viewer") {
  return prisma.workspaceMember.create({ data: { workspaceId, userId, role } });
}
async function overageSum(workspaceId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT SUM(overage_credits) AS total FROM usage_events WHERE workspace_id = ${workspaceId}`;
  return Number(rows[0]?.total ?? 0);
}
async function eventCount(workspaceId: string): Promise<number> {
  return prisma.usageEvent.count({ where: { workspaceId } });
}

// ── Fake Stripe client (offline) ─────────────────────────────────────────────

const realStripe = new Stripe(SK_TEST);
function sign(payload: string): string {
  return realStripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC_TEST });
}

interface FakeCalls {
  customersCreated: Array<Record<string, unknown>>;
  customersUpdated: Array<{ id: string; params: Record<string, unknown> }>;
  sessionsCreated: Array<Record<string, unknown>>;
  setupIntentsRetrieved: string[];
  invoiceItems: Array<{ params: Record<string, unknown>; idempotencyKey: string | undefined }>;
  invoicesCreated: Array<{ params: Record<string, unknown>; idempotencyKey: string | undefined }>;
  finalized: Array<{ id: string; idempotencyKey: string | undefined }>;
}

function makeFakeStripe() {
  const calls: FakeCalls = {
    customersCreated: [],
    customersUpdated: [],
    sessionsCreated: [],
    setupIntentsRetrieved: [],
    invoiceItems: [],
    invoicesCreated: [],
    finalized: [],
  };
  let n = 0;
  const fake = {
    customers: {
      create: async (p: Record<string, unknown>) => {
        calls.customersCreated.push(p);
        return { id: "cus_test_123", ...p };
      },
      update: async (id: string, p: Record<string, unknown>) => {
        calls.customersUpdated.push({ id, params: p });
        return { id };
      },
    },
    checkout: {
      sessions: {
        create: async (p: Record<string, unknown>) => {
          calls.sessionsCreated.push(p);
          n += 1;
          return { id: `cs_test_setup_${RUNID}_${n}`, url: `https://checkout.stripe.com/setup/test${n}` };
        },
      },
    },
    setupIntents: {
      retrieve: async (id: string) => {
        calls.setupIntentsRetrieved.push(id);
        return { id, payment_method: "pm_test_123" };
      },
    },
    invoiceItems: {
      create: async (p: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        calls.invoiceItems.push({ params: p, idempotencyKey: opts?.idempotencyKey });
        return { id: `ii_test_${calls.invoiceItems.length}` };
      },
    },
    invoices: {
      create: async (p: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        calls.invoicesCreated.push({ params: p, idempotencyKey: opts?.idempotencyKey });
        // Run-unique: the battery may share a DB across runs, and invoice
        // rows are looked up by Stripe id (webhook tests), so a per-run
        // counter alone would collide with prior runs' rows.
        return { id: `in_test_${RUNID}_${calls.invoicesCreated.length}` };
      },
      finalizeInvoice: async (id: string, _p: unknown, opts?: { idempotencyKey?: string }) => {
        calls.finalized.push({ id, idempotencyKey: opts?.idempotencyKey });
        return {
          id,
          hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
          invoice_pdf: `https://invoice.stripe.com/i/${id}/pdf`,
          status: "open",
        };
      },
    },
    // Real crypto for signature verification (no network).
    webhooks: realStripe.webhooks,
  };
  return { fake: fake as unknown as Stripe, calls };
}

const { fake, calls } = makeFakeStripe();
const sink = () => new StripeBillingSink({ secretKey: SK_TEST, webhookSecret: WHSEC_TEST, client: fake });

// Billing "configured" for this battery = env keys present (in-process only).
const savedSK = process.env.STRIPE_SECRET_KEY;
const savedWH = process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = SK_TEST;
process.env.STRIPE_WEBHOOK_SECRET = WHSEC_TEST;

function setupEventPayload(opts: {
  sessionId: string;
  workspaceId?: string;
  customer?: string;
  setupIntent?: string;
}): string {
  const obj: Record<string, unknown> = {
    id: opts.sessionId,
    object: "checkout.session",
    mode: "setup",
    payment_status: "complete",
    customer: opts.customer ?? "cus_test_123",
    setup_intent: opts.setupIntent ?? "seti_test_1",
    metadata: { kind: "overage-payment-method" },
  };
  if (opts.workspaceId !== undefined)
    (obj.metadata as Record<string, string>).workspaceId = opts.workspaceId;
  return JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type: "checkout.session.completed",
    data: { object: obj },
  });
}

function invoiceEventPayload(type: "invoice.paid" | "invoice.payment_failed", opts: {
  invoiceId: string;
  customer?: string;
}): string {
  return JSON.stringify({
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type,
    data: {
      object: {
        id: opts.invoiceId,
        object: "invoice",
        customer: opts.customer ?? "cus_test_123",
      },
    },
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const wsOver = await makeWorkspace(); // auto-overage + card
const wsHard = await makeWorkspace(); // hard cap (default)
const wsNoCard = await makeWorkspace(); // 402 test
const wsZero = await makeWorkspace(); // no-overage skip test
const wsSmall = await makeWorkspace(); // below-minimum test
const wsConc = await makeWorkspace(); // concurrent double-run test
const wsCardRemoved = await makeWorkspace(); // overage accrued, card then removed
const adminOver = uid("adminOver");
const adminNoCard = uid("adminNoCard");
const adminConc = uid("adminConc");
const adminSmall = uid("adminSmall");
const adminCardRemoved = uid("adminCardRemoved");
const adminZero = uid("adminZero");
await addMember(wsOver.id, adminOver, "admin");
await addMember(wsNoCard.id, adminNoCard, "admin");
await addMember(wsConc.id, adminConc, "admin");
await addMember(wsSmall.id, adminSmall, "admin");
await addMember(wsCardRemoved.id, adminCardRemoved, "admin");
await addMember(wsZero.id, adminZero, "admin");

/** Full arming: card on file (fake Stripe) + auto-overage enabled. */
async function armWorkspace(workspaceId: string, adminId: string): Promise<void> {
  await sink().createPaymentMethodCheckout({
    workspaceId,
    successUrl: "https://a/s",
    cancelUrl: "https://a/c",
  });
  const p = setupEventPayload({ sessionId: `cs_test_arm_${uid("s")}`, workspaceId });
  const w = await sink().handleWebhook(p, sign(p));
  if (!w.ok) throw new Error(`arm card failed: ${w.reason}`);
  const r = await setOverageForUser({ userId: adminId, workspaceId, enabled: true });
  if (r.status !== 200) throw new Error(`arm overage failed: ${r.status} ${JSON.stringify(r.body)}`);
}

const POOL = 2500; // starter plan included credits

let burnSeq = 0; // global — burn() must never reuse an idempotency key
async function burn(workspaceId: string, totalCredits: number, chunk = 100): Promise<void> {
  let remaining = totalCredits;
  while (remaining > 0) {
    const c = Math.min(chunk, remaining);
    const r = await meter({
      workspaceId,
      action: "rank_check",
      credits: c,
      idempotencyKey: `overage-batt:${RUN}:${workspaceId}:${burnSeq++}`,
    });
    if (!r.ok) break; // hard cap stopped us
    remaining -= c;
  }
}

// ── B11: card on file + setup webhook ────────────────────────────────────────
console.log("card on file");
{
  const res = await sink().createPaymentMethodCheckout({
    workspaceId: wsOver.id,
    successUrl: "https://app/usage?setup=success",
    cancelUrl: "https://app/usage?setup=cancelled",
  });
  check("setup checkout returns url", res.url.includes("checkout.stripe.com"));
  const sessParams = calls.sessionsCreated[0];
  check("setup mode", sessParams.mode === "setup");
  check(
    "metadata binds workspace",
    (sessParams.metadata as Record<string, string>).workspaceId === wsOver.id,
  );
  const custParams = calls.customersCreated[0];
  check(
    "customer created with workspace metadata",
    (custParams.metadata as Record<string, string>).workspaceId === wsOver.id,
  );
  const bw = await prisma.billingWorkspace.findUnique({ where: { workspaceId: wsOver.id } });
  check("customer id stored server-side", bw?.stripeCustomerId === "cus_test_123");

  const payload = setupEventPayload({ sessionId: `cs_test_setup_${uid("main")}`, workspaceId: wsOver.id });
  const r1 = await sink().handleWebhook(payload, sign(payload));
  check("setup webhook ok", r1.ok && r1.applied?.kind === "setup_completed");
  check("hasPaymentMethod true", await hasPaymentMethod(wsOver.id));
  const upd = calls.customersUpdated[0];
  check(
    "payment method set as default",
    upd?.id === "cus_test_123" &&
      (upd.params.invoice_settings as Record<string, string>).default_payment_method === "pm_test_123",
  );

  // Replay: exactly-once.
  const r2 = await sink().handleWebhook(payload, sign(payload));
  check("setup replay alreadyApplied", r2.ok && r2.applied?.alreadyApplied === true);
  check("no second attach on replay", calls.customersUpdated.length === 1);

  // Stripped workspace metadata → rejected.
  const bad = setupEventPayload({ sessionId: `cs_test_setup_${uid("nostrip")}` });
  const r3 = await sink().handleWebhook(bad, sign(bad));
  check("setup without workspace rejected", !r3.ok && r3.reason === "missing_workspace");

  // Customer mismatch vs stored binding → rejected (B10).
  const evil = setupEventPayload({
    sessionId: `cs_test_setup_${uid("evil")}`,
    workspaceId: wsOver.id,
    customer: "cus_evil_999",
  });
  const r4 = await sink().handleWebhook(evil, sign(evil));
  check("setup customer mismatch rejected", !r4.ok && r4.reason === "customer_mismatch");
  check("binding unchanged after mismatch", (await prisma.billingWorkspace.findUnique({ where: { workspaceId: wsOver.id } }))?.stripeCustomerId === "cus_test_123");

  // Forgery still rejected first.
  const r5 = await sink().handleWebhook(payload, "t=1,v1=deadbeef");
  check("setup forgery rejected", !r5.ok && r5.reason === "invalid_signature");
}

// ── B11: no card → auto-overage denied ───────────────────────────────────────
console.log("card required to enable");
{
  const r = await setOverageForUser({ userId: adminNoCard, workspaceId: wsNoCard.id, enabled: true });
  check("enable without card → 402", r.status === 402, String(r.status));
  check(
    "plain-language card message",
    typeof (r.body as { error?: string }).error === "string" &&
      /card/i.test((r.body as { error: string }).error),
    JSON.stringify(r.body).slice(0, 80),
  );
  const cap = await prisma.spendCap.findUnique({ where: { workspaceId: wsNoCard.id } });
  check("autoOverage stays off", cap?.autoOverage !== true);

  // Disabling never needs a card.
  const rOff = await setOverageForUser({ userId: adminNoCard, workspaceId: wsNoCard.id, enabled: false });
  check("disable without card ok", rOff.status === 200);

  // With a card, enabling works.
  const rOn = await setOverageForUser({ userId: adminOver, workspaceId: wsOver.id, enabled: true });
  check("enable with card → 200", rOn.status === 200 && (rOn.body as { autoOverage: boolean }).autoOverage === true);
}

// ── B9: accrual only under auto-overage ──────────────────────────────────────
console.log("overage accrual");
{
  await burn(wsOver.id, POOL + 500);
  const sum = await overageSum(wsOver.id);
  check("overage accrues exactly past the pool", sum === 500, `sum=${sum}`);

  await burn(wsHard.id, POOL + 500);
  const hardSum = await overageSum(wsHard.id);
  const hardEvents = await eventCount(wsHard.id);
  check("hard cap blocks: zero overage", hardSum === 0);
  check("hard cap blocks: events stop at pool", hardEvents === Math.ceil(POOL / 100));

  // In-cap charges mark zero.
  const inCap = await prisma.usageEvent.findFirst({
    where: { workspaceId: wsOver.id, overageCredits: 0 },
  });
  check("in-cap events mark zero overage", inCap !== null);

  // Cross-workspace: wsOver's overage is invisible to others.
  check("overage isolated per workspace", (await overageSum(wsNoCard.id)) === 0);
}

// ── B12: invoice + replay ────────────────────────────────────────────────────
console.log("invoicing");
// The battery's overage events occur "now" (this UTC month). Production cron
// passes monthStart(now) as the cutoff (completed months only); here we
// simulate the NEXT cron run so the just-accrued overage is billable.
const nowDate = new Date();
const cutoff = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1));
let firstInvoiceId = "";
{
  const before = { items: calls.invoiceItems.length, finalized: calls.finalized.length };
  const r = await sink().invoiceOverage(wsOver.id, cutoff);
  check("invoice created", r.status === "invoiced" && !r.alreadyApplied);
  check("item amount matches accrued overage", calls.invoiceItems[before.items]?.params.amount === overageCentsFor(500), String(calls.invoiceItems[before.items]?.params.amount));
  check("item is USD", calls.invoiceItems[before.items]?.params.currency === "usd");
  check(
    "Stripe idempotency keys present",
    typeof calls.invoiceItems[before.items]?.idempotencyKey === "string" &&
      typeof calls.finalized[before.finalized]?.idempotencyKey === "string",
  );
  check("one finalize call", calls.finalized.length === before.finalized + 1);
  firstInvoiceId = r.stripeInvoiceId ?? "";
  check("stripe invoice id returned", firstInvoiceId.startsWith("in_test_"));

  const row = await prisma.billingOverageInvoice.findFirst({ where: { stripeInvoiceId: firstInvoiceId } });
  check("invoice row finalized", row?.status === "finalized" && row?.overageCredits === 500);
  const expectedPeriod = new Date(cutoff.getTime() - 1).toISOString().slice(0, 7);
  check("period label is the completed month", row?.period === expectedPeriod, row?.period ?? "none");
  check("receipt links stored", !!row?.hostedInvoiceUrl && !!row?.invoicePdfUrl);
  const bw = await prisma.billingWorkspace.findUnique({ where: { workspaceId: wsOver.id } });
  check("watermark advanced to cutoff", bw?.lastOverageInvoicedThrough?.getTime() === cutoff.getTime());

  // Sequential replay.
  const r2 = await sink().invoiceOverage(wsOver.id, cutoff);
  check("replay already_invoiced", r2.status === "already_invoiced" && r2.alreadyApplied);
  check("no new Stripe calls on replay", calls.finalized.length === before.finalized + 1 && calls.invoiceItems.length === before.items + 1);
  check("one invoice row", (await prisma.billingOverageInvoice.count({ where: { workspaceId: wsOver.id } })) === 1);

  // Zero overage → skipped (card on file so we reach the ledger check).
  await armWorkspace(wsZero.id, adminZero);
  const rz = await sink().invoiceOverage(wsZero.id, cutoff);
  check("zero overage skipped", rz.status === "no_overage", rz.status);
  check("no invoice row for zero", (await prisma.billingOverageInvoice.count({ where: { workspaceId: wsZero.id } })) === 0);

  // Card removed after accrual → invoicing fails closed (no silent customer).
  await armWorkspace(wsCardRemoved.id, adminCardRemoved);
  await burn(wsCardRemoved.id, POOL + 500);
  await prisma.billingWorkspace.update({
    where: { workspaceId: wsCardRemoved.id },
    data: { hasPaymentMethod: false, stripeCustomerId: null },
  });
  const beforeCust = calls.customersCreated.length;
  const rNC = await sink().invoiceOverage(wsCardRemoved.id, cutoff);
  check("no card → no_payment_method", rNC.status === "no_payment_method", rNC.status);
  check("no customer silently created", calls.customersCreated.length === beforeCust);
  check("no invoice row without card", (await prisma.billingOverageInvoice.count({ where: { workspaceId: wsCardRemoved.id } })) === 0);
}

// ── B12: concurrent double-run ───────────────────────────────────────────────
console.log("concurrent double-run");
{
  // Arm wsConc with card + auto-overage, accrue ≥ $5 of overage.
  await armWorkspace(wsConc.id, adminConc);
  await burn(wsConc.id, POOL + 600);
  const n0 = calls.finalized.length;
  const [a, b] = await Promise.all([
    sink().invoiceOverage(wsConc.id, cutoff),
    sink().invoiceOverage(wsConc.id, cutoff),
  ]);
  const statuses = [a.status, b.status].sort().join(",");
  check("one wins, one replays", statuses === "already_invoiced,invoiced", statuses);
  check("single finalize under concurrency", calls.finalized.length === n0 + 1);
  check(
    "single row under concurrency",
    (await prisma.billingOverageInvoice.count({ where: { workspaceId: wsConc.id } })) === 1,
  );
}

// ── B15: below-minimum carries forward ───────────────────────────────────────
console.log("minimum threshold");
{
  check("minimum is $5.00", MIN_OVERAGE_INVOICE_CENTS === 500);
  await armWorkspace(wsSmall.id, adminSmall);
  await burn(wsSmall.id, POOL + 100); // $1.20 of overage
  const r1 = await sink().invoiceOverage(wsSmall.id, cutoff);
  check("sub-$5 skipped", r1.status === "below_minimum" && r1.overageCredits === 100);
  check("no row for sub-minimum", (await prisma.billingOverageInvoice.count({ where: { workspaceId: wsSmall.id } })) === 0);
  const bw1 = await prisma.billingWorkspace.findUnique({ where: { workspaceId: wsSmall.id } });
  check("watermark NOT advanced on skip", bw1?.lastOverageInvoicedThrough === null);

  await burn(wsSmall.id, 400); // +$4.80 → $6.00 total
  const r2 = await sink().invoiceOverage(wsSmall.id, cutoff);
  check("carried forward and billed together", r2.status === "invoiced" && r2.overageCredits === 500, `${r2.status} ${r2.overageCredits}`);
  check("amount is $6.00", r2.amountCents === 600, String(r2.amountCents));
}

// ── B13: invoice webhooks ────────────────────────────────────────────────────
console.log("invoice webhooks");
{
  const paidPayload = invoiceEventPayload("invoice.paid", { invoiceId: firstInvoiceId });
  const r1 = await sink().handleWebhook(paidPayload, sign(paidPayload));
  check("invoice.paid ok", r1.ok && r1.applied?.kind === "invoice_paid");
  const row1 = await prisma.billingOverageInvoice.findFirst({ where: { stripeInvoiceId: firstInvoiceId } });
  check("row marked paid", row1?.status === "paid");

  // Unknown invoice → ignored, never failed.
  const unknownPayload = invoiceEventPayload("invoice.paid", { invoiceId: "in_unknown_xyz" });
  const r2 = await sink().handleWebhook(unknownPayload, sign(unknownPayload));
  check("unknown invoice ignored", r2.ok && r2.ignored === true);
  check(
    "no row created for unknown",
    (await prisma.billingOverageInvoice.count({ where: { stripeInvoiceId: "in_unknown_xyz" } })) === 0,
  );

  // Customer mismatch → ignored.
  const evilPayload = invoiceEventPayload("invoice.paid", { invoiceId: firstInvoiceId, customer: "cus_evil_999" });
  const r3 = await sink().handleWebhook(evilPayload, sign(evilPayload));
  check("customer mismatch ignored", r3.ok && r3.ignored === true);
  const row3 = await prisma.billingOverageInvoice.findFirst({ where: { stripeInvoiceId: firstInvoiceId } });
  check("row untouched by mismatch", row3?.status === "paid");

  // Forgery rejected before any state change.
  const r4 = await sink().handleWebhook(paidPayload, "t=1,v1=deadbeef");
  check("invoice webhook forgery rejected", !r4.ok && r4.reason === "invalid_signature");

  // payment_failed → surfaced.
  const concRow = await prisma.billingOverageInvoice.findFirst({ where: { workspaceId: wsConc.id } });
  const failPayload = invoiceEventPayload("invoice.payment_failed", { invoiceId: concRow!.stripeInvoiceId! });
  const r5 = await sink().handleWebhook(failPayload, sign(failPayload));
  check("payment_failed ok", r5.ok && r5.applied?.kind === "invoice_failed");
  const row5 = await prisma.billingOverageInvoice.findFirst({ where: { id: concRow!.id } });
  check("row marked failed", row5?.status === "failed");
  const auditLogs = await prisma.fileChangeLog.findMany({
    where: { workspaceId: wsConc.id, filePath: "billing/overage-invoicing" },
  });
  check("failure audit-logged", auditLogs.some((a) => /payment FAILED/.test(a.summary)));
}

// ── billOverage semantics ────────────────────────────────────────────────────
console.log("billOverage");
{
  // Completed month → invoices (uses a fresh workspace to avoid the replay row).
  const wsPast = await makeWorkspace();
  const adminPast = uid("adminPast");
  await addMember(wsPast.id, adminPast, "admin");
  await armWorkspace(wsPast.id, adminPast);
  await burn(wsPast.id, POOL + 700);
  // Backdate the overage events into a FULLY completed month (August — the
  // battery's cutoff simulates the Oct 1 cron run, so September is still in
  // progress and correctly returns nothing_due).
  // The ledger trigger forbids UPDATEs — drop it for this test-only
  // manipulation and recreate it immediately after.
  const completedMonth = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - 2, 15));
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS usage_events_no_mutation ON "usage_events"`);
  await prisma.$executeRaw`UPDATE usage_events SET occurred_at = ${completedMonth} WHERE workspace_id = ${wsPast.id} AND overage_credits > 0`;
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER usage_events_no_mutation BEFORE UPDATE OR DELETE ON "usage_events" ` +
      `FOR EACH ROW EXECUTE FUNCTION prevent_usage_event_mutation()`,
  );
  const trig = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'usage_events_no_mutation') AS "exists"`;
  check("ledger trigger restored after backdate", trig[0]?.exists === true);
  const rPast = await sink().billOverage(wsPast.id, 0, completedMonth);
  check("completed month invoiced", rPast.status === "invoiced" && rPast.overageCredits === 700, `${rPast.status}`);
  check("providerRef is the Stripe invoice", (rPast.providerRef ?? "").startsWith("in_test_"));
  const pastRow = await prisma.billingOverageInvoice.findFirst({ where: { workspaceId: wsPast.id } });
  const expectedPastPeriod = new Date(completedMonth.getTime()).toISOString().slice(0, 7);
  check("billOverage period is the completed month", pastRow?.period === expectedPastPeriod, pastRow?.period ?? "none");

  // In-progress month → nothing_due (ledger decides, not the credits arg).
  const rNow = await sink().billOverage(wsPast.id, 99999, new Date());
  check("in-progress month nothing_due", rNow.status === "nothing_due" && rNow.providerRef === "");
}

// ── getOverageState (UI/status read) ─────────────────────────────────────────
console.log("overage state read");
{
  const st = await getOverageState(wsOver.id);
  check("state shows card on file", st.hasPaymentMethod === true);
  check("state shows paid invoice", st.invoices.some((i) => i.status === "paid" && i.overageCredits === 500));
  check("accrued is zero after invoicing", st.accruedCredits === 0, String(st.accruedCredits));
  const stSmall = await getOverageState(wsSmall.id);
  check("accrued carries post-invoice watermark", stSmall.accruedCredits === 0);
}

// ── B7: unconfigured fail-closed ─────────────────────────────────────────────
console.log("unconfigured fail-closed");
{
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const dead = new StripeBillingSink({ secretKey: null, webhookSecret: null });
  const expectNotConfigured = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      check(name, false, "did not throw");
    } catch (e) {
      check(name, e instanceof BillingNotConfiguredError, e instanceof Error ? e.message.slice(0, 60) : "?");
    }
  };
  await expectNotConfigured("invoiceOverage unconfigured", () => dead.invoiceOverage(wsOver.id, cutoff));
  await expectNotConfigured("createPaymentMethodCheckout unconfigured", () =>
    dead.createPaymentMethodCheckout({ workspaceId: wsOver.id, successUrl: "https://a/s", cancelUrl: "https://a/c" }));
  await expectNotConfigured("billOverage still fail-closed unconfigured", () => dead.billOverage(wsOver.id, 10, new Date()));
  await expectNotConfigured("handleWebhook unconfigured", () => dead.handleWebhook("{}", "sig"));

  // Unconfigured: the card gate is unconditional — no card, no auto-overage,
  // even with no Stripe keys (there is no card path, so the hard cap stays
  // on and overage cannot accrue unbilled).
  const wsPlain = await makeWorkspace();
  const adminPlain = uid("adminPlain");
  await addMember(wsPlain.id, adminPlain, "admin");
  const r = await setOverageForUser({ userId: adminPlain, workspaceId: wsPlain.id, enabled: true });
  check("unconfigured toggle denied without card", r.status === 402, String(r.status));
  const capPlain = await prisma.spendCap.findUnique({ where: { workspaceId: wsPlain.id } });
  check("unconfigured denial flips nothing", capPlain?.autoOverage !== true);

  process.env.STRIPE_SECRET_KEY = SK_TEST;
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC_TEST;
}

// ── restore env ──────────────────────────────────────────────────────────────
if (savedSK === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedSK;
if (savedWH === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = savedWH;

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
