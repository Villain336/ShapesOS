// ShapesOS Phase 11 (seotools): analyze_data end to end as the app role —
// WorkspaceFile inputs (CSV + XLSX) are copied into the (TEST-ONLY fake)
// sandbox, Python reads them with the standard library, and what it writes
// to OUTPUT_DIR comes back as WorkspaceFiles (chart PNG, summary CSV); unsafe
// or unsupported outputs are reported, not saved; another workspace's file
// id is refused.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/sandbox/__tests__/analyze-tool-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import type { ToolContext } from "@/lib/chat/tools";
import { readFile, writeFile } from "@/lib/filesystem/service";
import { buildXlsx } from "@/lib/documents/xlsx";
import { createFakeSandbox, type FakeSandbox } from "@/lib/ship/__tests__/fake-sandbox";
import { analyze_data, setAnalyzeSandboxForTests } from "../analyze-tool";

const RUN = `p11x-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";
let csvId = "";
let xlsxId = "";
let otherId = "";
let sb: FakeSandbox;
const storage = mkdtempSync(path.join(tmpdir(), "shapes-analysis-"));
const saved = process.env.MARKETR_STORAGE_DIR;

const ctx = (): ToolContext => ({ projectId, workspaceId: WS_A, userId: USER, role: "editor", confirmed: true });

// Python that only needs the standard library: totals per region, a 1x1 PNG
// "chart" (zlib + struct), a script-bearing SVG (must be refused) and a .sh.
const CODE = String.raw`
import csv, os, struct, zlib
inp, out = os.environ["INPUT_DIR"], os.environ["OUTPUT_DIR"]
print(sorted(os.listdir(inp)))
totals = {}
with open(os.path.join(inp, "sales.csv")) as f:
    for row in csv.DictReader(f):
        totals[row["region"]] = totals.get(row["region"], 0) + float(row["amount"])
with open(os.path.join(inp, "targets.Targets.csv")) as f:
    targets = {r["region"]: float(r["target"]) for r in csv.DictReader(f)}
with open(os.path.join(out, "summary.csv"), "w") as f:
    f.write("region,total,target\n")
    for k in sorted(totals):
        f.write(f"{k},{totals[k]},{targets.get(k, '')}\n")
def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")
open(os.path.join(out, "chart.png"), "wb").write(png)
open(os.path.join(out, "evil.svg"), "w").write('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
open(os.path.join(out, "run.sh"), "w").write("echo hi")
print("north", totals["north"])
`;

before(async () => {
  process.env.MARKETR_STORAGE_DIR = storage;
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "acme.example" } })).id;
  csvId = (await writeFile({ workspaceId: WS_A, logicalPath: "/files/data/sales.csv", kind: "file", bytes: Buffer.from("region,amount\nnorth,10\nsouth,5\nnorth,2.5\n"), mimeType: "text/csv", createdBy: USER })).id;
  const xlsx = await buildXlsx({ sheets: [{ name: "Targets", rows: [["region", "target"], ["north", 20], ["south", 4]] }] });
  xlsxId = (await writeFile({ workspaceId: WS_A, logicalPath: "/files/data/targets.xlsx", kind: "file", bytes: xlsx, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdBy: USER })).id;
  otherId = (await writeFile({ workspaceId: WS_B, logicalPath: "/files/data/secret.csv", kind: "file", bytes: Buffer.from("a\n1\n"), mimeType: "text/csv", createdBy: USER })).id;
  sb = createFakeSandbox();
  setAnalyzeSandboxForTests(async () => sb);
});

after(async () => {
  setAnalyzeSandboxForTests(null);
  await sb.destroy();
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await fs.rm(storage, { recursive: true, force: true });
  if (saved === undefined) delete process.env.MARKETR_STORAGE_DIR;
  else process.env.MARKETR_STORAGE_DIR = saved;
});

describe("analyze_data with workspace files", () => {
  it("analyses CSV + XLSX inputs and saves the outputs as WorkspaceFiles", async () => {
    const r = await analyze_data.execute(ctx(), { code: CODE, fileIds: `${csvId},${xlsxId}` });
    const d = r.details as {
      exitCode: number;
      inputs: string[];
      files: { fileId: string; name: string; logicalPath: string }[];
      skipped: string[];
    };
    assert.equal(d.exitCode, 0, r.summary);
    assert.deepEqual(d.inputs, ["sales.csv", "targets.xlsx", "targets.Targets.csv"]);
    assert.match(r.summary, /north 12\.5/);
    assert.deepEqual(d.files.map((f) => f.name).sort(), ["chart.png", "summary.csv"]);
    for (const f of d.files) assert.match(f.logicalPath, new RegExp(`^/files/analysis/${projectId}/\\d{4}-\\d{2}/[0-9a-f]{8}-`));
    const summary = d.files.find((f) => f.name === "summary.csv")!;
    const back = await readFile({ workspaceId: WS_A, fileId: summary.fileId });
    assert.equal(back!.bytes.toString(), "region,total,target\nnorth,12.5,20.0\nsouth,5.0,4.0\n");
    const png = await readFile({ workspaceId: WS_A, fileId: d.files.find((f) => f.name === "chart.png")!.fileId });
    assert.equal(png!.meta.mimeType, "image/png");
    assert.ok(d.skipped.some((s) => /evil\.svg/.test(s)), "a script-bearing SVG is refused by the upload gate");
    assert.ok(d.skipped.some((s) => /run\.sh \(type not saved\)/.test(s)));
  });

  it("refuses a file from another workspace before touching the sandbox", async () => {
    const before = sb.log.length;
    const r = await analyze_data.execute(ctx(), { code: "print(1)", fileIds: otherId });
    assert.match(r.summary, /was not found in this workspace/);
    assert.equal(sb.log.length, before);
  });
});
