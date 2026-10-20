// ShapesOS — public legal and trust pages (beta readiness, WS=legal).
//
// ONE registry of the public pages served on the website host (/terms,
// /privacy, …): the website footer, the sign-in card footer, host routing
// (lib/hosting/host-routing.ts WEBSITE_ONLY_PATHS) and the page files are
// all checked against it (lib/legal/__tests__/public-pages.test.ts).
//
// The legal TEXT is a draft template: it is written from what the code
// actually does (data stored, providers used, cookies set), but it is not
// legal advice and has not been reviewed by a lawyer. Every legal page shows
// a banner saying so while LEGAL_DRAFT_PENDING_REVIEW is true. The owner
// flips it to false ONLY after a lawyer has reviewed the text — nothing
// else reads it. The text itself is English only (the chrome is en + es).
//
// Pure data — no I/O. Nothing here reads a secret.

/**
 * Draft flag. true = every legal page shows "Draft — not legal advice,
 * pending lawyer review". Set to false after the review; also update
 * `updated` on the reviewed pages below.
 */
export const LEGAL_DRAFT_PENDING_REVIEW = true;

export type LegalPageKey =
  | "terms"
  | "privacy"
  | "dpa"
  | "subprocessors"
  | "security"
  | "acceptableUse"
  | "cookies"
  | "contact"
  | "status";

export interface LegalPageEntry {
  key: LegalPageKey;
  /** The public path (also the app/ folder name). */
  path: `/${string}`;
  /** English title (the chrome strings carry the en/es footer labels). */
  title: string;
  /** Last revision of the text, ISO date. */
  updated: string;
  /** Legal text (draft banner, "English only" note) vs a live/trust page. */
  kind: "legal" | "live";
}

const UPDATED = "2026-10-20";

export const LEGAL_PAGES: readonly LegalPageEntry[] = [
  { key: "terms", path: "/terms", title: "Terms of service", updated: UPDATED, kind: "legal" },
  { key: "privacy", path: "/privacy", title: "Privacy policy", updated: UPDATED, kind: "legal" },
  { key: "dpa", path: "/dpa", title: "Data processing addendum", updated: UPDATED, kind: "legal" },
  { key: "subprocessors", path: "/subprocessors", title: "Subprocessors", updated: UPDATED, kind: "legal" },
  { key: "security", path: "/security", title: "Security", updated: UPDATED, kind: "legal" },
  { key: "acceptableUse", path: "/acceptable-use", title: "Acceptable use policy", updated: UPDATED, kind: "legal" },
  { key: "cookies", path: "/cookies", title: "Cookies", updated: UPDATED, kind: "legal" },
  { key: "contact", path: "/contact", title: "Contact", updated: UPDATED, kind: "live" },
  { key: "status", path: "/status", title: "Status", updated: UPDATED, kind: "live" },
];

/** The registry entry for a path, or null. */
export function legalPage(path: string): LegalPageEntry | null {
  return LEGAL_PAGES.find((p) => p.path === path) ?? null;
}

/** Shown wherever the support address would go while SUPPORT_EMAIL is unset. */
export const SUPPORT_EMAIL_UNSET = "set SUPPORT_EMAIL";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The monitored support address (SUPPORT_EMAIL), lower-cased and trimmed.
 * Unset or malformed → the honest placeholder, never an invented address.
 */
export function supportEmail(env: Record<string, string | undefined> = process.env): string {
  const v = (env.SUPPORT_EMAIL ?? "").trim().toLowerCase();
  return EMAIL.test(v) ? v : SUPPORT_EMAIL_UNSET;
}

/** True when the address is a real one (not the placeholder). */
export function hasSupportEmail(env: Record<string, string | undefined> = process.env): boolean {
  return supportEmail(env) !== SUPPORT_EMAIL_UNSET;
}
