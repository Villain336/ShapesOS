// ShapesOS — Phase 19A (WS=server): the ShapesOS Desktop download feed.
//
// The desktop app auto-updates from an R2 public bucket with electron-
// updater's "generic" provider: DESKTOP_UPDATE_URL/<channel>/latest.yml
// (Windows) and latest-mac.yml (macOS), written by electron-builder. The
// website's /download page (and GET /api/desktop/releases) reads the same
// files, so the download links are always the build the app updates to.
// No DESKTOP_UPDATE_URL → { configured: false } and the page says "Desktop
// builds are not published yet" — never a made-up link.

export const DESKTOP_CHANNELS = ["stable", "beta"] as const;
export type DesktopChannel = (typeof DESKTOP_CHANNELS)[number];

export interface DesktopReleaseFile {
  os: "mac" | "windows";
  arch: "x64" | "arm64" | "universal";
  url: string;
  size: number | null;
  sha512: string | null;
}

export interface DesktopReleases {
  configured: boolean;
  channel: DesktopChannel;
  version: string | null;
  releaseDate: string | null;
  files: DesktopReleaseFile[];
  /** Plain reason when the feed could not be read. */
  error?: string;
}

type Env = Record<string, string | undefined>;

export function desktopUpdateBase(env: Env = process.env): string | null {
  const raw = (env.DESKTOP_UPDATE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.search && !u.hash ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Parse the subset of electron-builder's latest*.yml we need (PURE):
 *   version: 1.2.3
 *   files:
 *     - url: ShapesOS-1.2.3-arm64.dmg
 *       sha512: …
 *       size: 123
 *   releaseDate: '2026-10-06T…'
 */
export function parseLatestYml(text: string): { version: string | null; releaseDate: string | null; files: Array<{ url: string; sha512: string | null; size: number | null }> } {
  const unq = (v: string) => v.trim().replace(/^['"]|['"]$/g, "");
  let version: string | null = null;
  let releaseDate: string | null = null;
  const files: Array<{ url: string; sha512: string | null; size: number | null }> = [];
  let inFiles = false;
  let cur: { url: string; sha512: string | null; size: number | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top) {
      inFiles = top[1] === "files";
      if (cur) files.push(cur), (cur = null);
      if (top[1] === "version") version = unq(top[2]!);
      if (top[1] === "releaseDate") releaseDate = unq(top[2]!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    const prop = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    const kv = item ?? prop;
    if (!kv) continue;
    if (item) {
      if (cur) files.push(cur);
      cur = { url: "", sha512: null, size: null };
    }
    if (!cur) continue;
    const [, k, v] = kv;
    if (k === "url") cur.url = unq(v!);
    else if (k === "sha512") cur.sha512 = unq(v!);
    else if (k === "size") cur.size = Number.isFinite(Number(unq(v!))) ? Number(unq(v!)) : null;
  }
  if (cur) files.push(cur);
  return { version, releaseDate, files: files.filter((f) => f.url && !/\.(blockmap|zip\.blockmap)$/i.test(f.url)) };
}

export function archOf(fileName: string): DesktopReleaseFile["arch"] {
  if (/universal/i.test(fileName)) return "universal";
  if (/arm64|aarch64/i.test(fileName)) return "arm64";
  return "x64";
}

const cache = new Map<string, { at: number; value: DesktopReleases }>();
const CACHE_MS = 5 * 60_000;

export async function desktopReleases(channel: DesktopChannel = "stable", deps: { env?: Env; fetchImpl?: typeof fetch; now?: number } = {}): Promise<DesktopReleases> {
  const base = desktopUpdateBase(deps.env ?? process.env);
  if (!base) return { configured: false, channel, version: null, releaseDate: null, files: [] };
  const now = deps.now ?? Date.now();
  const key = `${base}|${channel}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS && !deps.fetchImpl) return hit.value;
  const f = deps.fetchImpl ?? fetch;
  const folder = `${base}/${channel}`;
  const files: DesktopReleaseFile[] = [];
  let version: string | null = null;
  let releaseDate: string | null = null;
  const errors: string[] = [];
  for (const [name, os] of [["latest-mac.yml", "mac"], ["latest.yml", "windows"]] as const) {
    try {
      const res = await f(`${folder}/${name}`, { signal: AbortSignal.timeout(8_000) });
      if (res.status === 404) continue;
      if (!res.ok) {
        errors.push(`${name}: ${res.status}`);
        continue;
      }
      const parsed = parseLatestYml(await res.text());
      version = version ?? parsed.version;
      releaseDate = releaseDate ?? parsed.releaseDate;
      for (const file of parsed.files) {
        // electron-updater uses the .zip on macOS; people download the .dmg.
        if (os === "mac" && !/\.dmg$/i.test(file.url)) continue;
        if (os === "windows" && !/\.exe$/i.test(file.url)) continue;
        const url = /^https:\/\//i.test(file.url) ? file.url : `${folder}/${file.url.split("/").map(encodeURIComponent).join("/")}`;
        files.push({ os, arch: archOf(file.url), url, size: file.size, sha512: file.sha512 });
      }
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const value: DesktopReleases = { configured: true, channel, version, releaseDate, files, ...(errors.length && files.length === 0 ? { error: "The release feed could not be read." } : {}) };
  cache.set(key, { at: now, value });
  return value;
}
