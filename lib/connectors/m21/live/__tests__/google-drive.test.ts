// Phase 4b: Google Drive adapter live path (files list/get/export, read-only).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/google-drive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveAdapter } from "../../native/google-drive";
import { escapeDriveQuery } from "../google-drive";
import { jsonResponse, textResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const DRIVE = "https://www.googleapis.com/drive/v3";

describe("Google Drive adapter", () => {
  it("mock mode without a credential", async () => {
    const f = scriptedFetch([]);
    const r = await new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps).invoke("list_files", {}, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("list_files: folder query, fields mask, pageToken pagination, limit", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { files: [{ id: "a", name: "A", mimeType: "text/plain", size: "12", modifiedTime: "2026-09-01T00:00:00Z" }], nextPageToken: "p2" }),
      jsonResponse(200, { files: [{ id: "b", name: "B", mimeType: "application/pdf" }, { id: "c", name: "C", mimeType: "x" }] }),
    ]);
    const r = await new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "list_files",
      { limit: "2" },
      oauthCred("d-tok"),
      ctxWith({ projectConfig: { folderId: "folder_1" } }),
    );
    assert.equal(r.ok, true, r.error);
    const q1 = f.calls[0].url.searchParams;
    assert.equal(f.calls[0].url.origin + f.calls[0].url.pathname, `${DRIVE}/files`);
    assert.equal(f.calls[0].headers.authorization, "Bearer d-tok");
    assert.equal(q1.get("q"), "'folder_1' in parents and trashed = false");
    assert.equal(q1.get("pageSize"), "2");
    assert.equal(q1.get("fields"), "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)");
    assert.equal(q1.get("supportsAllDrives"), "true");
    assert.equal(f.calls[1].url.searchParams.get("pageToken"), "p2");
    assert.equal(f.calls[1].url.searchParams.get("pageSize"), "1");
    const files = r.data as Array<{ id: string; sizeBytes?: number }>;
    assert.deepEqual(files.map((x) => x.id), ["a", "b"]);
    assert.equal(files[0].sizeBytes, 12);
  });

  it("search_files escapes quotes in the Drive query grammar", async () => {
    const f = scriptedFetch([jsonResponse(200, { files: [] })]);
    await new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps).invoke("search_files", { query: "o'brien \\ brief" }, oauthCred(), ctxWith());
    assert.equal(
      f.calls[0].url.searchParams.get("q"),
      "(name contains 'o\\'brien \\\\ brief' or fullText contains 'o\\'brien \\\\ brief') and trashed = false",
    );
    assert.equal(escapeDriveQuery("a'b"), "a\\'b");
  });

  it("get_file_text exports Google Docs as text/plain", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { id: "doc1", name: "Brief", mimeType: "application/vnd.google-apps.document" }),
      textResponse(200, "Hello brief"),
    ]);
    const r = await new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps).invoke("get_file_text", { fileId: "doc1" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[1].url.pathname, "/drive/v3/files/doc1/export");
    assert.equal(f.calls[1].url.searchParams.get("mimeType"), "text/plain");
    assert.deepEqual(r.data, { fileId: "doc1", name: "Brief", mimeType: "application/vnd.google-apps.document", text: "Hello brief", truncated: false });
  });

  it("get_file_text: Sheets → CSV export; text files → alt=media; binaries → metadata only", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { id: "s1", name: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }),
      textResponse(200, "a,b\n1,2"),
      jsonResponse(200, { id: "t1", name: "notes.md", mimeType: "text/markdown" }),
      textResponse(200, "# notes"),
      jsonResponse(200, { id: "p1", name: "deck.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/p1" }),
    ]);
    const a = new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps);
    await a.invoke("get_file_text", { fileId: "s1" }, oauthCred(), ctxWith());
    assert.equal(f.calls[1].url.searchParams.get("mimeType"), "text/csv");
    const t = await a.invoke("get_file_text", { fileId: "t1" }, oauthCred(), ctxWith());
    assert.equal(f.calls[3].url.searchParams.get("alt"), "media");
    assert.equal((t.data as { text: string }).text, "# notes");
    const p = await a.invoke("get_file_text", { fileId: "p1" }, oauthCred(), ctxWith());
    assert.equal((p.data as { text: null }).text, null);
    assert.equal(f.calls.length, 5);
  });

  it("refresh-on-401, 404 mapping, id validation", async () => {
    const f = scriptedFetch([jsonResponse(401, {}), jsonResponse(404, { error: { message: "File not found: zz." } })]);
    const ctx = refreshingCtx();
    const a = new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("get_file_text", { fileId: "zz" }, oauthCred(), ctx);
    assert.equal(ctx.refreshCalls(), 1);
    assert.equal(r.errorCode, "not_found");
    assert.match(r.error ?? "", /File not found/);
    const bad = await a.invoke("get_file_text", { fileId: "../../etc" }, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    assert.equal(f.calls.length, 2);
  });

  it("health check reads about?fields=user", async () => {
    const f = scriptedFetch([jsonResponse(200, { user: {} })]);
    const r = await new GoogleDriveAdapter(liveDeps(f.fetchImpl).deps).healthCheck(oauthCred(), ctxWith());
    assert.equal(r.ok, true);
    assert.equal(f.calls[0].url.href, `${DRIVE}/about?fields=user`);
  });
});
