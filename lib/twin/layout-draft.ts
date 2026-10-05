// ShapesOS — Phase 13 (twincore): drafting a site layout (PURE).
//
// twin_draft_layout (lib/chat/ops-twin-tools.ts) turns a description — and,
// when the model can see images, a floor-plan photo — into a DRAFT site.
// Two honest paths feed the same validator:
//   - normaliseModelLayout(): the model's proposed objects, with each
//     binding given as a record CODE (location code, work-centre code,
//     register name) resolved here to ids; anything that doesn't fit the
//     grid, overlaps, or binds the wrong kind is dropped with a note;
//   - autoLayout(): no live model → a deterministic layout FROM THE
//     WAREHOUSE'S RECORDS (racks, zones, shelves, work centres, registers,
//     docks), clearly reported as not having read the description.
// Either way the result is a draft; a person publishes it (gated).

import {
  LOCATION_KINDS_FOR,
  TWIN_MAX_GRID,
  TWIN_MIN_GRID,
  footprintProblem,
  isTwinObjectKind,
  overlapWith,
  type LayoutItem,
} from "./derive";
import { TWIN_BINDABLE, type TwinBindingType, type TwinObjectKind, type TwinRotation, type TwinSiteKind } from "./types";

export interface DraftContext {
  kind: TwinSiteKind;
  locations: ReadonlyArray<{ id: string; parentId: string | null; kind: string; code: string; name: string | null }>;
  workCenters: ReadonlyArray<{ id: string; code: string; name: string }>;
  registers: ReadonlyArray<{ id: string; name: string }>;
}

export interface DraftObject {
  kind: TwinObjectKind;
  label: string;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rotation: TwinRotation;
  bindingType?: TwinBindingType;
  bindingId?: string;
}

export interface DraftLayout {
  gridW: number;
  gridD: number;
  objects: DraftObject[];
  notes: string[];
}

const clampGrid = (n: unknown, fallback: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(TWIN_MIN_GRID, Math.min(TWIN_MAX_GRID, v)) : fallback;
};

/** Add objects one by one, keeping only those that fit and don't overlap. */
function accept(grid: { gridW: number; gridD: number }, candidates: DraftObject[], notes: string[]): DraftObject[] {
  const kept: DraftObject[] = [];
  const items: LayoutItem[] = [];
  candidates.forEach((o, i) => {
    const problem = footprintProblem({ x: o.x, z: o.z, w: o.w, d: o.d, h: o.h, rotation: o.rotation }, grid);
    if (problem) {
      notes.push(`Skipped "${o.label}": ${problem}.`);
      return;
    }
    const item: LayoutItem = { id: `draft-${i}`, kind: o.kind, label: o.label, footprint: o };
    const clash = overlapWith(item, items);
    if (clash) {
      notes.push(`Skipped "${o.label}": it overlaps "${clash.label}".`);
      return;
    }
    items.push(item);
    kept.push(o);
  });
  return kept;
}

/** A deterministic layout from the warehouse's own records (rows of racks / shelves / zones / work centres / registers, an aisle between rows, docks + yard along the south edge). */
export function autoLayout(ctx: DraftContext): DraftLayout {
  const notes: string[] = [];
  const W = ctx.kind === "store" ? 30 : 40;
  const hasChildOfKind = (id: string, kinds: string[]) => ctx.locations.some((l) => l.parentId === id && kinds.includes(l.kind));
  type Item = Omit<DraftObject, "x" | "z">;
  const items: Item[] = [];
  const loc = (kind: TwinObjectKind, l: DraftContext["locations"][number], w: number, d: number, h: number): Item => ({
    kind,
    label: l.name ?? l.code,
    w,
    d,
    h,
    rotation: 0,
    bindingType: "location",
    bindingId: l.id,
  });
  for (const l of ctx.locations.filter((x) => x.kind === "rack")) items.push(loc("rack", l, 3, 8, 4));
  for (const l of ctx.locations.filter((x) => x.kind === "shelf")) items.push(loc("shelf", l, 2, 6, 2));
  for (const l of ctx.locations.filter((x) => x.kind === "zone" && !hasChildOfKind(x.id, ["rack", "shelf", "aisle"]))) items.push(loc("bin_zone", l, 6, 4, 1));
  for (const l of ctx.locations.filter((x) => x.kind === "bin" && !ctx.locations.some((p) => p.id === x.parentId && (p.kind === "rack" || p.kind === "shelf")))) {
    items.push(loc("bin_zone", l, 2, 2, 1));
  }
  for (const wc of ctx.workCenters) items.push({ kind: "work_center", label: wc.name, w: 4, d: 4, h: 3, rotation: 0, bindingType: "work_center", bindingId: wc.id });
  for (const r of ctx.registers) items.push({ kind: "register", label: r.name, w: 3, d: 2, h: 1, rotation: 0, bindingType: "register", bindingId: r.id });

  const objects: DraftObject[] = [];
  let x = 1;
  let z = 1;
  let rowD = 0;
  const newRow = () => {
    if (rowD === 0) return;
    z += rowD;
    objects.push({ kind: "path", label: "Aisle", x: 0, z, w: W, d: 1, h: 1, rotation: 0 });
    z += 2;
    x = 1;
    rowD = 0;
  };
  for (const it of items) {
    if (x + it.w > W - 1) newRow();
    objects.push({ ...it, x, z });
    x += it.w + 1;
    rowD = Math.max(rowD, it.d);
  }
  newRow();
  const docks = ctx.locations.filter((l) => l.kind === "dock");
  if (docks.length) {
    x = 1;
    for (const l of docks) {
      if (x + 4 > W - 1) {
        notes.push(`No room for dock ${l.code} on the south edge — add it in the layout editor.`);
        continue;
      }
      objects.push({ ...loc("dock_door", l, 4, 2, 3), x, z });
      objects.push({ kind: "yard_slot", label: `Yard ${l.code}`, x, z: z + 2, w: 4, d: 2, h: 1, rotation: 0 });
      x += 5;
    }
    z += 4;
  }
  const gridD = clampGrid(Math.max(z + 1, 10), 10);
  if (!items.length && !docks.length) notes.push("The warehouse has no racks, shelves, zones, docks, work centres or registers yet — the draft is empty.");
  notes.push("Equipment (forklifts, carts) isn't recorded anywhere else — add it in the layout editor.");
  return { gridW: W, gridD, objects: accept({ gridW: W, gridD }, objects, notes), notes };
}

/** The model's proposal → validated draft objects with record codes resolved to ids. */
export function normaliseModelLayout(raw: unknown, ctx: DraftContext): DraftLayout {
  const notes: string[] = [];
  const r = (raw ?? {}) as { gridW?: unknown; gridD?: unknown; objects?: unknown };
  const gridW = clampGrid(r.gridW, 40);
  const gridD = clampGrid(r.gridD, 30);
  const list = Array.isArray(r.objects) ? r.objects.slice(0, 400) : [];
  const byCode = new Map(ctx.locations.map((l) => [l.code.toLowerCase(), l]));
  const wcByCode = new Map(ctx.workCenters.map((w) => [w.code.toLowerCase(), w]));
  const regByName = new Map(ctx.registers.map((x) => [x.name.toLowerCase(), x]));
  const candidates: DraftObject[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (!isTwinObjectKind(o.kind)) {
      notes.push(`Skipped an object of unknown kind "${String(o.kind)}".`);
      continue;
    }
    const kind = o.kind;
    const int = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
    const rot = int(o.rotation, 0);
    const label = String(o.label ?? kind).trim().slice(0, 120) || kind;
    const obj: DraftObject = {
      kind,
      label,
      x: int(o.x, 0),
      z: int(o.z, 0),
      w: Math.max(1, int(o.w, 1)),
      d: Math.max(1, int(o.d, 1)),
      h: Math.max(1, Math.min(50, int(o.h, 1))),
      rotation: ([0, 90, 180, 270].includes(rot) ? rot : 0) as TwinRotation,
    };
    const code = typeof o.bind === "string" ? o.bind.trim().toLowerCase() : "";
    if (code) {
      const allowed = TWIN_BINDABLE[kind];
      const l = allowed.includes("location") ? byCode.get(code) : undefined;
      const wc = allowed.includes("work_center") ? wcByCode.get(code) : undefined;
      const reg = allowed.includes("register") ? regByName.get(code) : undefined;
      if (l && (LOCATION_KINDS_FOR[kind] ?? []).includes(l.kind)) Object.assign(obj, { bindingType: "location", bindingId: l.id });
      else if (wc) Object.assign(obj, { bindingType: "work_center", bindingId: wc.id });
      else if (reg) Object.assign(obj, { bindingType: "register", bindingId: reg.id });
      else notes.push(`"${label}" left unbound: no matching ${allowed.join(" / ") || "record"} for "${o.bind}".`);
    }
    candidates.push(obj);
  }
  return { gridW, gridD, objects: accept({ gridW, gridD }, candidates, notes), notes };
}

/** What the model is told about the records it may bind to (codes only — ids never leave the server). */
export function describeContext(ctx: DraftContext): string {
  const locs = ctx.locations.map((l) => `${l.kind} ${l.code}${l.name ? ` (${l.name})` : ""}`).slice(0, 300);
  return [
    `Site kind: ${ctx.kind}.`,
    `Locations (bind racks to rack/aisle/zone, bin zones to bin/zone, shelves to shelf, dock doors to dock): ${locs.join("; ") || "none"}.`,
    `Work centres (bind work_center objects by code): ${ctx.workCenters.map((w) => `${w.code} (${w.name})`).join("; ") || "none"}.`,
    `Registers (bind register objects by name): ${ctx.registers.map((r) => r.name).join("; ") || "none"}.`,
  ].join("\n");
}
