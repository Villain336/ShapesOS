// ShapesOS — Phase 21B (WS=drive) browser smoke seed (run after scripts/e2e/seed.mts).
// In the E2E admin's workspace: a second member (to share with), a Marketing folder tree with a
// Markdown, CSV, text, PNG and PDF file, a file that is already in the Trash, and an agent run that
// saved a new file into an attached folder through the real save_drive_file tool (for "Undo this run").
// Prints JSON ids. Run: DATABASE_URL=<app role url> npx tsx scripts/smoke/p21b-drive/seed.mts

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun } from "@/lib/agents/runs/service";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { createFolderAs, trashItemAs, writeFileAs } from "@/lib/drive/ops";
import { attachFolderToRun } from "@/lib/drive/run-folders";

const ADMIN = "admin:e2e-admin@example.com";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

async function main() {
  const ws = await prisma.workspace.findFirstOrThrow({ where: { ownerUserId: ADMIN } });
  const actor = { workspaceId: ws.id, userId: ADMIN, role: "owner" as const };
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: ws.id, userId: "smoke-ben" } },
    create: { workspaceId: ws.id, userId: "smoke-ben", role: "editor", email: "ben@example.com", name: "Ben Smoke" },
    update: {},
  });
  await createFolderAs(actor, "/shared/Marketing");
  await createFolderAs(actor, "/shared/Marketing/Campaigns");
  const put = (dir: string, filename: string, bytes: Buffer, mimeType: string) => writeFileAs(actor, { dir, filename, bytes, mimeType });
  await put("/shared/Marketing", "brief.md", Buffer.from("# Q4 brief\n\nShip the Drive.\n"), "text/markdown");
  await put("/shared/Marketing", "budget.csv", Buffer.from("channel,spend\nsearch,1200\nsocial,800\n"), "text/csv");
  await put("/shared/Marketing", "notes.txt", Buffer.from("Remember to thank the team."), "text/plain");
  await put("/shared/Marketing", "logo.png", PNG, "image/png");
  await put("/shared/Marketing", "report.pdf", PDF, "application/pdf");
  await put("/shared/Marketing/Campaigns", "launch.txt", Buffer.from("Launch on Tuesday."), "text/plain");
  const old = await put("/shared/Marketing", "old-draft.txt", Buffer.from("scrap"), "text/plain");
  await trashItemAs(actor, { kind: "file", id: old.file.id });

  const project = (await prisma.project.findFirst({ where: { workspaceId: ws.id } })) ?? (await prisma.project.create({ data: { workspaceId: ws.id, domain: "smoke-drive.test" } }));
  const run = await createAgentRun({ workspaceId: ws.id, kind: "chat", startedBy: ADMIN });
  await attachFolderToRun(actor, run.id, "/shared/Marketing");
  const ctx = { workspaceId: ws.id, projectId: project.id, userId: ADMIN, role: "owner" as const, confirmed: true, runId: run.id };
  const call: ChatToolCall = { tool: "save_drive_file", args: { path: "/shared/Marketing/agent-summary.txt", content: "Summary written by the agent." }, status: "executed" };
  await executeTool(ctx, "save_drive_file", { ...call.args }, call);
  if (call.status !== "executed") throw new Error(`save_drive_file: ${call.resultSummary}`);
  await withWorkspaceScope(ws.id, (tx) => tx.agentRun.update({ where: { id: run.id }, data: { status: "succeeded", endedAt: new Date() } }));
  console.log(JSON.stringify({ workspaceId: ws.id, projectId: project.id, runId: run.id }));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
