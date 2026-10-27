// ShapesOS mobile - Office docs data layer: real route shapes, plain-text
// round-trip, explicit refusal of richer content, version-conflict handling.
import { describe, expect, it } from "vitest";
import { DocConflictError, fetchDoc, fetchDocs, plainText, readPlainDoc, rebuildPlainDoc, saveDocSnapshot } from "../src/api/docs";
import { OsApiError } from "../src/api/os";

// The snapshot shape lib/univer/snapshots.ts buildDocSnapshot writes.
const doc = (texts: string[], extra: Record<string, unknown> = {}, bodyExtra: Record<string, unknown> = {}) => {
  let off = 0;
  const paragraphs = texts.map((t, i) => {
    const p = { startIndex: off, paragraphId: `p${i}` };
    off += t.length + 2;
    return p;
  });
  return { id: "doc_1", title: "Notes", locale: "enUS", documentStyle: { pageSize: { width: 595 } }, body: { dataStream: texts.map((t) => `${t}\r\n`).join(""), paragraphs, textRuns: [], ...bodyExtra }, ...extra };
};

function recorder(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, opts: { baseUrl: "https://x.example.com", authHeaders: () => ({ Cookie: "s=1" }), fetchImpl } };
}

describe("plain-text docs", () => {
  it("reads the lines of a plain document", () => {
    const r = readPlainDoc("doc", doc(["Quarterly plan", "", "Revenue grew 12%."]));
    expect(r).toEqual({ editable: true, lines: ["Quarterly plan", "", "Revenue grew 12%."] });
  });

  it("round-trips an edit: new text in, everything else carried over, ids kept", () => {
    const src = doc(["One", "Two"]);
    const out = rebuildPlainDoc(src, "One\nTwo edited\nThree") as typeof src;
    expect(out.body.dataStream).toBe("One\r\nTwo edited\r\nThree\r\n");
    expect(out.body.paragraphs.map((p) => p.paragraphId)).toEqual(["p0", "p1", "p2"]);
    expect(out.body.paragraphs.map((p) => p.startIndex)).toEqual([0, 5, 17]);
    expect(out.documentStyle).toEqual(src.documentStyle);
    expect(out.id).toBe("doc_1");
    expect(readPlainDoc("doc", out)).toEqual({ editable: true, lines: ["One", "Two edited", "Three"] });
    expect(plainText((readPlainDoc("doc", out) as { lines: string[] }).lines)).toBe("One\nTwo edited\nThree");
  });

  it("an unchanged text rebuilds to the identical snapshot", () => {
    const src = doc(["A", "BB", ""]);
    expect(rebuildPlainDoc(src, "A\nBB\n")).toEqual(src);
  });

  it("keeps the closing-CR paragraph convention when the doc uses it", () => {
    const stream = "ab\r\ncd\r\n";
    const src = { id: "d", body: { dataStream: stream, paragraphs: [{ startIndex: 2 }, { startIndex: 6 }], textRuns: [] } };
    expect(readPlainDoc("doc", src).editable).toBe(true);
    const out = rebuildPlainDoc(src, "abc\nd") as typeof src;
    expect(out.body.paragraphs.map((p) => p.startIndex)).toEqual([3, 6]);
  });

  it("an empty document is editable and gains text", () => {
    const src = { id: "d", body: { dataStream: "", paragraphs: [], textRuns: [] } };
    expect(readPlainDoc("doc", src)).toEqual({ editable: true, lines: [""] });
    expect((rebuildPlainDoc(src, "Hello") as typeof src).body.dataStream).toBe("Hello\r\n");
  });

  it("refuses richer content explicitly, with a reason, and never rebuilds it", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["bold run", doc(["Hi"], {}, { textRuns: [{ st: 0, ed: 2, ts: { bl: 1 } }] }), /formatting/],
      ["heading", { ...doc(["Hi"]), body: { ...doc(["Hi"]).body, paragraphs: [{ startIndex: 0, paragraphId: "p0", paragraphStyle: { headingId: "heading1" } }] } }, /headings/],
      ["list", { ...doc(["Hi"]), body: { ...doc(["Hi"]).body, paragraphs: [{ startIndex: 0, paragraphId: "p0", bullet: { listId: "l" } }] } }, /lists/],
      ["table", doc(["Hi"], {}, { tables: [{ startIndex: 0 }] }), /tables/],
      ["links", doc(["Hi"], {}, { customRanges: [{ startIndex: 0, endIndex: 1 }] }), /links/],
      ["section break", doc(["Hi"], {}, { sectionBreaks: [{ startIndex: 2 }] }), /section/],
      ["image", doc(["Hi"], { drawings: { a: {} } }), /images/],
      ["odd stream", { id: "d", body: { dataStream: "a\rb\r\n", paragraphs: [{ startIndex: 0 }], textRuns: [] } }, /layout/],
      ["bad index map", { id: "d", body: { dataStream: "ab\r\n", paragraphs: [{ startIndex: 1 }], textRuns: [] } }, /layout/],
    ];
    for (const [name, snap, re] of cases) {
      const r = readPlainDoc("doc", snap);
      expect(r.editable, name).toBe(false);
      expect((r as { reason: string }).reason, name).toMatch(re);
      expect(() => rebuildPlainDoc(snap, "x"), name).toThrow(/Not editable on the phone/);
    }
    expect(readPlainDoc("sheet", {})).toMatchObject({ editable: false });
    expect(readPlainDoc("slide", {})).toMatchObject({ editable: false });
  });

  it("refuses text the stream cannot hold", () => {
    expect(() => rebuildPlainDoc(doc(["a"]), "bad\u0001text")).toThrow(/characters/);
  });
});

describe("docs API client", () => {
  it("lists docs by kind and reads one doc with its version", async () => {
    const r = recorder([
      { body: { docs: [{ id: "d1", kind: "doc", title: "Plan", version: 3, updatedAt: "2026-10-26T10:00:00Z" }] } },
      { body: { doc: { id: "d1", kind: "doc", title: "Plan", version: 3, updatedAt: "x", snapshot: doc(["a"]) } } },
    ]);
    expect((await fetchDocs(r.opts))[0]!.title).toBe("Plan");
    expect((await fetchDoc(r.opts, "d1")).version).toBe(3);
    expect(r.calls.map((c) => c.url)).toEqual(["https://x.example.com/api/office/docs?kind=doc", "https://x.example.com/api/office/docs/d1"]);
  });

  it("saves with the version the phone opened", async () => {
    const r = recorder([{ body: { doc: { id: "d1", kind: "doc", title: "Plan", version: 4, updatedAt: "x", snapshot: {} } } }]);
    const saved = await saveDocSnapshot(r.opts, "d1", { a: 1 }, 3);
    expect(saved.version).toBe(4);
    expect(r.calls[0]).toMatchObject({ method: "PATCH", url: "https://x.example.com/api/office/docs/d1", body: { snapshot: { a: 1 }, expectedVersion: 3 } });
  });

  it("a 409 is a conflict error and is not retried or forced", async () => {
    const r = recorder([{ status: 409, body: { error: "version conflict: expected 3, have 5" } }]);
    await expect(saveDocSnapshot(r.opts, "d1", {}, 3)).rejects.toBeInstanceOf(DocConflictError);
    expect(r.calls).toHaveLength(1);
  });

  it("other failures keep the server's message (e.g. a viewer's 403)", async () => {
    const r = recorder([{ status: 403, body: { error: "Forbidden" } }]);
    await expect(saveDocSnapshot(r.opts, "d1", {}, 3)).rejects.toMatchObject({ status: 403, message: "Forbidden" });
    await expect(saveDocSnapshot(r.opts, "d1", {}, 3).catch((e) => { throw e; })).rejects.toBeInstanceOf(OsApiError);
  });
});

describe("previewText", () => {
  it("shows the text of a rich doc for reading, never as a save source", async () => {
    const { previewText } = await import("../src/api/docs");
    const rich = doc(["Title", "Body"], {}, { textRuns: [{ st: 0, ed: 5, ts: { bl: 1 } }] });
    expect(previewText(rich)).toBe("Title\nBody");
    expect(previewText({})).toBe("");
  });
});
