// Marketr — Dataset Builder slice 1 tests: ingest pipelines per source kind.
// Run: npx tsx --test lib/datasetbuilder/__tests__/ingest.test.ts
//
// No network, no credentials: Drive runs through MockNangoDriveAdapter, the
// crawl injects a fake fetch. Every pipeline must end with document.status
// "ready" and all chunks pointing at that document.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import AdmZip from "adm-zip";

import { InMemoryDatasetBuilderStore } from "../store";
import {
  extractMainText,
  ingestDriveFile,
  ingestPaste,
  ingestUpload,
  ingestWeb,
} from "../ingest";
import { MockNangoDriveAdapter, type DriveFileContent } from "../nango";
import { DatasetBuilderError } from "../types";
import { verifyNoOrphanedChunks } from "../register";

const WS = "ws-test";

function makeStore() {
  return new InMemoryDatasetBuilderStore();
}

function makePdf(lines: string[]): Uint8Array {
  const ops = lines.map((l) => `(${l}) Tj`).join("\n") + "\n";
  const deflated = deflateSync(Buffer.from(ops, "latin1"));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
        "latin1",
      ),
      deflated,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]),
  );
}

function makeDocx(paragraphs: string[]): Uint8Array {
  const zip = new AdmZip();
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="urn:x"><w:body>${body}</w:body></w:document>`,
      "utf8",
    ),
  );
  return new Uint8Array(zip.toBuffer());
}

const enc = new TextEncoder().encode.bind(new TextEncoder());

describe("ingestUpload", () => {
  it("ingests a PDF end to end", async () => {
    const store = makeStore();
    const result = await ingestUpload(store, {
      workspaceId: WS,
      filename: "one-pager.pdf",
      bytes: makePdf(["Acme pricing one-pager", "Plans start at $29 per seat"]),
    });
    assert.equal(result.source.kind, "upload");
    assert.equal(result.document.status, "ready");
    assert.ok(result.chunkCount >= 1);
    assert.ok(result.charCount > 0);
    const chunks = await store.listChunksByDocument(result.document.id);
    assert.equal(chunks.length, result.chunkCount);
    assert.ok(chunks.every((c) => c.documentId === result.document.id));
  });

  it("ingests a DOCX end to end", async () => {
    const store = makeStore();
    const result = await ingestUpload(store, {
      workspaceId: WS,
      filename: "sop.docx",
      bytes: makeDocx(["Refund policy", "Refunds within 30 days."]),
    });
    assert.equal(result.document.status, "ready");
    assert.ok(result.charCount > 0);
  });

  it("ingests a CSV end to end", async () => {
    const store = makeStore();
    const result = await ingestUpload(store, {
      workspaceId: WS,
      filename: "catalog.csv",
      bytes: enc("sku,price\nA-1,29\nB-2,49\n"),
    });
    assert.equal(result.document.status, "ready");
    const chunks = await store.listChunksByDocument(result.document.id);
    assert.ok(chunks[0].text.includes("sku: A-1"));
  });

  it("ingests markdown end to end", async () => {
    const store = makeStore();
    const result = await ingestUpload(store, {
      workspaceId: WS,
      filename: "faq.md",
      bytes: enc("# FAQ\n\nWhat do you sell? Widgets.\n"),
    });
    assert.equal(result.document.status, "ready");
    assert.ok(result.chunkCount >= 1);
  });

  it("marks the document failed on bad input, never half-claimed", async () => {
    const store = makeStore();
    await assert.rejects(
      () =>
        ingestUpload(store, {
          workspaceId: WS,
          filename: "broken.pdf",
          bytes: enc("not a pdf"),
        }),
      (e) => e instanceof DatasetBuilderError,
    );
    const docs = (await store.listSources(WS)).length;
    assert.equal(docs, 1, "source was created");
  });

  it("rejects unsupported file types", async () => {
    const store = makeStore();
    await assert.rejects(
      () =>
        ingestUpload(store, {
          workspaceId: WS,
          filename: "photo.png",
          bytes: enc("..."),
        }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "UNSUPPORTED_FILE_TYPE",
    );
  });
});

describe("ingestPaste", () => {
  it("ingests labeled text with the user-provided label", async () => {
    const store = makeStore();
    const result = await ingestPaste(store, {
      workspaceId: WS,
      label: "Founder notes 2026-10-01",
      text: "We sell widgets to dental offices. Pricing starts at $29.",
    });
    assert.equal(result.source.kind, "paste");
    assert.equal(result.source.name, "Founder notes 2026-10-01");
    assert.equal(result.document.status, "ready");
    assert.ok(result.chunkCount >= 1);
  });

  it("requires an explicit source label (negative)", async () => {
    const store = makeStore();
    await assert.rejects(
      () => ingestPaste(store, { workspaceId: WS, label: "   ", text: "hi" }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });

  it("rejects empty text (negative)", async () => {
    const store = makeStore();
    await assert.rejects(
      () => ingestPaste(store, { workspaceId: WS, label: "notes", text: "  " }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });
});

describe("extractMainText", () => {
  it("prefers article content and strips nav/script", () => {
    const html = `
      <html><head><title>x</title></head><body>
      <nav>Home About Contact</nav>
      <script>var x = 1;</script>
      <article><h1>Our pricing</h1><p>Plans start at $29.</p></article>
      <footer>copyright</footer>
      </body></html>`;
    const text = extractMainText(html);
    assert.ok(text.includes("Plans start at $29."));
    assert.ok(!text.includes("Home About Contact"));
    assert.ok(!text.includes("var x = 1"));
  });
});

describe("ingestWeb", () => {
  const fakeFetch = (async (url: string) => {
    assert.ok(url.startsWith("https://"));
    return new Response(
      `<html><body><article><h1>Acme FAQ</h1><p>We ship worldwide.</p></article></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;

  // Patch global fetch for the crawl path only.
  const realFetch = globalThis.fetch;

  it("crawls a URL and chunks with the URL as source pointer", async () => {
    globalThis.fetch = fakeFetch;
    try {
      const store = makeStore();
      const result = await ingestWeb(store, {
        workspaceId: WS,
        url: "https://acme.example/faq",
      });
      assert.equal(result.source.kind, "web");
      assert.equal(result.source.externalRef, "https://acme.example/faq");
      assert.equal(result.document.status, "ready");
      assert.ok(result.chunkCount >= 1);
      const chunks = await store.listChunksByDocument(result.document.id);
      assert.ok(chunks.every((c) => c.documentId === result.document.id));
      assert.ok(chunks[0].text.includes("We ship worldwide."));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects non-http URLs", async () => {
    const store = makeStore();
    await assert.rejects(
      () => ingestWeb(store, { workspaceId: WS, url: "ftp://x.example/f" }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });

  it("rejects malformed URLs", async () => {
    const store = makeStore();
    await assert.rejects(
      () => ingestWeb(store, { workspaceId: WS, url: "not a url" }),
      (e) =>
        e instanceof DatasetBuilderError && e.code === "VALIDATION_FAILED",
    );
  });
});

describe("ingestDriveFile", () => {
  function fixture(): DriveFileContent {
    return {
      ref: {
        id: "drive-file-1",
        name: "Board deck",
        mimeType: "text/csv",
        sizeBytes: 40,
        modifiedTime: "2026-10-01T00:00:00Z",
      },
      bytes: enc("metric,value\nMRR,12000\n"),
      filename: "board-deck.csv",
    };
  }

  it("ingests through the mock Nango adapter with no credentials", async () => {
    const store = makeStore();
    const adapter = new MockNangoDriveAdapter([fixture()]);
    const result = await ingestDriveFile(store, {
      workspaceId: WS,
      connectionId: "conn-test",
      fileId: "drive-file-1",
      adapter,
    });
    assert.equal(result.source.kind, "drive");
    assert.equal(result.source.externalRef, "drive-file-1");
    assert.equal(result.document.status, "ready");
    assert.ok(result.charCount > 0);
    const chunks = await store.listChunksByDocument(result.document.id);
    assert.ok(chunks.every((c) => c.documentId === result.document.id));
  });

  it("fails on unknown drive file ids", async () => {
    const store = makeStore();
    const adapter = new MockNangoDriveAdapter([fixture()]);
    await assert.rejects(
      () =>
        ingestDriveFile(store, {
          workspaceId: WS,
          connectionId: "conn-test",
          fileId: "nope",
          adapter,
        }),
      (e) => e instanceof DatasetBuilderError && e.code === "FETCH_FAILED",
    );
  });

  it("leaves zero orphaned chunks after a full ingest", async () => {
    const store = makeStore();
    const adapter = new MockNangoDriveAdapter([fixture()]);
    await ingestDriveFile(store, {
      workspaceId: WS,
      connectionId: "conn-test",
      fileId: "drive-file-1",
      adapter,
    });
    const orphans = await verifyNoOrphanedChunks(store, WS);
    assert.deepEqual(orphans, []);
  });
});
