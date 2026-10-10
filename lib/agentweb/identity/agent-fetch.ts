// ShapesOS — Phase 21A round 2 (WS=agentweb): honest, signed outbound agent traffic.
//
// Every fetch an agent makes on its own (the answer engine's page reader, site probes)
// goes through here. What it does:
//   - says who it is: the ShapesOS-Agent user agent, always;
//   - with a deployment identity configured, signs the request with Web Bot Auth
//     (lib/agentweb/identity/httpsig.ts) for the authority of THIS hop. Redirects are
//     followed by hand and each hop is signed again, so a signature never reaches a host
//     it was not made for;
//   - goes through the same SSRF checks as every other fetch (every hop validated);
//   - adds nothing else: no cookies, no browser headers, no retry under another identity.
// And what it never does: get around a refusal. A site that challenges, blocks or rate
// limits an agent gets a typed `blocked_by_site` outcome (the UI explains the manual
// path); HTTP 402 is `payment_required` for a person to decide (nothing is paid here).

import { assertSafeUrl, type ResolveFn } from "@/lib/safe-url";

/** Kept in step with lib/agentweb/probe.ts (the one place that names the agent). */
export const AGENT_USER_AGENT = "ShapesOS-Agent/1.0 (+https://shapesos.com/agents)";

/** Returns the signature headers for one request, or null to send it unsigned. */
export type Signer = (req: { url: string; method?: string }) => Promise<Record<string, string> | null>;

export interface AgentFetchDeps {
  fetchFn?: typeof fetch;
  resolve?: ResolveFn;
  signer?: Signer | null;
  maxRedirects?: number;
  signal?: AbortSignal;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function agentFetch(url: string, init: { headers?: Record<string, string> } = {}, deps: AgentFetchDeps = {}): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const max = deps.maxRedirects ?? 3;
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(current, { resolve: deps.resolve });
    const headers: Record<string, string> = { "user-agent": AGENT_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.3", ...(init.headers ?? {}) };
    let signed: Record<string, string> | null = null;
    try {
      signed = deps.signer ? await deps.signer({ url: current, method: "GET" }) : null;
    } catch {
      signed = null; // a signing problem never blocks a read or changes who we say we are
    }
    if (signed) for (const [k, v] of Object.entries(signed)) headers[k.toLowerCase()] = v;
    const res = await fetchFn(current, { method: "GET", headers, redirect: "manual", signal: deps.signal });
    const location = res.headers.get("location");
    if (!REDIRECTS.has(res.status) || !location) return res;
    if (hop >= max) throw new Error("Too many redirects.");
    current = new URL(location, current).toString();
  }
}

// ---------------------------------------------------------------------------
// What a response means for an agent
// ---------------------------------------------------------------------------

export type BlockReason = "challenge" | "forbidden" | "unauthorized" | "rate_limited";

export type FetchOutcome =
  | { kind: "ok" }
  | { kind: "blocked_by_site"; reason: BlockReason; status: number; manualPath: true; retryAfterSec?: number }
  | { kind: "payment_required"; status: 402; price: string | null }
  | { kind: "error"; status: number };

const CHALLENGE_TEXT = /captcha|just a moment|attention required|verify you are (a )?human|are you a robot|checking your browser|access denied.*(bot|automated)/i;

/** `body` is the (clipped) response text; the response itself is only read for status and headers. */
export function classifyResponse(res: Response, body: string): FetchOutcome {
  const status = res.status;
  if (status === 402) return { kind: "payment_required", status: 402, price: res.headers.get("crawler-price")?.trim() || null };
  const challenged = res.headers.get("cf-mitigated")?.toLowerCase() === "challenge" || (CHALLENGE_TEXT.test(body.slice(0, 4000)) && (status >= 400 || /<title>\s*just a moment/i.test(body)));
  if (challenged) return { kind: "blocked_by_site", reason: "challenge", status, manualPath: true };
  if (status === 403) return { kind: "blocked_by_site", reason: "forbidden", status, manualPath: true };
  if (status === 401) return { kind: "blocked_by_site", reason: "unauthorized", status, manualPath: true };
  if (status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    return { kind: "blocked_by_site", reason: "rate_limited", status, manualPath: true, ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: retry } : {}) };
  }
  if (status >= 400) return { kind: "error", status };
  return { kind: "ok" };
}

/**
 * The headers to continue a browser navigation with: the page's own headers plus the Web Bot
 * Auth signature for this URL. Null when there is nothing to add (no identity, or the signer
 * failed): the navigation then goes ahead unsigned, honest user agent only.
 */
export async function signedNavigationHeaders(signer: Signer | null | undefined, req: { url: string; method: string; headers: Record<string, string> }): Promise<Record<string, string> | null> {
  if (!signer) return null;
  try {
    const sig = await signer({ url: req.url, method: req.method });
    if (!sig) return null;
    const merged: Record<string, string> = { ...req.headers };
    for (const [k, v] of Object.entries(sig)) merged[k.toLowerCase()] = v;
    return merged;
  } catch {
    return null;
  }
}
