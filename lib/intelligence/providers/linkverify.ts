// Marketr — Phase 10 M6: demand-driven backlink verification fleet.
// Verifies KNOWN links cheaply: fetch the source URL and check whether it
// still links to the target. Seed discovery comes from the free CC graph or
// one-time licensed buys — this fleet only verifies, never builds an index.
// Polite by construction: robots.txt respected, 1s per-domain delay, 10s
// timeout, identifiable User-Agent. No new npm deps.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { recordApiMeter } from "./meter";
import { auditApiCall } from "./audit";

export type LinkStatus = "verified" | "lost" | "unknown";

export interface VerifyLinkResult {
  targetUrl: string;
  sourceUrl: string;
  status: LinkStatus;
  checkedAt: Date;
  detail: string;
}

const UA = "Marketr-LinkVerifier/1.0 (+https://marketr.example.com/bot)";
const FETCH_TIMEOUT_MS = 10_000;
const POLITE_DELAY_MS = 1_000;
const MAX_BODY_BYTES = 2_000_000; // don't download whole media files

const lastFetchAt = new Map<string, number>();
const robotsCache = new Map<string, { at: number; disallows: string[] }>();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/** SSRF guard: refuse loopback / link-local / private-network hostnames. */
function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (h === "0.0.0.0" || h === "::1") return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

async function politeDelay(domain: string): Promise<void> {
  const last = lastFetchAt.get(domain) ?? 0;
  const wait = POLITE_DELAY_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt.set(domain, Date.now());
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  await politeDelay(parsed.hostname);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const buf = await res.arrayBuffer();
    const body = Buffer.from(buf.slice(0, MAX_BODY_BYTES)).toString("utf8");
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal robots.txt parser: Disallow lines under the "*" group. */
async function robotsAllows(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const cached = robotsCache.get(origin);
  let disallows: string[] | null = cached && Date.now() - cached.at < ROBOTS_TTL_MS ? cached.disallows : null;
  if (!disallows) {
    disallows = [];
    try {
      const { status, body } = await fetchText(`${origin}/robots.txt`);
      if (status === 200) {
        let inWildcardGroup = false;
        let sawAnyGroup = false;
        for (const line of body.split("\n")) {
          const clean = line.split("#")[0].trim();
          const ua = clean.match(/^user-agent\s*:\s*(.+)$/i);
          if (ua) {
            sawAnyGroup = true;
            inWildcardGroup = ua[1].trim() === "*";
            continue;
          }
          const dis = clean.match(/^disallow\s*:\s*(.*)$/i);
          if (dis && (!sawAnyGroup || inWildcardGroup)) {
            const path = dis[1].trim();
            if (path) disallows.push(path);
          }
        }
      }
    } catch {
      // robots.txt unreachable → treat as allowed (RFC 9309 default)
    }
    robotsCache.set(origin, { at: Date.now(), disallows });
  }
  return !disallows.some((d) => parsed.pathname.startsWith(d));
}

function normalizeLink(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function pageLinksTo(body: string, sourceUrl: string, targetUrl: string): boolean {
  const target = new URL(targetUrl);
  const targetHost = target.hostname.replace(/^www\./, "");
  const targetPath = target.pathname.replace(/\/$/, "");
  const hrefs = body.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi) ?? [];
  for (const tag of hrefs) {
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    const abs = normalizeLink(m[1], sourceUrl);
    if (!abs) continue;
    const u = new URL(abs);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== targetHost) continue;
    if (targetPath === "" || targetPath === "/") return true; // homepage link counts
    const path = u.pathname.replace(/\/$/, "");
    if (path === targetPath) return true;
  }
  return false;
}

/**
 * Verify one backlink: fetch sourceUrl (polite) and check it links to targetUrl.
 * Writes/updates the link_verification row and meters a backlink_pull ($0).
 */
export async function verifyLink(
  workspaceId: string,
  targetUrl: string,
  sourceUrl: string,
): Promise<VerifyLinkResult> {
  let target: URL;
  let source: URL;
  try {
    target = new URL(targetUrl);
    source = new URL(sourceUrl);
  } catch {
    throw new Error("verifyLink requires absolute http(s) URLs for both target and source.");
  }
  if (!["http:", "https:"].includes(target.protocol) || !["http:", "https:"].includes(source.protocol)) {
    throw new Error("verifyLink requires http(s) URLs.");
  }
  if (!isPublicHost(source.hostname) || !isPublicHost(target.hostname)) {
    throw new Error("verifyLink refuses non-public hosts.");
  }

  const upsertRow = (status: LinkStatus) =>
    withWorkspaceScope(workspaceId, (tx) =>
      tx.linkVerification.upsert({
        where: { workspaceId_targetUrl_sourceUrl: { workspaceId, targetUrl, sourceUrl } },
        update: { status, checkedAt: new Date() },
        create: { workspaceId, targetUrl, sourceUrl, status, checkedAt: new Date() },
      }),
    ).catch(() => null);

  let status: LinkStatus = "unknown";
  let detail = "";
  try {
    if (!(await robotsAllows(sourceUrl))) {
      status = "unknown";
      detail = "robots.txt disallows this path — not fetched";
    } else {
      const { status: httpStatus, body } = await fetchText(sourceUrl);
      if (httpStatus >= 200 && httpStatus < 300) {
        status = pageLinksTo(body, sourceUrl, targetUrl) ? "verified" : "lost";
        detail = status === "verified" ? "link found on source page" : "source fetched OK, link not present";
      } else {
        status = "unknown";
        detail = `source returned HTTP ${httpStatus}`;
      }
    }
  } catch (e) {
    status = "unknown";
    detail = `fetch failed: ${(e as Error).message}`;
  }

  const checkedAt = new Date();
  await upsertRow(status);
  await recordApiMeter(workspaceId, "fleet", "backlink_pull", 1, 0);
  await auditApiCall(workspaceId, "linkVerified", `Link ${sourceUrl} → ${targetUrl}: ${status} (${detail})`);
  return { targetUrl, sourceUrl, status, checkedAt, detail };
}
