// ShapesOS — Phase 11 (devtools): Netlify as an m21 registry connector.
//
// NO SECOND NETLIFY CLIENT: every call goes through the Phase 9 deploy
// adapter (lib/deploy/netlify.ts NetlifyDeployTarget):
//   list_sites      listSites()            GET  /api/v1/sites
//   list_deploys    listDeployments()      GET  /api/v1/sites/:id/deploys
//   get_deploy      getDeploymentStatus()  GET  /api/v1/deploys/:id
//   trigger_deploy  triggerBuild()         POST /api/v1/sites/:id/builds  [mutating]
// CREDENTIALS (API-key vault payload, never in args):
//   { hostingConnectionId } — reuse a project's existing Netlify hosting
//     connection (Sites → Hosting, "Use for agents"); the token stays in
//     that connection (decrypted server-side by lib/deploy), scoped to this
//     workspace; or
//   { apiKey } — a Netlify personal access token entered on Settings →
//     Connectors.
// trigger_deploy starts a new build from the site's linked repository and
// maps to the "publish_owned" action (your own site; asks unless a per-agent
// rule allows it). It is never retried. Tool group "site".
//
// MOCK MODE (no credential, or a demo hosting connection; dev/test/demo only
// — production answers "not connected"): labelled "(MOCK)" rows; a mock
// trigger deploys nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, mockOk, numProp, strProp } from "../types";
import { scrubMessage, type ConnectorErrorCode } from "../live/http";
import { NetlifyApiError, NetlifyDeployTarget } from "@/lib/deploy/netlify";

/** Loads + decrypts a workspace's Netlify hosting connection config (null when not found). */
export type HostingConfigLoader = (hostingConnectionId: string, workspaceId: string) => Promise<Record<string, unknown> | null>;

const defaultLoader: HostingConfigLoader = async (id, workspaceId) => {
  const { prisma } = await import("@/lib/prisma");
  const conn = await prisma.hostingConnection.findFirst({
    where: { id, target: "netlify", project: { workspaceId } },
    select: { configEnc: true },
  });
  if (!conn) return null;
  const { decryptHostingConfig } = await import("@/lib/deploy");
  return decryptHostingConfig(conn);
};

export interface NetlifyConnectorDeps {
  fetchImpl?: typeof fetch;
  loadHostingConfig?: HostingConfigLoader;
}

interface Resolved {
  target: NetlifyDeployTarget;
  token: string;
  /** Default site: the hosting connection's site id, or the data source's projectConfig.siteId. */
  siteId: string;
}

const SITE_ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const DEPLOY_ID_RE = /^[a-f0-9]{24}$/i;

function statusCode(status: number): ConnectorErrorCode {
  if (status === 401) return "auth_rejected";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "bad_request";
  return "provider_error";
}

export class NetlifyM21Adapter implements ConnectorAdapter {
  readonly key = "netlify";
  readonly displayName = "Netlify";
  readonly authType = "api_key" as const;
  readonly configSchema = {
    type: "object",
    properties: { siteId: { type: "string", description: "Default Netlify site id for this project data source (optional)." } },
  };

  constructor(private readonly deps: NetlifyConnectorDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    const siteId = strProp("Netlify site id (from list_sites); defaults to the connection's site.");
    return [
      {
        name: "list_sites",
        description: "List the Netlify sites this connection can see (name, URL, linked repository, published deploy).",
        mutating: false,
        argsSchema: { type: "object", properties: { limit: numProp("Max sites (default 50, max 100).") } },
      },
      {
        name: "list_deploys",
        description: "List recent deploys of a Netlify site (id, URL, status).",
        mutating: false,
        argsSchema: { type: "object", properties: { siteId, limit: numProp("Max deploys (default 10, max 50).") } },
      },
      {
        name: "get_deploy",
        description: "Read one Netlify deploy's status and URL.",
        mutating: false,
        argsSchema: { type: "object", properties: { deployId: strProp("Deploy id.") }, required: ["deployId"] },
      },
      {
        name: "trigger_deploy",
        description: "Start a new Netlify build and deploy of a site from its linked repository. Asks for confirmation first.",
        mutating: true,
        argsSchema: { type: "object", properties: { siteId, clearCache: boolProp("Clear the build cache first (default false).") } },
      },
    ];
  }

  /** Build the deploy target from the vault credential; null → mock mode. */
  private async resolve(credential: DecryptedCredential | null, ctx: InvokeContext): Promise<Resolved | "demo" | null> {
    const p = credential?.payload ?? {};
    const fromConfig = typeof ctx.projectConfig?.siteId === "string" ? ctx.projectConfig.siteId.trim() : "";
    if (typeof p.hostingConnectionId === "string" && p.hostingConnectionId) {
      const cfg = await (this.deps.loadHostingConfig ?? defaultLoader)(p.hostingConnectionId, ctx.workspaceId);
      if (!cfg) {
        throw Object.assign(new Error("The Netlify hosting connection this connector uses was removed — reconnect Netlify."), { code: "not_found" as const });
      }
      if (cfg.demo === true) return "demo";
      const token = String(cfg.token ?? "").trim();
      if (!token) return null;
      const siteId = String(cfg.siteId ?? "").trim();
      return { target: new NetlifyDeployTarget({ token, siteId, demo: false }, { fetchImpl: this.deps.fetchImpl }), token, siteId: fromConfig || siteId };
    }
    const token = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    if (!token) return null;
    return { target: new NetlifyDeployTarget({ token, siteId: "", demo: false }, { fetchImpl: this.deps.fetchImpl }), token, siteId: fromConfig };
  }

  private siteOf(args: Record<string, unknown>, r: Resolved): string {
    const s = (typeof args.siteId === "string" ? args.siteId.trim() : "") || r.siteId;
    if (!s) throw Object.assign(new Error("siteId is required (no default site on this connection)."), { code: "bad_request" as const });
    if (!SITE_ID_RE.test(s)) throw Object.assign(new Error("siteId must be a Netlify site id or name."), { code: "bad_request" as const });
    return s;
  }

  private failure(err: unknown, token: string | null): InvokeResult {
    const secrets = token ? [token] : [];
    if (err instanceof NetlifyApiError) {
      return { ok: false, mock: false, errorCode: statusCode(err.status), error: scrubMessage(err.message, secrets) };
    }
    const code = (err as { code?: unknown })?.code;
    const msg = err instanceof Error ? scrubMessage(err.message, secrets) : "unexpected error";
    if (code === "bad_request" || code === "not_found") return { ok: false, mock: false, errorCode: code, error: msg };
    if (err instanceof TypeError) return { ok: false, mock: false, errorCode: "provider_unreachable", error: "Netlify could not be reached." };
    return { ok: false, mock: false, errorCode: "provider_error", error: `Netlify: ${msg}` };
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    let r: Resolved | "demo" | null;
    try {
      r = await this.resolve(credential, ctx);
    } catch (err) {
      return this.failure(err, null);
    }
    if (r === null || r === "demo") return this.mock(tool, args);
    try {
      switch (tool) {
        case "list_sites":
          return liveOk(await r.target.listSites({ limit: Number(args.limit) || undefined }));
        case "list_deploys": {
          const siteId = this.siteOf(args, r);
          const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 10), 1), 50);
          return liveOk({ siteId, deploys: await r.target.listDeployments({ projectName: siteId, limit }) });
        }
        case "get_deploy": {
          const id = typeof args.deployId === "string" ? args.deployId.trim() : "";
          if (!DEPLOY_ID_RE.test(id)) return { ok: false, mock: false, errorCode: "bad_request", error: "deployId must be a Netlify deploy id." };
          return liveOk(await r.target.getDeploymentStatus(id));
        }
        case "trigger_deploy": {
          const siteId = this.siteOf(args, r);
          const build = await r.target.triggerBuild(siteId, { clearCache: args.clearCache === true || args.clearCache === "true" });
          return liveOk({ siteId, ...build });
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return this.failure(err, r.token);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    let r: Resolved | "demo" | null = null;
    try {
      r = await this.resolve(credential, ctx);
      if (r === null || r === "demo") return { ok: false, errorCode: "not_connected", error: "Netlify is not connected." };
      return liveOk({ info: (await r.target.test()).info });
    } catch (err) {
      return this.failure(err, r && r !== "demo" ? r.token : null);
    }
  }

  /** Labelled mock (dev/test/demo). Deploys nothing. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_sites":
        return mockOk([{ id: "mock-netlify-site-001", name: "acme-plumbing-demo (MOCK)", url: "https://acme-plumbing-demo.netlify.app", adminUrl: null, repo: null, branch: null, publishedDeployId: null, updatedAt: null, mock: true }]);
      case "list_deploys":
        return mockOk({ siteId: String(args.siteId ?? "mock-netlify-site-001"), deploys: [{ id: "mock-dep-netlify-001", url: "https://mock-dep-netlify-001--acme-plumbing-demo.netlify.app", status: "ready", mock: true }] });
      case "get_deploy":
        return mockOk({ id: String(args.deployId ?? "mock-dep-netlify-001"), url: null, status: "ready", mock: true });
      case "trigger_deploy":
        return mockOk({ triggered: false, mock: true, info: "MOCK — Netlify is not connected; nothing was deployed." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
