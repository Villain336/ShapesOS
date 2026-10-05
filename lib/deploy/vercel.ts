// Marketr — Vercel deploy target (milestone 9, live implementation).
//
// Auth: personal access token (https://vercel.com/account/tokens), encrypted
// at rest, decrypted server-side only. Deploy uploads static files via
// POST /v13/deployments with a files payload ({file, data (base64), sha});
// Vercel auto-creates a project when none is given, or deploys into an
// existing project when projectId is set. Returns the live *.vercel.app URL.
// Phase 9: rollback() is Vercel's instant rollback
// (POST /v9/projects/:project/rollback/:deployment) — production domains
// point at the earlier deployment again, nothing is rebuilt.
//
// NOTE: live API is untested from this sandbox (no network egress). Shapes
// follow the documented Vercel REST API (api.vercel.com, v13 deployments).

import { createHash } from "node:crypto";
import {
  normalizeStatus,
  type DeployFile,
  type DeployResult,
  type DeployTarget,
  type DeploymentSummary,
  type DeployPlace,
  type VercelConfig,
} from "./types";

const API = "https://api.vercel.com";

function sha1(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

export class VercelDeployTarget implements DeployTarget {
  readonly kind = "vercel" as const;
  readonly name = "Vercel";
  readonly isLive = true;

  constructor(private cfg: VercelConfig) {}

  private qs(): string {
    const p = new URLSearchParams();
    if (this.cfg.teamId) p.set("teamId", this.cfg.teamId);
    return p.toString() ? `?${p}` : "";
  }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${API}${path}${this.qs()}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    return res;
  }

  private async check(res: Response, what: string): Promise<Record<string, unknown>> {
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? JSON.stringify(body).slice(0, 200);
      } catch {
        detail = res.statusText;
      }
      throw new Error(`Vercel ${what} failed (${res.status}): ${detail}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    if (!this.cfg.token) throw new Error("Vercel token is required.");
    const body = await this.check(await this.api("/v2/user"), "token check");
    const user = (body.user ?? body) as Record<string, unknown>;
    const name = String(user.name ?? user.username ?? "unknown");
    const email = String(user.email ?? "");
    return { ok: true, info: `Vercel user ${name}${email ? ` (${email})` : ""}` };
  }

  async deploy(files: DeployFile[], opts?: { projectName?: string; project?: string | null }): Promise<DeployResult> {
    if (!files.length) throw new Error("Nothing to deploy — the site has no files.");
    const projectId = (opts?.project || opts?.projectName || this.cfg.projectId).trim();
    const payload: Record<string, unknown> = {
      name: projectId || "marketr-site",
      files: files.map((f) => ({
        file: f.path.replace(/^\//, ""),
        data: Buffer.from(f.content, "utf8").toString("base64"),
        sha: sha1(f.content),
      })),
      projectSettings: { framework: null },
      target: "production",
    };
    if (projectId) payload.project = projectId;
    const body = await this.check(
      await this.api("/v13/deployments", { method: "POST", body: JSON.stringify(payload) }),
      "deploy",
    );
    const id = String(body.id ?? "");
    const url = body.url ? `https://${String(body.url)}` : null;
    return {
      deploymentId: id,
      url: url ?? `https://${id}.vercel.app`,
      status: normalizeStatus(body.status),
      mock: false,
      project: body.projectId ? String(body.projectId) : projectId || undefined,
    };
  }

  async listDeployments(opts?: { projectName?: string; limit?: number }): Promise<DeploymentSummary[]> {
    const projectId = (opts?.projectName ?? this.cfg.projectId).trim();
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 20);
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    if (projectId) p.set("projectId", projectId);
    const extra = this.qs() ? `&${this.qs().slice(1)}` : "";
    const body = await this.check(
      await fetch(`${API}/v6/deployments?${p}${extra}`, {
        headers: { Authorization: `Bearer ${this.cfg.token}` },
      }),
      "list deployments",
    );
    const list = (body.deployments ?? []) as Record<string, unknown>[];
    return list.map((d) => ({
      id: String(d.uid ?? d.id ?? ""),
      url: d.url ? `https://${String(d.url)}` : null,
      status: normalizeStatus(d.state ?? d.status),
      mock: false,
    }));
  }

  async getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary> {
    const body = await this.check(await this.api(`/v13/deployments/${deploymentId}`), "deployment status");
    return {
      id: String(body.id ?? deploymentId),
      url: body.url ? `https://${String(body.url)}` : null,
      status: normalizeStatus(body.status),
      mock: false,
    };
  }

  async rollback(deploymentId: string, place: DeployPlace): Promise<DeploymentSummary> {
    if (!deploymentId) throw new Error("A deployment id is required to roll back.");
    let project = (place.project ?? this.cfg.projectId ?? "").trim();
    if (!project) {
      const d = await this.check(await this.api(`/v13/deployments/${encodeURIComponent(deploymentId)}`), "deployment lookup");
      project = String(d.projectId ?? "").trim();
    }
    if (!project) throw new Error("Could not tell which Vercel project this deployment belongs to.");
    const res = await this.api(
      `/v9/projects/${encodeURIComponent(project)}/rollback/${encodeURIComponent(deploymentId)}`,
      { method: "POST" },
    );
    if (!res.ok) await this.check(res, "rollback");
    return this.getDeploymentStatus(deploymentId);
  }
}
