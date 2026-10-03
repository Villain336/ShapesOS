// Marketr — Phase 5 B1: DOOH vendor provider abstraction.
//
// Mirrors lib/mail/provider.ts + fake.ts: one interface, a fake provider
// for dev/tests (DEFAULT), and vendor adapters in PLANNING/ESTIMATE-ONLY
// mode. There is no buy-side API for any DOOH vendor as of Sept 2026
// (docs/phase5-research.md §Track 1 — the honest bottom line), so the
// adapters can look up planning inventory and compute documented
// estimates only; they have no execute path. Execution always happens in
// the CLIENT's own operator account (browser-agent convenience path or
// human with a launch packet).
//
// VENDOR ORDER (locked, SPEC-PHASE5.md §B1): Blip first, Blindspot second,
// Adomni optional. AdQuick is PARKED: zero AdQuick code — only the
// referral deep link ADQUICK_SELF_SERVE_URL (plain outbound link in the
// planner UI).
//
// Estimate sources: docs/phase5-research.md "Track 1 — DOOH buying
// landscape" (Sep-2026 sources). All estimates are documented_estimate
// basis — vendors set final prices in their own UI.

export type DoohVendorName = "fake" | "blip" | "blindspot" | "adomni";

export const DOOH_VENDOR_ORDER: Exclude<DoohVendorName, "fake">[] = [
  "blip",
  "blindspot",
  "adomni",
];

/** Plain outbound referral link to AdQuick self-serve checkout (PARKED API — referral only). */
export const ADQUICK_SELF_SERVE_URL = "https://www.adquick.com";

export interface DoohSizeSpec {
  id: string;
  label: string;
  /** Pixel dimensions (width x height). */
  widthPx: number;
  heightPx: number;
  notes?: string;
}

/**
 * DOOH creative sizes, extended in the PLANNER (per SPEC §B1). The Creative
 * Studio format registry (lib/studio/formats.ts) is NOT modified — the
 * planner validates Studio creative sizes against these specs when binding
 * creatives to a plan.
 */
export const DOOH_SIZE_SPECS: DoohSizeSpec[] = [
  { id: "dooh_portrait_1080x1920", label: "Portrait 1080×1920 (9:16)", widthPx: 1080, heightPx: 1920, notes: "Standard digital board portrait" },
  { id: "dooh_landscape_1920x1080", label: "Landscape 1920×1080 (16:9)", widthPx: 1920, heightPx: 1080, notes: "Standard digital board landscape" },
  { id: "dooh_bulletin_1400x400", label: "Bulletin 1400×400", widthPx: 1400, heightPx: 400, notes: "Large-format digital bulletin" },
  { id: "dooh_poster_1080x1080", label: "Square 1080×1080", widthPx: 1080, heightPx: 1080, notes: "Place-based / street furniture" },
  { id: "dooh_times_square", label: "Times Square spec 1920×1080", widthPx: 1920, heightPx: 1080, notes: "Premium spectaculars — confirm pixel spec per unit" },
];

export interface DoohInventoryItem {
  boardId: string;
  name: string;
  city: string;
  state: string;
  /** Pixel formats the board accepts. */
  formats: string[];
  latitude?: number;
  longitude?: number;
  /** Documented audience reference (not a buy guarantee). */
  weeklyImpressions?: number | null;
}

export interface DoohInventoryQuery {
  city?: string;
  state?: string;
  limit?: number;
}

export interface DoohDaypart {
  name: string;
  /** [startHour24, endHour24) */
  hours: [number, number];
  /** Demand weight — scales play counts and (where dynamic) pricing. */
  weight: number;
}

export const DOOH_DAYPARTS: DoohDaypart[] = [
  { name: "Overnight", hours: [0, 6], weight: 0.3 },
  { name: "Morning drive", hours: [6, 10], weight: 1.4 },
  { name: "Midday", hours: [10, 15], weight: 1.0 },
  { name: "Evening drive", hours: [15, 19], weight: 1.5 },
  { name: "Evening", hours: [19, 23], weight: 1.1 },
  { name: "Late night", hours: [23, 24], weight: 0.4 },
];

export interface DoohEstimateSpec {
  vendor: DoohVendorName;
  /** Board ids selected from lookupInventory. */
  boardIds: string[];
  /** Daypart names (subset of DOOH_DAYPARTS). */
  dayparts: string[];
  flightStart: string; // ISO date
  flightEnd: string; // ISO date
  /** Target plays per board per day (Blip "blips", Blindspot "plays"). */
  playsPerBoardPerDay?: number;
  /** For CPM-mode vendors (Adomni): estimated weekly impressions. */
  weeklyImpressions?: number;
}

export interface DoohCostLine {
  label: string;
  units: number;
  /** Integer cents per unit. */
  unitCents: number;
  totalCents: number;
  basis: "documented_estimate";
  note?: string;
}

export interface DoohEstimate {
  vendor: DoohVendorName;
  lines: DoohCostLine[];
  minCents: number;
  maxCents: number;
  notes: string[];
}

/** Honest error: planning surface only — there is no execute path. */
export class DoohExecutionNotAvailableError extends Error {
  constructor(vendor: DoohVendorName) {
    super(
      `No buy-side API for ${vendor} (Sept 2026 landscape). Execute in the client's own ${vendor} account ` +
        `via the launch packet — browser-agent convenience path or human with checklist + receipt upload.`,
    );
    this.name = "DoohExecutionNotAvailableError";
  }
}

export class DoohProviderNotConfiguredError extends Error {
  constructor(vendor: string) {
    super(`${vendor} DOOH provider is not configured (planning-only mode is the default).`);
    this.name = "DoohProviderNotConfiguredError";
  }
}

export interface DoohProvider {
  readonly name: DoohVendorName;
  /** Planning-only inventory lookup (documented/fixture data, never live availability). */
  lookupInventory(query: DoohInventoryQuery): Promise<DoohInventoryItem[]>;
  /** Documented-estimate cost lines. Never a live charge or quote lock. */
  estimate(spec: DoohEstimateSpec): Promise<DoohEstimate>;
  /** ALWAYS throws DoohExecutionNotAvailableError — there is no execute path. */
  launch(): Promise<never>;
}

// ---------------------------------------------------------------------------
// Estimate sources (docs/phase5-research.md, Sep 2026).
// ---------------------------------------------------------------------------

/** Blip: from $0.01/blip, dynamic by time/location/demand; daily budgets from ~$20. */
export const BLIP_PER_BLIP_FLOOR_CENTS = 1;
/** Blindspot: per-play from ~$0.23 (Times Square premium ~$40/play). */
export const BLINDSPOT_PER_PLAY_CENTS = 23;
export const BLINDSPOT_PREMIUM_PER_PLAY_CENTS = 4000;
/** Programmatic DOOH CPM range (Adomni planning): denominators differ — compare with caution. */
export const PROGRAMMATIC_DOOH_CPM_MIN_CENTS = 200; // $2 CPM
export const PROGRAMMATIC_DOOH_CPM_MAX_CENTS = 1500; // $15 CPM
/** Blip daily budget floor. */
export const BLIP_DAILY_BUDGET_FLOOR_CENTS = 2000; // ~$20

function flightDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1) throw new Error("flightEnd must be on or after flightStart.");
  return days;
}

function daypartWeight(dayparts: string[]): number {
  const sel = new Set(dayparts);
  return DOOH_DAYPARTS.filter((d) => sel.has(d.name)).reduce((a, d) => a + d.weight, 0);
}

// ---------------------------------------------------------------------------
// Fake provider (DEFAULT). Deterministic fixture inventory + documented
// estimate math. Used in dev/tests; never touches a vendor.
// ---------------------------------------------------------------------------

const FAKE_INVENTORY: DoohInventoryItem[] = [
  { boardId: "blip-fake-001", name: "I-40 W @ Exit 210", city: "Greensboro", state: "NC", formats: ["dooh_landscape_1920x1080"], latitude: 36.07, longitude: -79.79, weeklyImpressions: 280000 },
  { boardId: "blip-fake-002", name: "Battleground Ave @ New Garden", city: "Greensboro", state: "NC", formats: ["dooh_portrait_1080x1920", "dooh_landscape_1920x1080"], latitude: 36.1, longitude: -79.85, weeklyImpressions: 190000 },
  { boardId: "blip-fake-003", name: "Downtown Elm St Shelter", city: "Greensboro", state: "NC", formats: ["dooh_portrait_1080x1920", "dooh_poster_1080x1080"], latitude: 36.07, longitude: -79.79, weeklyImpressions: 95000 },
  { boardId: "blsp-fake-101", name: "RDU Airport Arrivals", city: "Morrisville", state: "NC", formats: ["dooh_landscape_1920x1080"], latitude: 35.88, longitude: -78.79, weeklyImpressions: 420000 },
  { boardId: "blsp-fake-102", name: "Times Sq Pedestrian (premium)", city: "New York", state: "NY", formats: ["dooh_times_square"], latitude: 40.76, longitude: -73.99, weeklyImpressions: 1500000 },
];

export class FakeDoohProvider implements DoohProvider {
  readonly name = "fake" as const;

  async lookupInventory(query: DoohInventoryQuery): Promise<DoohInventoryItem[]> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    let items = FAKE_INVENTORY;
    if (query.city) {
      const c = query.city.toLowerCase();
      items = items.filter((i) => i.city.toLowerCase().includes(c));
    }
    if (query.state) {
      const s = query.state.toLowerCase();
      items = items.filter((i) => i.state.toLowerCase() === s);
    }
    return items.slice(0, limit);
  }

  async estimate(spec: DoohEstimateSpec): Promise<DoohEstimate> {
    const days = flightDays(spec.flightStart, spec.flightEnd);
    const weight = daypartWeight(spec.dayparts);
    const playsPerDay = spec.playsPerBoardPerDay ?? 100;
    const plays = Math.round(spec.boardIds.length * playsPerDay * days * (weight / DOOH_DAYPARTS.length));
    const minCents = plays * BLIP_PER_BLIP_FLOOR_CENTS;
    const lines: DoohCostLine[] = [
      { label: "Media — per-play floor", units: plays, unitCents: BLIP_PER_BLIP_FLOOR_CENTS, totalCents: minCents, basis: "documented_estimate", note: `Blip from $0.01/blip (${spec.boardIds.length} boards × ${days}d × ~${playsPerDay}/board/day)` },
    ];
    return {
      vendor: "fake",
      lines,
      minCents,
      maxCents: minCents * 5, // dynamic pricing band — vendor sets actuals
      notes: [
        "Fake provider — deterministic fixture inventory, documented estimate math only.",
        "Real Blip pricing is dynamic by time/location/demand; actuals are set in the client's Blip account.",
        "Estimates are planning figures — the approved binding's max_total_spend is the controlling cap.",
      ],
    };
  }

  async launch(): Promise<never> {
    throw new DoohExecutionNotAvailableError("fake");
  }
}

// ---------------------------------------------------------------------------
// Vendor adapters — planning/estimate-only mode. They reuse documented
// estimate math with vendor-specific labels. launch() always throws the
// honest no-buy-side-API error (concierge is the architecture, not a
// stopgap).
// ---------------------------------------------------------------------------

abstract class VendorAdapterBase implements DoohProvider {
  abstract readonly name: Exclude<DoohVendorName, "fake">;

  async lookupInventory(query: DoohInventoryQuery): Promise<DoohInventoryItem[]> {
    // Planning-only: no vendor exposes a buy-side inventory API, so the
    // adapters reuse the documented fixture set with vendor attribution.
    const fake = new FakeDoohProvider();
    const items = await fake.lookupInventory(query);
    return items.map((i) => ({
      ...i,
      name: `${i.name} [${this.name} planning fixture — confirm in the client's ${this.name} account]`,
    }));
  }

  abstract estimate(spec: DoohEstimateSpec): Promise<DoohEstimate>;

  async launch(): Promise<never> {
    throw new DoohExecutionNotAvailableError(this.name);
  }
}

export class BlipAdapter extends VendorAdapterBase {
  readonly name = "blip" as const;

  async estimate(spec: DoohEstimateSpec): Promise<DoohEstimate> {
    const days = flightDays(spec.flightStart, spec.flightEnd);
    const weight = daypartWeight(spec.dayparts);
    const playsPerDay = spec.playsPerBoardPerDay ?? 100;
    const plays = Math.round(spec.boardIds.length * playsPerDay * days * (weight / DOOH_DAYPARTS.length));
    const mediaMin = plays * BLIP_PER_BLIP_FLOOR_CENTS;
    const dailyFloorTotal = Math.max(BLIP_DAILY_BUDGET_FLOOR_CENTS * days, mediaMin);
    return {
      vendor: "blip",
      lines: [
        {
          label: "Blip media — per-blip floor",
          units: plays,
          unitCents: BLIP_PER_BLIP_FLOOR_CENTS,
          totalCents: mediaMin,
          basis: "documented_estimate",
          note: `Blip from $0.01/blip — dynamic by time/location/demand (${spec.boardIds.length} boards × ${days}d)`,
        },
        {
          label: "Blip daily-budget floor (~$20/day)",
          units: days,
          unitCents: BLIP_DAILY_BUDGET_FLOOR_CENTS,
          totalCents: dailyFloorTotal - mediaMin,
          basis: "documented_estimate",
          note: "Blip daily budgets from ~$20; shown as the planning floor above per-blip media.",
        },
      ],
      minCents: dailyFloorTotal,
      maxCents: dailyFloorTotal * 4, // dynamic band
      notes: [
        "Estimate only — Blip bills per blip (7.5–10s display) at dynamic rates set in the client's Blip account.",
        "No buy-side API: execute in the client's own Blip account via the launch packet (browser-agent or human).",
        "Launchabl agency note: Blip's free agency reseller program (no minimums) maps to this planner → approval flow.",
      ],
    };
  }
}

export class BlindspotAdapter extends VendorAdapterBase {
  readonly name = "blindspot" as const;

  async estimate(spec: DoohEstimateSpec): Promise<DoohEstimate> {
    const days = flightDays(spec.flightStart, spec.flightEnd);
    const weight = daypartWeight(spec.dayparts);
    const playsPerDay = spec.playsPerBoardPerDay ?? 24; // bookable by the hour
    const plays = Math.round(spec.boardIds.length * playsPerDay * days * (weight / DOOH_DAYPARTS.length));
    const premium = spec.boardIds.some((b) => b.includes("102"));
    const unitCents = premium ? BLINDSPOT_PREMIUM_PER_PLAY_CENTS : BLINDSPOT_PER_PLAY_CENTS;
    const total = plays * unitCents;
    return {
      vendor: "blindspot",
      lines: [
        {
          label: premium ? "Blindspot media — premium per-play" : "Blindspot media — per-play",
          units: plays,
          unitCents,
          totalCents: total,
          basis: "documented_estimate",
          note: premium
            ? "Times-Square-class premium inventory ~$40/play (documented 2026 figure)"
            : `Blindspot from ~$0.23/play, bookable by the hour (${spec.boardIds.length} screens × ${days}d)`,
        },
      ],
      minCents: total,
      maxCents: premium ? total : Math.round(total * 2),
      notes: [
        "Estimate only — actuals set in the client's Blindspot (TPS Engage) account; AI planner 'Blinky' books free, media only.",
        "No public buy-side API (the published Pull API is device/sell-side). Execute via launch packet in the client's account.",
      ],
    };
  }
}

export class AdomniAdapter extends VendorAdapterBase {
  readonly name = "adomni" as const;

  async estimate(spec: DoohEstimateSpec): Promise<DoohEstimate> {
    const days = flightDays(spec.flightStart, spec.flightEnd);
    const weeklyImpressions = spec.weeklyImpressions ?? 100000;
    const impressions = Math.round((weeklyImpressions / 7) * days);
    const minTotal = Math.round((impressions / 1000) * PROGRAMMATIC_DOOH_CPM_MIN_CENTS);
    const maxTotal = Math.round((impressions / 1000) * PROGRAMMATIC_DOOH_CPM_MAX_CENTS);
    return {
      vendor: "adomni",
      lines: [
        {
          label: "Adomni programmatic DOOH — CPM floor",
          units: Math.round(impressions / 1000),
          unitCents: PROGRAMMATIC_DOOH_CPM_MIN_CENTS,
          totalCents: minTotal,
          basis: "documented_estimate",
          note: `$2 CPM floor × ~${impressions.toLocaleString("en-US")} impressions over ${days}d`,
        },
      ],
      minCents: minTotal,
      maxCents: maxTotal,
      notes: [
        "Programmatic DOOH CPM $2–$15 (StackAdapt/AdQuick benchmarks). DENOMINATORS DIFFER — impression-multiplier methods vary across vendors; compare with caution.",
        "Adomni: no spend minimums, credit-card signup, self-serve — execute in the client's Adomni account via launch packet.",
        "Full programmatic execution via a DSP seat (Vistar/Place Exchange supply) is deferred — ShapesOS prepares PMP-ready plans only.",
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Provider resolution: fake default (test mode); vendor adapters in
// planning/estimate-only mode. No vendor keys exist — there is nothing to
// store — because there is no buy-side API.
// ---------------------------------------------------------------------------

export type DoohProviderSelection = DoohVendorName;

export function getDoohProvider(selection: DoohProviderSelection = "fake"): DoohProvider {
  switch (selection) {
    case "blip":
      return new BlipAdapter();
    case "blindspot":
      return new BlindspotAdapter();
    case "adomni":
      return new AdomniAdapter();
    case "fake":
    default:
      return new FakeDoohProvider();
  }
}
