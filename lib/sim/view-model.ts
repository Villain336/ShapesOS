// ShapesOS — Phase 19B (WS=engine): the TownViewModel — the seam between the
// server-authoritative engine and every renderer.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// The browser never simulates. It receives the event log (each trip's
// PLANNED PATH with a timestamp per point, arrivals, purchases, decisions)
// and, optionally, an hourly snapshot to seek from; TownPlayback turns them
// into a TownViewModel at any sim second by interpolating along the paths.
// The 2D SVG map (milestone 2) and the R3F town (milestone 3) both render a
// TownViewModel and nothing else: the 3D renderer adds meshes, cameras and
// LOD, never game logic. Pure — runs in the browser.

import type { TownEvent, TownSnapshot } from "./engine";
import { lotCenter, type TownLayout } from "./layout";
import type { TravelMode } from "./pathfind";

export type PathTuple = [number, number, number];

/** Where a resident is at `sec` along a timestamped path (clamped to its ends). */
export function positionOnPath(path: readonly PathTuple[], sec: number): { x: number; y: number } {
  if (!path.length) return { x: 0, y: 0 };
  if (sec <= path[0]![2]) return { x: path[0]![0], y: path[0]![1] };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (sec < b[2]) {
      const f = b[2] > a[2] ? (sec - a[2]) / (b[2] - a[2]) : 1;
      return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
    }
  }
  const last = path[path.length - 1]!;
  return { x: last[0], y: last[1] };
}

export interface ResidentMeta {
  id: string;
  name: string;
  segment: string;
  homeLotId: string;
}

export interface ResidentView {
  id: string;
  name: string;
  segment: string;
  position: { x: number; y: number };
  moving: boolean;
  mode: TravelMode | null;
  /** The lot they are at (null while moving). */
  lot: string | null;
  adopted: boolean;
}

export interface TownViewModel {
  layout: TownLayout;
  /** Sim second since Monday 00:00 of day 1. */
  t: number;
  day: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  clock: string;
  weather: string | null;
  residents: ResidentView[];
  yourStores: string[];
  stats: { adopters: number; visits: number };
}

interface Track {
  lot: string | null;
  fixed: { x: number; y: number } | null;
  trip: { path: PathTuple[]; mode: TravelMode; to: string; start: number; end: number } | null;
  adoptedAt: number | null;
}

export class TownPlayback {
  private readonly tracks = new Map<string, Track>();
  private readonly days: Array<{ sec: number; weather: string }> = [];
  private readonly newStores: Array<{ sec: number; lot: string }> = [];
  private readonly visits: number[] = [];
  private baseVisits = 0;
  private baseAdopters = 0;
  private baseSec = 0;
  private readonly centers: Map<string, { x: number; y: number }>;
  private readonly baseStores: string[];

  constructor(
    readonly layout: TownLayout,
    private readonly people: readonly ResidentMeta[],
  ) {
    this.centers = new Map(layout.lots.map((l) => [l.id, lotCenter(l)]));
    this.baseStores = layout.lots.filter((l) => l.kind === "shop" && l.owner === "you").map((l) => l.id);
    this.reset();
  }

  private reset(): void {
    this.tracks.clear();
    for (const p of this.people) this.tracks.set(p.id, { lot: p.homeLotId, fixed: null, trip: null, adoptedAt: null });
  }

  /** Seek: everyone where the hourly snapshot has them (events after it are applied next). */
  loadSnapshot(s: TownSnapshot): void {
    this.reset();
    this.days.length = 0;
    this.visits.length = 0;
    this.baseSec = s.t * 60;
    this.baseVisits = s.visits;
    this.baseAdopters = s.adopters;
    for (const r of s.residents) {
      const tr = this.tracks.get(r.id);
      if (!tr) continue;
      tr.lot = r.lot;
      tr.fixed = { x: r.x, y: r.y };
      tr.adoptedAt = r.adopted ? this.baseSec : null;
    }
  }

  apply(events: readonly TownEvent[]): void {
    for (const e of events) {
      const sec = e.t * 60;
      const tr = e.r ? this.tracks.get(e.r) : undefined;
      switch (e.type) {
        case "day":
          this.days.push({ sec, weather: String((e.d as { weather?: string })?.weather ?? "") });
          break;
        case "trip": {
          if (!tr) break;
          const d = e.d as { mode: TravelMode; path: PathTuple[] };
          const path = d.path ?? [];
          tr.trip = { path, mode: d.mode, to: e.lot ?? "", start: path[0]?.[2] ?? sec, end: path[path.length - 1]?.[2] ?? sec };
          tr.fixed = null;
          break;
        }
        case "arrive":
          if (tr) {
            tr.lot = e.lot ?? null;
            tr.fixed = null;
          }
          break;
        case "adopt":
          if (tr && tr.adoptedAt === null) tr.adoptedAt = sec;
          break;
        case "visit":
          this.visits.push(sec);
          break;
        case "intervention": {
          const d = e.d as { kind?: string; lotId?: string };
          if (d?.kind === "new_location" && d.lotId) this.newStores.push({ sec, lot: d.lotId });
          break;
        }
        default:
          break;
      }
    }
  }

  viewAt(sec: number): TownViewModel {
    const day = Math.floor(sec / 86_400);
    const m = Math.floor((sec - day * 86_400) / 60);
    let weather: string | null = null;
    for (const d of this.days) if (d.sec <= sec) weather = d.weather;
    let adopters = this.baseAdopters;
    const residents: ResidentView[] = this.people.map((p) => {
      const tr = this.tracks.get(p.id)!;
      const adopted = tr.adoptedAt !== null && tr.adoptedAt <= sec;
      if (adopted && tr.adoptedAt! > this.baseSec) adopters += 1;
      const trip = tr.trip;
      if (trip && sec >= trip.start && sec < trip.end) {
        return { id: p.id, name: p.name, segment: p.segment, position: positionOnPath(trip.path, sec), moving: true, mode: trip.mode, lot: null, adopted };
      }
      const lot = trip && sec >= trip.end ? (trip.to || tr.lot) : tr.lot;
      const position = tr.fixed ?? (trip && sec >= trip.end ? positionOnPath(trip.path, sec) : (this.centers.get(lot ?? p.homeLotId) ?? { x: 0, y: 0 }));
      return { id: p.id, name: p.name, segment: p.segment, position, moving: false, mode: null, lot, adopted };
    });
    const yourStores = [...new Set([...this.baseStores, ...this.newStores.filter((s) => s.sec <= sec).map((s) => s.lot)])].sort();
    return {
      layout: this.layout,
      t: sec,
      day,
      weekday: ((day % 7) + 7) % 7,
      clock: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      weather,
      residents,
      yourStores,
      stats: { adopters, visits: this.baseVisits + this.visits.filter((v) => v <= sec).length },
    };
  }
}
