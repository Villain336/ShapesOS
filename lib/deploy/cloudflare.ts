// Marketr — Cloudflare Pages deploy target (milestone 9, live implementation).
//
// Auth: API token (Pages:Edit + Pages:Read), encrypted at rest, decrypted
// server-side only. Deploy uses the direct-upload flow:
//   1. ensure the Pages project exists (GET, else POST /pages/projects)
//   2. POST /pages/projects/:name/deployments with multipart form data
//      (manifest.json describing each file's sha256 + a blob per file)
// Returns the live *.pages.dev URL.
//
// NOTE: live API is untested from this sandbox (no network egress). Shapes
// follow the documented Cloudflare API (api.cloudflare.com, Pages).

import { createHash } from "node:crypto";
import {
  normalizeStatus,
  type DeployFile,
  type DeployResult,
  type DeployTarget,
  type DeploymentSummary,
  type CloudflareConfig,
} from "./types";

const API = "https://api.cloudflare.com/client/v4";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface CfEnvelope {
  success: boolean;
  result?: unknown;
  errors?: { message?: string; code?: number }[];
}

export class CloudflarePagesDeployTarget implements DeployTarget {
  readonly kind = "cloudflare-pages" as const;
  readonly name = "Cloudflare Pages";
  readonly isLive = true;

  constructor(private cfg: CloudflareConfig) {}

  private async api(path: string, init?: RequestInit): Promise<CfEnvelope> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(init?.headers ?? {}),
      },
    });
    let body: CfEnvelope;
    try {
      body = (await res.json()) as CfEnvelope;
    } catch {
      throw new Error(`Cloudflare request failed (${res.status} ${res.statusText}).`);
    }
    if (!res.ok || !body.success) {
      const msg =
        body.errors?.[0]?.message ?? `request failed (${res.status} ${res.statusText})`;
      throw new Error(`Cloudflare ${path} failed: ${msg}`);
    }
    return body;
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    if (!this.cfg.token) throw new Error("Cloudflare API token is required.");
    if (!this.cfg.accountId) throw new Error("Cloudflare account id is required.");
    const body = await this.api(`/accounts/${this.cfg.accountId}/pages/projects?per_page=1`);
    const list = (body.result ?? []) as Record<string, unknown>[];
    const sub = (body as { result_info?: { count?: number } }).result_info?.count ?? list.length;
    return {
      ok: true,
      info: `Cloudflare account ${this.cfg.accountId.slice(0, 8)}… — ${sub} Pages project(s) visible`,
    };
  }

  private projectPath(): string {
    return `/accounts/${this.cfg.accountId}/pages/projects`;
  }

  /** Ensure the Pages project exists; return its name. */
  private async ensureProject(name: string): Promise<string> {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63);
    if (!slug) throw new Error("Could not derive a Cloudflare Pages project name.");
    try {
      await this.api(`${this.projectPath()}/${slug}`);
      return slug;
    } catch {
      // Not found (or other error) — attempt creation.
      const body = await this.api(this.projectPath(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, production_branch: "main" }),
      });
      const created = body.result as Record<string, unknown> | undefined;
      return String(created?.name ?? slug);
    }
  }

  async deploy(files: DeployFile[], opts?: { projectName?: string }): Promise<DeployResult> {
    if (!files.length) throw new Error("Nothing to deploy — the site has no files.");
    const projectName = await this.ensureProject(
      (opts?.projectName ?? this.cfg.projectName).trim() || "marketr-site",
    );

    // Direct-upload: manifest maps sha256 → filename, blobs attach per file.
    const manifest: Record<string, string> = {};
    const blobs = new Map<string, Buffer>();
    for (const f of files) {
      const clean = f.path.replace(/^\//, "");
      const hash = sha256(f.content);
      manifest[hash] = clean;
      if (!blobs.has(hash)) blobs.set(hash, Buffer.from(f.content, "utf8"));
    }
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    for (const [hash, buf] of blobs) {
      form.append(hash, new Blob([new Uint8Array(buf)]), manifest[hash]);
    }

    const body = await this.api(`${this.projectPath()}/${projectName}/deployments`, {
      method: "POST",
      body: form,
    });
    const d = (body.result ?? {}) as Record<string, unknown>;
    const latestStage = d.latest_stage as Record<string, unknown> | undefined;
    const stage = d.stage as Record<string, unknown> | undefined;
    const id = String(d.id ?? "");
    const url = d.url ? String(d.url) : `https://${projectName}.pages.dev`;
    return {
      deploymentId: id,
      url,
      status: normalizeStatus(latestStage?.status ?? stage?.status ?? d.status),
      mock: false,
    };
  }

  async listDeployments(opts?: { projectName?: string; limit?: number }): Promise<DeploymentSummary[]> {
    const projectName = (opts?.projectName ?? this.cfg.projectName).trim();
    if (!projectName) return [];
    const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 25);
    const body = await this.api(
      `${this.projectPath()}/${projectName}/deployments?per_page=${limit}`,
    );
    const list = (body.result ?? []) as Record<string, unknown>[];
    return list.map((d) => ({
      id: String(d.id ?? ""),
      url: d.url ? String(d.url) : null,
      status: normalizeStatus(
        (d.latest_stage as Record<string, unknown> | undefined)?.status ?? d.status,
      ),
      mock: false,
    }));
  }

  async getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary> {
    const projectName = this.cfg.projectName.trim();
    if (!projectName) throw new Error("A Pages project name is required to check status.");
    const body = await this.api(
      `${this.projectPath()}/${projectName}/deployments/${deploymentId}`,
    );
    const d = (body.result ?? {}) as Record<string, unknown>;
    return {
      id: String(d.id ?? deploymentId),
      url: d.url ? String(d.url) : null,
      status: normalizeStatus(
        (d.latest_stage as Record<string, unknown> | undefined)?.status ?? d.status,
      ),
      mock: false,
    };
  }
}
