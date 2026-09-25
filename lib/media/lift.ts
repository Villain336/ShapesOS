// Marketr — Phase 5 A1: branded-search lift dashboard.
//
// Methodology (docs/phase5-research.md §Track 5, Sep-2026 sources):
//   1. 4–6 week pre-campaign baseline of branded-query impressions/clicks
//      (Google Search Console).
//   2. Align exactly to flight dates; date-compare; segment by device
//      (billboards drive mobile) and geography — board metro vs holdout.
//   3. Separate search VOLUME from search CAPTURE (rising demand + flat CTR
//      = AI Overviews / competitors intercepting).
//   4. Run a geo-holdout, not before-and-after — the only way to credit the
//      OOH specifically. SMB budgets often can't buy enough geography for
//      holdouts: then the dashboard says so instead of claiming causation.
//   5. Google Trends as the free metro-level cross-check.
//   6. Direct traffic in GA4 aligned to flight dates (much of it is actually
//      search/AI overflow — 2026 analyses estimate AI-attributable sessions
//      under-counted ~3×).
//
// FAKE DEFAULT: FakeLiftProvider generates deterministic branded-search,
// direct-traffic and GBP series behind the LiftProvider interface. No live
// GSC/Trends OAuth pulls in v1 — the real adapters are declared but throw
// honest "not configured" errors.

import { createHash } from "node:crypto";

export type LiftSource = "gsc" | "gtrends" | "ga4" | "gbp";

export interface LiftDay {
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
  device: "mobile" | "desktop";
  metro: string;
}

export interface LiftQuery {
  /** Branded query root, e.g. "acme plumbing". */
  brandQuery: string;
  baselineStart: string;
  baselineEnd: string;
  flightStart: string;
  flightEnd: string;
  /** Metros carrying the OOH flight. */
  boardMetros: string[];
  /** Holdout metros (no OOH) — the only path to causal claims. */
  holdoutMetros: string[];
}

export interface MetroLift {
  metro: string;
  kind: "board" | "holdout";
  baselineDaily: number;
  flightDaily: number;
  liftPct: number | null;
}

export interface DeviceLift {
  device: "mobile" | "desktop";
  baselineDaily: number;
  flightDaily: number;
  liftPct: number | null;
}

export interface LiftResult {
  query: LiftQuery;
  source: LiftSource;
  baselineDays: number;
  flightDays: number;
  metros: MetroLift[];
  /** Net lift = board lift − holdout lift (diff-in-diff). Null without holdouts. */
  netLiftPct: number | null;
  hasHoldout: boolean;
  devices: DeviceLift[];
  /** Verdict text for the report card (directional, never causal). */
  verdict: string;
}

export interface DirectTrafficDay {
  date: string;
  sessions: number;
  metro: string;
}

export interface DirectTrafficLift {
  baselineDaily: number;
  flightDaily: number;
  liftPct: number | null;
  note: string;
}

export interface GbpDay {
  date: string;
  directionRequests: number;
  calls: number;
  websiteClicks: number;
}

export interface GbpLift {
  baseline: { directionRequests: number; calls: number; websiteClicks: number };
  flight: { directionRequests: number; calls: number; websiteClicks: number };
  liftPct: { directionRequests: number | null; calls: number | null; websiteClicks: number | null };
  note: string;
}

export interface LiftProvider {
  readonly name: string;
  /** Branded-search daily rows for baseline + flight windows. */
  getBrandedSearch(query: LiftQuery): Promise<LiftDay[]>;
  getDirectTraffic(query: LiftQuery): Promise<DirectTrafficDay[]>;
  getGbpActions(query: LiftQuery): Promise<GbpDay[]>;
}

// ---------------------------------------------------------------------------
// Deterministic fake data (seeded — stable across runs)
// ---------------------------------------------------------------------------

function seededRand(seed: string): () => number {
  let h = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 12), 16);
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function inFlight(date: string, q: LiftQuery): boolean {
  return date >= q.flightStart && date <= q.flightEnd;
}

export class FakeLiftProvider implements LiftProvider {
  readonly name = "fake" as const;

  async getBrandedSearch(query: LiftQuery): Promise<LiftDay[]> {
    this.assertQuery(query);
    const days = daysBetween(query.baselineStart, query.flightEnd);
    const metros = [
      ...query.boardMetros.map((m) => ({ metro: m, kind: "board" as const })),
      ...query.holdoutMetros.map((m) => ({ metro: m, kind: "holdout" as const })),
    ];
    const rows: LiftDay[] = [];
    for (const { metro, kind } of metros) {
      for (const device of ["mobile", "desktop"] as const) {
        const rand = seededRand(`gsc:${query.brandQuery}:${metro}:${device}`);
        const base = 40 + rand() * 60; // baseline daily impressions
        const mobileShare = device === "mobile" ? 0.68 : 0.32;
        for (const date of days) {
          const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
          const weekend = dow === 0 || dow === 6 ? 0.82 : 1.0;
          const noise = 0.88 + rand() * 0.24;
          // OOH drives branded search: board metros get a flight bump
          // (directional — the fake models +18% mobile, +6% desktop);
          // holdouts stay near baseline (tiny spillover).
          const bump = inFlight(date, query)
            ? kind === "board"
              ? device === "mobile" ? 1.18 : 1.06
              : 1.015
            : 1.0;
          const impressions = Math.max(1, Math.round(base * mobileShare * weekend * noise * bump));
          rows.push({
            date,
            impressions,
            clicks: Math.max(0, Math.round(impressions * (0.3 + rand() * 0.25))),
            device,
            metro,
          });
        }
      }
    }
    return rows;
  }

  async getDirectTraffic(query: LiftQuery): Promise<DirectTrafficDay[]> {
    this.assertQuery(query);
    const days = daysBetween(query.baselineStart, query.flightEnd);
    const out: DirectTrafficDay[] = [];
    for (const metro of query.boardMetros) {
      const rand = seededRand(`ga4:${query.brandQuery}:${metro}`);
      for (const date of days) {
        const bump = inFlight(date, query) ? 1.12 : 1.0;
        out.push({ date, metro, sessions: Math.max(1, Math.round((60 + rand() * 40) * bump * (0.9 + rand() * 0.2))) });
      }
    }
    return out;
  }

  async getGbpActions(query: LiftQuery): Promise<GbpDay[]> {
    this.assertQuery(query);
    const days = daysBetween(query.baselineStart, query.flightEnd);
    const rand = seededRand(`gbp:${query.brandQuery}`);
    return days.map((date) => {
      const bump = inFlight(date, query) ? 1.15 : 1.0;
      return {
        date,
        directionRequests: Math.max(0, Math.round((8 + rand() * 6) * bump)),
        calls: Math.max(0, Math.round((5 + rand() * 5) * bump)),
        websiteClicks: Math.max(0, Math.round((12 + rand() * 8) * bump)),
      };
    });
  }

  private assertQuery(q: LiftQuery): void {
    if (!(q.baselineStart < q.baselineEnd)) throw new Error("baselineStart must precede baselineEnd");
    if (!(q.flightStart < q.flightEnd)) throw new Error("flightStart must precede flightEnd");
    if (!q.boardMetros.length) throw new Error("boardMetros must be non-empty");
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(source: string) {
    super(`${source} lift provider is not configured — connect GSC/Trends OAuth before live pulls`);
    this.name = "ProviderNotConfiguredError";
  }
}

/** Real GSC/Trends adapter — declared for the interface; live OAuth lands later. */
export class RealLiftProvider implements LiftProvider {
  readonly name = "live" as const;
  constructor(private source: LiftSource) {}
  async getBrandedSearch(_query: LiftQuery): Promise<LiftDay[]> {
    throw new ProviderNotConfiguredError(this.source);
  }
  async getDirectTraffic(_query: LiftQuery): Promise<DirectTrafficDay[]> {
    throw new ProviderNotConfiguredError(this.source);
  }
  async getGbpActions(_query: LiftQuery): Promise<GbpDay[]> {
    throw new ProviderNotConfiguredError(this.source);
  }
}

// ---------------------------------------------------------------------------
// Lift computation
// ---------------------------------------------------------------------------

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function liftPct(baseline: number, flight: number): number | null {
  if (baseline <= 0) return null;
  return Math.round(((flight - baseline) / baseline) * 1000) / 10;
}

export async function computeLift(
  provider: LiftProvider,
  query: LiftQuery,
  source: LiftSource = "gsc",
): Promise<LiftResult> {
  const rows = await provider.getBrandedSearch(query);
  const baselineDays = daysBetween(query.baselineStart, query.baselineEnd).length;
  const flightDays = daysBetween(query.flightStart, query.flightEnd).length;

  const metros: MetroLift[] = [];
  for (const metro of [...query.boardMetros, ...query.holdoutMetros]) {
    const kind = query.boardMetros.includes(metro) ? "board" : "holdout";
    const base = rows.filter((r) => r.metro === metro && r.date >= query.baselineStart && r.date <= query.baselineEnd);
    const flt = rows.filter((r) => r.metro === metro && r.date >= query.flightStart && r.date <= query.flightEnd);
    const b = avg(base.map((r) => r.impressions));
    const f = avg(flt.map((r) => r.impressions));
    metros.push({ metro, kind, baselineDaily: Math.round(b * 10) / 10, flightDaily: Math.round(f * 10) / 10, liftPct: liftPct(b, f) });
  }

  const devices: DeviceLift[] = (["mobile", "desktop"] as const).map((device) => {
    const base = rows.filter((r) => r.device === device && query.boardMetros.includes(r.metro) && r.date >= query.baselineStart && r.date <= query.baselineEnd);
    const flt = rows.filter((r) => r.device === device && query.boardMetros.includes(r.metro) && r.date >= query.flightStart && r.date <= query.flightEnd);
    const b = avg(base.map((r) => r.impressions));
    const f = avg(flt.map((r) => r.impressions));
    return { device, baselineDaily: Math.round(b * 10) / 10, flightDaily: Math.round(f * 10) / 10, liftPct: liftPct(b, f) };
  });

  const hasHoldout = query.holdoutMetros.length > 0;
  const boardAvg = avg(metros.filter((m) => m.kind === "board").map((m) => m.liftPct ?? 0));
  const holdoutAvg = avg(metros.filter((m) => m.kind === "holdout").map((m) => m.liftPct ?? 0));
  const netLiftPct = hasHoldout ? Math.round((boardAvg - holdoutAvg) * 10) / 10 : null;

  const verdict = hasHoldout
    ? `Board metros ran ${boardAvg >= 0 ? "+" : ""}${boardAvg.toFixed(1)}% vs holdouts at ${holdoutAvg >= 0 ? "+" : ""}${holdoutAvg.toFixed(1)}% — net directional lift ${netLiftPct! >= 0 ? "+" : ""}${netLiftPct!.toFixed(1)}%. Directional only: holdouts shrink causal doubt but do not eliminate it.`
    : `Board metros ran ${boardAvg >= 0 ? "+" : ""}${boardAvg.toFixed(1)}% vs baseline with NO holdout metros — this is a before-and-after read. It cannot be credited to the OOH specifically; treat as a directional indicator only.`;

  return { query, source, baselineDays, flightDays, metros, netLiftPct, hasHoldout, devices, verdict };
}

export async function computeDirectTrafficLift(
  provider: LiftProvider,
  query: LiftQuery,
): Promise<DirectTrafficLift> {
  const rows = await provider.getDirectTraffic(query);
  const b = avg(rows.filter((r) => r.date >= query.baselineStart && r.date <= query.baselineEnd).map((r) => r.sessions));
  const f = avg(rows.filter((r) => r.date >= query.flightStart && r.date <= query.flightEnd).map((r) => r.sessions));
  return {
    baselineDaily: Math.round(b * 10) / 10,
    flightDaily: Math.round(f * 10) / 10,
    liftPct: liftPct(b, f),
    note: "Direct traffic conflates true direct visits with search/AI overflow — 2026 analyses estimate AI-attributable sessions are under-counted ~3× and land here.",
  };
}

export async function computeGbpLift(provider: LiftProvider, query: LiftQuery): Promise<GbpLift> {
  const rows = await provider.getGbpActions(query);
  const sum = (rs: GbpDay[]) => ({
    directionRequests: avg(rs.map((r) => r.directionRequests)),
    calls: avg(rs.map((r) => r.calls)),
    websiteClicks: avg(rs.map((r) => r.websiteClicks)),
  });
  const baseline = sum(rows.filter((r) => r.date >= query.baselineStart && r.date <= query.baselineEnd));
  const flight = sum(rows.filter((r) => r.date >= query.flightStart && r.date <= query.flightEnd));
  const lp = (a: number, b: number) => liftPct(a, b);
  return {
    baseline: {
      directionRequests: Math.round(baseline.directionRequests * 10) / 10,
      calls: Math.round(baseline.calls * 10) / 10,
      websiteClicks: Math.round(baseline.websiteClicks * 10) / 10,
    },
    flight: {
      directionRequests: Math.round(flight.directionRequests * 10) / 10,
      calls: Math.round(flight.calls * 10) / 10,
      websiteClicks: Math.round(flight.websiteClicks * 10) / 10,
    },
    liftPct: {
      directionRequests: lp(baseline.directionRequests, flight.directionRequests),
      calls: lp(baseline.calls, flight.calls),
      websiteClicks: lp(baseline.websiteClicks, flight.websiteClicks),
    },
    note: "Google Business Profile actions (direction requests, calls, website clicks) tracked before/during/after the flight — a pragmatic SMB proxy for footfall at billboard scale.",
  };
}
