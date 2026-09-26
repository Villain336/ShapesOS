// Marketr — Phase 10 M4: typed wrapper around the M6 fetchSerp contract.
//
// Real contract (lib/intelligence/providers barrel → routing.ts, M6):
//   fetchSerp(workspaceId, keyword, locale, opts?: SerpSearchOpts)
//     → SerpResponse { results: SerpOrganicResult[] }
// Each organic result carries position/url/domain/title. Throws
// VendorNotConfigured (typed) when no SERP vendor is configured — the digest
// treats that as "SERP unavailable this week" and degrades gracefully.
//
// The wrapper shape-checks the response at runtime so a future contract
// drift surfaces as a caught error, never a silent wrong digest.

import {
  fetchSerp,
  VendorNotConfigured,
  type SerpOrganicResult,
  type SerpSearchOpts,
} from "@/lib/intelligence/providers";

export interface SerpOrganicEntry {
  url: string;
  position: number;
  title: string;
  domain: string | null;
}

function looksLikeOrganic(r: unknown): r is SerpOrganicResult {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as { url?: unknown }).url === "string" &&
    typeof (r as { position?: unknown }).position === "number"
  );
}

/** True when the provider layer has no configured SERP vendor (graceful
 *  degradation signal for the digest — not an error to surface). */
export function isSerpUnavailable(err: unknown): boolean {
  return err instanceof VendorNotConfigured;
}

/** Top-N organic results for one keyword. Throws VendorNotConfigured when
 *  no vendor is configured; throws on contract-shape drift. */
export async function fetchSerpTop10(
  workspaceId: string,
  keyword: string,
  locale = "en-US",
  opts: { numResults?: number } = {},
): Promise<SerpOrganicEntry[]> {
  const serpOpts: SerpSearchOpts = { numResults: opts.numResults ?? 10 };
  const res = await fetchSerp(workspaceId, keyword, locale, serpOpts);
  if (!res || !Array.isArray(res.results) || !res.results.every(looksLikeOrganic)) {
    throw new Error("fleet: fetchSerp returned an unexpected shape");
  }
  return res.results.slice(0, opts.numResults ?? 10).map((r) => ({
    url: r.url,
    position: r.position,
    title: r.title ?? "",
    domain: typeof r.domain === "string" ? r.domain : null,
  }));
}

/** Extract the registrable domain (last two labels) for competitor matching.
 *  Prefer the adapter-supplied r.domain; use this as fallback. */
export function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}
