// ShapesOS Phase 11 (seotools): create_document / create_spreadsheet save
// real WorkspaceFiles through the filesystem service (upload sniff, quota,
// local storage) as the app role; the files open back up; another
// workspace can't read them; registered with a group and a Tier-0 action.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/documents/__tests__/document-tools-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { readFile } from "@/lib/filesystem/service";
import { getTool, toolAction, toolGroup, type ToolContext } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { create_document, create_spreadsheet } from "../tools";
import { readXlsx } from "../xlsx";

const RUN = `p11d-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";
const storage = mkdtempSync(path.join(tmpdir(), "shapes-docs-"));
const saved = process.env.MARKETR_STORAGE_DIR;

const ctx = (role: ToolContext["role"] = "editor"): ToolContext => ({ projectId, workspaceId: WS_A, userId: USER, role, confirmed: true });

before(async () => {
  process.env.MARKETR_STORAGE_DIR = storage;
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "acme.example" } })).id;
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await fs.rm(storage, { recursive: true, force: true });
  if (saved === undefined) delete process.env.MARKETR_STORAGE_DIR;
  else process.env.MARKETR_STORAGE_DIR = saved;
});

describe("document tools", () => {
  it("are registered in the content group as Tier-0 drafts", () => {
    for (const name of ["create_document", "create_spreadsheet"]) {
      assert.ok(getTool(name), name);
      assert.equal(toolGroup(name), "content");
      assert.equal(evaluateTier({ kind: toolAction(name) }, { smallActionThresholdCents: 0 } as never), 0, name);
    }
  });

  it("create_document saves a .docx WorkspaceFile", async () => {
    const res = await create_document.execute(ctx(), { title: "Launch plan", markdown: "# Goals\n- Ship **v2**\n\n| Week | Task |\n|---|---|\n| 1 | Beta |" });
    const d = res.details as { fileId: string; logicalPath: string; url: string };
    assert.match(d.logicalPath, new RegExp(`^/files/documents/${projectId}/\\d{4}-\\d{2}/launch-plan-[0-9a-f]{8}\\.docx$`));
    assert.match(d.url, /\/api\/files\//);
    const file = await readFile({ workspaceId: WS_A, fileId: d.fileId });
    assert.equal(file?.meta.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const xml = await (await JSZip.loadAsync(file!.bytes)).file("word/document.xml")!.async("string");
    assert.ok(xml.includes("Goals") && xml.includes("v2") && xml.includes("Beta"));
    assert.equal(await readFile({ workspaceId: WS_B, fileId: d.fileId }), null, "another workspace can't read it");
  });

  it("create_spreadsheet saves an .xlsx WorkspaceFile", async () => {
    const res = await create_spreadsheet.execute(ctx(), {
      title: "Pipeline",
      sheets: JSON.stringify([
        { name: "Deals", rows: [["Deal", "Value"], ["Acme", 12000]] },
        { name: "Notes", rows: [["=1+1"]], header: false },
      ]),
    });
    const d = res.details as { fileId: string; sheets: { name: string; rows: number }[] };
    assert.deepEqual(d.sheets, [{ name: "Deals", rows: 2 }, { name: "Notes", rows: 1 }]);
    const file = await readFile({ workspaceId: WS_A, fileId: d.fileId });
    const back = await readXlsx(file!.bytes);
    assert.deepEqual(back[0].rows, [["Deal", "Value"], ["Acme", 12000]]);
    assert.deepEqual(back[1].rows, [["=1+1"]]);
  });

  it("refuses bad content and viewers without writing a file", async () => {
    const before = await prisma.workspaceFile.count({ where: { workspaceId: WS_A } });
    assert.match((await create_spreadsheet.execute(ctx(), { title: "x", rows: "not json" })).summary, /Bad spreadsheet content/);
    assert.match((await create_document.execute(ctx(), { title: "x", markdown: "   " })).summary, /no content/);
    await assert.rejects(create_document.execute(ctx("viewer"), { title: "x", markdown: "hi" }), /editor role/);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS_A } }), before);
  });
});
