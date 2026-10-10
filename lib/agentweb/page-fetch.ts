// ShapesOS — Phase 21A (WS=agentweb): read one page's text over plain HTTP.
//
// The answer engine's "depth" step: for the top results, read the page itself.
// It says who it is (the honest agent user agent) and, when the deployment has an
// identity, signs the request with Web Bot Auth (lib/agentweb/identity). It reads
// robots.txt first and honours both what the site disallows for agents and its AI-usage
// preference (Content-Signal ai-input=no), goes through the SSRF-safe path (private
// addresses and every redirect hop are refused), reads at most 1 MB, and returns the
// VISIBLE text only (no script, style, hidden content). It runs no JavaScript: a page
// that needs it comes back thin, and that is reported as thin rather than papered over.
//
// A site that says no gets a typed outcome (readPage): blocked_by_site (the UI explains
// the manual path) or payment_required (a person decides). Never a workaround.

import { isAllowed, parseRobots } from "@/lib/intelligence/fleet/robots";
import type { ResolveFn } from "@/lib/safe-url";
import { parseHtml, visibleText } from "./html";
import { agentFetch, classifyResponse, type FetchOutcome, type Signer } from "./identity/agent-fetch";
import { deploymentSigner } from "./identity/signer";
import { AGENT_BOT_TOKEN } from "./probe";
import { policyOf } from "./site/robots-ai";

const MAX_BYTES = 1_000_000;
export const PAGE_TEXT_CAP = 20_000;

export type PageOutcome = Exclude<FetchOutcome, { kind: "ok" }> | { kind: "disallowed_by_robots" } | { kind: "disallowed_by_preference" } | { kind: "not_html" } | { kind: "empty" } | { kind: "unreachable" };
export type PageRead = { ok: true; text: string } | { ok: false; outcome: PageOutcome };

export interface PageFetchDeps {
  fetchFn?: typeof fetch;
  resolve?: ResolveFn;
  /** undefined = the deployment's signer (null when it has no https identity); null = unsigned. */
  signer?: Signer | null;
}

export async function readPage(url: string, deps: PageFetchDeps = {}): Promise<PageRead> {
  const signer = deps.signer === undefined ? deploymentSigner() : deps.signer;
  const net = { fetchFn: deps.fetchFn, resolve: deps.resolve, signer, maxRedirects: 3 };
  try {
    const origin = new URL(url).origin;
    const robotsText = await agentFetch(`${origin}/robots.txt`, {}, net).then(async (r) => (r.status === 200 ? (await r.text()).slice(0, 100_000) : null), () => null);
    if (robotsText !== null) {
      if (!isAllowed(parseRobots(robotsText), AGENT_BOT_TOKEN, url)) return { ok: false, outcome: { kind: "disallowed_by_robots" } };
      if (policyOf(robotsText)?.input === false) return { ok: false, outcome: { kind: "disallowed_by_preference" } };
    }
    const res = await agentFetch(url, {}, net);
    const body = (await res.text()).slice(0, MAX_BYTES);
    const outcome = classifyResponse(res, body);
    if (outcome.kind !== "ok") return { ok: false, outcome };
    if (!/html|xml/i.test(res.headers.get("content-type") ?? "")) return { ok: false, outcome: { kind: "not_html" } };
    const text = visibleText(parseHtml(body)).slice(0, PAGE_TEXT_CAP);
    return text ? { ok: true, text } : { ok: false, outcome: { kind: "empty" } };
  } catch {
    return { ok: false, outcome: { kind: "unreachable" } };
  }
}

export async function fetchPageText(url: string, deps: PageFetchDeps = {}): Promise<string | null> {
  const r = await readPage(url, deps);
  return r.ok ? r.text : null;
}
