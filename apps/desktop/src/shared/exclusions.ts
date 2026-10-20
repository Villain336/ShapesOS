// ShapesOS Desktop: the per-app exclusion list.
//
// When the app in front matches an entry, NOTHING is captured for that turn
// and the turn says so. Entries are case-insensitive:
//   "1Password"                 app name (also the .exe name without ".exe")
//   "bundle:com.1password.1password"   macOS bundle id
//   "url:chase.com"             the browser tab's host (or any subdomain)
//   "title:bank"                a word in the window title
// Defaults cover password managers and banking. People can edit the list in
// Settings; an empty list is allowed (their choice), malformed entries are
// rejected by settings validation.

export interface FocusedApp {
  name: string;
  /** macOS bundle id. */
  bundleId?: string;
  /** Executable path (Windows/Linux). */
  path?: string;
  title?: string;
  /** Browser tab URL when the OS gives it (macOS, some browsers). */
  url?: string;
}

export const DEFAULT_EXCLUSIONS: readonly string[] = [
  // Password managers
  "1Password",
  "bundle:com.1password.1password",
  "bundle:com.agilebits.onepassword7",
  "Bitwarden",
  "bundle:com.bitwarden.desktop",
  "Dashlane",
  "LastPass",
  "KeePassXC",
  "KeePass",
  "Keeper Password Manager",
  "NordPass",
  "Proton Pass",
  "Enpass",
  "RoboForm",
  "Keychain Access",
  "bundle:com.apple.keychainaccess",
  "Passwords",
  "bundle:com.apple.Passwords",
  // Banking and payments (apps, tabs and titles)
  "title:bank",
  "title:banking",
  "url:paypal.com",
  "url:chase.com",
  "url:wellsfargo.com",
  "url:bankofamerica.com",
  "url:citi.com",
  "url:capitalone.com",
  "url:hsbc.com",
  "url:barclays.co.uk",
  "url:monzo.com",
  "url:revolut.com",
  "url:wise.com",
  "url:venmo.com",
  "url:americanexpress.com",
  "url:schwab.com",
  "url:fidelity.com",
  "url:vanguard.com",
];

export type ExclusionKind = "app" | "bundle" | "url" | "title";

export interface ParsedExclusion {
  kind: ExclusionKind;
  value: string;
  raw: string;
}

const PREFIX = /^(bundle|url|title|app):\s*/i;

export function parseExclusion(raw: string): ParsedExclusion | null {
  const t = raw.trim();
  if (!t || t.length > 120) return null;
  const m = PREFIX.exec(t);
  const kind = (m?.[1]?.toLowerCase() ?? "app") as ExclusionKind;
  let value = (m ? t.slice(m[0].length) : t).trim().toLowerCase();
  if (!value) return null;
  if (kind === "url") {
    value = value.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "");
    if (!/^[a-z0-9.-]+$/.test(value) || !value.includes(".")) return null;
  }
  if (kind === "bundle" && !/^[a-z0-9.-]+$/i.test(value)) return null;
  return { kind, value, raw: t };
}

function basenameNoExe(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(exe|app)$/i, "").toLowerCase();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function wordIn(haystack: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(haystack);
}

/** The first entry the focused app matches, or null. */
export function matchExclusion(app: FocusedApp, entries: readonly string[]): ParsedExclusion | null {
  const name = app.name.trim().toLowerCase();
  const exe = app.path ? basenameNoExe(app.path) : null;
  const bundle = app.bundleId?.toLowerCase() ?? null;
  const host = app.url ? hostOf(app.url) : null;
  const title = app.title ?? "";
  for (const raw of entries) {
    const e = parseExclusion(raw);
    if (!e) continue;
    switch (e.kind) {
      case "app":
        if (name === e.value || exe === e.value) return e;
        break;
      case "bundle":
        if (bundle === e.value) return e;
        break;
      case "url":
        if (host && (host === e.value || host.endsWith(`.${e.value}`))) return e;
        break;
      case "title":
        if (title && wordIn(title, e.value)) return e;
        break;
    }
  }
  return null;
}

/** The sentence the turn shows and speaks when capture was skipped. */
export function exclusionMessage(app: FocusedApp, hit: ParsedExclusion): string {
  const what = hit.kind === "url" ? hit.value : hit.kind === "title" ? `this ${app.name || "window"}` : app.name || hit.value;
  return `${what} is on your exclusion list, so nothing on screen was captured.`;
}

/** Normalise a list from Settings: trim, drop blanks and duplicates (case-insensitive). */
export function normaliseExclusions(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const e = parseExclusion(raw);
    if (!e) continue;
    const key = `${e.kind}:${e.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.raw);
  }
  return out;
}
