// Marketr — Playwright E2E seed (Phase A, fix 3).
// Run:  DATABASE_URL=... npx tsx scripts/e2e/seed.mts
// (or via scripts/e2e/run.sh which sets the whole E2E env).
//
// Creates the E2E world against a FRESH database:
//   - workspace "E2E Workspace" owned by the E2E admin identity
//   - WorkspaceMember rows: admin (owner) + editor (editor)
//   - demo project "e2e-example.com"
// Idempotent: re-running reuses existing rows (safe to run twice).
//
// Auth note: the credentials provider mints the user id `admin:<email>`
// (see auth.ts). The seeded ownerUserId / member userId must match that
// format exactly or workspace resolution will not find the workspace.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com";
const EDITOR_EMAIL = process.env.E2E_EDITOR_EMAIL ?? "e2e-editor@example.com";
// Must match the subject format minted by the credentials provider.
const adminUserId = `admin:${ADMIN_EMAIL.toLowerCase()}`;
const editorUserId = `editor:${EDITOR_EMAIL.toLowerCase()}`;

async function main() {
  let workspace = await prisma.workspace.findFirst({ where: { ownerUserId: adminUserId } });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "E2E Workspace",
        ownerUserId: adminUserId,
        plan: "self_hosted",
      },
    });
    console.log(`[e2e-seed] created workspace ${workspace.id}`);
  } else {
    console.log(`[e2e-seed] reusing workspace ${workspace.id}`);
  }

  for (const m of [
    { userId: adminUserId, email: ADMIN_EMAIL, role: "owner" as const },
    { userId: editorUserId, email: EDITOR_EMAIL, role: "editor" as const },
  ]) {
    const existing = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: m.userId },
    });
    if (!existing) {
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: m.userId, email: m.email, name: m.email, role: m.role },
      });
      console.log(`[e2e-seed] added member ${m.email} (${m.role})`);
    }
  }

  let project = await prisma.project.findFirst({
    where: { workspaceId: workspace.id, domain: "e2e-example.com" },
  });
  if (!project) {
    project = await prisma.project.create({
      data: { workspaceId: workspace.id, domain: "e2e-example.com", locale: "en-US" },
    });
    console.log(`[e2e-seed] created project ${project.id}`);
  } else {
    console.log(`[e2e-seed] reusing project ${project.id}`);
  }

  // Pending approvals for the Home feed's Needs-you semantics spec
  // (tests/e2e/visual-gate.spec.ts): two decidable mission approvals and one
  // authority approval the admin already approved (the blocked row). All are
  // synthetic rows in the disposable e2e database — deciding them in CI
  // exercises the real queue routes without touching anything live.
  const later = new Date(Date.now() + 86_400_000);
  for (const a of [
    { id: "e2e-feed-approve", action: "send_estimate", bindingJson: { amountCents: 485000 } },
    { id: "e2e-feed-deny", action: "pause_campaign", bindingJson: {} },
  ]) {
    await prisma.missionApproval.upsert({
      where: { id: a.id },
      update: { status: "pending", expiresAt: later },
      create: {
        id: a.id,
        workspaceId: workspace.id,
        action: a.action,
        tier: 1,
        bindingJson: a.bindingJson,
        bindingHash: "e2e",
        status: "pending",
        expiresAt: later,
        createdBy: "agent:lead",
      },
    });
  }
  await prisma.authorityApproval.upsert({
    where: { id: "e2e-feed-blocked" },
    update: { status: "pending", expiresAt: later },
    create: {
      id: "e2e-feed-blocked",
      workspaceId: workspace.id,
      type: "review_reply_post",
      status: "pending",
      bindingJson: { subject: "Reply to Dana K.'s review" },
      bindingHash: "e2e",
      createdBy: "agent:reviews",
      approversJson: [adminUserId],
      twoPersonRequired: true,
      expiresAt: later,
    },
  });
  console.log("[e2e-seed] seeded feed approvals (2 decidable, 1 blocked)");

  // A connected mock connector so connector-dependent UI has data.
  const existingConn = await prisma.connectorConnection.findFirst({
    where: { workspaceId: workspace.id, connectorKey: "mock-oauth" },
  });
  if (!existingConn) {
    console.log("[e2e-seed] (mock-oauth connection is created by the connectors spec itself)");
  }

  console.log(
    JSON.stringify(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        adminUserId,
        editorUserId,
      },
      null,
      2,
    ),
  );

  // Written for the Playwright specs (gitignored).
  const { writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    join(here, ".e2e-ids.json"),
    JSON.stringify({ workspaceId: workspace.id, projectId: project.id }, null, 2),
  );
  console.log("[e2e-seed] wrote scripts/e2e/.e2e-ids.json");
}

main()
  .catch((e) => {
    console.error("[e2e-seed] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
