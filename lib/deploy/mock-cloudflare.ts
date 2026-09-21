// Marketr — mock Cloudflare Pages deploy target (milestone 9).
//
// Deterministic demo so the full connect → deploy → visit flow works
// end-to-end without a Cloudflare token or network access. Every result is
// flagged mock: true and the UI labels it honestly. Writes are in-memory
// (per server process); restarting resets the demo. Never ship as real data.

import type {
  DeployFile,
  DeployResult,
  DeployTarget,
  DeploymentSummary,
  CloudflareConfig,
} from "./types";

const MOCK_PROJECT = "acme-plumbing-demo";
const BASE = 1730000000000; // deterministic timestamps

export class MockCloudflarePagesDeployTarget implements DeployTarget {
  readonly kind = "cloudflare-pages" as const;
  readonly name = "Cloudflare Pages";
  readonly isLive = false;

  private deployments: Map<string, { url: string; status: DeploymentSummary["status"]; at: number }> =
    new Map();

  constructor(private cfg: CloudflareConfig) {}

  async test(): Promise<{ ok: boolean; info: string }> {
    return { ok: true, info: `Cloudflare demo — Pages project ${MOCK_PROJECT} (MOCK)` };
  }

  async deploy(files: DeployFile[]): Promise<DeployResult> {
    if (!files.length) throw new Error("Nothing to deploy — the site has no files.");
    const id = `mock-dep-cf-${String(this.deployments.size + 1).padStart(3, "0")}`;
    const url = `https://${MOCK_PROJECT}.pages.dev`;
    this.deployments.set(id, { url, status: "ready", at: BASE + this.deployments.size * 1000 });
    return { deploymentId: id, url, status: "ready", mock: true };
  }

  async listDeployments(opts?: { limit?: number }): Promise<DeploymentSummary[]> {
    const limit = opts?.limit ?? 10;
    const entries = [...this.deployments.entries()].reverse().slice(0, limit);
    return entries.map(([id, d]) => ({ id, url: d.url, status: d.status, mock: true }));
  }

  async getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary> {
    const d = this.deployments.get(deploymentId);
    if (!d) throw new Error(`Unknown demo deployment ${deploymentId}.`);
    return { id: deploymentId, url: d.url, status: d.status, mock: true };
  }
}

export { MOCK_PROJECT as MOCK_CF_PROJECT };
