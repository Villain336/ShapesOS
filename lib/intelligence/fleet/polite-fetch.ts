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
// fetching a URL; PoliteFetcher only enforces rate + timeout.

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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchedPage {
  url: string;
  status: number;
  text: string;
  contentType: string | null;
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PoliteFetcher {
  private readonly minDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
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
  async get(url: string): Promise<FetchedPage> {
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
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          "User-Agent": fleetUserAgent(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        url,
        status: res.status,
        text,
        contentType: res.headers.get("content-type"),
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`fleet: fetch timed out after ${this.timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
