// ShapesOS — Phase 13 (twinui): a tiny RFC 6902 applier for the twin live
// stream (event: patch, data: TwinPatchOp[] — lib/twin/types.ts).
//
// Only the three ops the server sends: replace, add, remove. Immutable: the
// input is never mutated; containers along each touched path are copied, the
// rest is shared, so React sees new references exactly where state changed.
// Any path that doesn't resolve (a missed frame, a reordered array) returns
// { ok: false } — the caller then RESYNCS from the state endpoint instead of
// drawing a half-applied snapshot. PURE.

import type { TwinPatchOp } from "./types";

export type PatchResult<T> = { ok: true; value: T } | { ok: false; reason: string; opIndex: number };

/** "/objects/3/state/status" → ["objects", "3", "state", "status"] (RFC 6901 unescaping). */
export function parsePointer(path: string): string[] | null {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  return path
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === "object" && v !== null;
}

/** Array index token: "0", "12" (no leading zeros, no sign); "-" only where allowed. */
function arrayIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (allowEnd && token === "-") return length;
  if (!/^(0|[1-9]\d*)$/.test(token)) return null;
  const i = Number(token);
  if (allowEnd ? i > length : i >= length) return null;
  return i;
}

function applyOne(doc: unknown, op: TwinPatchOp): { ok: true; value: unknown } | { ok: false; reason: string } {
  const tokens = parsePointer(op.path);
  if (tokens === null) return { ok: false, reason: `bad path "${op.path}"` };
  if (tokens.length === 0) {
    // Whole-document ops.
    if (op.op === "remove") return { ok: false, reason: "cannot remove the root" };
    return { ok: true, value: op.value };
  }

  // Walk down, copying each container on the way (copy-on-write).
  const root: unknown = Array.isArray(doc) ? [...doc] : isContainer(doc) ? { ...doc } : doc;
  if (!isContainer(root)) return { ok: false, reason: `"${op.path}": root is not an object` };
  let parent: Container = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    let child: unknown;
    if (Array.isArray(parent)) {
      const idx = arrayIndex(t, parent.length, false);
      if (idx === null) return { ok: false, reason: `"${op.path}": no index ${t}` };
      child = parent[idx];
      if (!isContainer(child)) return { ok: false, reason: `"${op.path}": ${t} is not a container` };
      const copy: Container = Array.isArray(child) ? [...child] : { ...child };
      parent[idx] = copy;
      parent = copy;
    } else {
      if (!Object.prototype.hasOwnProperty.call(parent, t)) return { ok: false, reason: `"${op.path}": no key ${t}` };
      child = parent[t];
      if (!isContainer(child)) return { ok: false, reason: `"${op.path}": ${t} is not a container` };
      const copy: Container = Array.isArray(child) ? [...child] : { ...child };
      parent[t] = copy;
      parent = copy;
    }
  }

  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(parent)) {
    if (op.op === "add") {
      const idx = arrayIndex(last, parent.length, true);
      if (idx === null) return { ok: false, reason: `"${op.path}": index out of range` };
      parent.splice(idx, 0, op.value);
    } else {
      const idx = arrayIndex(last, parent.length, false);
      if (idx === null) return { ok: false, reason: `"${op.path}": no index ${last}` };
      if (op.op === "replace") parent[idx] = op.value;
      else parent.splice(idx, 1);
    }
  } else {
    const has = Object.prototype.hasOwnProperty.call(parent, last);
    if (op.op === "add") {
      parent[last] = op.value; // add on an existing member replaces it (RFC 6902 §4.1)
    } else if (!has) {
      return { ok: false, reason: `"${op.path}": no key ${last}` };
    } else if (op.op === "replace") {
      parent[last] = op.value;
    } else {
      delete parent[last];
    }
  }
  return { ok: true, value: root };
}

/**
 * Apply `ops` in order. On the first op that doesn't resolve the whole patch
 * is rejected (nothing partial leaks out) and the caller should resync.
 */
export function applyTwinPatch<T>(doc: T, ops: readonly TwinPatchOp[]): PatchResult<T> {
  let cur: unknown = doc;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (!op || (op.op !== "replace" && op.op !== "add" && op.op !== "remove") || typeof op.path !== "string") {
      return { ok: false, reason: "unsupported op", opIndex: i };
    }
    const r = applyOne(cur, op);
    if (!r.ok) return { ok: false, reason: r.reason, opIndex: i };
    cur = r.value;
  }
  return { ok: true, value: cur as T };
}
