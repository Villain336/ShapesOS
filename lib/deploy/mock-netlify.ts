// ShapesOS — mock Netlify deploy target (Phase 9).
//
// Deterministic demo so the full connect → deploy → visit → roll back flow
// works end-to-end without a Netlify token or network access. Every result
// is flagged mock: true and the UI labels it honestly. Writes are in-memory
// (per instance; targets are built per request); restarting resets the
// demo. Never ship as real data.

import type {
  DeployFile,
  DeployPlace,
  DeployResult,
  DeployTarget,
  DeploymentSummary,
  NetlifyConfig,
} from "./types";

const MOCK_SITE = "acme-plumbing-demo";
const MOCK_SITE_ID = "mock-netlify-site-001";
const BASE = 1730000000000; // deterministic timestamps

export class MockNetlifyDeployTarget implements DeployTarget {
  readonly kind = "netlify" as const;
  readonly name = "Netlify";
  readonly isLive = false;

  private deployments: Map<string, { url: string; status: DeploymentSummary["status"]; at: number }> =
    new Map();

  constructor(private cfg: NetlifyConfig) {}

  async test(): Promise<{ ok: boolean; info: string }> {
    return { ok: true, info: `Netlify demo — site ${MOCK_SITE} (MOCK)` };
  }

  async deploy(files: DeployFile[]): Promise<DeployResult> {
    if (!files.length) throw new Error("Nothing to deploy — the site has no files.");
    const id = `mock-dep-netlify-${String(this.deployments.size + 1).padStart(3, "0")}`;
    const url = `https://${id}--${MOCK_SITE}.netlify.app`;
    this.deployments.set(id, { url, status: "ready", at: BASE + this.deployments.size * 1000 });
    return { deploymentId: id, url, status: "ready", mock: true, project: MOCK_SITE_ID };
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

  /** Demo restore: reported done on the demo site URL, flagged mock. */
  async rollback(deploymentId: string, _place: DeployPlace): Promise<DeploymentSummary> {
    if (!deploymentId) throw new Error("A deployment id is required to roll back.");
    return { id: deploymentId, url: `https://${MOCK_SITE}.netlify.app`, status: "ready", mock: true };
  }
}

export { MOCK_SITE as MOCK_NETLIFY_SITE };
