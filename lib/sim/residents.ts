// ShapesOS — Phase 19B (WS=engine): residents — people, not agents.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// 50–500 residents generated from the panel's personas (lib/panel/persona.ts,
// read through its exported PersonaSpec type) plus segment sliders. Each has:
//   * a home (households share one → family ties) and a workplace;
//   * a routine template: weekday (Mon–Fri 9–5), weekend (Thu–Mon 10–6) or
//     night shift (Mon–Fri 22–06), each start jittered ±15 min per person;
//   * traits (price sensitivity, ad openness, sociability, scepticism) from
//     the persona when there is one, else from the slider, with seeded noise;
//   * a wage per shift, a starting balance and a budget for your product
//     (the persona's monthly maximum);
//   * friends: a seeded small-world graph (Watts–Strogatz ring over
//     neighbours, k = 4, 15 % rewired), always symmetric.
// A resident built from a calibrated persona is `calibrated`; residents from
// sliders alone are not (and never feed a verdict — lib/sim/results.ts).
// Pure and deterministic per seed.

import type { PersonaSpec } from "@/lib/panel/persona";
import { lotCapacity, type TownLayout } from "./layout";
import { rngFor, type Rng } from "./rng";

export type Routine = "weekday" | "weekend" | "night";
export const ROUTINES: readonly Routine[] = ["weekday", "weekend", "night"];
export type Income = "low" | "mid" | "high";

/** A population slider: share of the town, optionally tied to a panel persona. */
export interface SegmentSpec {
  key: string;
  label: string;
  /** 0..1; shares are normalised. */
  share: number;
  personaId?: string | null;
  routineMix?: Partial<Record<Routine, number>>;
  income?: Income;
  /** 0..1 overrides (otherwise from the persona, else 0.5). */
  priceSensitivity?: number;
  adOpenness?: number;
}

export interface PersonaSeed {
  id: string;
  spec: PersonaSpec;
  /** The persona cites an interview that exists (lib/panel/verdicts.ts personaCalibrated). */
  calibrated: boolean;
}

export interface ResidentTraits {
  priceSensitivity: number;
  adOpenness: number;
  sociability: number;
  skepticism: number;
}

export interface Resident {
  id: string;
  name: string;
  segment: string;
  personaId: string | null;
  calibrated: boolean;
  homeLotId: string;
  workLotId: string;
  routine: Routine;
  /** Minutes added to every shift start/end (−15..15). */
  shiftOffset: number;
  income: Income;
  drives: boolean;
  /** Paid at the end of each shift. */
  wageCents: number;
  /** Rent and bills, paid at 00:00 every day. */
  livingCostCents: number;
  startingBalanceCents: number;
  /** Most they would spend on your product in a month (from the persona's budget). */
  productBudgetCents: number;
  traits: ResidentTraits;
  friends: string[];
  family: string[];
}

export const MINUTES_PER_DAY = 1440;

/** Absolute sim minute of (day, hh:mm); day 0 is a Monday. */
export function minuteOf(day: number, hour: number, minute = 0): number {
  return day * MINUTES_PER_DAY + hour * 60 + minute;
}

export function dayOf(absMinute: number): number {
  return Math.floor(absMinute / MINUTES_PER_DAY);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day: number): number {
  return ((day % 7) + 7) % 7;
}

const WAGE: Record<Income, number> = { low: 12_000, mid: 20_000, high: 32_000 };
const DRIVES: Record<Income, number> = { low: 0.4, mid: 0.7, high: 0.9 };

interface Shift {
  start: number;
  end: number;
}

/** Shifts that START on `day` (absolute minutes). */
export function shiftsStartingOn(r: Pick<Resident, "routine" | "shiftOffset">, day: number): Shift[] {
  const wd = weekdayOf(day);
  const o = r.shiftOffset;
  switch (r.routine) {
    case "weekday":
      return wd <= 4 ? [{ start: minuteOf(day, 9) + o, end: minuteOf(day, 17) + o }] : [];
    case "weekend":
      // Thursday to Monday.
      return wd === 0 || wd >= 3 ? [{ start: minuteOf(day, 10) + o, end: minuteOf(day, 18) + o }] : [];
    case "night":
      return wd <= 4 ? [{ start: minuteOf(day, 22) + o, end: minuteOf(day + 1, 6) + o }] : [];
  }
}

/** The shift covering `absMinute`, if any (yesterday's night shift included). */
export function shiftAt(r: Pick<Resident, "routine" | "shiftOffset">, absMinute: number): Shift | null {
  const day = dayOf(absMinute);
  for (const d of [day, day - 1]) {
    for (const s of shiftsStartingOn(r, d)) if (absMinute >= s.start && absMinute < s.end) return s;
  }
  return null;
}

export type ScheduleBlock = "work" | "sleep" | "free";

/** Where the routine puts a resident at an absolute minute. */
export function scheduleBlock(r: Pick<Resident, "routine" | "shiftOffset">, absMinute: number): ScheduleBlock {
  if (shiftAt(r, absMinute)) return "work";
  const m = absMinute - dayOf(absMinute) * MINUTES_PER_DAY;
  if (r.routine === "night") return m >= 7 * 60 && m < 14 * 60 ? "sleep" : "free";
  return m >= 23 * 60 || m < 7 * 60 ? "sleep" : "free";
}

const GIVEN = ["Ana", "Ben", "Chloe", "Dev", "Elena", "Femi", "Grace", "Hugo", "Iris", "Jon", "Kira", "Leo", "Mina", "Nate", "Olu", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Victor", "Wen", "Yara", "Zane"];
const INITIAL = "ABCDEFGHJKLMNPRSTVW";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function pickWeighted<T extends string>(rng: Rng, weights: Partial<Record<T, number>>, fallback: T): T {
  const entries = Object.entries(weights).filter(([, w]) => typeof w === "number" && (w as number) > 0) as Array<[T, number]>;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return fallback;
  let x = rng.next() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x < 0) return k;
  }
  return entries[entries.length - 1]![0];
}

/** Split `n` by shares (largest remainder), in segment order. */
function apportion(n: number, shares: number[]): number[] {
  const total = shares.reduce((s, x) => s + Math.max(0, x), 0) || 1;
  const raw = shares.map((s) => (Math.max(0, s) / total) * n);
  const out = raw.map(Math.floor);
  let left = n - out.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export interface GenerateResidentsOptions {
  layout: TownLayout;
  population: number;
  segments: SegmentSpec[];
  personas: PersonaSeed[];
  seed: number;
}

/** The town's residents (deterministic per seed). */
export function generateResidents(opts: GenerateResidentsOptions): Resident[] {
  const rng = rngFor(opts.seed, "residents");
  const homes = opts.layout.lots.filter((l) => l.kind === "home");
  const capacity = homes.reduce((s, l) => s + lotCapacity(l), 0);
  if (opts.population > capacity) throw new Error(`This town only has homes for ${capacity} residents (asked for ${opts.population}).`);
  const segments = opts.segments.length ? opts.segments : [{ key: "everyone", label: "Everyone", share: 1 } satisfies SegmentSpec];
  const personas = new Map(opts.personas.map((p) => [p.id, p]));
  const counts = apportion(opts.population, segments.map((s) => s.share));

  // Workplaces: offices and works, plus a few jobs at shops and cafés.
  const jobs: string[] = [];
  for (const l of opts.layout.lots) {
    const n = l.kind === "work" ? lotCapacity(l) : l.kind === "shop" || l.kind === "cafe" ? 3 : 0;
    for (let i = 0; i < n; i++) jobs.push(l.id);
  }
  if (jobs.length === 0) throw new Error("This town has no workplaces.");

  // Home slots, filled household by household in a shuffled home order.
  const homeOrder = [...homes];
  const hr = rng.fork("homes");
  for (let i = homeOrder.length - 1; i > 0; i--) {
    const j = hr.int(0, i);
    [homeOrder[i], homeOrder[j]] = [homeOrder[j]!, homeOrder[i]!];
  }
  const slots: string[] = [];
  for (const h of homeOrder) for (let i = 0; i < lotCapacity(h); i++) slots.push(h.id);

  const residents: Resident[] = [];
  let n = 0;
  segments.forEach((seg, si) => {
    const persona = seg.personaId ? (personas.get(seg.personaId) ?? null) : null;
    for (let k = 0; k < counts[si]!; k++) {
      const id = `r${String(n + 1).padStart(3, "0")}`;
      const r = rng.fork(`resident:${id}`);
      const income: Income = seg.income ?? (persona ? (persona.spec.budget.monthlyMax >= 300 ? "high" : persona.spec.budget.monthlyMax >= 80 ? "mid" : "low") : pickWeighted<Income>(r, { low: 0.3, mid: 0.5, high: 0.2 }, "mid"));
      const spec = persona?.spec;
      const noise = () => (r.next() - 0.5) * 0.2;
      const traits: ResidentTraits = {
        priceSensitivity: clamp01((seg.priceSensitivity ?? (spec ? (spec.budget.hardCap ? 0.8 : 0.55) - Math.min(0.3, spec.budget.monthlyMax / 2000) : 0.5)) + noise()),
        adOpenness: clamp01((seg.adOpenness ?? (spec ? 0.25 + spec.bigFive.openness * 0.5 : 0.5)) + noise()),
        sociability: clamp01((spec ? spec.bigFive.extraversion : 0.5) + noise()),
        skepticism: clamp01((spec ? spec.skepticism : 0.5) + noise()),
      };
      const wage = Math.round(WAGE[income] * (0.9 + r.next() * 0.2));
      residents.push({
        id,
        name: `${GIVEN[(n * 7 + r.int(0, GIVEN.length - 1)) % GIVEN.length]} ${INITIAL[r.int(0, INITIAL.length - 1)]}.`,
        segment: seg.key,
        personaId: persona?.id ?? null,
        calibrated: persona?.calibrated ?? false,
        homeLotId: slots[n]!,
        workLotId: jobs[(n * 13 + r.int(0, jobs.length - 1)) % jobs.length]!,
        routine: pickWeighted<Routine>(r, seg.routineMix ?? { weekday: 0.7, weekend: 0.2, night: 0.1 }, "weekday"),
        shiftOffset: r.int(-3, 3) * 5,
        income,
        drives: r.chance(DRIVES[income]),
        wageCents: wage,
        livingCostCents: Math.round((wage * 5 * 0.55) / 7),
        startingBalanceCents: wage * 3,
        productBudgetCents: Math.round((spec?.budget.monthlyMax ?? (income === "high" ? 150 : income === "mid" ? 60 : 25)) * 100),
        traits,
        friends: [],
        family: [],
      });
      n += 1;
    }
  });

  // Family: everyone sharing a home.
  const byHome = new Map<string, string[]>();
  for (const r of residents) byHome.set(r.homeLotId, [...(byHome.get(r.homeLotId) ?? []), r.id]);
  for (const r of residents) r.family = byHome.get(r.homeLotId)!.filter((id) => id !== r.id);

  // Friends: Watts–Strogatz over a ring ordered by home (neighbours are local).
  const ring = [...residents].sort((a, b) => slots.indexOf(a.homeLotId) - slots.indexOf(b.homeLotId) || a.id.localeCompare(b.id));
  const N = ring.length;
  const edges = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const wr = rng.fork("ties");
  if (N > 1) {
    for (let i = 0; i < N; i++) {
      for (let d = 1; d <= Math.min(2, Math.floor((N - 1) / 2) || 1); d++) {
        const a = ring[i]!.id;
        let b = ring[(i + d) % N]!.id;
        if (wr.chance(0.15)) {
          for (let guard = 0; guard < 10; guard++) {
            const c = ring[wr.int(0, N - 1)]!.id;
            if (c !== a && !edges.has(key(a, c))) {
              b = c;
              break;
            }
          }
        }
        if (a !== b) edges.add(key(a, b));
      }
    }
  }
  const byId = new Map(residents.map((r) => [r.id, r]));
  for (const e of [...edges].sort()) {
    const [a, b] = e.split("|") as [string, string];
    byId.get(a)!.friends.push(b);
    byId.get(b)!.friends.push(a);
  }
  for (const r of residents) r.friends.sort();
  return residents;
}
