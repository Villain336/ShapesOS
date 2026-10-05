// Marketr — Phase 10 M4: polite HTTP fetching for the competitor fleet.
//
// Politeness IS the cost control (spec §M4 cost notes: "self-hosted fetching
// is ~$0 marginal; the cost is compute politeness, not API bills"):
//   - ≥2s between hits to the same domain (default; robots crawl-delay wins
//     when larger — see setCrawlDelay()).
//   - 15s timeout per request (AbortController).
//   - Identifiable User-Agent with a contact URL the operator configures.
//   - Plain fetch — NO new npm dependencies.
//
// Callers are still responsible for the robots.txt check (robots.ts) before
// fetching a URL; PoliteFetcher enforces rate + timeout, and every request
// goes through safeFetch (H8): DNS is validated per request and every
// redirect hop is re-checked, so a competitor sitemap can't point the fleet
// at internal addresses. isOnWatchedDomain() keeps <loc> URLs on-domain.

import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";

/**
 * True when `url` is an http(s) URL whose host is `domain` or one of its
 * subdomains (a leading "www." on either side is ignored). Used to keep
 * sitemap <loc> entries and tracked URLs on the watched competitor's site.
 */
export function isOnWatchedDomain(url: string, domain: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  const d = domain.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  if (!d) return false;
  return host === d || host.endsWith(`.${d}`);
}

export const FLEET_USER_AGENT_BASE = "Marketr-CompetitorFleet/1.0";

/** Operator-configurable contact URL, appended to the User-Agent so site
 *  owners can identify and reach us. Set FLEET_CONTACT_URL in env. */
export function fleetUserAgent(): string {
  const contact = (process.env.FLEET_CONTACT_URL ?? "").trim();
  return contact
    ? `${FLEET_USER_AGENT_BASE} (+${contact})`
    : `${FLEET_USER_AGENT_BASE} (polite competitor change monitoring)`;
}

export interface PoliteFetchOpts {
  /** Minimum ms between hits to the same domain. Default 2000 (spec). */
  minDelayMs?: number;
  /** Per-request timeout ms. Default 15000 (spec). */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** DNS seam for the SSRF guard (tests inject a fake; default real DNS). */
  resolve?: ResolveFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchedPage {
  url: string;
  status: number;
  text: string;
  contentType: string | null;
  /** Phase 11 (seotools): where the request ended after redirects. */
  finalUrl?: string;
  /** Phase 11 (seotools): every redirect hop followed, in order. */
  redirects?: { from: string; to: string; status: number }[];
  /** Phase 11 (seotools): response headers (lower-case names). */
  headers?: Record<string, string>;
}

export interface PoliteGetOptions {
  /** Phase 11 (seotools): stop reading the body after this many characters. */
  maxChars?: number;
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PoliteFetcher {
  private readonly minDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolve: ResolveFn | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** domain → timestamp (ms) of the last request START. */
  private readonly lastHit = new Map<string, number>();
  /** domain → robots crawl-delay (ms), honored when larger than minDelayMs. */
  private readonly crawlDelays = new Map<string, number>();

  constructor(opts: PoliteFetchOpts = {}) {
    this.minDelayMs = Math.max(0, opts.minDelayMs ?? 2000);
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.resolve = opts.resolve;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? DEFAULT_SLEEP;
  }

  /** Register a robots.txt crawl-delay for a domain (seconds → ms). */
  setCrawlDelay(domain: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.crawlDelays.set(domain.toLowerCase(), seconds * 1000);
    }
  }

  private delayFor(domain: string): number {
    const crawl = this.crawlDelays.get(domain.toLowerCase()) ?? 0;
    return Math.max(this.minDelayMs, crawl);
  }

  /** GET a URL politely. Throws on network error / timeout / bad URL. */
  async get(url: string, getOpts: PoliteGetOptions = {}): Promise<FetchedPage> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`fleet: refusing to fetch malformed URL`);
    }

    // Enforce the inter-hit delay for this domain.
    const wait = this.delayFor(host) - (this.now() - (this.lastHit.get(host) ?? 0));
    if (wait > 0) await this.sleep(wait);
    this.lastHit.set(host, this.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const redirects: { from: string; to: string; status: number }[] = [];
    try {
      const res = await safeFetch(
        url,
        {
          headers: {
            "User-Agent": fleetUserAgent(),
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: controller.signal,
        },
        { fetchFn: this.fetchImpl, resolve: this.resolve, onRedirect: (h) => redirects.push(h) },
      );
      const full = await res.text();
      const text = getOpts.maxChars !== undefined ? full.slice(0, getOpts.maxChars) : full;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return {
        url,
        status: res.status,
        text,
        contentType: res.headers.get("content-type"),
        finalUrl: redirects.length ? redirects[redirects.length - 1].to : url,
        redirects,
        headers,
      };
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`fleet: fetch timed out after ${this.timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
