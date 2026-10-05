// ShapesOS — Netlify deploy target (Phase 9, live implementation).
//
// Auth: personal access token (https://app.netlify.com/user/applications),
// encrypted at rest in the HostingConnection, decrypted server-side only.
// Deploy uses Netlify's file-digest flow (docs.netlify.com/api/get-started,
// "File digest method"):
//   1. resolve the Netlify site: the one the last deploy of this Site went
//      to → the connection's site id → an existing site with the derived
//      name → POST /api/v1/sites to create one (a taken name gets a suffix)
//   2. POST /api/v1/sites/:site_id/deploys { files: { "/path": sha1 } }
//      → { id, required: [sha1 …] } — the files Netlify does not have yet
//   3. PUT /api/v1/deploys/:deploy_id/files/:path for each required file
//      (application/octet-stream)
// rollback() is POST /api/v1/sites/:site_id/deploys/:deploy_id/restore —
// that earlier deploy becomes the published one again.
// Phase 11 (devtools): the m21 "netlify" connector (lib/connectors/m21/
// native/netlify.ts) reuses this class — listSites() is GET /api/v1/sites,
// triggerBuild() is POST /api/v1/sites/:site_id/builds (a new build from the
// site's linked repository). It never retries: a build trigger must not
// run twice.
//
// NOTE: live API is untested from this sandbox (no network egress); shapes
// follow the documented Netlify REST API (api.netlify.com/api/v1). The
// opt-in smoke test is scripts/live/netlify.mts.

import { createHash, randomBytes } from "node:crypto";
import {
  normalizeStatus,
  type DeployFile,
  type DeployPlace,
  type DeployResult,
  type DeployTarget,
  type DeploymentSummary,
  type NetlifyConfig,
} from "./types";

export const NETLIFY_API = "https://api.netlify.com/api/v1";

function sha1(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

/** A Netlify site name: lowercase [a-z0-9-], ≤ 63, no leading/trailing dash. */
export function netlifySiteSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
}

/** "/a b/c.html" → "a%20b/c.html" (each segment encoded, slashes kept). */
export function encodeDeployPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

type Json = Record<string, unknown>;

export class NetlifyDeployTarget implements DeployTarget {
  readonly kind = "netlify" as const;
  readonly name = "Netlify";
  readonly isLive = true;

  constructor(
    private cfg: NetlifyConfig,
    /** Phase 11 (devtools): injectable fetch (tests); defaults to the global fetch at call time. */
    private readonly opts: { fetchImpl?: typeof fetch } = {},
  ) {}

  private async api(path: string, init?: RequestInit): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    return fetchImpl(`${NETLIFY_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  private async check(res: Response, what: string): Promise<unknown> {
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        detail = body?.message ?? body?.error ?? JSON.stringify(body).slice(0, 200);
      } catch {
        detail = res.statusText;
      }
      throw new NetlifyApiError(`Netlify ${what} failed (${res.status}): ${detail}`, res.status);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : {};
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    if (!this.cfg.token) throw new Error("A Netlify access token is required.");
    const user = (await this.check(await this.api("/user"), "token check")) as Json;
    const name = String(user.full_name ?? user.slug ?? "unknown");
    const email = String(user.email ?? "");
    return { ok: true, info: `Netlify user ${name}${email ? ` (${email})` : ""}` };
  }

  /** The Netlify site id to deploy into (created on first deploy). */
  private async resolveSite(opts?: { projectName?: string; project?: string | null }): Promise<string> {
    const known = (opts?.project ?? "").trim() || this.cfg.siteId.trim();
    if (known) return known;
    const slug = netlifySiteSlug(opts?.projectName ?? "") || "shapesos-site";
    // An existing site of ours with exactly this name (the name filter is a
    // substring match, so compare exactly).
    const found = (await this.check(
      await this.api(`/sites?name=${encodeURIComponent(slug)}&filter=all&per_page=100`),
      "site lookup",
    )) as Json[];
    const exact = Array.isArray(found) ? found.find((s) => s?.name === slug) : undefined;
    if (exact?.id) return String(exact.id);
    // Create it. Netlify site names are global: a taken one gets a suffix.
    for (const name of [slug, `${slug.slice(0, 56)}-${randomBytes(3).toString("hex")}`]) {
      try {
        const created = (await this.check(
          await this.api("/sites", { method: "POST", body: JSON.stringify({ name }) }),
          "site create",
        )) as Json;
        if (created.id) return String(created.id);
      } catch (err) {
        if (!(err instanceof NetlifyApiError) || err.status !== 422) throw err;
      }
    }
    throw new Error(`Could not create a Netlify site named ${slug}.`);
  }

  async deploy(files: DeployFile[], opts?: { projectName?: string; project?: string | null }): Promise<DeployResult> {
    if (!files.length) throw new Error("Nothing to deploy — the site has no files.");
    const siteId = await this.resolveSite(opts);

    // Digest: "/path" → sha1. Identical content shares one sha; Netlify asks
    // for each sha once, any path carrying it will do.
    const digest: Record<string, string> = {};
    const bySha = new Map<string, DeployFile>();
    for (const f of files) {
      const path = `/${f.path.replace(/^\/+/, "")}`;
      const sha = sha1(f.content);
      digest[path] = sha;
      if (!bySha.has(sha)) bySha.set(sha, { path, content: f.content });
    }

    const created = (await this.check(
      await this.api(`/sites/${encodeURIComponent(siteId)}/deploys`, {
        method: "POST",
        body: JSON.stringify({ files: digest }),
      }),
      "deploy",
    )) as Json;
    const deployId = String(created.id ?? "");
    if (!deployId) throw new Error("Netlify did not return a deploy id.");

    const required = Array.isArray(created.required) ? (created.required as unknown[]).map(String) : [];
    for (const sha of required) {
      const f = bySha.get(sha);
      if (!f) throw new Error(`Netlify asked for a file this deploy does not have (${sha.slice(0, 8)}…).`);
      await this.check(
        await this.api(`/deploys/${encodeURIComponent(deployId)}/files/${encodeDeployPath(f.path)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: Buffer.from(f.content, "utf8"),
        }),
        `upload ${f.path}`,
      );
    }

    // After the uploads Netlify processes the deploy; read its state back.
    const after = required.length
      ? ((await this.check(await this.api(`/deploys/${encodeURIComponent(deployId)}`), "deploy status")) as Json)
      : created;
    return {
      deploymentId: deployId,
      url: deployUrl(after) ?? deployUrl(created) ?? `https://${deployId}.netlify.app`,
      status: normalizeStatus(after.state ?? created.state),
      mock: false,
      project: String(after.site_id ?? created.site_id ?? siteId),
    };
  }

  async listDeployments(opts?: { projectName?: string; limit?: number }): Promise<DeploymentSummary[]> {
    const siteId = (opts?.projectName ?? "").trim() || this.cfg.siteId.trim();
    if (!siteId) return [];
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
    const list = (await this.check(
      await this.api(`/sites/${encodeURIComponent(siteId)}/deploys?per_page=${limit}`),
      "list deploys",
    )) as Json[];
    return (Array.isArray(list) ? list : []).map((d) => ({
      id: String(d.id ?? ""),
      url: deployUrl(d),
      status: normalizeStatus(d.state),
      mock: false,
    }));
  }

  async getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary> {
    const d = (await this.check(await this.api(`/deploys/${encodeURIComponent(deploymentId)}`), "deploy status")) as Json;
    return { id: String(d.id ?? deploymentId), url: deployUrl(d), status: normalizeStatus(d.state), mock: false };
  }

  async rollback(deploymentId: string, place: DeployPlace): Promise<DeploymentSummary> {
    if (!deploymentId) throw new Error("A deployment id is required to roll back.");
    let siteId = (place.project ?? "").trim() || this.cfg.siteId.trim();
    if (!siteId) {
      const d = (await this.check(await this.api(`/deploys/${encodeURIComponent(deploymentId)}`), "deploy lookup")) as Json;
      siteId = String(d.site_id ?? "").trim();
    }
    if (!siteId) throw new Error("Could not tell which Netlify site this deploy belongs to.");
    const d = (await this.check(
      await this.api(`/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deploymentId)}/restore`, {
        method: "POST",
      }),
      "restore deploy",
    )) as Json;
    return {
      id: String(d.id ?? deploymentId),
      url: siteUrl(d) ?? deployUrl(d),
      status: normalizeStatus(d.state ?? "ready"),
      mock: false,
    };
  }

  /** Phase 11 (devtools): the token's sites (GET /sites), for the m21 connector. */
  async listSites(opts: { limit?: number } = {}): Promise<NetlifySiteSummary[]> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 100);
    const list = (await this.check(await this.api(`/sites?filter=all&per_page=${limit}`), "list sites")) as Json[];
    return (Array.isArray(list) ? list : []).map((s) => {
      const build = (s.build_settings ?? {}) as Json;
      const published = (s.published_deploy ?? {}) as Json;
      return {
        id: String(s.id ?? ""),
        name: String(s.name ?? ""),
        url: siteUrl(s),
        adminUrl: typeof s.admin_url === "string" ? s.admin_url : null,
        repo: typeof build.repo_url === "string" && build.repo_url ? build.repo_url : null,
        branch: typeof build.repo_branch === "string" && build.repo_branch ? build.repo_branch : null,
        publishedDeployId: typeof published.id === "string" ? published.id : null,
        updatedAt: typeof s.updated_at === "string" ? s.updated_at : null,
      };
    });
  }

  /**
   * Phase 11 (devtools): start a new build + deploy from the site's linked
   * repository (POST /sites/:id/builds). Never retried — a second trigger
   * would deploy twice.
   */
  async triggerBuild(siteId: string, opts: { clearCache?: boolean } = {}): Promise<NetlifyBuildSummary> {
    const id = siteId.trim() || this.cfg.siteId.trim();
    if (!id) throw new Error("A Netlify site id is required to trigger a deploy.");
    const b = (await this.check(
      await this.api(`/sites/${encodeURIComponent(id)}/builds`, {
        method: "POST",
        body: JSON.stringify(opts.clearCache ? { clear_cache: true } : {}),
      }),
      "trigger build",
    )) as Json;
    if (!b.id) throw new Error("Netlify did not return a build id.");
    return {
      buildId: String(b.id),
      deployId: typeof b.deploy_id === "string" ? b.deploy_id : null,
      createdAt: typeof b.created_at === "string" ? b.created_at : null,
      done: b.done === true,
    };
  }
}

export interface NetlifySiteSummary {
  id: string;
  name: string;
  url: string | null;
  adminUrl: string | null;
  repo: string | null;
  branch: string | null;
  publishedDeployId: string | null;
  updatedAt: string | null;
}

export interface NetlifyBuildSummary {
  buildId: string;
  deployId: string | null;
  createdAt: string | null;
  done: boolean;
}

/** The deploy's own permalink (https://<id>--<site>.netlify.app). */
function deployUrl(d: Json): string | null {
  const u = d.deploy_ssl_url ?? d.deploy_url ?? d.ssl_url ?? d.url;
  return typeof u === "string" && u ? u : null;
}

/** The site's main URL (what a restore makes live). */
function siteUrl(d: Json): string | null {
  const u = d.ssl_url ?? d.url;
  return typeof u === "string" && u ? u : null;
}

export class NetlifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NetlifyApiError";
  }
}
