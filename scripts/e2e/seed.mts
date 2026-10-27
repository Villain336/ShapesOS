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
  // Phase 23 share-link fixtures (real storage, real rows):
  //   - a ready report whose pdfPath points at a REAL minimal PDF written
  //     through the app's own blobPut (so readStoredRef resolves it in
  //     whatever storage mode the e2e server runs)
  //   - an already-expired Office doc share whose token the spec reads, so
  //     the expired case is exercised without waiting
  const { blobPut } = await import("../../lib/filesystem/storage");
  const { createHash, randomBytes } = await import("node:crypto");

  function buildFixturePdf(): Buffer {
    const objs = [
      "<</Type/Catalog/Pages 2 0 R>>",
      "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
      "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ];
    const stream = "BT /F1 24 Tf 72 120 Td (ShapesOS shared report fixture) Tj ET";
    objs.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefAt = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(pdf, "utf8");
  }

  const pdfRef = await blobPut("reports", "e2e/share-fixture.pdf", buildFixturePdf(), "application/pdf");
  let template = await prisma.reportTemplate.findFirst({ where: { workspaceId: workspace.id, name: "E2E Shared Report" } });
  if (!template) {
    template = await prisma.reportTemplate.create({
      data: { workspaceId: workspace.id, name: "E2E Shared Report", type: "custom", content: { e2e: true } },
    });
  }
  let report = await prisma.report.findFirst({ where: { templateId: template.id, period: "2026-10" } });
  if (!report) {
    report = await prisma.report.create({
      data: { templateId: template.id, period: "2026-10", status: "ready", pdfPath: pdfRef },
    });
    console.log(`[e2e-seed] created ready report ${report.id} (pdf ${pdfRef})`);
  }

  const expiredDocToken = "osh_" + randomBytes(32).toString("base64url");
  const expiredDoc = await prisma.univerDoc.create({
    data: { workspaceId: workspace.id, kind: "doc", title: "Expired share doc", snapshot: { body: { textRuns: [] } } },
  });
  await prisma.univerDocShare.create({
    data: {
      workspaceId: workspace.id,
      docId: expiredDoc.id,
      tokenHash: createHash("sha256").update(expiredDocToken, "utf8").digest("hex"),
      tokenHint: expiredDocToken.slice(-4),
      label: "e2e expired",
      expiresAt: new Date(Date.now() - 86_400_000),
      createdBy: adminUserId,
    },
  });
  console.log("[e2e-seed] created expired doc share fixture");

  const { writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    join(here, ".e2e-ids.json"),
    JSON.stringify({ workspaceId: workspace.id, projectId: project.id, reportId: report.id, expiredDocToken }, null, 2),
  );
  console.log("[e2e-seed] wrote scripts/e2e/.e2e-ids.json");
}

main()
  .catch((e) => {
    console.error("[e2e-seed] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
