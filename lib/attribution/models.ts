// Marketr — Revenue attribution (C2): credit models.
//
// v1: first-touch, last-touch, linear. (Time-decay / position-based later.)
//
// Money math is integer cents throughout: a lead's revenue is split across
// its touches by rounding down each share and dealing the remainder one cent
// at a time to the earliest touches, so per-touch cents always sum exactly
// to the lead's revenue. Customer credit is fractional under linear (a lead
// won via 3 touches counts 1/3 of a customer per channel).

export type AttributionModel = "first_touch" | "last_touch" | "linear";

export const ATTRIBUTION_MODELS: AttributionModel[] = ["first_touch", "last_touch", "linear"];

export function isAttributionModel(m: unknown): m is AttributionModel {
  return m === "first_touch" || m === "last_touch" || m === "linear";
}

/** Minimal touch shape the math needs; callers sort per lead by occurredAt. */
export interface ModelTouch {
  id: string;
  leadId: string;
  channel: string;
  campaign: string | null;
  contentId: string | null;
  occurredAt: Date;
}

/** 0/1 share per touch under the model (index-aligned with `touches`). */
export function touchShares(n: number, model: AttributionModel): number[] {
  if (n <= 0) return [];
  if (model === "first_touch") return Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
  if (model === "last_touch") return Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : 0));
  return new Array(n).fill(1 / n);
}

/**
 * Split revenueCents across n touches. Integer cents; the remainder goes to
 * the earliest touches so the output always sums exactly to revenueCents.
 */
export function splitRevenue(revenueCents: number, n: number): number[] {
  if (n <= 0) return [];
  const rev = Math.max(0, Math.round(revenueCents));
  const base = Math.floor(rev / n);
  const out = new Array(n).fill(base);
  let remainder = rev - base * n;
  for (let i = 0; remainder > 0; i = (i + 1) % n, remainder--) out[i] += 1;
  return out;
}

/**
 * Per-touch credit in cents under each model (index-aligned).
 *
 * First-touch puts the full revenue on the first touch, last-touch puts it
 * on the last touch, and linear splits integer cents evenly. Never split
 * first and then multiply by shares — that undercredits every model.
 */
export function creditByModel(
  touches: ModelTouch[],
  revenueCents: number,
): Record<AttributionModel, number[]> {
  const n = touches.length;
  const rev = Math.max(0, Math.round(revenueCents));
  return {
    first_touch: touches.map((_, i) => (i === 0 ? rev : 0)),
    last_touch: touches.map((_, i) => (i === n - 1 ? rev : 0)),
    linear: splitRevenue(rev, n),
  };
}

export interface ChannelStats {
  channel: string;
  /** Distinct leads with ≥1 touch on the channel (model-independent). */
  leads: number;
  spendCents: number;
  /** spend / leads; null when spend is 0 or there are no leads. */
  cplCents: number | null;
  /** Attributed customers (fractional under linear). */
  customers: number;
  /** spend / customers; null when spend is 0 or no customers. */
  cacCents: number | null;
  revenueCents: number;
  /** revenue / spend; null when spend is 0. */
  roas: number | null;
}

export interface CampaignStats extends ChannelStats {
  campaign: string | null;
}

export interface ContentStats {
  contentId: string;
  touches: number;
  leads: number;
  customers: number;
  revenueCents: number;
}

export interface ReportTotals {
  leads: number;
  customers: number;
  attributedRevenueCents: number;
  /** Won revenue on leads with no touches at all (measurement blind spot). */
  unattributedRevenueCents: number;
  spendCents: number;
  cplCents: number | null;
  cacCents: number | null;
  roas: number | null;
}

function div(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

interface Agg {
  leads: Set<string>;
  customers: number;
  revenueCents: number;
}

function newAgg(): Agg {
  return { leads: new Set(), customers: 0, revenueCents: 0 };
}

function toStats(channel: string, agg: Agg, spendCents: number): ChannelStats {
  const leads = agg.leads.size;
  const customers = agg.customers;
  return {
    channel,
    leads,
    spendCents,
    cplCents: spendCents > 0 && leads > 0 ? Math.round(spendCents / leads) : null,
    customers: Math.round(customers * 1000) / 1000,
    cacCents: spendCents > 0 && customers > 0 ? Math.round(spendCents / customers) : null,
    revenueCents: agg.revenueCents,
    roas: div(agg.revenueCents, spendCents),
  };
}

/**
 * The full attribution computation. Pure function of its inputs so the
 * battery can assert exact credit splits.
 *
 * - touches: workspace-scoped touches in the report window, any order.
 * - revenueByLead: leadId → revenue cents (won leads only; see
 *   lib/attribution/revenue.ts leadRevenueCents).
 * - spendByChannel: channel → cents for spend periods overlapping the window.
 * - spendByCampaign: "channel::campaign" → cents (campaign-scoped spend).
 *
 * Touches are grouped per lead and ordered by (occurredAt, id) before the
 * model is applied, so first/last are deterministic.
 */
export function computeReport(opts: {
  touches: ModelTouch[];
  revenueByLead: Map<string, number>;
  spendByChannel: Map<string, number>;
  spendByCampaign: Map<string, number>;
  /**
   * Won revenue on leads with no touches in the window (the measurement
   * blind spot). Computed by the caller — this function only ever sees
   * touched leads.
   */
  untouchedRevenueCents?: number;
}): Record<AttributionModel, { channels: ChannelStats[]; campaigns: CampaignStats[]; totals: ReportTotals }> {
  const { touches, revenueByLead, spendByChannel, spendByCampaign, untouchedRevenueCents = 0 } = opts;

  // Group touches per lead, ordered deterministically.
  const byLead = new Map<string, ModelTouch[]>();
  for (const t of touches) {
    const list = byLead.get(t.leadId) ?? [];
    list.push(t);
    byLead.set(t.leadId, list);
  }
  for (const list of byLead.values()) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
  }

  const out = {} as Record<AttributionModel, { channels: ChannelStats[]; campaigns: CampaignStats[]; totals: ReportTotals }>;

  for (const model of ATTRIBUTION_MODELS) {
    const chAgg = new Map<string, Agg>();
    const cpAgg = new Map<string, Agg>(); // key: channel + "\n" + campaign
    const allLeads = new Set<string>();

    const getCh = (c: string) => {
      let a = chAgg.get(c);
      if (!a) { a = newAgg(); chAgg.set(c, a); }
      return a;
    };
    const getCp = (c: string, cp: string | null) => {
      const k = `${c}\n${cp ?? ""}`;
      let a = cpAgg.get(k);
      if (!a) { a = newAgg(); cpAgg.set(k, a); }
      return a;
    };

    for (const [leadId, list] of byLead) {
      const revenue = revenueByLead.get(leadId) ?? 0;
      allLeads.add(leadId);
      const revenueCredit = creditByModel(list, revenue)[model];
      const customerShares =
        revenue > 0 ? touchShares(list.length, model) : new Array(list.length).fill(0);
      list.forEach((t, i) => {
        const ch = getCh(t.channel);
        ch.leads.add(leadId);
        ch.revenueCents += revenueCredit[i];
        ch.customers += customerShares[i];
        const cp = getCp(t.channel, t.campaign);
        cp.leads.add(leadId);
        cp.revenueCents += revenueCredit[i];
        cp.customers += customerShares[i];
      });
    }

    const channels: ChannelStats[] = [...chAgg.entries()]
      .map(([channel, a]) => toStats(channel, a, spendByChannel.get(channel) ?? 0))
      .sort((x, y) => y.revenueCents - x.revenueCents || x.channel.localeCompare(y.channel));

    const campaigns: CampaignStats[] = [...cpAgg.entries()]
      .map(([k, a]) => {
        const [channel, campaign] = k.split("\n");
        const spend = spendByCampaign.get(`${channel}::${campaign}`) ?? 0;
        const s = toStats(channel, a, spend);
        return { ...s, campaign: campaign || null };
      })
      .sort((x, y) => y.revenueCents - x.revenueCents || (x.campaign ?? "").localeCompare(y.campaign ?? ""));

    const attributedRevenue = channels.reduce((s, c) => s + c.revenueCents, 0);
    const spendTotal = [...spendByChannel.values()].reduce((s, v) => s + v, 0);
    const modelCustomers = channels.reduce((s, c) => s + c.customers, 0);

    out[model] = {
      channels,
      campaigns,
      totals: {
        leads: allLeads.size,
        customers: Math.round(modelCustomers * 1000) / 1000,
        attributedRevenueCents: attributedRevenue,
        unattributedRevenueCents: untouchedRevenueCents,
        spendCents: spendTotal,
        cplCents: spendTotal > 0 && allLeads.size > 0 ? Math.round(spendTotal / allLeads.size) : null,
        cacCents: spendTotal > 0 && modelCustomers > 0 ? Math.round(spendTotal / modelCustomers) : null,
        roas: div(attributedRevenue, spendTotal),
      },
    };
  }
  return out;
}

/** Revenue-influenced content: touches carrying a contentId, per model. */
export function computeContentReport(
  touches: ModelTouch[],
  revenueByLead: Map<string, number>,
  model: AttributionModel,
): ContentStats[] {
  const withContent = touches.filter((t) => t.contentId);
  const byLead = new Map<string, ModelTouch[]>();
  for (const t of withContent) {
    const list = byLead.get(t.leadId) ?? [];
    list.push(t);
    byLead.set(t.leadId, list);
  }
  for (const list of byLead.values()) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : 1));
  }
  const agg = new Map<string, { touches: number; leads: Set<string>; customers: number; revenueCents: number }>();
  for (const [leadId, list] of byLead) {
    const revenue = revenueByLead.get(leadId) ?? 0;
    const shares = touchShares(list.length, model);
    const splits = splitRevenue(revenue, list.length);
    list.forEach((t, i) => {
      const cid = t.contentId!;
      let a = agg.get(cid);
      if (!a) { a = { touches: 0, leads: new Set(), customers: 0, revenueCents: 0 }; agg.set(cid, a); }
      a.touches += 1;
      a.leads.add(leadId);
      a.revenueCents += Math.round(splits[i] * shares[i]);
      if (revenue > 0) a.customers += shares[i];
    });
  }
  return [...agg.entries()]
    .map(([contentId, a]) => ({
      contentId,
      touches: a.touches,
      leads: a.leads.size,
      customers: Math.round(a.customers * 1000) / 1000,
      revenueCents: a.revenueCents,
    }))
    .sort((x, y) => y.revenueCents - x.revenueCents);
}
