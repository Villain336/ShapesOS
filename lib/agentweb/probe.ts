// ShapesOS — Phase 21A (WS=agentweb): probe a site for what it declares to agents.
//
// Fetches the handful of well-known files the channel ladder looks at
// (llms.txt, an OpenAPI description, a site MCP card, an NLWeb /ask) from the
// origin an agent is already visiting. It says who it is (an honest agent
// user agent, no impersonation), reads robots.txt first and skips what the site
// disallows for agents, goes through the SSRF-safe fetch, and clips what it
// reads. No CAPTCHA handling, no evasion: a refusal is reported as one.

import { isAllowed, parseRobots } from "@/lib/intelligence/fleet/robots";
import { UnsafeUrlError, type ResolveFn } from "@/lib/safe-url";
import { PROBE_PATHS, type SiteProbe } from "./channels";
import { agentFetch, type Signer } from "./identity/agent-fetch";
import { deploymentSigner } from "./identity/signer";

export const AGENT_BOT_TOKEN = "shapesos-agent";
export { AGENT_USER_AGENT } from "./identity/agent-fetch";
const FILE_CAP = 200_000;
const TIMEOUT_MS = 8_000;

export interface ProbeDeps {
  fetchFn?: typeof fetch;
  resolve?: ResolveFn;
  /** undefined = the deployment's Web Bot Auth signer; null = unsigned. */
  signer?: Signer | null;
}

export async function probeSite(origin: string, html: string, deps: ProbeDeps = {}): Promise<SiteProbe> {
  const files: SiteProbe["files"] = {};
  const get = async (path: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await agentFetch(
        `${origin}${path}`,
        { headers: { accept: "application/json, text/plain, text/html;q=0.8, */*;q=0.5" } },
        { fetchFn: deps.fetchFn, resolve: deps.resolve, signer: deps.signer === undefined ? deploymentSigner() : deps.signer, maxRedirects: 2, signal: ctl.signal },
      );
      return { status: res.status, body: (await res.text()).slice(0, FILE_CAP) };
    } finally {
      clearTimeout(timer);
    }
  };

  let robots;
  try {
    const r = await get("/robots.txt");
    robots = r.status === 200 ? parseRobots(r.body) : null;
  } catch (err) {
    // A private or unreachable address: nothing is probed.
    if (err instanceof UnsafeUrlError) return { origin, html, files };
    robots = null;
  }

  for (const path of PROBE_PATHS) {
    if (path === "/robots.txt") continue;
    if (robots && !isAllowed(robots, AGENT_BOT_TOKEN, `${origin}${path}`)) {
      files[path] = { status: 403, body: "" };
      continue;
    }
    try {
      files[path] = await get(path);
    } catch {
      files[path] = { status: 0, body: "" };
    }
  }
  return { origin, html, files };
}
