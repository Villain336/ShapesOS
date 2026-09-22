// Marketr — workspace filesystem: logical-path validation (Phase B, W3).
//
// The registry (WorkspaceFile.logicalPath) is the authorization boundary.
// Paths are NEVER concatenated with a storage base — the DB row is the only
// mapping between a logical path and an opaque storage key. This module is
// the strict whitelist parser every write/rename/move passes through.
//
// Node-24 type-stripping compatible: erasable syntax only, no @/ imports.

export const FS_ROOTS = ["/skills", "/memory", "/artifacts", "/files"] as const;
export type FsRoot = (typeof FS_ROOTS)[number];

export type FileKind = "skill" | "memory" | "artifact" | "file";

export const KIND_ROOT: Record<FileKind, FsRoot> = {
  skill: "/skills",
  memory: "/memory",
  artifact: "/artifacts",
  file: "/files",
};

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_PATH_LEN = 512;
const MAX_DEPTH = 12;

export type PathCheck =
  | { ok: true; path: string; root: FsRoot; kind: FileKind }
  | { ok: false; reason: string };

/**
 * Normalize and validate a user-supplied logical path. Rejects:
 * - anything not rooted at /skills, /memory, /artifacts, /files
 * - `..` segments (literal AND after one decodeURIComponent round — but we
 *   deliberately do NOT double-decode names, so a literal "%252e%252e" stays
 *   a harmless filename, never a traversal)
 * - absolute-escapes, NUL bytes, backslashes, empty/trailing/double slashes
 * - over-long paths or segments, depth beyond MAX_DEPTH
 *
 * Returns the canonical path (single slashes, no trailing slash) plus the
 * derived kind, or a rejection reason safe to show the user.
 */
export function normalizeLogicalPath(input: string): PathCheck {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "Path is required." };
  }
  if (input.length > MAX_PATH_LEN) {
    return { ok: false, reason: `Path is too long (max ${MAX_PATH_LEN} characters).` };
  }
  if (input.includes("\0")) {
    return { ok: false, reason: "Path contains an invalid character." };
  }
  // Decode exactly once to catch %2e%2e / %2f tricks; double-encoded payloads
  // stay encoded and therefore inert (they can never match ".." as a segment).
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return { ok: false, reason: "Path contains invalid encoding." };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { ok: false, reason: "Path contains an invalid character." };
  }
  if (!decoded.startsWith("/")) {
    return { ok: false, reason: "Path must start with /." };
  }
  const rawSegments = decoded.split("/");
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "") continue; // collapse double slashes; reject below via shape
    if (seg === "." || seg === "..") {
      return { ok: false, reason: "Path must not contain . or .. segments." };
    }
    if (!SEGMENT_RE.test(seg)) {
      return {
        ok: false,
        reason:
          "Path segments may only contain letters, numbers, dots, dashes, and underscores.",
      };
    }
    segments.push(seg);
  }
  // Shape: at least /<root> and at most /<root>/<seg>... (file paths need a name).
  if (segments.length < 1 || segments.length > MAX_DEPTH + 1) {
    return { ok: false, reason: "Path depth is invalid." };
  }
  const root = `/${segments[0]}` as FsRoot;
  if (!(FS_ROOTS as readonly string[]).includes(root)) {
    return {
      ok: false,
      reason: "Path must live under /skills, /memory, /artifacts, or /files.",
    };
  }
  if (segments.length === 1) {
    return { ok: false, reason: "Path must name a file, not a root." };
  }
  const path = `/${segments.join("/")}`;
  const kind = (Object.keys(KIND_ROOT) as FileKind[]).find(
    (k) => KIND_ROOT[k] === root,
  )!;
  return { ok: true, path, root, kind };
}

/** Basename of a normalized logical path (the display filename). */
export function basenameOf(normalizedPath: string): string {
  const i = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(i + 1);
}

/** Parent directory of a normalized logical path ("" for root-level files). */
export function dirnameOf(normalizedPath: string): string {
  const i = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(0, i) || "/";
}
