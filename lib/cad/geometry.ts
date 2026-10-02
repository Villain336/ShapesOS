// Marketr — CAD + Hardware slice 1: pure mesh geometry.
// No three.js, no prisma, no Node-only APIs beyond Buffer — this module is
// shared by the upload path (server) and is browser-safe.
//
// Honesty contract (the slice's core guardrail): every stat here is computed
// from the actual file bytes. Formats we cannot parse (STEP) return null —
// the caller marks preview/geometry as unavailable rather than inventing
// numbers. The mesh-volume figure is the signed-tetrahedra sum; it is exact
// only for closed meshes, so it is labeled an ESTIMATE everywhere it shows.

import type { CadFormat } from "./types";

export type Vec3 = [number, number, number];

export interface MeshStats {
  triangleCount: number;
  bboxMin: Vec3;
  bboxMax: Vec3;
  /** Signed-volume sum; exact for closed meshes, approximate otherwise. */
  volumeEstimate: number;
}

export interface FormatSniff {
  /** The format the BYTES say it is. Null = unrecognized. */
  format: CadFormat | null;
  /** Canonical extension for storage naming. */
  ext: string;
}

/** Sniff the format from file bytes — never trust the client declaration. */
export function sniffCadFormat(buf: Buffer, fileName: string): FormatSniff {
  const head = buf.subarray(0, Math.min(buf.length, 8192)).toString("latin1");

  // STEP AP203/AP214: plain text, "ISO-10303-21;" header.
  if (/^\s*ISO-10303-21\s*;/m.test(head)) {
    return { format: "step", ext: "step" };
  }

  // Binary STL: 80-byte header + uint32 count + 50 bytes/triangle, exact fit.
  // Check the size equation FIRST: a binary STL may also start with "solid".
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (count > 0 && count <= 20_000_000 && 84 + count * 50 === buf.length) {
      return { format: "stl", ext: "stl" };
    }
  }

  // ASCII STL: "solid … facet normal … endfacet".
  if (/^\s*solid\b/m.test(head) && /facet\s+normal/m.test(head)) {
    return { format: "stl", ext: "stl" };
  }

  // OBJ: vertex + face lines (may trail a comment header — window is 8KB).
  if (/^\s*v\s+[-+.\deE]+\s+[-+.\deE]+\s+[-+.\deE]+/m.test(head)) {
    return { format: "obj", ext: "obj" };
  }

  // Unrecognized — the upload is rejected (INVALID_FORMAT). A renamed
  // extension is never trusted over the bytes; the ext is reported only
  // for the error message.
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return { format: null, ext: ext || "bin" };
}

class Bbox {
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];
  add(x: number, y: number, z: number): void {
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
  }
}

/** Signed volume of tetrahedron (origin, a, b, c) — summed over the mesh. */
function signedVolume(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  return (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
}

/** Parse binary STL (bytes already validated by the size equation). */
function parseBinaryStl(buf: Buffer): MeshStats | null {
  const count = buf.readUInt32LE(80);
  const bbox = new Bbox();
  let volume = 0;
  let offset = 84;
  for (let i = 0; i < count; i++) {
    // 12 floats normal (ignored) + 9 vertex floats + 2 attribute bytes.
    const ax = buf.readFloatLE(offset + 12);
    const ay = buf.readFloatLE(offset + 16);
    const az = buf.readFloatLE(offset + 20);
    const bx = buf.readFloatLE(offset + 24);
    const by = buf.readFloatLE(offset + 28);
    const bz = buf.readFloatLE(offset + 32);
    const cx = buf.readFloatLE(offset + 36);
    const cy = buf.readFloatLE(offset + 40);
    const cz = buf.readFloatLE(offset + 44);
    bbox.add(ax, ay, az);
    bbox.add(bx, by, bz);
    bbox.add(cx, cy, cz);
    volume += signedVolume(ax, ay, az, bx, by, bz, cx, cy, cz);
    offset += 50;
  }
  if (!Number.isFinite(bbox.min[0])) return null;
  return { triangleCount: count, bboxMin: bbox.min, bboxMax: bbox.max, volumeEstimate: volume };
}

/** Parse ASCII STL: vertices grouped by consecutive "vertex" lines. */
function parseAsciiStl(text: string): MeshStats | null {
  const bbox = new Bbox();
  let volume = 0;
  let triangles = 0;
  const verts: number[] = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("vertex ")) {
      const parts = line.split(/\s+/).slice(1, 4).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) verts.push(...parts);
    } else if (line.startsWith("endfacet")) {
      if (verts.length === 9) {
        triangles += 1;
        bbox.add(verts[0], verts[1], verts[2]);
        bbox.add(verts[3], verts[4], verts[5]);
        bbox.add(verts[6], verts[7], verts[8]);
        volume += signedVolume(
          verts[0], verts[1], verts[2],
          verts[3], verts[4], verts[5],
          verts[6], verts[7], verts[8],
        );
      }
      verts.length = 0;
    }
  }
  if (triangles === 0) return null;
  return { triangleCount: triangles, bboxMin: bbox.min, bboxMax: bbox.max, volumeEstimate: volume };
}

/** Parse OBJ: "v" vertices + "f" faces (fan-triangulated, negative refs ok). */
function parseObj(text: string): MeshStats | null {
  const verts: Vec3[] = [];
  const bbox = new Bbox();
  let triangles = 0;
  let volume = 0;
  const resolve = (ref: number): Vec3 | null => {
    const idx = ref > 0 ? ref - 1 : verts.length + ref;
    return verts[idx] ?? null;
  };
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const parts = line.split(/\s+/).slice(1, 4).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        const v: Vec3 = [parts[0], parts[1], parts[2]];
        verts.push(v);
        bbox.add(v[0], v[1], v[2]);
      }
    } else if (line.startsWith("f ")) {
      const refs = line
        .split(/\s+/)
        .slice(1)
        .map((tok) => parseInt(tok.split("/")[0]!, 10))
        .filter(Number.isInteger);
      if (refs.length < 3) continue;
      const v0 = resolve(refs[0]!);
      if (!v0) continue;
      // Fan triangulation: (v0, vi, vi+1).
      for (let i = 1; i < refs.length - 1; i++) {
        const a = resolve(refs[i]!);
        const b = resolve(refs[i + 1]!);
        if (!a || !b) continue;
        triangles += 1;
        volume += signedVolume(v0[0], v0[1], v0[2], a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
  }
  if (triangles === 0 || verts.length === 0) return null;
  return { triangleCount: triangles, bboxMin: bbox.min, bboxMax: bbox.max, volumeEstimate: volume };
}

/**
 * Parse a mesh upload into honest stats. Returns null for STEP (no geometry
 * extraction attempted) and for any unparseable/degenerate file. The caller
 * records nulls as "unavailable" — never as zero.
 */
export function parseMeshStats(buf: Buffer, format: CadFormat): MeshStats | null {
  try {
    if (format === "stl") {
      if (buf.length >= 84) {
        const count = buf.readUInt32LE(80);
        if (count > 0 && count <= 20_000_000 && 84 + count * 50 === buf.length) {
          return parseBinaryStl(buf);
        }
      }
      const text = buf.toString("utf8");
      if (/facet\s+normal/m.test(text)) return parseAsciiStl(text);
      return null;
    }
    if (format === "obj") {
      return parseObj(buf.toString("utf8"));
    }
    // step: no parser — conversion is pending, not faked.
    return null;
  } catch {
    return null;
  }
}
