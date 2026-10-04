// ShapesOS — Phase 13 (twinui): the twin scene kit.
//
// ONE shared library for every object component under components/twin/scene:
//   - the clay palette, resolved from CSS tokens (--aos-clay-0…4, -grid;
//     docs/design/tokens.css) — no raw colours in scene code;
//   - grid ↔ world maths (1 cell = 1 m; the site is centred on the origin);
//   - the isometric camera preset and fit-to-site zoom;
//   - shared geometries + materials (one BoxGeometry for every block, one
//     material per clay level) and instancing helpers (pallets, stock boxes).
// Grid maths and layout helpers are PURE (unit-tested); the THREE caches are
// created lazily on the client.
//
// Footprint convention (lib/twin/types.ts TwinFootprint): x/z is the minimum
// corner of the cells the object OCCUPIES; w/d are the object's own
// (unrotated) width and depth; a 90°/270° rotation swaps the occupied extent.
// Rotation turns the object's front: 0 faces south (+z), 90 east (+x),
// 180 north (−z), 270 west (−x).

import * as THREE from "three";
import type { TwinFootprint, TwinRotation, TwinSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Clay palette (tokens only)
// ---------------------------------------------------------------------------

export const CLAY_TOKENS = {
  0: "--aos-clay-0",
  1: "--aos-clay-1",
  2: "--aos-clay-2",
  3: "--aos-clay-3",
  4: "--aos-clay-4",
  grid: "--aos-clay-grid",
  ink: "--aos-ink",
  muted: "--aos-text-muted",
} as const;
export type ClayKey = keyof typeof CLAY_TOKENS;

const tokenCache = new Map<string, string>();

/** A CSS custom property's computed value (client); a neutral fallback elsewhere. */
export function resolveToken(name: string): string {
  if (typeof document === "undefined") return "gray";
  let v = tokenCache.get(name);
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "gray";
    tokenCache.set(name, v);
  }
  return v;
}

export function clayColor(key: ClayKey): string {
  return resolveToken(CLAY_TOKENS[key]);
}

/** CSS `var()` reference for DOM/SVG use (server-safe). */
export function clayVar(key: ClayKey): string {
  return `var(${CLAY_TOKENS[key]})`;
}

// ---------------------------------------------------------------------------
// Grid ↔ world (PURE)
// ---------------------------------------------------------------------------

export type SiteGrid = Pick<TwinSnapshot["site"], "gridW" | "gridD">;

export const TWIN_ROTATIONS: readonly TwinRotation[] = [0, 90, 180, 270];

/** The extent an object occupies on the grid (rotation 90/270 swaps w and d). */
export function occupiedSize(fp: Pick<TwinFootprint, "w" | "d" | "rotation">): { w: number; d: number } {
  return fp.rotation === 90 || fp.rotation === 270 ? { w: fp.d, d: fp.w } : { w: fp.w, d: fp.d };
}

/** The occupied rectangle in cells: [x0, z0) – [x1, z1). */
export function occupiedRect(fp: TwinFootprint): { x0: number; z0: number; x1: number; z1: number } {
  const s = occupiedSize(fp);
  return { x0: fp.x, z0: fp.z, x1: fp.x + s.w, z1: fp.z + s.d };
}

/** Grid cell coordinates → world x/z (the site is centred on the origin). */
export function cellToWorld(x: number, z: number, grid: SiteGrid): { x: number; z: number } {
  return { x: x - grid.gridW / 2, z: z - grid.gridD / 2 };
}

/** World x/z → grid coordinates (continuous). */
export function worldToGrid(x: number, z: number, grid: SiteGrid): { x: number; z: number } {
  return { x: x + grid.gridW / 2, z: z + grid.gridD / 2 };
}

/** World x/z → the snapped cell under it, clamped inside the site. */
export function worldToCell(x: number, z: number, grid: SiteGrid): { x: number; z: number } {
  const g = worldToGrid(x, z, grid);
  return {
    x: Math.min(grid.gridW - 1, Math.max(0, Math.floor(g.x))),
    z: Math.min(grid.gridD - 1, Math.max(0, Math.floor(g.z))),
  };
}

/** World position of the footprint's centre (on the ground). */
export function footprintCenter(fp: TwinFootprint, grid: SiteGrid): { x: number; z: number } {
  const s = occupiedSize(fp);
  return cellToWorld(fp.x + s.w / 2, fp.z + s.d / 2, grid);
}

/** Radians about +Y for a TwinRotation (0 front→+z, 90 front→+x). */
export function rotationY(rot: TwinRotation): number {
  return (rot * Math.PI) / 180;
}

/** Unit vector (world x/z) the object's front faces. */
export function frontDirection(rot: TwinRotation): { x: number; z: number } {
  const a = rotationY(rot);
  // Rounded so 90° gives exact (1, 0) instead of (1, 6e-17).
  return { x: Math.round(Math.sin(a)) + 0, z: Math.round(Math.cos(a)) + 0 }; // + 0 turns -0 into 0
}

export function nextRotation(rot: TwinRotation): TwinRotation {
  return TWIN_ROTATIONS[(TWIN_ROTATIONS.indexOf(rot) + 1) % 4]!;
}

/** Keep a footprint inside the site (snapped to whole cells, min 1 × 1). */
export function clampFootprint(fp: TwinFootprint, grid: SiteGrid): TwinFootprint {
  const w = Math.max(1, Math.round(fp.w));
  const d = Math.max(1, Math.round(fp.d));
  const s = occupiedSize({ w, d, rotation: fp.rotation });
  const x = Math.min(Math.max(0, Math.round(fp.x)), Math.max(0, grid.gridW - s.w));
  const z = Math.min(Math.max(0, Math.round(fp.z)), Math.max(0, grid.gridD - s.d));
  return { ...fp, x, z, w, d, h: Math.max(0, fp.h) };
}

/** Do two occupied rectangles overlap (touching edges don't)? */
export function footprintsOverlap(a: TwinFootprint, b: TwinFootprint): boolean {
  const ra = occupiedRect(a);
  const rb = occupiedRect(b);
  return ra.x0 < rb.x1 && rb.x0 < ra.x1 && ra.z0 < rb.z1 && rb.z0 < ra.z1;
}

/** Rotate in place around the occupied centre (the editor's "Rotate 90°"). */
export function rotateFootprint(fp: TwinFootprint, grid: SiteGrid): TwinFootprint {
  const before = occupiedSize(fp);
  const rotation = nextRotation(fp.rotation);
  const after = occupiedSize({ ...fp, rotation });
  const cx = fp.x + before.w / 2;
  const cz = fp.z + before.d / 2;
  return clampFootprint({ ...fp, rotation, x: Math.round(cx - after.w / 2), z: Math.round(cz - after.d / 2) }, grid);
}

/**
 * Where a truck parks at a dock door: centred on the door, nose against it,
 * its body extending outward along the door's front. World coords + heading.
 */
export function truckPlacement(fp: TwinFootprint, grid: SiteGrid, length = 10): { x: number; z: number; rotY: number } {
  const c = footprintCenter(fp, grid);
  const f = frontDirection(fp.rotation);
  const depth = fp.d; // the door's own depth along its front
  const off = depth / 2 + length / 2 + 0.3;
  return { x: c.x + f.x * off, z: c.z + f.z * off, rotY: rotationY(fp.rotation) };
}

// ---------------------------------------------------------------------------
// Stock → instances (PURE)
// ---------------------------------------------------------------------------

/** Units drawn as one pallet (or one shelf box) — a display scale, not a record. */
export const UNITS_PER_PALLET = 40;
export const UNITS_PER_BOX = 6;

/** How many pallets to draw for an on-hand quantity: 0 when empty, ≥1 when any, capped. */
export function palletCount(onHand: number, capacity: number, unitsPer = UNITS_PER_PALLET): number {
  if (!Number.isFinite(onHand) || onHand <= 0 || capacity <= 0) return 0;
  return Math.min(capacity, Math.max(1, Math.ceil(onHand / unitsPer)));
}

/**
 * Rack slots in LOCAL space (the rack centred on the origin, unrotated w × d,
 * long axis whichever is longer): bays of ~1.2 m along the long axis,
 * levels of ~1.2 m up to the rack height. Filled bottom-up, front-to-back.
 */
export function rackSlots(w: number, d: number, h: number): { x: number; y: number; z: number }[] {
  const alongX = w >= d;
  const long = alongX ? w : d;
  const bays = Math.max(1, Math.floor(long / 1.2));
  const levels = Math.max(1, Math.floor(Math.max(1, h) / 1.25));
  const bay = long / bays;
  const out: { x: number; y: number; z: number }[] = [];
  for (let l = 0; l < levels; l++) {
    for (let b = 0; b < bays; b++) {
      const t = -long / 2 + bay * (b + 0.5);
      const y = 0.15 + l * 1.25 + 0.35;
      out.push(alongX ? { x: t, y, z: 0 } : { x: 0, y, z: t });
    }
  }
  return out;
}

/** Shelf facings: 3 shelf levels × slots of ~0.5 m along the long axis. */
export function shelfSlots(w: number, d: number, h: number): { x: number; y: number; z: number }[] {
  const alongX = w >= d;
  const long = alongX ? w : d;
  const per = Math.max(1, Math.floor(long / 0.5));
  const levels = 3;
  const step = Math.max(0.5, h) / (levels + 0.4);
  const out: { x: number; y: number; z: number }[] = [];
  for (let l = 0; l < levels; l++) {
    for (let i = 0; i < per; i++) {
      const t = -long / 2 + (long / per) * (i + 0.5);
      const y = 0.2 + l * step + 0.14;
      out.push(alongX ? { x: t, y, z: 0 } : { x: 0, y, z: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Isometric camera (orthographic)
// ---------------------------------------------------------------------------

/** True isometric elevation: atan(1/√2) ≈ 35.26° above the ground. */
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
/** Default azimuth: looking from the south-east (front faces of south/east walls visible). */
export const ISO_AZIMUTH = Math.PI / 4;

/** Camera position for an orbit around `target` at `distance` (azimuth from +z toward +x). */
export function isoCameraPosition(
  target: { x: number; y: number; z: number },
  distance: number,
  azimuth = ISO_AZIMUTH,
  elevation = ISO_ELEVATION,
): { x: number; y: number; z: number } {
  const flat = Math.cos(elevation) * distance;
  return {
    x: target.x + Math.sin(azimuth) * flat,
    y: target.y + Math.sin(elevation) * distance,
    z: target.z + Math.cos(azimuth) * flat,
  };
}

/** Orthographic zoom (px per metre) that fits the whole site in a viewport. */
export function fitZoom(grid: SiteGrid, viewportW: number, viewportH: number, margin = 0.82): number {
  // The projected width of a w×d site seen at 45° is (w + d)/√2; its
  // projected height adds the ground's foreshortening plus some height.
  const projW = (grid.gridW + grid.gridD) / Math.SQRT2;
  const projH = projW * Math.sin(ISO_ELEVATION) + 8;
  const z = Math.min((viewportW * margin) / projW, (viewportH * margin) / projH);
  return Math.max(2, Math.min(200, z));
}

/** Which compass quadrant the camera looks from (0 SE, 1 NE, 2 NW, 3 SW) — for cut-away walls. */
export function viewQuadrant(azimuth: number): 0 | 1 | 2 | 3 {
  const a = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // SE = (0, π/2] around π/4 …
  return (Math.floor(a / (Math.PI / 2)) % 4) as 0 | 1 | 2 | 3;
}

/** Which building walls face the camera (and are cut low) for a quadrant. */
export function facingWalls(q: 0 | 1 | 2 | 3): { south: boolean; east: boolean; north: boolean; west: boolean } {
  // q0: camera at +x,+z (SE) → south & east walls face it.
  switch (q) {
    case 0:
      return { south: true, east: true, north: false, west: false };
    case 1:
      return { south: false, east: true, north: true, west: false };
    case 2:
      return { south: false, east: false, north: true, west: true };
    default:
      return { south: true, east: false, north: false, west: true };
  }
}

// ---------------------------------------------------------------------------
// Shared THREE geometry + materials (client; created lazily, never disposed —
// they're shared by every object for the page's lifetime)
// ---------------------------------------------------------------------------

let unitBox: THREE.BoxGeometry | null = null;
/** A 1 × 1 × 1 box centred on the origin; scale it per mesh. */
export function boxGeometry(): THREE.BoxGeometry {
  if (!unitBox) unitBox = new THREE.BoxGeometry(1, 1, 1);
  return unitBox;
}

let unitCyl: THREE.CylinderGeometry | null = null;
/** A unit cylinder (radius 0.5, height 1) with 12 sides — wheels, posts. */
export function cylinderGeometry(): THREE.CylinderGeometry {
  if (!unitCyl) unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  return unitCyl;
}

let unitPlane: THREE.PlaneGeometry | null = null;
/** A 1 × 1 plane lying flat on the ground (XZ), facing +y. */
export function groundPlaneGeometry(): THREE.PlaneGeometry {
  if (!unitPlane) {
    unitPlane = new THREE.PlaneGeometry(1, 1);
    unitPlane.rotateX(-Math.PI / 2);
  }
  return unitPlane;
}

const materials = new Map<ClayKey, THREE.MeshStandardMaterial>();
/** One flat, matte material per clay level. */
export function clayMaterial(key: ClayKey): THREE.MeshStandardMaterial {
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(clayColor(key)), roughness: 1, metalness: 0, flatShading: true });
    materials.set(key, m);
  }
  return m;
}

/** Write instance matrices for boxes of `size` at `positions` (local space). */
export function setInstanceBoxes(
  mesh: THREE.InstancedMesh,
  positions: readonly { x: number; y: number; z: number }[],
  size: { x: number; y: number; z: number },
): void {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(size.x, size.y, size.z);
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    p.set(pos.x, pos.y, pos.z);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.count = positions.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}
