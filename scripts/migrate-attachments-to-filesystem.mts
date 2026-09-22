// Marketr — one-way migration: legacy .data/attachments → workspace filesystem.
//
// For each FileAttachment with a legacy storagePath (".data/attachments/..."),
// bytes move into the registry at /files/chat/<projectId>/<uuid>.<ext> and the
// row's storagePath becomes "fs:<workspaceFileId>". Rows already on "fs:"
// are skipped. Legacy bytes are deleted after a successful write.
//
// Old files keep working WITHOUT this migration via the compat read path in
// lib/filesystem/compat.ts. Run once per deployment after upgrading.
//
// Run: npx tsx scripts/migrate-attachments-to-filesystem.mts [--dry-run]

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { writeFile } from "@/lib/filesystem/service";
import { resolveWithinDir } from "@/lib/security/upload-safety";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const rows = await prisma.fileAttachment.findMany({
    where: {
      source: "upload",
      storagePath: { startsWith: ".data/attachments/" },
    },
    include: { project: { select: { workspaceId: true } } },
  });
  console.log(`Legacy attachments to migrate: ${rows.length}${DRY_RUN ? " (dry run)" : ""}`);

  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    const rel = row.storagePath!.slice(".data/attachments/".length);
    try {
      const abs = resolveWithinDir(join(process.cwd(), ".data/attachments"), rel);
      const bytes = await readFile(abs);
      if (DRY_RUN) {
        migrated++;
        continue;
      }
      const ext = (row.filename.split(".").pop() ?? "bin").toLowerCase().slice(0, 10);
      const wf = await writeFile({
        workspaceId: row.project.workspaceId,
        logicalPath: `/files/chat/${row.projectId}/${randomUUID()}.${ext.replace(/[^a-z0-9]/g, "") || "bin"}`,
        kind: "file",
        bytes,
        mimeType: row.mimeType ?? undefined,
        createdBy: row.uploadedBy,
        // These bytes passed upload-safety when originally uploaded; skip the
        // gate so legacy files (e.g. .json) don't get re-filtered.
        skipSafety: true,
      });
      await prisma.fileAttachment.update({
        where: { id: row.id },
        data: { storagePath: `fs:${wf.id}` },
      });
      await unlink(abs).catch(() => {});
      migrated++;
    } catch (err) {
      failed++;
      console.error(`  FAIL ${row.id} (${row.filename}): ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Migrated: ${migrated}, failed: ${failed}`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
