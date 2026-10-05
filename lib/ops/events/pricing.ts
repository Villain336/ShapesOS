// ShapesOS — Phase 12 (people): event ticket rules. PURE (no I/O) — the
// registration service (lib/ops/events/registrations.ts) and the public page
// both read availability from here, so what the page shows is what the
// server enforces.
//
//   on sale   the ticket type is active, the event is published and hasn't
//             ended, and now is inside the sales window [start, end)
//   quantity  1 … maxPerOrder per registration, and never more than what is
//             left on the ticket type, its session and the event (capacity
//             is enforced again by the row-locked counters and DB CHECKs)
//   price     priceCents × quantity (0 = free; "comp" registrations by staff
//             are free whatever the price)

export interface TicketLike {
  priceCents: number;
  quantity: number | null;
  soldCount: number;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  maxPerOrder: number;
  active: boolean;
}

export interface CapacityLike {
  capacity: number | null;
  reservedCount: number;
}

export interface EventLike extends CapacityLike {
  status: string;
  startsAt: Date;
  endsAt: Date;
}

export type SaleState = "on_sale" | "not_started" | "ended" | "sold_out" | "inactive" | "event_closed";

export interface TicketAvailability {
  state: SaleState;
  /** Seats left for this ticket (null = no limit at any level). */
  remaining: number | null;
  /** Max a buyer can take in one registration right now. */
  maxNow: number;
  reason: string | null;
}

/** Seats left on a counter (null = unlimited). */
export function remainingOf(c: CapacityLike | null | undefined): number | null {
  if (!c || c.capacity == null) return null;
  return Math.max(0, c.capacity - c.reservedCount);
}

function minLeft(...vals: Array<number | null>): number | null {
  const nums = vals.filter((v): v is number => v !== null);
  return nums.length ? Math.min(...nums) : null;
}

export function ticketAvailability(t: TicketLike, event: EventLike, session: CapacityLike | null, now: Date): TicketAvailability {
  const remaining = minLeft(t.quantity == null ? null : Math.max(0, t.quantity - t.soldCount), remainingOf(session), remainingOf(event));
  const out = (state: SaleState, reason: string | null): TicketAvailability => ({
    state,
    remaining,
    maxNow: state === "on_sale" ? Math.min(t.maxPerOrder, remaining ?? t.maxPerOrder) : 0,
    reason,
  });
  if (event.status !== "published") return out("event_closed", "Registration is closed.");
  if (now.getTime() >= event.endsAt.getTime()) return out("event_closed", "This event has ended.");
  if (!t.active) return out("inactive", "This ticket isn't available.");
  if (t.salesStartAt && now.getTime() < t.salesStartAt.getTime()) return out("not_started", `Sales open ${t.salesStartAt.toISOString()}.`);
  if (t.salesEndAt && now.getTime() >= t.salesEndAt.getTime()) return out("ended", "Sales for this ticket have ended.");
  if (remaining !== null && remaining <= 0) return out("sold_out", "Sold out.");
  return out("on_sale", null);
}

export class TicketRuleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TicketRuleError";
    this.status = status;
  }
}

/** Validate a quantity against availability; returns the amount due (cents). */
export function priceRegistration(
  t: TicketLike,
  availability: TicketAvailability,
  quantity: number,
  opts: { comp?: boolean } = {},
): { unitPriceCents: number; amountCents: number } {
  if (!Number.isInteger(quantity) || quantity < 1) throw new TicketRuleError(400, "Choose at least one ticket");
  if (availability.state !== "on_sale") throw new TicketRuleError(409, availability.reason ?? "This ticket isn't on sale");
  if (quantity > t.maxPerOrder) throw new TicketRuleError(400, `At most ${t.maxPerOrder} per registration`);
  if (availability.remaining !== null && quantity > availability.remaining) {
    throw new TicketRuleError(409, availability.remaining === 0 ? "Sold out." : `Only ${availability.remaining} left.`);
  }
  const unit = opts.comp ? 0 : t.priceCents;
  const amount = unit * quantity;
  if (amount > 2_147_483_647) throw new TicketRuleError(400, "That order is too large");
  return { unitPriceCents: unit, amountCents: amount };
}

/** "Spring Launch Party 2026!" → "spring-launch-party-2026". */
export function slugifyEventTitle(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return s || "event";
}

export const EVENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Path segments under /events that are pages of their own, never event slugs. */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(["ticket", "tickets", "new"]);

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e) && e.length <= 320 ? e : null;
}
