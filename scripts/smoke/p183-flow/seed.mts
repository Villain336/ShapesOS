// ShapesOS — Phase 18.3 (WS=flow) browser smoke seed (run after scripts/e2e/seed.mts).
// In the E2E admin's workspace: a skill (so "Describe it" drafts a schedule),
// a workflow on the canvas (the Automations list), a file (share sheet), a
// note with a version (version history), and an agent run that did real work
// through executeTool — a note and a reminder — for "Undo this agent run".
// Prints JSON ids. Run: DATABASE_URL=<migrate url> npx tsx scripts/smoke/p183-flow/seed.mts

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { writeFile } from "@/lib/filesystem/service";
import { createAgentRun } from "@/lib/agents/runs/service";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";

const ADMIN = "admin:e2e-admin@example.com";

async function main() {
  const ws = await prisma.workspace.findFirstOrThrow({ where: { ownerUserId: ADMIN } });
  const project = (await prisma.project.findFirst({ where: { workspaceId: ws.id } })) ?? (await prisma.project.create({ data: { workspaceId: ws.id, domain: "smoke-flow.test" } }));
  await withWorkspaceScope(ws.id, async (tx) => {
    if (!(await tx.skill.findFirst({ where: { workspaceId: ws.id, slug: "ticket-digest" } }))) {
      await tx.skill.create({ data: { workspaceId: ws.id, name: "Ticket digest", slug: "ticket-digest", description: "Summarise new support tickets", source: "upload", skillMd: "# Ticket digest\nSummarise new tickets.", declaredTools: [], trustTier: "built_in" } });
    }
  });
  if (!(await prisma.workflow.findFirst({ where: { projectId: project.id, name: "Weekly site audit" } }))) {
    const wf = await prisma.workflow.create({ data: { projectId: project.id, name: "Weekly site audit", status: "active", enabled: true, schedule: "0 9 * * 1", createdBy: ADMIN } });
    const a = await prisma.workflowNode.create({ data: { workflowId: wf.id, kind: "trigger", type: "schedule", label: "Every Monday", config: { cron: "0 9 * * 1" }, positionX: 0, positionY: 0 } });
    const b = await prisma.workflowNode.create({ data: { workflowId: wf.id, kind: "action", type: "send_alert", label: "Tell me", config: { title: "Audit done" }, positionX: 260, positionY: 0 } });
    await prisma.workflowEdge.create({ data: { workflowId: wf.id, sourceNodeId: a.id, targetNodeId: b.id } });
  }
  const file =
    (await prisma.workspaceFile.findFirst({ where: { workspaceId: ws.id, filename: "launch-plan.txt", trashedAt: null } })) ??
    (await writeFile({ workspaceId: ws.id, logicalPath: "/files/launch-plan.txt", kind: "file", bytes: Buffer.from("Launch plan: ship the PWA."), mimeType: "text/plain", createdBy: ADMIN, skipSafety: true }));
  const run = await createAgentRun({ workspaceId: ws.id, kind: "chat", startedBy: ADMIN });
  const ctx = { workspaceId: ws.id, projectId: project.id, userId: ADMIN, role: "owner" as const, confirmed: true, runId: run.id };
  for (const [tool, args] of [
    ["create_note", { title: "Agent research notes", body: "Competitor pricing went up 10%." }],
    ["create_reminder", { title: "Check competitor pricing again" }],
  ] as const) {
    const call: ChatToolCall = { tool, args: { ...args }, status: "executed" };
    await executeTool(ctx, tool, { ...args }, call);
    if (call.status !== "executed") throw new Error(`${tool}: ${call.resultSummary}`);
  }
  await withWorkspaceScope(ws.id, (tx) => tx.agentRun.update({ where: { id: run.id }, data: { status: "succeeded", endedAt: new Date() } }));
  console.log(JSON.stringify({ workspaceId: ws.id, projectId: project.id, fileId: file.id, runId: run.id }));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
