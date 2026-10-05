// ShapesOS Phase 10 (ops-core) — promotion rule evaluation (pure).
//
// OpsPromotion.rules is { percentOff?, amountOffCents?, minSubtotalCents?,
// productSkus? } (schema comment). Until now nothing evaluated them; this
// is the single evaluator the Promotions view previews with (and that a
// checkout can apply). Integer cents; the discount never exceeds the
// eligible subtotal and never goes negative.

export interface PromotionRules {
  percentOff?: number;
  amountOffCents?: number;
  minSubtotalCents?: number;
  productSkus?: string[];
}

export interface PromotionLike {
  code: string;
  rules: unknown;
  active: boolean;
  usageLimit: number | null;
  usedCount: number;
  // Phase 10 (store): optional validity window (null/undefined = open).
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
}

export interface PromoLine {
  sku?: string;
  qty: number;
  priceCents: number;
}

export type PromotionVerdict =
  | { ok: true; discountCents: number; eligibleSubtotalCents: number }
  | { ok: false; reason: string };

export function parsePromotionRules(raw: unknown): PromotionRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: PromotionRules = {};
  if (typeof r.percentOff === "number" && r.percentOff > 0) out.percentOff = Math.min(100, r.percentOff);
  if (typeof r.amountOffCents === "number" && r.amountOffCents > 0) out.amountOffCents = Math.floor(r.amountOffCents);
  if (typeof r.minSubtotalCents === "number" && r.minSubtotalCents > 0) out.minSubtotalCents = Math.floor(r.minSubtotalCents);
  if (Array.isArray(r.productSkus)) {
    const skus = r.productSkus.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (skus.length) out.productSkus = skus;
  }
  return out;
}

export function evaluatePromotion(promo: PromotionLike, lines: PromoLine[], now: Date = new Date()): PromotionVerdict {
  if (!promo.active) return { ok: false, reason: `Code ${promo.code} is inactive` };
  // Phase 10 (store): the active window.
  if (promo.startsAt && new Date(promo.startsAt).getTime() > now.getTime()) {
    return { ok: false, reason: `Code ${promo.code} isn't active yet` };
  }
  if (promo.endsAt && new Date(promo.endsAt).getTime() <= now.getTime()) {
    return { ok: false, reason: `Code ${promo.code} has expired` };
  }
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit) {
    return { ok: false, reason: `Code ${promo.code} has reached its usage limit` };
  }
  const rules = parsePromotionRules(promo.rules);
  const subtotal = lines.reduce((s, l) => s + l.qty * l.priceCents, 0);
  if (rules.minSubtotalCents && subtotal < rules.minSubtotalCents) {
    return { ok: false, reason: `Order subtotal is below the ${rules.minSubtotalCents}c minimum` };
  }
  const eligible = rules.productSkus
    ? lines.filter((l) => l.sku && rules.productSkus!.includes(l.sku)).reduce((s, l) => s + l.qty * l.priceCents, 0)
    : subtotal;
  if (eligible <= 0) return { ok: false, reason: "No line in the order is eligible for this code" };
  let discount = 0;
  if (rules.percentOff) discount += Math.floor((eligible * rules.percentOff) / 100);
  if (rules.amountOffCents) discount += rules.amountOffCents;
  discount = Math.max(0, Math.min(discount, eligible));
  if (discount === 0) return { ok: false, reason: "This code has no discount configured" };
  return { ok: true, discountCents: discount, eligibleSubtotalCents: eligible };
}
