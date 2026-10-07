// ShapesOS — Phase 19B (WS=engine): the town simulation engine.
// Commercial layer (entitlement dress_rehearsal; Pro and above). Company-authored.
//
// Server-authoritative (it runs in the agent worker as a `town_run` job —
// lib/sim/run.server.ts); the browser only replays what it produced.
//
//   ┌ tick loop: 1 sim-minute per tick, day 0 = Monday 00:00 ───────────────┐
//   │ 00:00  day start: weather (seeded), rent, interventions of the day,   │
//   │        today's ad reach (social feed / search / event flyers)          │
//   │ :00    every sim-hour: a snapshot (seeking / scrubbing)                │
//   │ each   the minute's actions from the EVENT QUEUE, in insertion order: │
//   │ tick   plan (routine + utility) → trip (A*, timestamped path) →       │
//   │        arrive → activity (meal, groceries, park, your store) ;        │
//   │        wages at shift end ; feed / search / flyer exposures ;          │
//   │        21:00 word of mouth ; 23:00 nightly reflection                  │
//   │ then   the minute's DECISION POINTS go to the decider in one batch,   │
//   │        answers are applied in request order (they may raise more)    │
//   └────────────────────────────────────────────────────────────────────────┘
//
// Decision points (lib/sim/decisions.ts) are the only model calls: seeing an
// ad, entering your store, a friend's mention, the purchase decision, and the
// nightly reflection. Each resident gets at most DAILY_DECISION_CAP model
// decisions per point per day (rules answer the rest), so the up-front cap
// estimate is a true upper bound. A cap stop (PanelCapReachedError) ends the
// run cleanly at that minute: `stopped` says where, and every metric up to
// there is kept — an honest partial result.
//
// Determinism: every random draw comes from a stream of (seed, label)
// (lib/sim/rng.ts); actions run in insertion order; decisions are applied in
// request order. The same seed and inputs (and the same decisions — rules,
// the fake model or a recorded cache) give the same event log, byte for byte
// (lib/sim/hash.ts). A live model's answers are not deterministic; a replay
// with the recorded decision cache is.
//
// Economy (all in cents): wages in at the end of each shift; rent and bills
// out at 00:00; purchases out at cafés, competitor storefronts and your
// store(s) — every purchase is exactly one store's revenue. Per resident per
// day: opening + wages = rent + purchases + closing (tested over 30 days).
// Simulated ad spend is the scenario's own object, never a resident's money.
//
// Interventions are simulated objects only (lib/sim/scenario.ts): nothing
// here reads or writes a real ShapesOS record.

import { isCapReached } from "@/lib/panel/budget";
import {
  DAILY_DECISION_CAP,
  decisionKey,
  ruleDecision,
  type AttentionDecision,
  type Decision,
  type DecisionFacts,
  type DecisionPoint,
  type DecisionRequest,
  type DecisionValues,
  type EnterDecision,
  type PurchaseDecision,
  type ReflectDecision,
  type TownDecider,
} from "./decisions";
import { lotCenter, type Lot, type TownLayout } from "./layout";
import { ResidentMemory } from "./memory";
import { astar, roadGraph, timedPath, walkGraph, type PathGraph, type TravelMode } from "./pathfind";
import { dayOf, MINUTES_PER_DAY, scheduleBlock, shiftsStartingOn, weekdayOf, type PersonaSeed, type Resident } from "./residents";
import { hash32, rngFor, type Rng } from "./rng";
import type { AdChannel, Intervention, Scenario } from "./scenario";

export type TownEventType =
  | "day"
  | "intervention"
  | "trip"
  | "arrive"
  | "wage"
  | "rent"
  | "buy"
  | "visit"
  | "ad"
  | "mention"
  | "decision"
  | "reflect"
  | "adopt"
  | "cap_stop"
  | "end";

/** One line of the event log. `t` = absolute sim minute (0 = Monday 00:00). */
export interface TownEvent {
  seq: number;
  t: number;
  type: TownEventType;
  r?: string;
  lot?: string;
  d?: Record<string, unknown>;
}

export interface SnapshotResident {
  id: string;
  /** Lot they are at, or null while travelling. */
  lot: string | null;
  x: number;
  y: number;
  money: number;
  interest: number;
  adopted: boolean;
}

export interface TownSnapshot {
  t: number;
  residents: SnapshotResident[];
  adopters: number;
  visits: number;
  yourRevenueCents: number;
}

export interface DayMetrics {
  day: number;
  weather: Weather;
  adoptersCumulative: number;
  newAdopters: number;
  visits: number;
  units: number;
  revenueCents: number;
  competitorRevenueCents: number;
  adExposures: number;
  mentions: number;
  simulatedAdSpendCents: number;
  modelDecisions: number;
  cachedDecisions: number;
  ruleDecisions: number;
  credits: number;
  bySegment: Record<string, { adopters: number; visits: number; residents: number }>;
}

export interface LedgerRow {
  day: number;
  residentId: string;
  opening: number;
  wagesIn: number;
  rentOut: number;
  purchasesOut: number;
  closing: number;
}

export interface ObjectionRecord {
  day: number;
  t: number;
  residentId: string;
  segment: string;
  personaId: string | null;
  calibrated: boolean;
  text: string;
}

export interface TownStop {
  reason: "cap" | "aborted";
  t: number;
  detail: string;
}

export interface TownRunResult {
  events: TownEvent[];
  snapshots: TownSnapshot[];
  days: DayMetrics[];
  ledger: LedgerRow[];
  storeRevenueCents: Record<string, number>;
  objections: ObjectionRecord[];
  stopped: TownStop | null;
  decisions: { model: number; cache: number; rules: number; credits: number };
  /** Resident-days simulated (for cost per resident-day). */
  residentDays: number;
}

export interface RunTownOptions {
  runId: string;
  layout: TownLayout;
  residents: Resident[];
  scenario: Scenario;
  days: number;
  seed: number;
  decider: TownDecider;
  personas?: ReadonlyArray<PersonaSeed>;
  record?: { events?: boolean; snapshots?: boolean };
  onEvent?: (e: TownEvent) => void;
  onDay?: (day: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export type Weather = "sunny" | "cloudy" | "rain";

/** Simulated reach prices (the scenario's own object, never real spend). */
export const SIM_AD_COSTS = { socialPerReachCents: 40, searchPerClickCents: 120, billboardPerBoardDayCents: 5_000 } as const;

const BILLBOARD_RANGE_M = 45;
const LEAD_MINUTES = 30;

interface RState {
  r: Resident;
  rng: Rng;
  lot: string | null;
  trip: { path: Array<[number, number, number]>; to: string } | null;
  money: number;
  hunger: number;
  leisure: number;
  needsAt: number;
  lastGroceryDay: number;
  interest: number;
  aware: boolean;
  adopted: boolean;
  plannedVisit: boolean;
  wantsToTell: boolean;
  productSpentThisMonth: number;
  visitsToday: number;
  calls: Record<DecisionPoint, number>;
  experiences: string[];
  boardsSeenToday: Set<string>;
  told: Set<string>;
  memory: ResidentMemory;
  ledger: { opening: number; wagesIn: number; rentOut: number; purchasesOut: number };
}

type Action =
  | { kind: "plan"; rid: string }
  | { kind: "arrive"; rid: string; lot: string; activity: Activity; stay: number; until: number }
  | { kind: "wage"; rid: string; cents: number }
  | { kind: "exposure"; rid: string; channel: AdChannel | "event"; creative: string }
  | { kind: "search"; rid: string };

type Activity = "work" | "sleep" | "home" | "cafe" | "groceries" | "park" | "store";

interface QueuedDecision {
  req: DecisionRequest;
  apply: (d: Decision) => void;
}

const fmtTime = (t: number) => {
  const d = dayOf(t);
  const m = t - d * MINUTES_PER_DAY;
  return `${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][weekdayOf(d)]} (day ${d + 1}) ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Run one seeded town over `days` sim-days. */
export async function runTown(opts: RunTownOptions): Promise<TownRunResult> {
  const { layout, scenario, seed } = opts;
  const recordEvents = opts.record?.events !== false;
  const recordSnaps = opts.record?.snapshots !== false;
  const lots = new Map(layout.lots.map((l) => [l.id, l]));
  const roadG = roadGraph(layout);
  const walkG = walkGraph(layout);
  const personas = new Map((opts.personas ?? []).map((p) => [p.id, p]));
  const T = Math.max(1, Math.floor(opts.days)) * MINUTES_PER_DAY;

  // ── state ────────────────────────────────────────────────────────────────
  const events: TownEvent[] = [];
  const snapshots: TownSnapshot[] = [];
  const dayMetrics: DayMetrics[] = [];
  const ledgerRows: LedgerRow[] = [];
  const objections: ObjectionRecord[] = [];
  const storeRevenue: Record<string, number> = {};
  const decisionTotals = { model: 0, cache: 0, rules: 0, credits: 0 };
  let seq = 0;
  let stopped: TownStop | null = null;
  const emit = (t: number, type: TownEventType, r?: string, lot?: string, d?: Record<string, unknown>) => {
    const e: TownEvent = { seq: seq++, t, type, ...(r ? { r } : {}), ...(lot ? { lot } : {}), ...(d ? { d } : {}) };
    if (recordEvents) events.push(e);
    opts.onEvent?.(e);
  };

  const states = new Map<string, RState>();
  for (const r of opts.residents) {
    states.set(r.id, {
      r,
      rng: rngFor(seed, `resident:${r.id}`),
      lot: r.homeLotId,
      trip: null,
      money: r.startingBalanceCents,
      hunger: 0.3,
      leisure: 0.3,
      needsAt: 0,
      lastGroceryDay: -2,
      interest: 0,
      aware: false,
      adopted: false,
      plannedVisit: false,
      wantsToTell: false,
      productSpentThisMonth: 0,
      visitsToday: 0,
      calls: { ad: 0, enter: 0, mention: 0, purchase: 0, reflect: 0 },
      experiences: [],
      boardsSeenToday: new Set(),
      told: new Set(),
      memory: new ResidentMemory(r.id),
      ledger: { opening: r.startingBalanceCents, wagesIn: 0, rentOut: 0, purchasesOut: 0 },
    });
  }
  const order = [...states.values()];

  // Scenario state (simulated objects only).
  let price = scenario.product.priceCents;
  let hours = { ...scenario.storeHours };
  let availableFrom = scenario.interventions.some((i) => i.kind === "product_drop") ? Infinity : 0;
  const yourStores = new Set(layout.lots.filter((l) => l.kind === "shop" && l.owner === "you").map((l) => l.id));
  let weather: Weather = "sunny";
  let today = 0;
  const day = { visits: 0, units: 0, revenue: 0, competitor: 0, ads: 0, mentions: 0, adSpend: 0, newAdopters: 0, model: 0, cache: 0, rules: 0, credits: 0, segVisits: {} as Record<string, number> };
  let searchClicksLeft = 0;
  let boardsActive: string[] = [];

  // ── event queue: one bucket per minute, run in insertion order ──────────
  const buckets: Action[][] = Array.from({ length: T + 1 }, () => []);
  const schedule = (t: number, a: Action) => {
    if (t < T) buckets[Math.max(0, Math.floor(t))]!.push(a);
  };
  const pending: QueuedDecision[] = [];

  // ── routes (cached per mode + node pair) ─────────────────────────────────
  const billboards = layout.lots.filter((l) => l.kind === "billboard");
  const routeCache = new Map<string, { nodes: string[]; boards: string[] } | null>();
  const route = (mode: TravelMode, from: string, to: string) => {
    const k = `${mode}:${from}:${to}`;
    if (routeCache.has(k)) return routeCache.get(k)!;
    const g: PathGraph = mode === "drive" ? roadG : walkG;
    const r = astar(g, from, to);
    let out: { nodes: string[]; boards: string[] } | null = null;
    if (r) {
      const pts = r.nodes.map((id) => g.nodes.get(id)!);
      const boards = billboards
        .filter((b) => {
          const c = lotCenter(b);
          return pts.some((p, i) => {
            const q = pts[i + 1] ?? p;
            const len2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
            const u = len2 ? Math.max(0, Math.min(1, ((c.x - p.x) * (q.x - p.x) + (c.y - p.y) * (q.y - p.y)) / len2)) : 0;
            return Math.hypot(p.x + u * (q.x - p.x) - c.x, p.y + u * (q.y - p.y) - c.y) <= BILLBOARD_RANGE_M;
          });
        })
        .map((b) => b.id);
      out = { nodes: r.nodes, boards };
    }
    routeCache.set(k, out);
    return out;
  };
  const nearestByKind = new Map<string, Lot[]>();
  const nearest = (from: Lot, pred: (l: Lot) => boolean, kindKey: string, n: number): Lot[] => {
    const k = `${from.id}:${kindKey}`;
    let hit = nearestByKind.get(k);
    if (!hit) {
      const c = lotCenter(from);
      hit = layout.lots
        .filter(pred)
        .map((l) => ({ l, d: Math.hypot(lotCenter(l).x - c.x, lotCenter(l).y - c.y) }))
        .sort((a, b) => a.d - b.d || a.l.id.localeCompare(b.l.id))
        .slice(0, n)
        .map((x) => x.l);
      nearestByKind.set(k, hit);
    }
    return hit;
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  const activeInterventions = <K extends Intervention["kind"]>(kind: K, d: number) =>
    scenario.interventions.filter((i): i is Extract<Intervention, { kind: K }> => {
      if (i.kind !== kind) return false;
      if (i.kind === "ad_campaign") return d >= i.startDay && d <= i.endDay;
      if (i.kind === "promotion") return d >= i.day && d <= i.endDay;
      return false;
    });
  const promotionToday = () => activeInterventions("promotion", today)[0] ?? null;
  const effectivePrice = () => Math.max(1, Math.round(price * (1 - (promotionToday()?.discountPct ?? 0) / 100)));
  const storeOpen = (t: number) => {
    const h = Math.floor((t - dayOf(t) * MINUTES_PER_DAY) / 60);
    return today >= availableFrom && h >= hours.openHour && h < hours.closeHour;
  };

  const updateNeeds = (s: RState, t: number) => {
    const hrs = (t - s.needsAt) / 60;
    if (hrs <= 0) return;
    const asleep = scheduleBlock(s.r, t) === "sleep";
    s.hunger = clamp01(s.hunger + hrs / (asleep ? 20 : 9));
    s.leisure = clamp01(s.leisure + hrs / (asleep ? 30 : 12));
    s.needsAt = t;
  };

  const blockAt = (s: RState, t: number) => (scheduleBlock(s.r, t + LEAD_MINUTES) === "work" ? "work" : scheduleBlock(s.r, t));
  const nextChange = (s: RState, t: number) => {
    const d = dayOf(t);
    const cands: number[] = [];
    for (const dd of [d - 1, d, d + 1]) {
      for (const sh of shiftsStartingOn(s.r, dd)) cands.push(sh.start - LEAD_MINUTES, sh.end);
      const base = dd * MINUTES_PER_DAY;
      if (s.r.routine === "night") cands.push(base + 7 * 60, base + 14 * 60);
      else cands.push(base + 7 * 60, base + 23 * 60);
    }
    let best = Infinity;
    for (const c of cands) if (c > t && c < best) best = c;
    return Number.isFinite(best) ? best : t + 60;
  };

  const pay = (s: RState, lotId: string, cents: number, t: number, item: string, yours: boolean) => {
    s.money -= cents;
    s.ledger.purchasesOut += cents;
    storeRevenue[lotId] = (storeRevenue[lotId] ?? 0) + cents;
    if (yours) {
      day.revenue += cents;
      day.units += 1;
      s.productSpentThisMonth += cents;
    } else {
      const l = lots.get(lotId);
      if (l?.kind === "shop") day.competitor += cents;
    }
    emit(t, "buy", s.r.id, lotId, { cents, item, yours });
  };

  const facts = (s: RState, t: number, stimulus: DecisionFacts["stimulus"], query: string): DecisionFacts => {
    const p = s.r.personaId ? personas.get(s.r.personaId) : undefined;
    const promo = promotionToday();
    return {
      residentId: s.r.id,
      residentName: s.r.name,
      segment: s.r.segment,
      persona: p ? { name: p.spec.identity.name, occupation: p.spec.occupation, goals: p.spec.goals, knownObjections: p.spec.knownObjections.map((o) => o.text) } : null,
      calibrated: s.r.calibrated,
      traits: s.r.traits,
      moneyCents: s.money,
      productBudgetLeftCents: Math.max(0, s.r.productBudgetCents - s.productSpentThisMonth),
      interest: Math.round(s.interest * 100) / 100,
      adopted: s.adopted,
      product: scenario.product,
      effectivePriceCents: effectivePrice(),
      discountPct: promo?.discountPct ?? 0,
      weather,
      when: fmtTime(t),
      stimulus,
      memories: s.memory.retrieve(query, t, 4).map((n) => n.content),
    };
  };

  /** Queue a decision; past the resident's daily cap, rules answer at once. */
  const decide = <P extends DecisionPoint>(s: RState, t: number, point: P, f: DecisionFacts, apply: (v: DecisionValues[P], d: Decision) => void) => {
    const key = decisionKey(point, f);
    const req: DecisionRequest = { point, residentId: s.r.id, key, facts: f };
    const finish = (d: Decision) => {
      day[d.source === "model" ? "model" : d.source === "cache" ? "cache" : "rules"] += 1;
      decisionTotals[d.source] += 1;
      day.credits += d.credits;
      decisionTotals.credits += d.credits;
      emit(t, "decision", s.r.id, undefined, { point, source: d.source, key, value: d.value, ...(d.credits ? { credits: d.credits } : {}), ...(d.note ? { note: d.note } : {}) });
      apply(d.value as DecisionValues[P], d);
    };
    if (s.calls[point] >= DAILY_DECISION_CAP[point]) {
      finish({ point, key, value: ruleDecision(point, f, key), source: "rules", credits: 0, note: "daily model-decision cap for this resident" });
      return;
    }
    s.calls[point] += 1;
    pending.push({ req, apply: finish });
  };

  // ── travel ───────────────────────────────────────────────────────────────
  const go = (s: RState, t: number, to: string, activity: Activity, stay: number, until: number) => {
    if (s.lot === to) {
      schedule(Math.max(t + 1, Math.min(until, t + Math.max(1, stay))), { kind: "plan", rid: s.r.id });
      return;
    }
    const from = lots.get(s.lot ?? s.r.homeLotId)!;
    const dest = lots.get(to)!;
    const a = lotCenter(from);
    const b = lotCenter(dest);
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    let mode: TravelMode = s.r.drives && (dist > 450 || (weather === "rain" && dist > 180)) ? "drive" : "walk";
    let rt = route(mode, mode === "drive" ? from.roadNode : from.walkNode, mode === "drive" ? dest.roadNode : dest.walkNode);
    if (!rt) {
      mode = mode === "drive" ? "walk" : "drive";
      rt = route(mode, mode === "drive" ? from.roadNode : from.walkNode, mode === "drive" ? dest.roadNode : dest.walkNode);
    }
    const depart = t * 60;
    let path: Array<[number, number, number]>;
    if (rt) {
      const g = mode === "drive" ? roadG : walkG;
      const tp = timedPath(g, mode, rt.nodes, depart + 60);
      path = [[round1(a.x), round1(a.y), depart], ...tp.points.map((p) => [round1(p.x), round1(p.y), p.t] as [number, number, number])];
      const last = path[path.length - 1]![2];
      path.push([round1(b.x), round1(b.y), last + 60]);
      // Billboards on the way.
      for (const board of rt.boards) {
        if (!boardsActive.includes(board) || s.boardsSeenToday.has(board)) continue;
        s.boardsSeenToday.add(board);
        if (s.rng.chance(0.25 + s.r.traits.adOpenness * 0.5)) {
          const camp = activeInterventions("ad_campaign", today).find((c) => c.channel === "billboard");
          if (camp) exposure(s, t, "billboard", camp.creative, board);
        }
      }
    } else {
      // Unreachable on both graphs: a straight walk (the layout is disconnected).
      const secs = Math.ceil(dist / 1.4);
      path = [
        [round1(a.x), round1(a.y), depart],
        [round1(b.x), round1(b.y), depart + secs],
      ];
      mode = "walk";
    }
    const arrive = Math.max(t + 1, Math.ceil(path[path.length - 1]![2] / 60));
    s.lot = null;
    s.trip = { path, to };
    emit(t, "trip", s.r.id, to, { mode, path });
    schedule(arrive, { kind: "arrive", rid: s.r.id, lot: to, activity, stay, until });
  };

  // ── planning ─────────────────────────────────────────────────────────────
  const plan = (s: RState, t: number) => {
    updateNeeds(s, t);
    const block = blockAt(s, t);
    const change = nextChange(s, t);
    if (block === "work") return go(s, t, s.r.workLotId, "work", change - t, change);
    if (block === "sleep") return go(s, t, s.r.homeLotId, "sleep", change - t, change);
    const here = lots.get(s.lot ?? s.r.homeLotId)!;
    const mod = t - dayOf(t) * MINUTES_PER_DAY;
    const travel = (l: Lot) => Math.hypot(lotCenter(l).x - lotCenter(here).x, lotCenter(l).y - lotCenter(here).y) / (s.r.drives ? 8 : 1.4) / 60;
    const rain = weather === "rain";
    const n = () => (s.rng.next() - 0.5) * 0.2;
    const options: Array<{ lot: string; act: Activity; u: number; stay: number }> = [
      { lot: s.r.homeLotId, act: "home", u: 0.25 + (mod >= 21 * 60 || mod < 6 * 60 ? 0.7 : 0) + s.hunger * 0.3 + (rain ? 0.15 : 0) + n(), stay: 90 },
    ];
    for (const c of nearest(here, (l) => l.kind === "cafe", "cafe", 2)) if (s.money >= 1_500) options.push({ lot: c.id, act: "cafe", u: s.hunger * 0.7 + s.leisure * 0.4 - s.r.traits.priceSensitivity * 0.25 - travel(c) / 45 + (rain ? 0.1 : 0) + n(), stay: 45 });
    for (const c of nearest(here, (l) => l.kind === "shop" && l.owner === "competitor", "competitor", 2))
      if (s.money >= 4_000) options.push({ lot: c.id, act: "groceries", u: Math.min(1, (today - s.lastGroceryDay) / 4) * 0.8 - travel(c) / 45 + n(), stay: 30 });
    for (const c of nearest(here, (l) => l.kind === "park", "park", 1)) options.push({ lot: c.id, act: "park", u: s.leisure * 0.8 - travel(c) / 45 - (rain ? 0.7 : 0) + n(), stay: 60 });
    if (s.aware && s.visitsToday === 0 && storeOpen(t)) {
      const promo = promotionToday();
      for (const id of [...yourStores].sort()) {
        const l = lots.get(id)!;
        options.push({ lot: id, act: "store", u: (s.plannedVisit ? 1 : s.interest * 1.2) - travel(l) / 45 + (promo ? 0.15 : 0) + (promo?.event ? 0.2 : 0) + n(), stay: 25 });
      }
    }
    let best = options[0]!;
    for (const o of options) if (o.u > best.u) best = o;
    go(s, t, best.lot, best.act, best.stay, change);
  };

  const arrive = (s: RState, t: number, a: Extract<Action, { kind: "arrive" }>) => {
    s.trip = null;
    s.lot = a.lot;
    updateNeeds(s, t);
    emit(t, "arrive", s.r.id, a.lot, { activity: a.activity });
    const lot = lots.get(a.lot)!;
    switch (a.activity) {
      case "cafe": {
        const cost = 600 + (hash32(lot.id) % 7) * 100;
        if (s.money >= cost) {
          pay(s, lot.id, cost, t, "meal", false);
          s.hunger = 0.1;
          s.leisure = clamp01(s.leisure - 0.4);
        }
        break;
      }
      case "groceries": {
        const cost = 2_000 + s.rng.int(0, 20) * 100;
        if (s.money >= cost) {
          pay(s, lot.id, cost, t, "groceries", false);
          s.lastGroceryDay = today;
        }
        break;
      }
      case "park":
        s.leisure = 0;
        break;
      case "home":
        if (s.hunger > 0.5) s.hunger = 0.1;
        s.leisure = clamp01(s.leisure - 0.2);
        break;
      case "store":
        if (yourStores.has(lot.id) && storeOpen(t)) visitStore(s, t, lot);
        break;
      default:
        break;
    }
    const stayUntil = a.activity === "work" || a.activity === "sleep" ? a.until : Math.min(t + a.stay, a.until);
    schedule(Math.max(t + 1, stayUntil), { kind: "plan", rid: s.r.id });
  };

  const visitStore = (s: RState, t: number, lot: Lot) => {
    s.visitsToday += 1;
    s.plannedVisit = false;
    s.experiences.push(`Went into ${lot.name}.`);
    s.memory.add("observation", `I went into ${lot.name} to look at ${scenario.product.name}.`, t);
    day.visits += 1;
    day.segVisits[s.r.segment] = (day.segVisits[s.r.segment] ?? 0) + 1;
    emit(t, "visit", s.r.id, lot.id);
    decide(s, t, "enter", facts(s, t, { store: lot.name }, `${scenario.product.name} store price`), (v: EnterDecision) => {
      s.interest = clamp01(s.interest + (v.impression === "positive" ? 0.15 : v.impression === "negative" ? -0.2 : 0));
      if (v.impression === "negative") {
        s.memory.add("observation", `${lot.name} put me off: ${v.thought}`, t);
        return;
      }
      decide(s, t, "purchase", facts(s, t, { store: lot.name, impression: v.impression }, `buy ${scenario.product.name} price budget`), (p: PurchaseDecision) => {
        const cost = effectivePrice();
        const budgetLeft = s.r.productBudgetCents - s.productSpentThisMonth;
        if (p.buy && s.money >= cost && cost <= budgetLeft) {
          pay(s, lot.id, cost, t, scenario.product.name, true);
          s.experiences.push(`Bought ${scenario.product.name}.`);
          s.memory.add("observation", `I bought ${scenario.product.name} at ${lot.name} for $${(cost / 100).toFixed(2)}.`, t);
          if (!s.adopted) {
            s.adopted = true;
            s.interest = Math.max(s.interest, 0.7);
            day.newAdopters += 1;
            emit(t, "adopt", s.r.id, lot.id);
          }
        } else {
          const text = (p.objection ?? p.thought).trim();
          s.experiences.push(`Didn't buy ${scenario.product.name}.`);
          s.memory.add("observation", `I didn't buy ${scenario.product.name}: ${text}`, t);
          if (text) objections.push({ day: today, t, residentId: s.r.id, segment: s.r.segment, personaId: s.r.personaId, calibrated: s.r.calibrated, text });
        }
      });
    });
  };

  const exposure = (s: RState, t: number, channel: AdChannel | "event", creative: string, lot?: string) => {
    s.aware = true;
    day.ads += 1;
    s.experiences.push(`Saw a ${channel} ad for ${scenario.product.name}.`);
    s.memory.add("observation", `I saw a ${channel} ad: "${creative}"`, t);
    emit(t, "ad", s.r.id, lot, { channel });
    if (s.adopted) return;
    decide(s, t, "ad", facts(s, t, { channel, creative }, `${scenario.product.name} ad`), (v: AttentionDecision) => applyAttention(s, t, v));
  };

  const applyAttention = (s: RState, t: number, v: AttentionDecision) => {
    if (v.attention === "curious") s.interest = clamp01(s.interest + 0.15);
    if (v.attention === "plan_visit") {
      s.interest = clamp01(s.interest + 0.3);
      s.plannedVisit = true;
    }
    if (v.thought) s.memory.add("observation", v.thought, t);
  };

  // ── days ─────────────────────────────────────────────────────────────────
  const weatherRng = rngFor(seed, "weather");
  const startDay = (d: number, t: number) => {
    today = d;
    const roll = weatherRng.next();
    weather = weather === "rain" ? (roll < 0.45 ? "rain" : roll < 0.75 ? "cloudy" : "sunny") : roll < 0.18 ? "rain" : roll < 0.45 ? "cloudy" : "sunny";
    emit(t, "day", undefined, undefined, { day: d, weekday: weekdayOf(d), weather });
    Object.assign(day, { visits: 0, units: 0, revenue: 0, competitor: 0, ads: 0, mentions: 0, adSpend: 0, newAdopters: 0, model: 0, cache: 0, rules: 0, credits: 0, segVisits: {} });
    if (d % 30 === 0) for (const s of order) s.productSpentThisMonth = 0;
    // Interventions that start today.
    for (const iv of scenario.interventions) {
      const startsToday = iv.kind === "ad_campaign" ? iv.startDay === d : iv.day === d;
      if (!startsToday) continue;
      if (iv.kind === "product_drop") availableFrom = d;
      if (iv.kind === "price_change") price = iv.priceCents;
      if (iv.kind === "opening_hours") hours = { openHour: iv.openHour, closeHour: iv.closeHour };
      if (iv.kind === "new_location" && lots.has(iv.lotId)) yourStores.add(iv.lotId);
      emit(t, "intervention", undefined, iv.kind === "new_location" ? iv.lotId : undefined, { ...iv });
    }
    // Residents: rent, daily resets, interest fades.
    for (const s of order) {
      s.ledger = { opening: s.money, wagesIn: 0, rentOut: 0, purchasesOut: 0 };
      s.money -= s.r.livingCostCents;
      s.ledger.rentOut += s.r.livingCostCents;
      emit(t, "rent", s.r.id, undefined, { cents: s.r.livingCostCents });
      s.interest *= 0.92;
      s.visitsToday = 0;
      s.calls = { ad: 0, enter: 0, mention: 0, purchase: 0, reflect: 0 };
      s.experiences = [];
      s.boardsSeenToday.clear();
      for (const sh of shiftsStartingOn(s.r, d)) schedule(sh.end, { kind: "wage", rid: s.r.id, cents: s.r.wageCents });
    }
    // Today's ads (simulated reach — never real spend).
    const camps = activeInterventions("ad_campaign", d);
    boardsActive = [];
    searchClicksLeft = 0;
    for (const c of camps) {
      if (c.channel === "billboard") {
        const n = Math.min(billboards.length, Math.floor(c.dailyBudgetCents / SIM_AD_COSTS.billboardPerBoardDayCents));
        boardsActive = billboards.slice(0, n).map((b) => b.id);
        day.adSpend += n * SIM_AD_COSTS.billboardPerBoardDayCents;
      } else if (c.channel === "social") {
        const reach = Math.min(order.length, Math.floor(c.dailyBudgetCents / SIM_AD_COSTS.socialPerReachCents));
        const picked = [...order].sort((a, b) => hash32(`${seed}:${d}:${a.r.id}:social`) - hash32(`${seed}:${d}:${b.r.id}:social`) || a.r.id.localeCompare(b.r.id)).slice(0, reach);
        day.adSpend += reach * SIM_AD_COSTS.socialPerReachCents;
        for (const s of picked) {
          const fr = rngFor(seed, `feed:${d}:${s.r.id}`);
          const at = s.r.routine === "night" ? 15 * 60 + fr.int(0, 360) : 18 * 60 + fr.int(0, 240);
          schedule(t + at, { kind: "exposure", rid: s.r.id, channel: "social", creative: c.creative });
        }
      } else {
        searchClicksLeft += Math.floor(c.dailyBudgetCents / SIM_AD_COSTS.searchPerClickCents);
      }
    }
    for (const s of order) {
      if (s.aware && !s.adopted && s.interest >= 0.2 && rngFor(seed, `search:${d}:${s.r.id}`).chance(0.3)) {
        schedule(t + 12 * 60 + rngFor(seed, `searchat:${d}:${s.r.id}`).int(0, 600), { kind: "search", rid: s.r.id });
      }
    }
    const promo = activeInterventions("promotion", d).find((p) => p.event && p.day === d);
    if (promo) {
      for (const s of order) {
        const fr = rngFor(seed, `flyer:${d}:${s.r.id}`);
        if (fr.chance(0.35)) schedule(t + 10 * 60 + fr.int(0, 480), { kind: "exposure", rid: s.r.id, channel: "event", creative: `${promo.label}: ${promo.discountPct}% off ${scenario.product.name}` });
      }
    }
  };

  const wordOfMouth = (t: number) => {
    const byId = states;
    for (const s of order) {
      if (!(s.adopted || s.interest >= 0.6 || s.wantsToTell)) continue;
      const circle = [...s.r.family.map((id) => ({ id, rel: "family" as const })), ...s.r.friends.map((id) => ({ id, rel: "friend" as const }))].filter((x) => !s.told.has(x.id));
      if (!circle.length) continue;
      if (!s.wantsToTell && !s.rng.chance(s.r.traits.sociability * 0.6)) continue;
      const pick = circle[s.rng.int(0, circle.length - 1)]!;
      const friend = byId.get(pick.id);
      if (!friend) continue;
      s.told.add(pick.id);
      s.wantsToTell = false;
      day.mentions += 1;
      const said = s.adopted ? `I got ${scenario.product.name} at your store downtown — worth a look.` : `Have you seen ${scenario.product.name} downtown?`;
      emit(t, "mention", s.r.id, undefined, { to: friend.r.id, relation: pick.rel });
      friend.aware = true;
      friend.experiences.push(`${s.r.name} told me about ${scenario.product.name}.`);
      friend.memory.add("observation", `${s.r.name} (${pick.rel}) told me: "${said}"`, t);
      if (friend.adopted) continue;
      decide(friend, t, "mention", facts(friend, t, { from: s.r.name, relation: pick.rel, said }, `${scenario.product.name} ${s.r.name}`), (v: AttentionDecision) => applyAttention(friend, t, v));
    }
  };

  const reflections = (t: number) => {
    for (const s of order) {
      if (!s.experiences.length) continue;
      const exp = s.experiences.slice(0, 6);
      decide(s, t, "reflect", facts(s, t, { experiences: exp }, `today ${scenario.product.name}`), (v: ReflectDecision) => {
        s.memory.add("reflection", v.summary, t);
        emit(t, "reflect", s.r.id, undefined, { summary: v.summary, plan: v.plan });
        if (v.plan === "visit_store" && !s.adopted) s.plannedVisit = true;
        if (v.plan === "tell_friend") s.wantsToTell = true;
      });
    }
  };

  const closeDay = (d: number) => {
    let adopters = 0;
    const bySegment: DayMetrics["bySegment"] = {};
    for (const s of order) {
      ledgerRows.push({ day: d, residentId: s.r.id, ...s.ledger, closing: s.money });
      if (s.adopted) adopters += 1;
      const seg = (bySegment[s.r.segment] ??= { adopters: 0, visits: 0, residents: 0 });
      seg.residents += 1;
      if (s.adopted) seg.adopters += 1;
    }
    for (const [k, v] of Object.entries(day.segVisits)) (bySegment[k] ??= { adopters: 0, visits: 0, residents: 0 }).visits = v;
    dayMetrics.push({
      day: d,
      weather,
      adoptersCumulative: adopters,
      newAdopters: day.newAdopters,
      visits: day.visits,
      units: day.units,
      revenueCents: day.revenue,
      competitorRevenueCents: day.competitor,
      adExposures: day.ads,
      mentions: day.mentions,
      simulatedAdSpendCents: day.adSpend,
      modelDecisions: day.model,
      cachedDecisions: day.cache,
      ruleDecisions: day.rules,
      credits: day.credits,
      bySegment,
    });
  };

  const snapshot = (t: number) => {
    let adopters = 0;
    const residents: SnapshotResident[] = order.map((s) => {
      if (s.adopted) adopters += 1;
      let x: number;
      let y: number;
      if (s.trip) {
        const sec = t * 60;
        const p = s.trip.path;
        let i = 0;
        while (i < p.length - 1 && p[i + 1]![2] <= sec) i++;
        const a = p[i]!;
        const b = p[Math.min(i + 1, p.length - 1)]!;
        const f = b[2] > a[2] ? Math.min(1, Math.max(0, (sec - a[2]) / (b[2] - a[2]))) : 0;
        x = round1(a[0] + (b[0] - a[0]) * f);
        y = round1(a[1] + (b[1] - a[1]) * f);
      } else {
        const c = lotCenter(lots.get(s.lot ?? s.r.homeLotId)!);
        x = round1(c.x);
        y = round1(c.y);
      }
      return { id: s.r.id, lot: s.trip ? null : s.lot, x, y, money: s.money, interest: Math.round(s.interest * 100) / 100, adopted: s.adopted };
    });
    const visits = dayMetrics.reduce((n, m) => n + m.visits, 0) + day.visits;
    const yourRevenueCents = [...yourStores].reduce((n, id) => n + (storeRevenue[id] ?? 0), 0);
    snapshots.push({ t, residents, adopters, visits, yourRevenueCents });
  };

  const resolve = async (t: number) => {
    while (pending.length) {
      const batch = pending.splice(0, pending.length);
      const answers = await opts.decider.decideMany(opts.runId, batch.map((q) => q.req));
      batch.forEach((q, i) => q.apply(answers[i]!));
    }
  };

  // ── the loop ─────────────────────────────────────────────────────────────
  for (const s of order) schedule(0, { kind: "plan", rid: s.r.id });
  let t = 0;
  loop: for (; t < T; t++) {
    if (t % MINUTES_PER_DAY === 0) {
      startDay(dayOf(t), t);
      if (opts.onDay) await opts.onDay(dayOf(t));
    }
    if (t % 60 === 0) {
      if (opts.signal?.aborted) {
        stopped = { reason: "aborted", t, detail: `Stopped at ${fmtTime(t)}: the run was cancelled.` };
        break;
      }
      if (recordSnaps) snapshot(t);
    }
    const bucket = buckets[t]!;
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i]!;
      const s = states.get(a.rid)!;
      switch (a.kind) {
        case "plan":
          plan(s, t);
          break;
        case "arrive":
          arrive(s, t, a);
          break;
        case "wage":
          s.money += a.cents;
          s.ledger.wagesIn += a.cents;
          emit(t, "wage", s.r.id, s.r.workLotId, { cents: a.cents });
          break;
        case "exposure":
          if (scheduleBlock(s.r, t) !== "sleep") exposure(s, t, a.channel, a.creative);
          break;
        case "search":
          if (searchClicksLeft > 0) {
            const camp = activeInterventions("ad_campaign", today).find((c) => c.channel === "search");
            if (camp) {
              searchClicksLeft -= 1;
              day.adSpend += SIM_AD_COSTS.searchPerClickCents;
              exposure(s, t, "search", camp.creative);
            }
          }
          break;
      }
    }
    buckets[t] = [];
    const mod = t % MINUTES_PER_DAY;
    if (mod === 21 * 60) wordOfMouth(t);
    if (mod === 23 * 60) reflections(t);
    if (pending.length) {
      try {
        await resolve(t);
      } catch (err) {
        if (!isCapReached(err)) throw err;
        pending.length = 0;
        stopped = { reason: "cap", t, detail: `Stopped at ${fmtTime(t)}: ${(err as Error).message}` };
        emit(t, "cap_stop", undefined, undefined, { message: (err as Error).message });
        break loop;
      }
    }
    if (mod === MINUTES_PER_DAY - 1) closeDay(dayOf(t));
  }
  if (stopped) closeDay(dayOf(Math.min(t, T - 1)));
  emit(Math.min(t, T), "end", undefined, undefined, { stopped: stopped?.reason ?? null });
  return {
    events,
    snapshots,
    days: dayMetrics,
    ledger: ledgerRows,
    storeRevenueCents: storeRevenue,
    objections,
    stopped,
    decisions: decisionTotals,
    residentDays: order.length * dayMetrics.length,
  };
}
