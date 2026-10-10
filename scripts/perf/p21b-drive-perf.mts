// ShapesOS — Phase 21B (WS=drive) performance numbers.
//   1. List a folder holding 10,000 files: first page, a deep page, each sort, and a Spotlight
//      query for a file name in it (rows are bulk-inserted directly; what is timed is the service).
//   2. Write 1,000 files through the real upload path (writeFileAs: path rules, scan hook, quota,
//      journal, storage) and then index their text for Spotlight (indexFileText, embeddings off:
//      the local embedding model is a separate download).
// Run: DATABASE_URL=<app role url> MARKETR_STORAGE=local npx tsx scripts/perf/p21b-drive-perf.mts
// Prints one JSON object of timings (ms).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DIR = mkdtempSync(join(tmpdir(), "p21b-perf-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

const { prisma } = await import("@/lib/prisma");
const { listChildren } = await import("@/lib/drive/tree");
const { createFolderAs, writeFileAs } = await import("@/lib/drive/ops");
const { indexFileText } = await import("@/lib/search/text-index");
const { searchRecords } = await import("@/lib/search/records");
const { collisionKey } = await import("@/lib/filesystem/paths");
const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");

const RUN = randomUUID().slice(0, 8);
const WS = `p21perf-${RUN}`;
const OWNER = `p21perf-own-${RUN}`;
const actor = { workspaceId: WS, userId: OWNER, role: "owner" as const };
const out: Record<string, number | string> = {};
const time = async <T>(label: string, fn: () => Promise<T>, repeat = 1): Promise<T> => {
  let last!: T;
  const t0 = performance.now();
  for (let i = 0; i < repeat; i++) last = await fn();
  out[label] = Math.round(((performance.now() - t0) / repeat) * 10) / 10;
  return last;
};

try {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: OWNER, role: "owner", email: `${OWNER}@example.test`, name: "Perf" } });

  // ---- 1. a folder with 10,000 files
  await createFolderAs(actor, "/shared/Big");
  const N = 10_000;
  const kinds = ["txt", "md", "csv", "pdf", "png"];
  const rows = Array.from({ length: N }, (_, i) => {
    const name = `file-${String(i).padStart(5, "0")}.${kinds[i % kinds.length]}`;
    const path = `/shared/Big/${name}`;
    return { workspaceId: WS, logicalPath: path, pathKey: collisionKey(path), storageKey: randomUUID(), filename: name, mimeType: "text/plain", sizeBytes: 100 + (i % 977), kind: "file" as const, createdBy: OWNER };
  });
  await time("seed_10000_rows_ms", async () => {
    for (let i = 0; i < rows.length; i += 1000) await prisma.workspaceFile.createMany({ data: rows.slice(i, i + 1000) });
  });
  out.files_in_folder = await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Big/" } } });

  const page = (sort: "name" | "kind" | "size" | "modified", dir: "asc" | "desc", offset: number) => listChildren({ actor, path: "/shared/Big", sort, dir, limit: 200, offset });
  const first = await time("list_first_page_200_by_name_ms", () => page("name", "asc", 0), 5);
  out.list_total_reported = first.total;
  await time("list_deep_page_offset_9800_by_name_ms", () => page("name", "asc", 9800), 5);
  await time("list_first_page_by_size_ms", () => page("size", "desc", 0), 5);
  await time("list_first_page_by_kind_ms", () => page("kind", "asc", 0), 5);
  await time("list_first_page_by_modified_ms", () => page("modified", "desc", 0), 5);
  await time("list_all_50_pages_sequential_ms", async () => {
    for (let o = 0; o < N; o += 200) await page("name", "asc", o);
  });
  out.first_page_rows = first.items.length;

  // ---- 2. 1,000 real uploads, then index them
  await createFolderAs(actor, "/shared/Docs");
  const M = 1000;
  const ids: string[] = [];
  await time("write_1000_files_ms", async () => {
    for (let i = 0; i < M; i++) {
      const r = await writeFileAs(actor, { dir: "/shared/Docs", filename: `note-${i}.txt`, bytes: Buffer.from(`Quarterly note ${i}. Revenue grew in the ${["north", "south", "east", "west"][i % 4]} region; keyword zebra${i % 50}.\n`.repeat(20)), mimeType: "text/plain" });
      ids.push(r.file.id);
    }
  });
  out.write_per_file_ms = Math.round((out.write_1000_files_ms as number) / M * 100) / 100;
  await time("index_1000_files_ms", async () => {
    for (const id of ids) await indexFileText(WS, id, { embed: false });
  });
  out.index_per_file_ms = Math.round((out.index_1000_files_ms as number) / M * 100) / 100;
  const byStatus = await withWorkspaceScope(WS, (tx) => tx.searchText.groupBy({ by: ["status"], where: { workspaceId: WS, source: "file" }, _count: true }));
  out.index_rows_by_status = byStatus.map((g) => `${g.status}=${g._count}`).join(", ");
  const nameHits = await time("spotlight_name_query_ms", () => searchRecords(WS, "owner", "file-04242", { kinds: ["file"] }), 5);
  out.spotlight_name_hits = nameHits.length;
  const contentHits = await time("spotlight_content_query_ms", () => searchRecords(WS, "owner", "zebra7", { kinds: ["file_content"] }), 5);
  out.spotlight_content_hits = contentHits.length;
  out.workspace = WS;
  console.log(JSON.stringify(out, null, 2));
} finally {
  await new Promise((r) => setTimeout(r, 500));
  await prisma.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
}
