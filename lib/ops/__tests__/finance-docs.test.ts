// ShapesOS — Phase 10 (finance): invoicing / quotes unit tests (no DB).
// Recurring cadence, quote conversion mapping, credit-note tax split, email
// delivery outcomes (fake transport stays labelled), Stripe key checks.
// Run: npx tsx --test lib/ops/__tests__/finance-docs.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advanceCadence, dueSlots } from "../finance/recurring";
import { quoteLinesToInvoice, quoteLinesToOrder } from "../finance/quotes";
import { proRataTax } from "../finance/invoicing";
import { deliverFinanceMail, renderFinanceEmail } from "../finance/delivery";
import { stripeKeyHint, validStripeSecret, validWebhookSecret } from "../finance/stripe";
import { buildFinanceDocument } from "../finance/pdf";

const d = (s: string) => new Date(s);

describe("recurring cadence", () => {
  it("weekly adds 7 × interval days", () => {
    assert.equal(advanceCadence(d("2026-10-05T09:00:00Z"), "weekly").toISOString(), "2026-10-12T09:00:00.000Z");
    assert.equal(advanceCadence(d("2026-10-05T09:00:00Z"), "weekly", 2).toISOString(), "2026-10-19T09:00:00.000Z");
  });
  it("monthly clamps to month end but keeps the anchor day", () => {
    const jan31 = d("2026-01-31T00:00:00Z");
    const feb = advanceCadence(jan31, "monthly", 1, 31);
    assert.equal(feb.toISOString(), "2026-02-28T00:00:00.000Z");
    assert.equal(advanceCadence(feb, "monthly", 1, 31).toISOString(), "2026-03-31T00:00:00.000Z");
  });
  it("quarterly and yearly (leap day clamps)", () => {
    assert.equal(advanceCadence(d("2026-11-15T00:00:00Z"), "quarterly").toISOString(), "2027-02-15T00:00:00.000Z");
    assert.equal(advanceCadence(d("2028-02-29T00:00:00Z"), "yearly", 1, 29).toISOString(), "2029-02-28T00:00:00.000Z");
  });
  it("dueSlots: every passed slot once, capped, stopping at endAt", () => {
    const s = { nextRunAt: d("2026-07-01T00:00:00Z"), cadence: "monthly" as const, intervalCount: 1, anchorDay: 1 };
    const r = dueSlots(s, d("2026-10-04T00:00:00Z"));
    assert.deepEqual(r.slots.map((x) => x.toISOString().slice(0, 10)), ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
    assert.equal(r.next.toISOString().slice(0, 10), "2026-11-01");
    assert.equal(dueSlots(s, d("2026-10-04T00:00:00Z"), 2).slots.length, 2);
    const ended = dueSlots({ ...s, endAt: d("2026-08-15T00:00:00Z") }, d("2026-10-04T00:00:00Z"));
    assert.equal(ended.slots.length, 2);
    assert.equal(dueSlots(s, d("2026-06-30T00:00:00Z")).slots.length, 0);
  });
});

describe("quote conversion", () => {
  const lines = [
    { description: "Website build", qty: 1, priceCents: 500_000, taxRateId: "tr_1", taxCents: 41_250, sku: "WEB" },
    { description: "Hosting (12 months)", qty: 12, priceCents: 2_000 },
  ];
  it("to invoice: copies description/qty/price and the tax rate (the invoice recomputes tax)", () => {
    assert.deepEqual(quoteLinesToInvoice(lines), [
      { description: "Website build", qty: 1, priceCents: 500_000, taxRateId: "tr_1" },
      { description: "Hosting (12 months)", qty: 12, priceCents: 2_000 },
    ]);
  });
  it("to order: { name, sku?, qty, priceCents }", () => {
    assert.deepEqual(quoteLinesToOrder(lines), [
      { name: "Website build", sku: "WEB", qty: 1, priceCents: 500_000 },
      { name: "Hosting (12 months)", qty: 12, priceCents: 2_000 },
    ]);
  });
});

describe("credit note tax split", () => {
  it("pro rata of the invoice's tax, half up", () => {
    assert.equal(proRataTax(5_500, 11_000, 1_000), 500);
    assert.equal(proRataTax(1_000, 10_825, 825), 76); // 76.2 → 76
    assert.equal(proRataTax(1_000, 10_000, 0), 0);
  });
});

describe("email delivery", () => {
  const mail = { to: "pat@example.com", subject: "Invoice INV-0001", text: "t", html: "<p>t</p>" };
  it("no recipient → no_recipient, nothing sent", async () => {
    const r = await deliverFinanceMail({ ...mail, to: null }, { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv });
    assert.equal(r.status, "no_recipient");
  });
  it("no mail channel outside production → the labelled fake transport (not 'sent')", async () => {
    const r = await deliverFinanceMail(mail, { env: { NODE_ENV: "development" } as NodeJS.ProcessEnv });
    assert.equal(r.status, "fake");
    assert.equal(r.channel, "fake");
  });
  it("no mail channel in production → not_configured", async () => {
    const r = await deliverFinanceMail(mail, { env: { NODE_ENV: "production" } as NodeJS.ProcessEnv });
    assert.equal(r.status, "not_configured");
  });
  it("SMTP configured → hands the message (with the PDF attachment) to the transport", async () => {
    const seen: unknown[] = [];
    const r = await deliverFinanceMail(
      { ...mail, attachment: { filename: "invoice-INV-0001.pdf", content: Buffer.from("%PDF") } },
      {
        env: { NODE_ENV: "production", SMTP_HOST: "smtp.example.com", SMTP_FROM: "billing@example.com" } as unknown as NodeJS.ProcessEnv,
        transport: async (channel, msg) => void seen.push({ channel, to: msg.to, from: msg.from, file: msg.attachment?.filename }),
      },
    );
    assert.equal(r.status, "sent");
    assert.deepEqual(seen, [{ channel: "smtp", to: "pat@example.com", from: "billing@example.com", file: "invoice-INV-0001.pdf" }]);
  });
  it("a transport failure is reported, never thrown", async () => {
    const r = await deliverFinanceMail(mail, {
      env: { RESEND_API_KEY: "re_x", INVITE_MAIL_FROM: "b@example.com" } as unknown as NodeJS.ProcessEnv,
      transport: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(r.status, "failed");
  });
  it("renders an escaped body with one black pill button", () => {
    const { html, text } = renderFinanceEmail({ heading: "Invoice <1>", paragraphs: ["a & b"], buttonLabel: "Pay online", buttonUrl: "https://pay.example.com/x" });
    assert.match(html, /Invoice &lt;1&gt;/);
    assert.match(html, /a &amp; b/);
    assert.match(text, /Pay online: https:\/\/pay\.example\.com\/x/);
  });
});

describe("tenant Stripe keys", () => {
  it("accepts secret / restricted keys and whsec secrets; hints never reveal the key", () => {
    assert.equal(validStripeSecret("sk_test_51Habcdefghijk"), true);
    assert.equal(validStripeSecret("rk_live_51Habcdefghijk"), true);
    assert.equal(validStripeSecret("pk_test_51Habcdefghijk"), false);
    assert.equal(validWebhookSecret("whsec_abcdefgh12345"), true);
    assert.equal(validWebhookSecret("sk_test_x"), false);
    const hint = stripeKeyHint("sk_test_51Habcdefghijk");
    assert.ok(!hint.includes("51Habcdefg"));
  });
});

describe("finance PDF document", () => {
  it("builds an invoice document element without rendering", () => {
    const el = buildFinanceDocument({
      kind: "Invoice",
      number: "INV-0001",
      issuedAt: new Date("2026-10-01T00:00:00Z"),
      dueAt: new Date("2026-10-31T00:00:00Z"),
      fromName: "Acme",
      toName: "Pat",
      lines: [{ description: "Work", qty: 2, priceCents: 5_000, taxCents: 825 }],
      subtotalCents: 10_000,
      taxCents: 825,
      totalCents: 10_825,
      paidCents: 825,
      balanceCents: 10_000,
    });
    assert.ok(el);
  });
});

import { validateExpenseLines } from "../finance/expenses";

describe("expense claim lines", () => {
  const ok = { spentAt: "2026-10-01", description: "Taxi", category: "travel", amountCents: 1_000, taxCents: 100 };
  it("totals valid lines", () => {
    assert.equal(validateExpenseLines([ok, { ...ok, amountCents: 500, taxCents: 0 }]).totalCents, 1_500);
  });
  it("rejects unknown categories, non-positive amounts, tax above the amount, bad dates and empty claims", () => {
    assert.throws(() => validateExpenseLines([{ ...ok, category: "yacht" }]), /unknown category/);
    assert.throws(() => validateExpenseLines([{ ...ok, amountCents: 0 }]), /positive/);
    assert.throws(() => validateExpenseLines([{ ...ok, taxCents: 1_001 }]), /tax/);
    assert.throws(() => validateExpenseLines([{ ...ok, spentAt: "soon" }]), /date/);
    assert.throws(() => validateExpenseLines([]), /at least one/);
  });
});
