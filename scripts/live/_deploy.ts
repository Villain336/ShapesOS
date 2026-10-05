// ShapesOS — Phase 9: the shared live flow for the three deploy adapters.
// Read-only: the token check. With LIVE_DEPLOY_WRITE=1: deploy page 1, wait
// until ready, deploy page 2, wait, roll back to page 1 (the one-click
// rollback path), then read its status. Uses a scratch project — never point
// it at a production site.
import type { DeployTarget, DeploymentSummary } from "@/lib/deploy/types";
import { sleep, smokePage, step, writesAllowed } from "./_lib";

async function waitReady(t: DeployTarget, id: string): Promise<DeploymentSummary> {
  for (let i = 0; i < 40; i++) {
    const s = await t.getDeploymentStatus(id);
    if (s.status === "ready" || s.status === "error") return s;
    await sleep(3000);
  }
  throw new Error(`deployment ${id} not ready after 2 minutes`);
}

export async function deployFlow(t: DeployTarget, projectName: string): Promise<void> {
  if (!t.isLive) throw new Error("refusing to smoke-test a mock target");
  await step("token (test)", () => t.test(), (r) => r.info);
  if (!writesAllowed()) {
    console.log("  SKIP deploy + rollback — set LIVE_DEPLOY_WRITE=1 (creates deployments in a scratch project).");
    return;
  }
  const first = await step("deploy 1", () => t.deploy(smokePage(t.name, 1), { projectName }), (r) => `${r.deploymentId} ${r.url} (${r.status})`);
  if (!first) return;
  await step("deploy 1 ready", () => waitReady(t, first.deploymentId), (s) => s.status);
  const second = await step("deploy 2", () => t.deploy(smokePage(t.name, 2), { projectName, project: first.project }), (r) => `${r.deploymentId} (${r.status})`);
  if (second) await step("deploy 2 ready", () => waitReady(t, second.deploymentId), (s) => s.status);
  await step("roll back to deploy 1", () => t.rollback(first.deploymentId, { project: first.project, projectName }), (s) => `${s.id} ${s.status}${s.url ? ` ${s.url}` : ""}`);
  await step("list deployments", () => t.listDeployments({ projectName: first.project ?? projectName, limit: 5 }), (l) => `${l.length} listed`);
}
