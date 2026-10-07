// ShapesOS — Phase 19B (WS=engine): the town layout JSON (zod).
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// One layout drives the simulation (lots residents live / work / shop at, a
// road graph for driving, a walkable graph for walking) and every renderer:
// the 2D SVG map now, the 3D town in milestone 3. Units are metres; x grows
// east, y grows south (SVG order). A layout comes from the procedural
// generator (lib/sim/generate.ts) or a Figma frame (lib/sim/figma.ts).
//
//   districts   named rectangles (residential / commercial / industrial / park / mixed)
//   lots        a building or place: home | work | shop | cafe | park | billboard;
//               a shop is yours or a competitor's; each lot connects to one
//               road node (cars) and one walk node (pedestrians)
//   roads       nodes + edges with lanes, speed limit and one-way flag
//   walkways    sidewalks / paths: nodes + undirected edges
// Pure: no I/O.

import { z } from "zod";

export const LOT_KINDS = ["home", "work", "shop", "cafe", "park", "billboard"] as const;
export type LotKind = (typeof LOT_KINDS)[number];
export const DISTRICT_KINDS = ["residential", "commercial", "industrial", "park", "mixed"] as const;
export type DistrictKind = (typeof DISTRICT_KINDS)[number];

const id = z.string().trim().min(1).max(80);
const coord = z.number().finite().min(-100_000).max(100_000);
export const RectSchema = z.object({ x: coord, y: coord, w: z.number().finite().positive().max(100_000), h: z.number().finite().positive().max(100_000) });
export type Rect = z.infer<typeof RectSchema>;

export const DistrictSchema = z.object({ id, name: z.string().trim().min(1).max(120), kind: z.enum(DISTRICT_KINDS), rect: RectSchema });
export type District = z.infer<typeof DistrictSchema>;

export const LotSchema = z.object({
  id,
  districtId: id,
  kind: z.enum(LOT_KINDS),
  /** Shops only: "you" (the store being rehearsed) or "competitor". */
  owner: z.enum(["you", "competitor"]).optional(),
  name: z.string().trim().min(1).max(120),
  rect: RectSchema,
  /** The road node a car arrives at. */
  roadNode: id,
  /** The walk node a pedestrian arrives at. */
  walkNode: id,
  /** People it holds at once (homes: residents; work: jobs). Default by kind. */
  capacity: z.number().int().min(1).max(10_000).optional(),
});
export type Lot = z.infer<typeof LotSchema>;

export const GraphNodeSchema = z.object({ id, x: coord, y: coord });
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const RoadEdgeSchema = z.object({
  id,
  from: id,
  to: id,
  lanes: z.number().int().min(1).max(8),
  speedKph: z.number().min(5).max(130),
  /** True = only from → to. */
  oneWay: z.boolean(),
});
export type RoadEdge = z.infer<typeof RoadEdgeSchema>;

export const WalkEdgeSchema = z.object({ id, from: id, to: id });
export type WalkEdge = z.infer<typeof WalkEdgeSchema>;

const LayoutShape = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  source: z.enum(["generated", "figma"]),
  size: z.object({ width: z.number().positive().max(100_000), height: z.number().positive().max(100_000) }),
  districts: z.array(DistrictSchema).min(1).max(200),
  lots: z.array(LotSchema).min(1).max(5_000),
  roads: z.object({ nodes: z.array(GraphNodeSchema).min(1).max(20_000), edges: z.array(RoadEdgeSchema).max(40_000) }),
  walkways: z.object({ nodes: z.array(GraphNodeSchema).min(1).max(20_000), edges: z.array(WalkEdgeSchema).max(40_000) }),
});

/** Default capacity of a lot when the layout gives none. */
export function lotCapacity(lot: Pick<Lot, "kind" | "capacity">): number {
  if (lot.capacity) return lot.capacity;
  return { home: 4, work: 40, shop: 30, cafe: 25, park: 200, billboard: 1 }[lot.kind];
}

function dupes(items: Array<{ id: string }>, what: string, path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((it, i) => {
    if (seen.has(it.id)) ctx.addIssue({ code: "custom", path: [path, i, "id"], message: `duplicate ${what} id "${it.id}"` });
    seen.add(it.id);
  });
}

export const TownLayoutSchema = LayoutShape.superRefine((l, ctx) => {
  dupes(l.districts, "district", "districts", ctx);
  dupes(l.lots, "lot", "lots", ctx);
  dupes(l.roads.nodes, "road node", "roads.nodes", ctx);
  dupes(l.walkways.nodes, "walk node", "walkways.nodes", ctx);
  const districts = new Set(l.districts.map((d) => d.id));
  const roadNodes = new Set(l.roads.nodes.map((n) => n.id));
  const walkNodes = new Set(l.walkways.nodes.map((n) => n.id));
  l.lots.forEach((lot, i) => {
    if (!districts.has(lot.districtId)) ctx.addIssue({ code: "custom", path: ["lots", i, "districtId"], message: `unknown district "${lot.districtId}"` });
    if (!roadNodes.has(lot.roadNode)) ctx.addIssue({ code: "custom", path: ["lots", i, "roadNode"], message: `unknown road node "${lot.roadNode}"` });
    if (!walkNodes.has(lot.walkNode)) ctx.addIssue({ code: "custom", path: ["lots", i, "walkNode"], message: `unknown walk node "${lot.walkNode}"` });
    if (lot.kind === "shop" && !lot.owner) ctx.addIssue({ code: "custom", path: ["lots", i, "owner"], message: "shop lots need an owner (you or competitor)" });
    if (lot.kind !== "shop" && lot.owner) ctx.addIssue({ code: "custom", path: ["lots", i, "owner"], message: "only shop lots have an owner" });
  });
  l.roads.edges.forEach((e, i) => {
    if (!roadNodes.has(e.from)) ctx.addIssue({ code: "custom", path: ["roads", "edges", i, "from"], message: `unknown road node "${e.from}"` });
    if (!roadNodes.has(e.to)) ctx.addIssue({ code: "custom", path: ["roads", "edges", i, "to"], message: `unknown road node "${e.to}"` });
  });
  l.walkways.edges.forEach((e, i) => {
    if (!walkNodes.has(e.from)) ctx.addIssue({ code: "custom", path: ["walkways", "edges", i, "from"], message: `unknown walk node "${e.from}"` });
    if (!walkNodes.has(e.to)) ctx.addIssue({ code: "custom", path: ["walkways", "edges", i, "to"], message: `unknown walk node "${e.to}"` });
  });
});
export type TownLayout = z.infer<typeof LayoutShape>;

export class TownLayoutError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid town layout: ${issues.slice(0, 8).join("; ")}${issues.length > 8 ? ` (+${issues.length - 8} more)` : ""}`);
    this.name = "TownLayoutError";
  }
}

function pathOf(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out ? `.${String(p)}` : String(p);
  return out;
}

/** Parse untrusted JSON into a layout, or throw TownLayoutError naming each problem. */
export function parseTownLayout(raw: unknown): TownLayout {
  const r = TownLayoutSchema.safeParse(raw);
  if (r.success) return r.data;
  throw new TownLayoutError(r.error.issues.map((i) => `${pathOf(i.path) || "(root)"}: ${i.message}`));
}

export function lotCenter(lot: Pick<Lot, "rect">): { x: number; y: number } {
  return { x: lot.rect.x + lot.rect.w / 2, y: lot.rect.y + lot.rect.h / 2 };
}
