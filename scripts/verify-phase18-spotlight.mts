// ShapesOS — Phase 18.1 (WS=find): Spotlight end to end with the REAL local
// MiniLM embedder (the DB test suite uses a deterministic mock embedder).
//
//   DATABASE_URL=<app role> npx tsx scripts/verify-phase18-spotlight.mts
//
// Seeds a scratch workspace, uploads a PDF through the real filesystem
// service, indexes it (extract → chunks → GIN + MiniLM embeddings), then:
//   1. full text finds a word inside the PDF;
//   2. meaning-search finds it from a paraphrase that shares no word;
//   3. a warm query stays within the ⌘K budget;
//   4. the agents' search_workspace tool returns the same top hit.
// Cleans up (the workspace cascade removes everything). Exit 1 on failure.

import "dotenv/config";
import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";

process.env.SPOTLIGHT_INDEX_ON_WRITE = "off";

const { prisma } = await import("../lib/prisma");
const { writeFile } = await import("../lib/filesystem/service");
const { indexFileText } = await import("../lib/search/text-index");
const { spotlight } = await import("../lib/search/records");
const { warmSpotlightEmbedder } = await import("../lib/search/semantic");
const { search_workspace } = await import("../lib/search/tool");

const WS = `p18-verify-${randomUUID().slice(0, 8)}`;
const OWNER = `${WS}-owner`;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function makePdf(lines: string[]): Buffer {
  const ops = lines.map((l) => `BT (${l}) Tj ET`).join("\n") + "\n";
  const d = deflateSync(Buffer.from(ops, "latin1"));
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${d.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    d,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}

try {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  const file = await writeFile({
    workspaceId: WS,
    logicalPath: "/files/q3-board-pack.pdf",
    kind: "file",
    bytes: makePdf([
      "Third quarter board pack.",
      "Our revenue forecast for next quarter rises eighteen percent on new enterprise contracts.",
      "Headcount stays flat; the Lisbon office opens in March.",
    ]),
    mimeType: "application/pdf",
    createdBy: OWNER,
  });
  const t0 = Date.now();
  await warmSpotlightEmbedder();
  console.log(`  model load ${Date.now() - t0} ms`);
  const idx = await indexFileText(WS, file.id);
  check("PDF indexed with real embeddings", idx.status === "indexed" && idx.embedded > 0, JSON.stringify(idx));

  const text = await spotlight(WS, "viewer", "Lisbon office", { userId: OWNER, semantic: "off" });
  const textHit = text.hits.find((h) => h.id === file.id && h.kind === "file_content");
  check("full text: a phrase inside the PDF", !!textHit && textHit.match.includes("text"), textHit?.snippet ?? "no hit");

  const meaning = await spotlight(WS, "viewer", "projected sales growth", { userId: OWNER, semantic: "wait" });
  const meaningHit = meaning.hits.find((h) => h.id === file.id);
  check(
    "meaning: a paraphrase with no shared word (real MiniLM + pgvector)",
    meaning.semantic === "used" && !!meaningHit && meaningHit.match.includes("meaning"),
    `semantic=${meaning.semantic} match=${meaningHit?.match.join("+") ?? "-"} score=${meaningHit?.score ?? "-"}`,
  );

  const t1 = Date.now();
  const warm = await spotlight(WS, "viewer", "board forecast", { userId: OWNER });
  const ms = Date.now() - t1;
  check("a warm query (text + meaning) answers within 1 s", ms < 1000 && warm.semantic === "used", `${ms} ms, semantic=${warm.semantic}`);

  const tool = await search_workspace.execute({ projectId: "p", workspaceId: WS, userId: OWNER, role: "viewer", confirmed: false }, { query: "Lisbon office" });
  const top = (tool.details as { results?: Array<{ id: string }> }).results?.[0]?.id;
  check("agents: search_workspace returns the same top hit", top === text.hits[0]?.id, `${top}`);
} catch (err) {
  check("no exception", false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\nverify-phase18-spotlight: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
