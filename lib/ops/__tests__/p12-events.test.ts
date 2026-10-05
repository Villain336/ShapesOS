// ShapesOS — Phase 12 (people): pure event rules.
//   - ticket availability: sales window, inactive, unpublished / ended
//     event, sold out, the tightest of ticket / session / event capacity
//   - pricing: quantity bounds, seats left, comp, amount
//   - QR ticket tokens: sign / verify round trip, tamper, wrong secret, no
//     secret, extraction from a scanned URL; registration view tokens are a
//     different kind; the rendered QR decodes back to the ticket URL
//   - slugs, emails, and the ticket-sale posting rule balances
// Run: npx tsx --test lib/ops/__tests__/p12-events.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_SLUG_RE,
  RESERVED_EVENT_SLUGS,
  TicketRuleError,
  normalizeEmail,
  priceRegistration,
  remainingOf,
  slugifyEventTitle,
  ticketAvailability,
  type EventLike,
  type TicketLike,
} from "../events/pricing";
import {
  extractTicketToken,
  newTicketCode,
  renderTicketQr,
  sameTicketCode,
  signRegistrationView,
  signTicket,
  ticketUrl,
  verifyRegistrationView,
  verifyTicket,
} from "../events/tickets";
import { assertBalanced, eventTicketSaleLines } from "../accounting/rules";
import { scanTestQr } from "@/lib/studio/qr-designer";

const NOW = new Date("2026-05-01T12:00:00Z");
const ticket = (t: Partial<TicketLike> = {}): TicketLike => ({
  priceCents: 2500,
  quantity: 100,
  soldCount: 0,
  salesStartAt: null,
  salesEndAt: null,
  maxPerOrder: 10,
  active: true,
  ...t,
});
const event = (e: Partial<EventLike> = {}): EventLike => ({
  status: "published",
  startsAt: new Date("2026-06-01T17:00:00Z"),
  endsAt: new Date("2026-06-01T21:00:00Z"),
  capacity: null,
  reservedCount: 0,
  ...e,
});

describe("ticket availability", () => {
  it("is on sale inside the window with seats left", () => {
    const a = ticketAvailability(ticket(), event(), null, NOW);
    assert.equal(a.state, "on_sale");
    assert.equal(a.remaining, 100);
    assert.equal(a.maxNow, 10);
  });

  it("respects the sales window (start inclusive, end exclusive)", () => {
    assert.equal(ticketAvailability(ticket({ salesStartAt: new Date("2026-05-02T00:00:00Z") }), event(), null, NOW).state, "not_started");
    assert.equal(ticketAvailability(ticket({ salesStartAt: NOW }), event(), null, NOW).state, "on_sale");
    assert.equal(ticketAvailability(ticket({ salesEndAt: NOW }), event(), null, NOW).state, "ended");
    assert.equal(ticketAvailability(ticket({ salesEndAt: new Date("2026-05-01T12:00:01Z") }), event(), null, NOW).state, "on_sale");
  });

  it("closes for unpublished, cancelled or finished events and inactive tickets", () => {
    assert.equal(ticketAvailability(ticket(), event({ status: "draft" }), null, NOW).state, "event_closed");
    assert.equal(ticketAvailability(ticket(), event({ status: "cancelled" }), null, NOW).state, "event_closed");
    assert.equal(ticketAvailability(ticket(), event({ endsAt: NOW }), null, NOW).state, "event_closed");
    assert.equal(ticketAvailability(ticket({ active: false }), event(), null, NOW).state, "inactive");
    assert.equal(ticketAvailability(ticket(), event({ status: "draft" }), null, NOW).maxNow, 0);
  });

  it("takes the tightest of ticket, session and event capacity", () => {
    assert.equal(ticketAvailability(ticket({ quantity: 10, soldCount: 7 }), event({ capacity: 50, reservedCount: 45 }), { capacity: 20, reservedCount: 18 }, NOW).remaining, 2);
    assert.equal(ticketAvailability(ticket({ quantity: null }), event({ capacity: 50, reservedCount: 46 }), null, NOW).remaining, 4);
    assert.equal(ticketAvailability(ticket({ quantity: null }), event(), null, NOW).remaining, null);
    const full = ticketAvailability(ticket({ quantity: 5, soldCount: 5 }), event(), null, NOW);
    assert.equal(full.state, "sold_out");
    assert.equal(ticketAvailability(ticket(), event({ capacity: 3, reservedCount: 3 }), null, NOW).state, "sold_out");
    assert.equal(ticketAvailability(ticket({ maxPerOrder: 10 }), event({ capacity: 3, reservedCount: 0 }), null, NOW).maxNow, 3);
    assert.equal(remainingOf({ capacity: 2, reservedCount: 5 }), 0);
  });
});

describe("registration pricing", () => {
  const on = (t: TicketLike, e = event()) => ticketAvailability(t, e, null, NOW);

  it("prices quantity × unit price; comp seats are free", () => {
    const t = ticket();
    assert.deepEqual(priceRegistration(t, on(t), 3), { unitPriceCents: 2500, amountCents: 7500 });
    assert.deepEqual(priceRegistration(t, on(t), 3, { comp: true }), { unitPriceCents: 0, amountCents: 0 });
    const free = ticket({ priceCents: 0 });
    assert.deepEqual(priceRegistration(free, on(free), 2), { unitPriceCents: 0, amountCents: 0 });
  });

  it("refuses bad quantities, over-limit orders, closed sales and overselling", () => {
    const t = ticket({ quantity: 10, soldCount: 8, maxPerOrder: 4 });
    const err = (fn: () => unknown, status: number, re?: RegExp) =>
      assert.throws(fn, (e: unknown) => e instanceof TicketRuleError && e.status === status && (!re || re.test(e.message)));
    err(() => priceRegistration(t, on(t), 0), 400);
    err(() => priceRegistration(t, on(t), 1.5), 400);
    err(() => priceRegistration(ticket({ maxPerOrder: 4 }), on(ticket({ maxPerOrder: 4 })), 5), 400, /At most 4/);
    err(() => priceRegistration(t, on(t), 3), 409, /Only 2 left/);
    const closed = ticket({ salesEndAt: new Date("2026-04-01T00:00:00Z") });
    err(() => priceRegistration(closed, on(closed), 1), 409, /ended/);
    const sold = ticket({ quantity: 1, soldCount: 1 });
    err(() => priceRegistration(sold, on(sold), 1), 409, /Sold out/);
  });
});

describe("slugs and emails", () => {
  it("slugifies titles into valid, non-reserved event slugs", () => {
    assert.equal(slugifyEventTitle("Spring Launch Party 2026!"), "spring-launch-party-2026");
    assert.equal(slugifyEventTitle("Café — Über Night"), "cafe-uber-night");
    assert.equal(slugifyEventTitle("!!!"), "event");
    assert.ok(EVENT_SLUG_RE.test(slugifyEventTitle("x".repeat(200))));
    assert.ok(RESERVED_EVENT_SLUGS.has("ticket"));
  });

  it("normalises emails", () => {
    assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
    assert.equal(normalizeEmail("not-an-email"), null);
    assert.equal(normalizeEmail(42), null);
  });
});

describe("QR tickets", () => {
  const env = { AUTH_SECRET: "test-secret-0123456789abcdef0123456789" };
  const claims = { workspaceId: "ws_abc", eventId: "ev_123", attendeeId: "att_456", ticketCode: newTicketCode() };

  it("sign → verify round trip", () => {
    const t = signTicket(claims, env);
    assert.match(t, /^t1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(verifyTicket(t, env), claims);
  });

  it("rejects tampering, another secret, no secret and garbage", () => {
    const t = signTicket(claims, env);
    const [p, payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ w: "ws_abc", e: "ev_123", a: "att_OTHER", c: claims.ticketCode })).toString("base64url");
    assert.equal(verifyTicket(`${p}.${forged}.${sig}`, env), null);
    assert.equal(verifyTicket(`${p}.${payload}.${sig!.slice(0, -2)}xx`, env), null);
    assert.equal(verifyTicket(t, { AUTH_SECRET: "another-secret-abcdefabcdefabcdef" }), null);
    assert.equal(verifyTicket(t, {}), null);
    assert.equal(verifyTicket("t1.abc", env), null);
    assert.equal(verifyTicket(null, env), null);
    assert.throws(() => signTicket(claims, {}));
  });

  it("extracts the token from a scanned ticket URL", () => {
    const t = signTicket(claims, env);
    assert.equal(extractTicketToken(ticketUrl("https://app.example.com/", t)), t);
    assert.equal(extractTicketToken(`  ${t}\n`), t);
    assert.equal(extractTicketToken("https://example.com/nothing"), null);
  });

  it("registration view tokens are a different kind of token", () => {
    const v = signRegistrationView({ workspaceId: "ws_abc", registrationId: "reg_1" }, env);
    assert.deepEqual(verifyRegistrationView(v, env), { workspaceId: "ws_abc", registrationId: "reg_1" });
    assert.equal(verifyTicket(v, env), null);
    assert.equal(verifyRegistrationView(signTicket(claims, env), env), null);
    assert.equal(verifyRegistrationView(v, { AUTH_SECRET: "another-secret-abcdefabcdefabcdef" }), null);
  });

  it("ticket codes are random and compared in constant time", () => {
    const a = newTicketCode();
    assert.notEqual(a, newTicketCode());
    assert.ok(sameTicketCode(a, a));
    assert.ok(!sameTicketCode(a, newTicketCode()));
    assert.ok(!sameTicketCode(a, a.slice(1)));
  });

  it("renders a QR (Creative Studio engine) that decodes back to the ticket URL", () => {
    const url = ticketUrl("https://app.example.com", signTicket(claims, env));
    const qr = renderTicketQr(url);
    assert.ok(qr.png.length > 1000);
    assert.equal(scanTestQr(qr.png, url).passed, true);
  });
});

describe("ticket-sale posting", () => {
  it("Dr Cash / Cr Sales, balanced", () => {
    const lines = eventTicketSaleLines(7500);
    assert.equal(assertBalanced(lines), 7500);
    assert.deepEqual(lines.map((l) => ("key" in l.account ? l.account.key : l.account.id)), ["cash", "sales"]);
  });
});
