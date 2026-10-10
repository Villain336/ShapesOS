// ShapesOS — Phase 21B (WS=drive): the Google Drive provider against a MOCK of the
// Drive API (not Google: real behaviour is UNVERIFIED-LIVE), through the same
// contract suite as every provider, plus the Google-specific cases.
// Run: npx tsx --test lib/drive/providers/__tests__/google-drive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoogleDriveProvider } from "../google-drive";
import { ProviderError, collect } from "../types";
import { MockDriveApi } from "./mock-drive-api";
import { runProviderContract } from "./contract-suite";

const publicResolve = async () => ["142.250.80.46"];
function setup(scope: "full" | "readonly" = "full") {
  const api = new MockDriveApi();
  api.scope = scope;
  const provider = new GoogleDriveProvider({ token: "tok-123" }, { fetchImpl: api.fetchImpl, resolve: publicResolve, sleep: async () => {}, maxRetries: 0 }, "root");
  return { api, provider };
}

runProviderContract("google-drive (against a MOCK of the Drive API)", async () => ({ provider: setup().provider, sampleText: (s) => Buffer.from(s, "utf8") }));

describe("Google Drive provider specifics", () => {
  it("sends the bearer token on every call and never anything else as credentials", async () => {
    const { api, provider } = setup();
    await provider.mkdir("/A");
    await provider.write("/A/x.txt", Buffer.from("x"));
    assert.ok(api.calls.length > 0);
    assert.ok(api.calls.every((c) => c.auth === "Bearer tok-123"));
  });

  it("with the read-only grant, writes fail as forbidden and reads still work", async () => {
    const { api, provider } = setup("readonly");
    api.create("Existing.txt", "text/plain", ["root"], Buffer.from("hi"));
    assert.deepEqual((await provider.list("/")).entries.map((e) => e.name), ["Existing.txt"]);
    await assert.rejects(() => provider.mkdir("/New"), (e: unknown) => e instanceof ProviderError && e.code === "forbidden");
    await assert.rejects(() => provider.write("/n.txt", Buffer.from("n")), (e: unknown) => e instanceof ProviderError && e.code === "forbidden");
    assert.equal((await collect(await provider.read("/Existing.txt"))).toString(), "hi");
  });

  it("refuses an ambiguous name instead of guessing (Drive allows two items with one name)", async () => {
    const { api, provider } = setup();
    api.create("Dup", "application/vnd.google-apps.folder", ["root"], null);
    api.create("dup", "application/vnd.google-apps.folder", ["root"], null);
    await assert.rejects(() => provider.stat("/Dup"), (e: unknown) => e instanceof ProviderError && e.code === "conflict" && /more than one/.test(e.message));
  });

  it("lists Google-native documents but cannot read them as bytes", async () => {
    const { api, provider } = setup();
    api.create("Brief", "application/vnd.google-apps.document", ["root"], null);
    const e = (await provider.list("/")).entries[0]!;
    assert.deepEqual([e.name, e.kind], ["Brief", "file"]);
    await assert.rejects(async () => collect(await provider.read("/Brief")), (err: unknown) => err instanceof ProviderError && err.code === "unsupported");
  });

  it("files over 5 MB are unsupported (no resumable upload yet), said plainly", async () => {
    const { provider } = setup();
    await assert.rejects(() => provider.write("/big.pdf", Buffer.alloc(5 * 1024 * 1024 + 1)), (e: unknown) => e instanceof ProviderError && e.code === "unsupported" && /5 MB/.test(e.message));
  });

  it("changes made by someone else show up as creates/updates/trash with the right paths", async () => {
    const { api, provider } = setup();
    const folder = api.create("Shared", "application/vnd.google-apps.folder", ["root"], null);
    const start = await provider.changes(null);
    const file = api.create("note.txt", "text/plain", [folder.id], Buffer.from("n"));
    const first = await provider.changes(start.cursor);
    assert.deepEqual(first.changes.map((c) => [c.type, c.entry.path]), [["create", "/Shared/note.txt"]]);
    file.name = "renamed.txt";
    file.changeSeq = ++api.seq;
    const second = await provider.changes(first.cursor);
    assert.deepEqual(second.changes.map((c) => [c.type, c.entry.path, c.prevPath]), [["move", "/Shared/renamed.txt", "/Shared/note.txt"]]);
    // A change outside the root folder is not reported.
    const other = new GoogleDriveProvider({ token: "t" }, { fetchImpl: api.fetchImpl, resolve: publicResolve, sleep: async () => {}, maxRetries: 0 }, folder.id);
    const s2 = await other.changes(null);
    api.create("elsewhere.txt", "text/plain", ["root"], Buffer.from("e"));
    assert.deepEqual((await other.changes(s2.cursor)).changes, []);
  });
});
