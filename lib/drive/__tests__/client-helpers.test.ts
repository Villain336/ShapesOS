// ShapesOS — Phase 21B (WS=drive): the Files app's pure client helpers (unit).
// Run: npx tsx --test lib/drive/__tests__/client-helpers.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileClass, filterRows, fmtSize, parentPath, rowFromShared, rowFromTrash, sortRows, type Row } from "../client/rows";
import { clearOpenWithForTests, openWithFor, registerOpenWith } from "../client/open-with";
import { DIRECT_UPLOAD_MAX, batchPercent, jobsFromDrop, jobsFromFiles, partRanges } from "../client/uploads";

const row = (over: Partial<Row> & { name: string }): Row => ({ kind: "file", id: over.name, path: `/shared/${over.name}`, mimeType: "text/plain", sizeBytes: 1, modifiedAt: "2026-11-01T00:00:00Z", version: 1, tags: [], color: null, system: false, favorite: false, canEdit: true, ...over });

describe("fileClass", () => {
  it("classifies by mime, then by name", () => {
    assert.equal(fileClass(row({ name: "a.png", mimeType: "image/png" })), "image");
    assert.equal(fileClass(row({ name: "a.pdf", mimeType: "application/pdf" })), "pdf");
    assert.equal(fileClass(row({ name: "a.csv", mimeType: "text/csv" })), "sheet");
    assert.equal(fileClass(row({ name: "b.xlsx", mimeType: "application/octet-stream" })), "sheet");
    assert.equal(fileClass(row({ name: "c.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })), "document");
    assert.equal(fileClass(row({ name: "d.md", mimeType: "text/markdown" })), "text");
    assert.equal(fileClass(row({ name: "e", kind: "folder", mimeType: null })), "folder");
    assert.equal(fileClass(row({ name: "f.bin", mimeType: "application/octet-stream" })), "other");
  });
});

describe("sortRows", () => {
  const rows = [row({ name: "b.txt", sizeBytes: 5 }), row({ name: "Docs", kind: "folder", sizeBytes: null }), row({ name: "a.txt", sizeBytes: 9 }), row({ name: "a10.txt", sizeBytes: 1 }), row({ name: "a2.txt", sizeBytes: 1 })];
  it("always leads with folders, then sorts by name naturally", () => {
    assert.deepEqual(sortRows(rows, "name", "asc").map((r) => r.name), ["Docs", "a.txt", "a2.txt", "a10.txt", "b.txt"]);
    assert.deepEqual(sortRows(rows, "name", "desc").map((r) => r.name), ["Docs", "b.txt", "a10.txt", "a2.txt", "a.txt"]);
  });
  it("sorts by size with name as the tie-break", () => {
    assert.deepEqual(sortRows(rows, "size", "desc").map((r) => r.name), ["Docs", "a.txt", "b.txt", "a2.txt", "a10.txt"]);
    assert.deepEqual(sortRows(rows, "size", "asc").map((r) => r.name), ["Docs", "a2.txt", "a10.txt", "b.txt", "a.txt"]);
  });
  it("sorts by modified time", () => {
    const r = [row({ name: "old", modifiedAt: "2026-01-01T00:00:00Z" }), row({ name: "new", modifiedAt: "2026-06-01T00:00:00Z" })];
    assert.deepEqual(sortRows(r, "modified", "desc").map((x) => x.name), ["new", "old"]);
  });
});

describe("filterRows / parentPath / fmtSize / rows from other views", () => {
  it("filters by name or tag, ignoring case", () => {
    const rows = [row({ name: "Invoice.pdf", tags: ["Q3"] }), row({ name: "notes.txt" })];
    assert.deepEqual(filterRows(rows, "invoice").map((r) => r.name), ["Invoice.pdf"]);
    assert.deepEqual(filterRows(rows, "q3").map((r) => r.name), ["Invoice.pdf"]);
    assert.equal(filterRows(rows, "  ").length, 2);
  });
  it("parentPath and fmtSize", () => {
    assert.equal(parentPath("/shared/a/b.txt"), "/shared/a");
    assert.equal(parentPath("/shared"), "/");
    assert.equal(fmtSize(0), "0 B");
    assert.equal(fmtSize(1536), "1.5 KB");
    assert.equal(fmtSize(5 * 1024 * 1024), "5.0 MB");
    assert.equal(fmtSize(null), "");
  });
  it("trash rows show the trashed time; shared rows show the role and allow editing only for editors", () => {
    assert.equal(rowFromTrash({ kind: "file", id: "1", name: "a", path: "/shared/a", sizeBytes: 3, trashedAt: "2026-11-02T00:00:00Z" }).modifiedAt, "2026-11-02T00:00:00Z");
    const v = rowFromShared({ kind: "file", id: "1", name: "a", path: "/shared/a", role: "viewer", sharedBy: "u", sharedAt: "2026-11-02T00:00:00Z", inPrivateHome: true });
    const e = rowFromShared({ kind: "file", id: "1", name: "a", path: "/shared/a", role: "editor", sharedBy: "u", sharedAt: "2026-11-02T00:00:00Z", inPrivateHome: true });
    assert.deepEqual([v.canEdit, e.canEdit, v.note], [false, true, "viewer"]);
  });
});

describe("Open with registry", () => {
  beforeEach(() => clearOpenWithForTests());
  it("offers the handlers that accept a row, in order, and registration can be undone", () => {
    const opened: string[] = [];
    const un1 = registerOpenWith({ id: "preview", label: "Quick look", order: 0, accepts: () => true, open: () => void opened.push("preview") });
    registerOpenWith({ id: "app:crm", label: "CRM Lite", appId: "crm", accepts: (r) => r.mimeType === "text/csv", open: () => void opened.push("crm") });
    assert.deepEqual(openWithFor(row({ name: "x.csv", mimeType: "text/csv" })).map((h) => h.id), ["preview", "app:crm"]);
    assert.deepEqual(openWithFor(row({ name: "x.txt" })).map((h) => h.id), ["preview"]);
    un1();
    assert.deepEqual(openWithFor(row({ name: "x.txt" })), []);
  });
  it("registering the same id again replaces the handler", () => {
    registerOpenWith({ id: "a", label: "One", accepts: () => true, open: () => undefined });
    registerOpenWith({ id: "a", label: "Two", accepts: () => true, open: () => undefined });
    assert.deepEqual(openWithFor(row({ name: "x" })).map((h) => h.label), ["Two"]);
  });
});

describe("upload planning", () => {
  it("takes relative paths from webkitRelativePath for a picked folder, null for loose files", () => {
    const a = new File(["x"], "a.txt");
    const b = Object.assign(new File(["y"], "b.txt"), { webkitRelativePath: "Proj/sub/b.txt" });
    const jobs = jobsFromFiles([a, b]);
    assert.deepEqual(jobs.map((j) => j.relativePath), [null, "Proj/sub/b.txt"]);
  });

  it("walks a dropped folder through the entries API, nested, with the folder name first", async () => {
    const file = (name: string) => ({ isFile: true, isDirectory: false, name, file: (cb: (f: File) => void) => cb(new File(["z"], name)) });
    const dir = (name: string, kids: unknown[]) => {
      let given = false;
      return { isFile: false, isDirectory: true, name, createReader: () => ({ readEntries: (cb: (e: unknown[]) => void) => { cb(given ? [] : kids); given = true; } }) };
    };
    const tree = dir("Proj", [file("a.txt"), dir("sub", [file("b.txt")])]);
    const jobs = await jobsFromDrop({ items: [{ kind: "file", webkitGetAsEntry: () => tree as never }, { kind: "file", webkitGetAsEntry: () => file("loose.txt") as never }] });
    assert.deepEqual(jobs.map((j) => j.relativePath), ["Proj/a.txt", "Proj/sub/b.txt", null]);
  });

  it("falls back to the plain file list when entries are unavailable, and caps the count", async () => {
    const files = Array.from({ length: 5 }, (_, i) => new File(["x"], `f${i}.txt`));
    const jobs = await jobsFromDrop({ items: [{ kind: "file" }], files }, 3);
    assert.equal(jobs.length, 3);
  });

  it("splits a file into part ranges and reports batch progress", () => {
    assert.deepEqual(partRanges(11, 5), [[0, 5], [5, 10], [10, 11]]);
    assert.deepEqual(partRanges(0, 5), []);
    assert.equal(DIRECT_UPLOAD_MAX, 8 * 1024 * 1024);
    const p = (size: number, sent: number, status: "queued" | "uploading" | "done") => ({ id: 0, name: "n", size, sent, status });
    assert.equal(batchPercent([p(100, 100, "done"), p(100, 50, "uploading")]), 75);
    assert.equal(batchPercent([]), 0);
  });
});
