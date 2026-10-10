// Marketr — workspace filesystem: logical-path validation (Phase B, W3).
//
// The registry (WorkspaceFile.logicalPath) is the authorization boundary.
// Paths are NEVER concatenated with a storage base — the DB row is the only
// mapping between a logical path and an opaque storage key. This module is
// the strict whitelist parser every write/rename/move passes through.
//
// Phase 21B (WS=drive): the root set is generalised (the model, in one picture):
//
//   /home/<userId>/…            private to that person (ownerUserId = userId)
//   /shared/…                   the workspace's own folders (ownerUserId = null)
//     /shared/{skills,memory,artifacts,files}/…   the four system folders: they
//                               are STORED as /skills /memory /artifacts /files
//                               (existing rows keep working untouched) and
//                               SHOWN under /shared; /shared/files/x and
//                               /files/x are one spelling (canonical = /files/x)
//   /apps/<appId>/<install>/…   one app install's container (21C fills it)
//   /agents/<runId>/…           an agent run's workspace
//   /mounts/<provider>/…        a mounted outside source (only "google-drive")
//   /trash                      a VIEW over trashed rows, never a stored path
//
// The four legacy roots keep the strict segment set [A-Za-z0-9._-] and the
// 512-character cap, byte for byte. The new roots allow real file names
// (spaces, Unicode letters) under portability rules: NFC, no Windows
// reserved names or characters, no trailing dot/space, no control/bidi/
// zero-width characters, 255 bytes per name, 1024 characters and 32 levels.
//
// Node-24 type-stripping compatible: erasable syntax only, no @/ imports.

export const FS_ROOTS = ["/skills", "/memory", "/artifacts", "/files"] as const;
export type FsRoot = (typeof FS_ROOTS)[number];

export const DRIVE_ROOTS = ["/home", "/shared", "/apps", "/agents", "/mounts"] as const;
export type DriveRootName = (typeof DRIVE_ROOTS)[number];
export type DriveRoot = FsRoot | DriveRootName;

export type FileKind = "skill" | "memory" | "artifact" | "file";

export const KIND_ROOT: Record<FileKind, FsRoot> = {
  skill: "/skills",
  memory: "/memory",
  artifact: "/artifacts",
  file: "/files",
};

/** Providers that may be mounted under /mounts. OneDrive/SharePoint, Dropbox and Box are NOT approved. */
export const MOUNT_PROVIDERS = ["google-drive"] as const;

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PATH_LEN = 512;
const MAX_DEPTH = 12;
export const MAX_DRIVE_PATH_LEN = 1024;
export const MAX_DRIVE_SEGMENTS = 32;
export const MAX_NAME_BYTES = 255;

export interface PathInfo {
  /** Canonical stored path (single slashes, NFC, no trailing slash). */
  path: string;
  root: DriveRoot;
  kind: FileKind;
  /** The person whose private home this is (/home/<userId>), else null. */
  ownerUserId: string | null;
  app: { appId: string; install: string } | null;
  runId: string | null;
  provider: string | null;
}

export type PathCheck = ({ ok: true } & PathInfo) | { ok: false; reason: string };

const LEGACY_SET = new Set<string>(FS_ROOTS);
const DRIVE_SET = new Set<string>(DRIVE_ROOTS);

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/;
// C0/C1 controls, bidi embeddings/overrides/isolates, zero-width and BOM.
const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Validate one drive-root name. Returns the NFC form, or the reason it is refused. */
function checkName(seg: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = seg.normalize("NFC");
  if (name === "." || name === "..") return { ok: false, reason: "Path must not contain . or .. segments." };
  if (name.length === 0) return { ok: false, reason: "A name can't be empty." };
  if (INVISIBLE_CHARS.test(name) || FORBIDDEN_CHARS.test(name)) {
    return { ok: false, reason: "A name contains a character that isn't allowed (control, invisible or one of < > : \" | ? *)." };
  }
  if (name.endsWith(".") || name.endsWith(" ")) return { ok: false, reason: "A name can't end with a dot or a space." };
  if (name.startsWith(" ")) return { ok: false, reason: "A name can't start with a space." };
  if (RESERVED_DEVICE.test(name.split(".")[0]!)) return { ok: false, reason: `"${name}" is a reserved name on Windows.` };
  if (utf8Bytes(name) > MAX_NAME_BYTES) return { ok: false, reason: `A name is too long (max ${MAX_NAME_BYTES} bytes).` };
  return { ok: true, name };
}

function legacyInfo(path: string, root: FsRoot): PathInfo {
  const kind = (Object.keys(KIND_ROOT) as FileKind[]).find((k) => KIND_ROOT[k] === root)!;
  return { path, root, kind, ownerUserId: null, app: null, runId: null, provider: null };
}

function parseLegacy(input: string, allowContainer: boolean): PathCheck {
  if (input.length > MAX_PATH_LEN) {
    return { ok: false, reason: `Path is too long (max ${MAX_PATH_LEN} characters).` };
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
  let segments: string[] = [];
  for (const seg of decoded.split("/")) {
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
  // /shared/<legacy>/… is the same place as /<legacy>/… (one canonical spelling).
  if (segments[0] === "shared" && segments[1] && LEGACY_SET.has(`/${segments[1]}`)) segments = segments.slice(1);
  // Shape: at least /<root> and at most /<root>/<seg>... (file paths need a name).
  if (segments.length < 1 || segments.length > MAX_DEPTH + 1) {
    return { ok: false, reason: "Path depth is invalid." };
  }
  const root = `/${segments[0]}`;
  if (!LEGACY_SET.has(root)) {
    return { ok: false, reason: "Path must live under /skills, /memory, /artifacts, /files, /home, /shared, /apps, /agents or /mounts." };
  }
  if (segments.length === 1 && !allowContainer) {
    return { ok: false, reason: "Path must name a file, not a root." };
  }
  return { ok: true, ...legacyInfo(`/${segments.join("/")}`, root as FsRoot) };
}

function parseDriveRoot(input: string, allowContainer: boolean): PathCheck {
  if (input.length > MAX_DRIVE_PATH_LEN * 2) return { ok: false, reason: `Path is too long (max ${MAX_DRIVE_PATH_LEN} characters).` };
  if (input.includes("\0")) return { ok: false, reason: "Path contains an invalid character." };
  const normalized = input.normalize("NFC");
  if (normalized.includes("\\")) return { ok: false, reason: "Path contains an invalid character." };
  const raw = normalized.split("/").filter((s) => s !== "");
  const names: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]!;
    if (i === 0) {
      names.push(seg);
      continue;
    }
    const c = checkName(seg);
    if (!c.ok) return c;
    names.push(c.name);
  }
  if (names.length > MAX_DRIVE_SEGMENTS) return { ok: false, reason: `Path depth is invalid (max ${MAX_DRIVE_SEGMENTS} levels).` };
  const path = `/${names.join("/")}`;
  if (path.length > MAX_DRIVE_PATH_LEN) return { ok: false, reason: `Path is too long (max ${MAX_DRIVE_PATH_LEN} characters).` };
  const root = `/${names[0]}` as DriveRootName;
  const base: PathInfo = { path, root, kind: "file", ownerUserId: null, app: null, runId: null, provider: null };
  const needFile = (min: number, what: string): PathCheck | null =>
    names.length < min && !allowContainer ? { ok: false, reason: `Path must name a file, not a ${what}.` } : null;

  switch (root) {
    case "/shared": {
      // /shared/<legacy>/… was handled by the legacy parser (canonical spelling).
      if (names.length === 1) return allowContainer ? { ok: true, ...base } : { ok: false, reason: "Path must name a file, not a root." };
      if (LEGACY_SET.has(`/${names[1]}`)) return { ok: false, reason: "Path must name a file, not a root." };
      return { ok: true, ...base };
    }
    case "/home": {
      if (names.length === 1) return { ok: false, reason: "Files in /home live in a person's folder: /home/<userId>/…" };
      const uid = names[1]!;
      if (!ID_RE.test(uid)) return { ok: false, reason: "A home folder is named after the person's id (letters, numbers, dashes, underscores)." };
      const miss = needFile(3, "home folder");
      if (miss) return miss;
      return { ok: true, ...base, ownerUserId: uid };
    }
    case "/apps": {
      if (names.length < 3) return { ok: false, reason: "App files live in /apps/<appId>/<install>/…" };
      const appId = names[1]!;
      const install = names[2]!;
      if (!APP_ID_RE.test(appId) || !ID_RE.test(install)) return { ok: false, reason: "An app container is /apps/<appId>/<install> with plain ids." };
      const miss = needFile(4, "app container");
      if (miss) return miss;
      return { ok: true, ...base, app: { appId, install } };
    }
    case "/agents": {
      if (names.length < 2) return { ok: false, reason: "Agent files live in /agents/<runId>/…" };
      const runId = names[1]!;
      if (!ID_RE.test(runId)) return { ok: false, reason: "An agent workspace is named after the run id." };
      const miss = needFile(3, "run workspace");
      if (miss) return miss;
      return { ok: true, ...base, runId };
    }
    case "/mounts": {
      if (names.length < 2) return { ok: false, reason: "Mounted files live in /mounts/<provider>/…" };
      const provider = names[1]!;
      if (!(MOUNT_PROVIDERS as readonly string[]).includes(provider)) {
        return { ok: false, reason: `Unknown mount provider "${provider}". Only ${MOUNT_PROVIDERS.join(", ")} can be mounted.` };
      }
      const miss = needFile(3, "mount");
      if (miss) return miss;
      return { ok: true, ...base, provider };
    }
    default:
      return { ok: false, reason: "Path must live under /skills, /memory, /artifacts, /files, /home, /shared, /apps, /agents or /mounts." };
  }
}

function parse(input: string, allowContainer: boolean): PathCheck {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "Path is required." };
  }
  if (input.includes("\0")) {
    return { ok: false, reason: "Path contains an invalid character." };
  }
  const first = input.startsWith("/") ? input.split("/")[1] ?? "" : "";
  if (first === "trash") return { ok: false, reason: "The trash is a view of removed items, not a place to store files." };
  if (DRIVE_SET.has(`/${first}`)) {
    // /shared/<legacy>/… collapses onto the legacy root before anything else.
    if (first === "shared") {
      const second = input.split("/").filter((s) => s !== "")[1];
      if (second && LEGACY_SET.has(`/${second}`)) return parseLegacy(input, allowContainer);
    }
    return parseDriveRoot(input, allowContainer);
  }
  const r = parseLegacy(input, allowContainer);
  return r;
}

/**
 * Normalize and validate a user-supplied logical path for a FILE. Rejects:
 * - anything not rooted at a known root (see the picture above)
 * - `..` segments (legacy roots: literal AND after one decodeURIComponent
 *   round, never a second; new roots are never percent-decoded, so a literal
 *   "%2e%2e" is a harmless name)
 * - absolute-escapes, NUL bytes, backslashes, empty/trailing/double slashes
 * - over-long paths or names, depth beyond the limits
 * - (new roots) Windows reserved names/characters, trailing dot/space,
 *   control/bidi/zero-width characters; names are normalised to NFC
 *
 * Returns the canonical path plus the derived kind, or a rejection reason
 * safe to show the user.
 */
export function normalizeLogicalPath(input: string): PathCheck {
  return parse(input, false);
}

/** Same rules for a FOLDER: roots and containers ("/files", "/home/<id>", "/apps/<a>/<i>") are valid. */
export function normalizeFolderPath(input: string): PathCheck {
  if (input === "/") return { ok: false, reason: "The top level is not a folder." };
  return parse(input, true);
}

/** Alias with the Drive vocabulary. */
export const normalizeDrivePath = normalizeLogicalPath;

/** How a stored path is shown in the tree: the four system folders live under /shared. */
export function displayPath(logicalPath: string): string {
  const root = `/${logicalPath.split("/")[1] ?? ""}`;
  return LEGACY_SET.has(root) ? `/shared${logicalPath}` : logicalPath;
}

/**
 * The case- and normalisation-insensitive identity of a path: two paths with
 * the same key are the same place on a Mac/Windows disk, so they may not both
 * exist in one folder. Used for the unique index on new rows.
 */
export function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Turn any browser-supplied file name into one the new-root rules accept. */
export function sanitizeUploadName(name: string): string {
  let n = String(name ?? "").normalize("NFC");
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(INVISIBLE_CHARS, "").replace(/[<>:"|?*]/g, "_");
  n = n.replace(/^[ ]+/, "").replace(/[. ]+$/, "");
  if (n === "" || n === "." || n === "..") return "file";
  if (RESERVED_DEVICE.test(n.split(".")[0]!)) n = `_${n}`;
  while (utf8Bytes(n) > MAX_NAME_BYTES) n = n.slice(0, -1);
  return n;
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

/**
 * The folders that exist as rows on the way down to `folderPath`, top first.
 * The tops of the drive tree (/shared, /home, /apps, /apps/<app>, /agents,
 * /mounts) are virtual: they are never rows. Containers (the four system
 * folders, /home/<id>, /apps/<app>/<install>, /agents/<run>, /mounts/<p>)
 * are rows marked `system`.
 */
export function folderChain(folderPath: string): Array<{ path: string; system: boolean }> {
  const segs = folderPath.split("/").filter(Boolean);
  if (segs.length === 0) return [];
  const top = `/${segs[0]}`;
  // How many leading segments are virtual, and how many make the container row.
  let virtual = 0;
  let containerLen = 1;
  if (top === "/shared") {
    virtual = 1;
    containerLen = 0; // /shared/<name> is an ordinary folder, not a system container
  } else if (top === "/home") {
    containerLen = 2;
  } else if (top === "/apps") {
    containerLen = 3;
  } else if (top === "/agents" || top === "/mounts") {
    containerLen = 2;
  }
  const out: Array<{ path: string; system: boolean }> = [];
  for (let n = virtual + 1; n <= segs.length; n++) {
    if (top === "/home" && n < 2) continue;
    if (top === "/apps" && n < 3) continue;
    if ((top === "/agents" || top === "/mounts") && n < 2) continue;
    out.push({ path: `/${segs.slice(0, n).join("/")}`, system: containerLen > 0 && n === containerLen });
  }
  return out;
}
