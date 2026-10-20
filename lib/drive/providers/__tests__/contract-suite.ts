// ShapesOS — Phase 21B (WS=drive): the FileProvider contract suite. Every provider
// implementation runs the SAME tests (native, fake, and Google Drive against a mock
// of the Drive API). Expected values are literals from the contract in types.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, collect, type FileProvider } from "../types";

export interface ProviderHarness {
  provider: FileProvider;
  /** A string that, written with write(), is accepted by this provider. */
  sampleText: (s: string) => Buffer;
  cleanup?: () => Promise<void>;
}

async function expectCode(p: Promise<unknown>, code: string, msg?: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ProviderError && e.code === code, msg ?? `expected ProviderError ${code}`);
}

export function runProviderContract(name: string, make: () => Promise<ProviderHarness>, opts: { supportsQuotaLimit?: boolean } = {}): void {
  describe(`FileProvider contract: ${name}`, () => {
    let h: ProviderHarness;
    let p: FileProvider;
    before(async () => {
      h = await make();
      p = h.provider;
    });
    after(async () => {
      await h.cleanup?.();
    });

    it("lists a folder it just created, even though it is empty", async () => {
      const f = await p.mkdir("/Docs");
      assert.deepEqual([f.kind, f.name, f.path], ["folder", "Docs", "/Docs"]);
      assert.deepEqual((await p.list("/Docs")).entries, []);
      assert.deepEqual((await p.list("/")).entries.map((e) => e.name), ["Docs"]);
    });

    it("writes a file, reports its size, lists it and reads the same bytes back", async () => {
      const bytes = h.sampleText("hello provider\n".repeat(50));
      const e = await p.write("/Docs/a.txt", bytes, { mimeType: "text/plain" });
      assert.deepEqual([e.kind, e.name, e.path, e.sizeBytes], ["file", "a.txt", "/Docs/a.txt", bytes.length]);
      const st = await p.stat("/Docs/a.txt");
      assert.equal(st?.sizeBytes, bytes.length);
      assert.deepEqual((await p.list("/Docs")).entries.map((x) => x.name), ["a.txt"]);
      assert.ok((await collect(await p.read("/Docs/a.txt"))).equals(bytes));
    });

    it("reads a byte range (inclusive)", async () => {
      const got = await collect(await p.read("/Docs/a.txt", { start: 6, end: 13 }));
      assert.equal(got.toString(), "provider");
    });

    it("refuses to overwrite without being asked, and replaces when asked", async () => {
      await expectCode(p.write("/Docs/a.txt", h.sampleText("other")), "conflict");
      const replaced = await p.write("/Docs/a.txt", h.sampleText("second version"), { overwrite: true, mimeType: "text/plain" });
      assert.equal(replaced.sizeBytes, "second version".length);
      assert.equal((await collect(await p.read("/Docs/a.txt"))).toString(), "second version");
    });

    it("treats names that differ only by case as the same name", async () => {
      await expectCode(p.write("/Docs/A.TXT", h.sampleText("x")), "conflict");
      await expectCode(p.mkdir("/docs"), "conflict");
    });

    it("needs the parent folder to exist", async () => {
      await expectCode(p.write("/Nope/b.txt", h.sampleText("x")), "not_found");
      await expectCode(p.mkdir("/Nope/Deeper"), "not_found");
    });

    it("moves and renames: the old path is gone, the new one is there, contents intact", async () => {
      await p.mkdir("/Archive");
      const moved = await p.move("/Docs/a.txt", "/Archive/renamed.txt");
      assert.deepEqual([moved.name, moved.path], ["renamed.txt", "/Archive/renamed.txt"]);
      assert.equal(await p.stat("/Docs/a.txt"), null);
      assert.equal((await collect(await p.read("/Archive/renamed.txt"))).toString(), "second version");
      await p.write("/Docs/c.txt", h.sampleText("c"));
      await expectCode(p.move("/Docs/c.txt", "/Archive/renamed.txt"), "conflict");
    });

    it("moves a folder with everything in it", async () => {
      await p.mkdir("/Tree");
      await p.write("/Tree/x.txt", h.sampleText("x"));
      await p.move("/Tree", "/Archive/Tree");
      assert.equal(await p.stat("/Tree"), null);
      assert.equal((await p.stat("/Archive/Tree/x.txt"))?.name, "x.txt");
      await expectCode(p.move("/Archive", "/Archive/Inside"), "invalid_path");
    });

    it("removing hides the item; removing something absent is not_found", async () => {
      await p.remove("/Docs/c.txt");
      assert.equal(await p.stat("/Docs/c.txt"), null);
      assert.deepEqual((await p.list("/Docs")).entries, []);
      await expectCode(p.remove("/Docs/c.txt"), "not_found");
    });

    it("missing things say not_found", async () => {
      assert.equal(await p.stat("/Docs/never.txt"), null);
      await expectCode(p.list("/NoSuchFolder"), "not_found");
      await expectCode(collect(await p.read("/Docs/never.txt")), "not_found");
    });

    it("refuses unsafe paths", async () => {
      for (const bad of ["/Docs/../x", "/Docs/CON", "/Docs/a?b.txt", "/Docs/trailing.", "Docs/a.txt"]) {
        await expectCode(p.write(bad, h.sampleText("x")), "invalid_path", bad);
      }
    });

    it("pages a long listing without losing or repeating entries", async () => {
      await p.mkdir("/Many");
      for (let i = 0; i < 7; i++) await p.write(`/Many/f${i}.txt`, h.sampleText(`n${i}`));
      const seen: string[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<FileProvider["list"]>> = await p.list("/Many", { pageToken: token, limit: 3 });
        seen.push(...page.entries.map((e) => e.name));
        token = page.nextPageToken;
        pages++;
      } while (token && pages < 10);
      assert.deepEqual(seen.sort(), ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"]);
      assert.equal(pages, 3);
    });

    it("keeps a change feed: a start cursor, then ordered changes, then nothing new", async () => {
      const start = await p.changes(null);
      assert.deepEqual(start.changes, []);
      await p.mkdir("/Feed");
      await p.write("/Feed/one.txt", h.sampleText("1"));
      await p.move("/Feed/one.txt", "/Feed/two.txt");
      await p.remove("/Feed/two.txt");
      const feed = await p.changes(start.cursor);
      // A provider may report only the LATEST state of each item (Google Drive does), so a
      // create that was renamed and trashed can arrive as one "trash". What must hold is the
      // order, that the folder shows up, and that the file's last change is the trash.
      const paths = feed.changes.map((c) => c.entry.path);
      assert.ok(feed.changes.some((c) => c.type === "create" && c.entry.path === "/Feed"), "the folder was created");
      const last = feed.changes.at(-1)!;
      assert.deepEqual([last.type, last.entry.path], ["trash", "/Feed/two.txt"]);
      assert.ok(paths.indexOf("/Feed") < paths.lastIndexOf("/Feed/two.txt"), "changes arrive oldest first");
      for (const c of feed.changes) if (c.type === "move") assert.equal(c.prevPath, "/Feed/one.txt");
      assert.equal(feed.hasMore, false);
      const again = await p.changes(feed.cursor);
      assert.deepEqual(again.changes, []);
      assert.equal(again.cursor, feed.cursor);
    });

    it("pages the change feed in order with hasMore", async () => {
      const start = await p.changes(null);
      for (let i = 0; i < 5; i++) await p.write(`/Feed/p${i}.txt`, h.sampleText(`p${i}`));
      const first = await p.changes(start.cursor, 2);
      assert.deepEqual(first.changes.map((c) => c.entry.path), ["/Feed/p0.txt", "/Feed/p1.txt"]);
      assert.equal(first.hasMore, true);
      const second = await p.changes(first.cursor, 10);
      assert.deepEqual(second.changes.map((c) => c.entry.path), ["/Feed/p2.txt", "/Feed/p3.txt", "/Feed/p4.txt"]);
      assert.equal(second.hasMore, false);
    });

    it("reports quota: used bytes cover what was written", async () => {
      const q = await p.quota();
      assert.ok(q.usedBytes >= "second version".length, `used ${q.usedBytes}`);
      assert.ok(q.limitBytes === null || q.limitBytes >= q.usedBytes);
    });

    if (opts.supportsQuotaLimit) {
      it("refuses a write that does not fit (quota_exceeded)", async () => {
        const big = h.sampleText("z".repeat(10_000_000));
        await expectCode(p.write("/Many/huge.txt", big), "quota_exceeded");
      });
    }
  });
}
