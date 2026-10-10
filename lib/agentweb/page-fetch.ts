// ShapesOS — Phase 21A (WS=agentweb): read one page's text over plain HTTP.
//
// The answer engine's "depth" step: for the top results, read the page itself.
// It says who it is (the honest agent user agent), reads robots.txt first and
// skips what the site disallows for agents, goes through the SSRF-safe fetch
// (private addresses and every redirect hop are refused), reads at most 1 MB,
// and returns the VISIBLE text only (no script, style, hidden content). It runs
// no JavaScript: a page that needs it comes back thin, and that is reported as
// thin rather than papered over.

import { safeFetch } from "@/lib/connectors/safe-fetch";
import { isAllowed, parseRobots } from "@/lib/intelligence/fleet/robots";
import type { ResolveFn } from "@/lib/safe-url";
import { parseHtml, visibleText } from "./html";
import { AGENT_BOT_TOKEN, AGENT_USER_AGENT } from "./probe";

const MAX_BYTES = 1_000_000;
export const PAGE_TEXT_CAP = 20_000;

export async function fetchPageText(url: string, deps: { fetchFn?: typeof fetch; resolve?: ResolveFn } = {}): Promise<string | null> {
  const opts = { fetchFn: deps.fetchFn, resolve: deps.resolve, maxRedirects: 3 };
  const headers = { "user-agent": AGENT_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.3" };
  try {
    const origin = new URL(url).origin;
    const robots = await safeFetch(`${origin}/robots.txt`, { headers }, opts).then(async (r) => (r.status === 200 ? parseRobots((await r.text()).slice(0, 100_000)) : null), () => null);
    if (robots && !isAllowed(robots, AGENT_BOT_TOKEN, url)) return null;
    const res = await safeFetch(url, { headers }, opts);
    if (!res.ok || !/html|xml/i.test(res.headers.get("content-type") ?? "")) return null;
    const text = (await res.text()).slice(0, MAX_BYTES);
    return visibleText(parseHtml(text)).slice(0, PAGE_TEXT_CAP) || null;
  } catch {
    return null;
  }
}
