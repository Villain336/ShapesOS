// ShapesOS — Phase 21A round 2 (WS=agentweb): browsing memory rules (PURE).
//
// Browsing memory is a member's own record of pages an agent read FOR THEM during research.
//   - Off until the member turns it on (per workspace member, default off).
//   - Only for pages the person asked the agent to read (research they started or linked).
//   - Never for a site on their excluded list (the site and its subdomains).
//   - Never with the address's query string or fragment: a search term is something typed.
//   - Never a private or internal address.
//   - A short excerpt, not the page. Deleted after the retention period or when the member forgets it.

import { isIP } from "node:net";

export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;
export const MAX_EXCLUDED_SITES = 200;
export const EXCERPT_MAX = 400;
export const MEMORY_PER_MEMBER_MAX = 2000;

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A site name from a host, an address or "*.host": just the lower-cased host, or null. */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/.test(s) && !/^[a-z0-9.-]+:\d+/.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      s = u.hostname;
    } catch {
      return null;
    }
  } else {
    s = s.replace(/^\*\./, "").split(/[/?#]/)[0] ?? "";
    s = s.replace(/:\d+$/, "");
  }
  s = s.replace(/^\*\./, "").replace(/\.$/, "");
  return HOST_RE.test(s) ? s : null;
}

export function normalizeSites(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = normalizeSite(raw);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_EXCLUDED_SITES) break;
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase().replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}

/** The site or any of its subdomains is on the list. An address that cannot be read counts as excluded. */
export function isExcluded(url: string, excluded: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return true;
  return excluded.some((e) => host === e || host.endsWith(`.${e}`));
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
  }
  if (isIP(host) === 6) return true; // literal v6 addresses are never a research source
  return false;
}

/** The address a memory item is keyed by: origin + path, no query or fragment, no trailing slash. */
export function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

export type MemoryDecision = { store: true; key: string; origin: string } | { store: false; reason: "off" | "not_asked" | "excluded" | "private" | "bad_url" };

export function decideMemory(input: { enabled: boolean; excluded: readonly string[]; url: string; askedByPerson: boolean }): MemoryDecision {
  if (!input.enabled) return { store: false, reason: "off" };
  if (!input.askedByPerson) return { store: false, reason: "not_asked" };
  const key = pageKey(input.url);
  const host = hostOf(input.url);
  if (!key || !host) return { store: false, reason: "bad_url" };
  if (isPrivateHost(host)) return { store: false, reason: "private" };
  if (isExcluded(input.url, input.excluded)) return { store: false, reason: "excluded" };
  return { store: true, key, origin: new URL(input.url).origin };
}

export function clampRetention(days: unknown): number {
  const n = typeof days === "number" ? Math.round(days) : Number.NaN;
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, n));
}

export function retentionDate(now: Date, days: unknown): Date {
  return new Date(now.getTime() + clampRetention(days) * 86_400_000);
}

export function excerptOf(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX);
}
