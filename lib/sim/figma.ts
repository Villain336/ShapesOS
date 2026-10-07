// ShapesOS — Phase 19B (WS=engine): a Figma frame → the town layout JSON.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// "You design a town by drawing it in Figma." One frame of named shapes,
// read through the Figma REST API (GET /v1/files/:key/nodes?ids=:id with the
// X-Figma-Token header, FIGMA_TOKEN — scoped to Dress Rehearsal; there is no
// general Figma connector). Naming convention (case-insensitive prefixes):
//
//   rectangles  district:<kind>:<Name>     kind = residential | commercial | industrial | park | mixed
//               home:<Name> · work:<Name> · cafe:<Name> · park:<Name> · billboard:<Name>
//               shop:you:<Name> · shop:competitor:<Name>
//   lines       road[:<lanes>][:<speed km/h>][:oneway]:<Name>   (one-way = the direction it was drawn)
//               walk:<Name>                                      (sidewalks; default = along every road)
//
// Anything else (text, unnamed shapes) is ignored. Groups are walked. Lines
// are axis-aligned or the diagonal of their bounding box; crossing and
// touching lines are split into a graph (T and X junctions). Each lot joins
// the nearest road node and the nearest walk node. Coordinates are relative
// to the frame, in metres at `metresPerPixel` (default 1).
// The conversion is pure and unit-tested on a fixture; the live read is
// UNVERIFIED-LIVE (no FIGMA_TOKEN here).

import type { District, DistrictKind, GraphNode, Lot, LotKind, Rect, RoadEdge, TownLayout, WalkEdge } from "./layout";
import { DISTRICT_KINDS, LOT_KINDS, parseTownLayout } from "./layout";

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  children?: FigmaNode[];
}

export class FigmaImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaImportError";
  }
}

const SNAP = 3;

interface Seg {
  a: { x: number; y: number };
  b: { x: number; y: number };
  name: string;
  lanes: number;
  speedKph: number;
  oneWay: boolean;
}

function walk(node: FigmaNode, out: FigmaNode[]): void {
  for (const c of node.children ?? []) {
    out.push(c);
    if (c.children?.length) walk(c, out);
  }
}

function lineEnds(box: NonNullable<FigmaNode["absoluteBoundingBox"]>, ox: number, oy: number, scale: number): Seg["a"][] {
  const x = (box.x - ox) * scale;
  const y = (box.y - oy) * scale;
  const w = box.width * scale;
  const h = box.height * scale;
  if (h <= 1) return [{ x, y: y + h / 2 }, { x: x + w, y: y + h / 2 }];
  if (w <= 1) return [{ x: x + w / 2, y }, { x: x + w / 2, y: y + h }];
  return [{ x, y }, { x: x + w, y: y + h }];
}

/** Intersection point of two segments (inclusive of endpoints), or null. */
function intersect(s: Seg, t: Seg): { x: number; y: number } | null {
  const d = (s.b.x - s.a.x) * (t.b.y - t.a.y) - (s.b.y - s.a.y) * (t.b.x - t.a.x);
  if (Math.abs(d) < 1e-9) return null; // parallel (collinear overlaps are joined by snapping endpoints)
  const u = ((t.a.x - s.a.x) * (t.b.y - t.a.y) - (t.a.y - s.a.y) * (t.b.x - t.a.x)) / d;
  const v = ((t.a.x - s.a.x) * (s.b.y - s.a.y) - (t.a.y - s.a.y) * (s.b.x - s.a.x)) / d;
  const tolS = SNAP / Math.max(1, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
  const tolT = SNAP / Math.max(1, Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y));
  if (u < -tolS || u > 1 + tolS || v < -tolT || v > 1 + tolT) return null;
  return { x: s.a.x + u * (s.b.x - s.a.x), y: s.a.y + u * (s.b.y - s.a.y) };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Split segments at every crossing and build a node/edge graph (ids p1, p2 …). */
function buildGraph(segs: Seg[], prefix: string): { nodes: GraphNode[]; parts: Array<{ seg: Seg; from: string; to: string }> } {
  const nodes: GraphNode[] = [];
  const nodeAt = (p: { x: number; y: number }): string => {
    const hit = nodes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) <= SNAP);
    if (hit) return hit.id;
    const n = { id: `${prefix}${nodes.length + 1}`, x: round(p.x), y: round(p.y) };
    nodes.push(n);
    return n.id;
  };
  const parts: Array<{ seg: Seg; from: string; to: string }> = [];
  segs.forEach((s, i) => {
    const pts: Array<{ x: number; y: number; u: number }> = [
      { ...s.a, u: 0 },
      { ...s.b, u: 1 },
    ];
    segs.forEach((t, j) => {
      if (i === j) return;
      const p = intersect(s, t);
      if (!p) return;
      const len2 = (s.b.x - s.a.x) ** 2 + (s.b.y - s.a.y) ** 2 || 1;
      const u = ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)) / len2;
      pts.push({ ...p, u: Math.min(1, Math.max(0, u)) });
    });
    pts.sort((p, q) => p.u - q.u);
    let prev = nodeAt(pts[0]!);
    for (const p of pts.slice(1)) {
      const id = nodeAt(p);
      if (id !== prev) parts.push({ seg: s, from: prev, to: id });
      prev = id;
    }
  });
  // Same street drawn twice → one edge.
  const seen = new Set<string>();
  return {
    nodes,
    parts: parts.filter((p) => {
      const k = p.seg.oneWay ? `${p.from}>${p.to}` : [p.from, p.to].sort().join("~");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

function nearest(nodes: GraphNode[], p: { x: number; y: number }): string {
  let best = nodes[0]!;
  let bestD = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best.id;
}

/** Convert one Figma frame node (the document of a /nodes response) into a layout. */
export function figmaFrameToLayout(frame: FigmaNode, opts: { metresPerPixel?: number } = {}): TownLayout {
  const box = frame.absoluteBoundingBox;
  if (!box) throw new FigmaImportError("The Figma node has no bounding box — pick a frame.");
  const scale = opts.metresPerPixel ?? 1;
  const all: FigmaNode[] = [];
  walk(frame, all);
  const rectOf = (n: FigmaNode): Rect | null => {
    const b = n.absoluteBoundingBox;
    if (!b || b.width <= 0 || b.height <= 0) return null;
    return { x: round((b.x - box.x) * scale), y: round((b.y - box.y) * scale), w: round(b.width * scale), h: round(b.height * scale) };
  };

  const districts: District[] = [];
  const lotDrafts: Array<Omit<Lot, "districtId" | "roadNode" | "walkNode">> = [];
  const roads: Seg[] = [];
  const walks: Seg[] = [];
  for (const n of all) {
    const parts = n.name.split(":").map((p) => p.trim());
    const head = (parts[0] ?? "").toLowerCase();
    if (n.type === "LINE" || n.type === "VECTOR") {
      if ((head !== "road" && head !== "walk") || !n.absoluteBoundingBox) continue;
      const [a, b] = lineEnds(n.absoluteBoundingBox, box.x, box.y, scale) as [Seg["a"], Seg["a"]];
      const rest = parts.slice(1);
      const nums = rest.filter((p) => /^\d+(\.\d+)?$/.test(p)).map(Number);
      const oneWay = rest.some((p) => p.toLowerCase() === "oneway");
      const name = rest.filter((p) => !/^\d+(\.\d+)?$/.test(p) && p.toLowerCase() !== "oneway").join(":") || n.name;
      const seg: Seg = { a, b, name, lanes: Math.min(8, Math.max(1, Math.round(nums[0] ?? 2))), speedKph: Math.min(130, Math.max(5, nums[1] ?? 30)), oneWay };
      (head === "road" ? roads : walks).push(seg);
      continue;
    }
    if (n.type !== "RECTANGLE" && n.type !== "FRAME") continue;
    const rect = rectOf(n);
    if (!rect) continue;
    if (head === "district") {
      const kind = (parts[1] ?? "").toLowerCase();
      if (!(DISTRICT_KINDS as readonly string[]).includes(kind)) continue;
      districts.push({ id: `d${districts.length + 1}`, name: parts.slice(2).join(":") || kind, kind: kind as DistrictKind, rect });
      continue;
    }
    if (!(LOT_KINDS as readonly string[]).includes(head)) continue;
    const kind = head as LotKind;
    if (kind === "shop") {
      const owner = (parts[1] ?? "").toLowerCase();
      if (owner !== "you" && owner !== "competitor") continue;
      lotDrafts.push({ id: `lot${lotDrafts.length + 1}`, kind, owner, name: parts.slice(2).join(":") || "Shop", rect });
    } else {
      lotDrafts.push({ id: `lot${lotDrafts.length + 1}`, kind, name: parts.slice(1).join(":") || kind, rect });
    }
  }
  if (roads.length === 0) throw new FigmaImportError('The frame has no roads: draw lines named "road:<lanes>:<km/h>:<Name>".');
  if (lotDrafts.length === 0) throw new FigmaImportError('The frame has no lots: name rectangles "home:…", "work:…", "shop:you:…", "cafe:…", "park:…" or "billboard:…".');

  const road = buildGraph(roads, "r");
  const roadEdges: RoadEdge[] = road.parts.map((p, i) => ({ id: `e${i + 1}`, from: p.from, to: p.to, lanes: p.seg.lanes, speedKph: p.seg.speedKph, oneWay: p.seg.oneWay }));
  const walkSrc = walks.length ? walks : roads.map((s) => ({ ...s, oneWay: false }));
  const walkG = buildGraph(walkSrc, "w");
  const walkEdges: WalkEdge[] = walkG.parts.map((p, i) => ({ id: `we${i + 1}`, from: p.from, to: p.to }));

  const width = round(box.width * scale);
  const height = round(box.height * scale);
  if (districts.length === 0) districts.push({ id: "d1", name: "Town", kind: "mixed", rect: { x: 0, y: 0, w: width, h: height } });
  const lots: Lot[] = lotDrafts.map((l) => {
    const c = { x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 };
    const d = districts.find((d) => c.x >= d.rect.x && c.x <= d.rect.x + d.rect.w && c.y >= d.rect.y && c.y <= d.rect.y + d.rect.h) ?? districts[0]!;
    return { ...l, districtId: d.id, roadNode: nearest(road.nodes, c), walkNode: nearest(walkG.nodes, c) };
  });
  const name = frame.name.replace(/^town\s*:\s*/i, "").trim() || "Figma town";
  return parseTownLayout({ version: 1, name, source: "figma", size: { width, height }, districts, lots, roads: { nodes: road.nodes, edges: roadEdges }, walkways: { nodes: walkG.nodes, edges: walkEdges } });
}

/** figma.com/design/:key/…?node-id=1-2 (or /file/, /board/; a branch key wins) → { fileKey, nodeId }. */
export function parseFigmaUrl(raw: string): { fileKey: string; nodeId: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const m = /^\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(u.pathname);
  const nodeRaw = u.searchParams.get("node-id");
  if (!m || !nodeRaw) return null;
  return { fileKey: m[2] ?? m[1]!, nodeId: nodeRaw.replace(/-/g, ":") };
}

export interface FetchFigmaOptions {
  token: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Read one frame through the Figma REST API (scoped to Dress Rehearsal). */
export async function fetchFigmaFrame(ref: { fileKey: string; nodeId: string }, opts: FetchFigmaOptions): Promise<FigmaNode> {
  if (!opts.token) throw new FigmaImportError("Figma import needs FIGMA_TOKEN (a Figma personal access token with file read access).");
  if (!/^[A-Za-z0-9]+$/.test(ref.fileKey) || !/^[0-9]+:[0-9]+$/.test(ref.nodeId)) throw new FigmaImportError("That is not a Figma file key and frame id.");
  const url = `https://api.figma.com/v1/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}`;
  const res = await (opts.fetch ?? fetch)(url, { headers: { "X-Figma-Token": opts.token }, signal: opts.signal });
  if (res.status === 403 || res.status === 401) throw new FigmaImportError("Figma said no: the token was refused, or it can't read that file.");
  if (res.status === 404) throw new FigmaImportError("Figma couldn't find that file.");
  if (!res.ok) throw new FigmaImportError(`Figma answered ${res.status}.`);
  const body = (await res.json()) as { nodes?: Record<string, { document?: FigmaNode } | null> };
  const doc = body.nodes?.[ref.nodeId]?.document;
  if (!doc) throw new FigmaImportError(`The frame ${ref.nodeId} was not found in that file.`);
  return doc;
}
