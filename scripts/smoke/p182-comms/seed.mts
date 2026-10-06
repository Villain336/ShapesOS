// ShapesOS — Phase 18.2 (WS=comms) browser-smoke helper (scripts/smoke/p182-comms). Not part of the app.
// Phase 18.2 (WS=comms) browser smoke seed (run from the worktree with tsx,
// DATABASE_URL = the owner role). Idempotent: clears the e2e workspace's comms
// rows, then seeds what the smoke needs:
//   - the admin's Outlook + Outlook Calendar connections WITHOUT credentials
//     (dev → the connectors' labelled mock paths);
//   - a lead and an Ops contact with the same email (→ a merge suggestion).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ADMIN = "admin:e2e-admin@example.com";

async function main() {
  const ws = await prisma.workspace.findFirst({ where: { ownerUserId: ADMIN } });
  if (!ws) throw new Error("run scripts/e2e/seed.mts first");
  const W = ws.id;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.workspace_id', $1, true)`, W);
    await tx.$executeRawUnsafe(`DELETE FROM chat_channels WHERE workspace_id = $1 AND kind <> 'project'`, W);
    await tx.$executeRawUnsafe(`DELETE FROM team_chat_messages WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM chat_channel_members WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM meeting_sessions WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM mail_drafts WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM mail_thread_cache WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM contact_merge_suggestions WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM contact_identities WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM ops_tasks WHERE workspace_id = $1 AND project_id IS NULL`, W);
    await tx.$executeRawUnsafe(`DELETE FROM ops_contacts WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM user_presence WHERE workspace_id = $1`, W);
    await tx.$executeRawUnsafe(`DELETE FROM agent_jobs WHERE workspace_id = $1`, W);
  });
  await prisma.notification.deleteMany({ where: { workspaceId: W } });
  await prisma.userDeskState.deleteMany({ where: { userId: ADMIN } });
  await prisma.lead.deleteMany({ where: { workspaceId: W, email: "dana@smoke-acme.test" } });
  await prisma.connectorConnection.deleteMany({ where: { workspaceId: W, connectorKey: { in: ["outlook", "outlook-calendar", "gmail", "google-calendar"] } } });

  await prisma.connectorConnection.create({ data: { workspaceId: W, connectorKey: "outlook", userId: ADMIN, status: "active", scopes: [], meta: { email: "e2e-admin@example.com" } } });
  await prisma.connectorConnection.create({ data: { workspaceId: W, connectorKey: "outlook-calendar", userId: ADMIN, status: "active", scopes: [], meta: { email: "e2e-admin@example.com" } } });

  let pipe = await prisma.pipeline.findFirst({ where: { workspaceId: W } });
  if (!pipe) pipe = await prisma.pipeline.create({ data: { workspaceId: W, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  await prisma.lead.create({ data: { workspaceId: W, pipelineId: pipe.id, name: "Dana Smoke", email: "dana@smoke-acme.test", company: "Smoke Acme" } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.workspace_id', $1, true)`, W);
    await tx.opsContact.create({ data: { workspaceId: W, name: "Dana Smoke", email: "DANA@smoke-acme.test", phone: "+1 415 555 0100" } });
  });
  console.log(JSON.stringify({ workspaceId: W }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
