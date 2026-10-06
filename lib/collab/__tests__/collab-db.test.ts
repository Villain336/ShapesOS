// ShapesOS — Phase 18.2 (WS=content): live collaboration end to end against
// real Postgres and a real Hocuspocus server (lib/collab/server.ts) with two
// real HocuspocusProvider clients over WebSocket (Node's built-in WebSocket).
//   - first open seeds the yjs document from the note's JSON snapshot
//   - an editor's change reaches the other client; the store writes the yjs
//     state AND the JSON snapshot back to univer_docs (version + 1)
//   - a viewer's token makes the connection read-only ON THE SERVER: its
//     local edits never reach anyone and are never stored
//   - a forged token, an expired token and a token for another document are
//     refused; persistence round-trip across a server restart
//   - a version restore underneath a live document resets every editor
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/collab/__tests__/collab-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.SPOTLIGHT_INDEX_ON_WRITE = "off";

import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createNote, getNote } from "@/lib/notes/service";
import { noteText } from "@/lib/notes/content";
import { NOTE_YJS_FIELD } from "@/lib/notes/schema";
import { listDocVersions, restoreDocVersion, saveNamedVersion } from "@/lib/univer/versions";
import { signCollabToken } from "../token";
import { collabDocJson } from "../persistence";
import { startCollabServer, type CollabServerHandle } from "../server";

const RUN = randomUUID().slice(0, 8);
const WS = `p182c-${RUN}`;
const ANA = `p182c-ana-${RUN}`;
const VIC = `p182c-vic-${RUN}`;
const SECRET = "p182-collab-test-secret-0123456789";

let srv: CollabServerHandle;
let noteId = "";
const clients: Array<{ provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; doc: Y.Doc }> = [];

function token(uid: string, role: "write" | "read", doc = `note:${noteId}`, exp?: number) {
  return signCollabToken({ ws: WS, doc, uid, role, name: uid, color: "var(--aos-ink)", ...(exp ? { exp } : {}) }, SECRET);
}

function connect(tok: string, name = `note:${noteId}`) {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${srv.port}`, maxAttempts: 1 });
  const events = { failed: false, reset: false };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token: tok,
    onAuthenticationFailed: () => {
      events.failed = true;
    },
    onStateless: ({ payload }) => {
      if (JSON.parse(payload).type === "reset") events.reset = true;
    },
  });
  provider.attach();
  const c = { provider, socket, doc };
  clients.push(c);
  return { ...c, events };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function textOf(doc: Y.Doc): string {
  return noteText(collabDocJson(doc));
}

function appendParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(NOTE_YJS_FIELD).push([p]);
}

async function snapshotText(): Promise<string> {
  const row = await withWorkspaceScope(WS, (tx) => tx.univerDoc.findFirst({ where: { id: noteId, workspaceId: WS }, select: { snapshot: true } }));
  return noteText(row?.snapshot);
}

function closeClients() {
  for (const c of clients.splice(0)) {
    c.provider.destroy();
    c.socket.destroy();
  }
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  const n = await createNote({ workspaceId: WS, createdBy: ANA, body: "Seed line written before live editing", shareState: "workspace" });
  noteId = n.id;
  srv = await startCollabServer({ port: 0, host: "127.0.0.1", secret: SECRET, pollMs: 60_000, log: () => undefined });
});

after(async () => {
  closeClients();
  await srv?.close().catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("live collaboration (DB + Hocuspocus)", () => {
  it("seeds from the note, syncs an editor's change to the other client, and stores state + snapshot", async () => {
    const a = connect(token(ANA, "write"));
    const v = connect(token(VIC, "read"));
    await until(() => a.provider.isSynced && v.provider.isSynced, 8000, "both synced");
    assert.match(textOf(a.doc), /Seed line written before live editing/, "seeded from the JSON snapshot");
    const before = await getNote({ workspaceId: WS, userId: ANA, role: "editor" }, noteId);
    appendParagraph(a.doc, "Ana types live");
    await until(() => /Ana types live/.test(textOf(v.doc)), 8000, "the viewer sees the editor's change");
    srv.server.hocuspocus.flushPendingStores();
    await until(async () => /Ana types live/.test(await snapshotText()), 8000, "snapshot written back");
    const after = await getNote({ workspaceId: WS, userId: ANA, role: "editor" }, noteId);
    assert.equal(after!.version, before!.version + 1);
    const state = await withWorkspaceScope(WS, (tx) => tx.univerDocCollabState.findFirst({ where: { workspaceId: WS, docId: noteId } }));
    assert.ok(state && state.state.length > 0, "yjs state persisted");
  });

  it("a viewer's connection is read-only on the server: its edits reach no one and are never stored", async () => {
    const [a, v] = clients;
    appendParagraph(v!.doc, "Viewer sneaks a line");
    await new Promise((r) => setTimeout(r, 800));
    assert.doesNotMatch(textOf(a!.doc), /Viewer sneaks a line/);
    srv.server.hocuspocus.flushPendingStores();
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(await snapshotText(), /Viewer sneaks a line/);
  });

  it("refuses forged, expired and wrong-document tokens", async () => {
    const forged = connect(signCollabToken({ ws: WS, doc: `note:${noteId}`, uid: VIC, role: "write", name: "x", color: "x" }, "not-the-secret-0123456789"));
    await until(() => forged.events.failed, 8000, "forged token refused");
    const expired = connect(token(ANA, "write", `note:${noteId}`, Date.now() - 1000));
    await until(() => expired.events.failed, 8000, "expired token refused");
    const other = connect(token(ANA, "write", "note:someothernote"));
    const wrong = connect(token(ANA, "write", "note:someothernote"), `note:${noteId}`);
    await until(() => wrong.events.failed, 8000, "a token for another document refused");
    await until(() => other.events.failed || other.provider.isSynced === false, 3000, "unknown document");
    assert.equal(other.provider.isSynced, false, "a document that doesn't exist never loads");
  });

  it("persistence round-trip across a server restart", async () => {
    closeClients();
    await srv.close();
    srv = await startCollabServer({ port: 0, host: "127.0.0.1", secret: SECRET, pollMs: 60_000, log: () => undefined });
    const a = connect(token(ANA, "write"));
    await until(() => a.provider.isSynced, 8000, "synced after restart");
    assert.match(textOf(a.doc), /Ana types live/);
    assert.match(textOf(a.doc), /Seed line/);
    assert.doesNotMatch(textOf(a.doc), /Viewer sneaks/);
  });

  it("a version restore underneath a live note resets every editor, and the next load is the restored text", async () => {
    const a = clients[0]!;
    const named = await saveNamedVersion(WS, noteId, "Before more typing", ANA);
    appendParagraph(a.doc, "Typed after the named version");
    srv.server.hocuspocus.flushPendingStores();
    await until(async () => /Typed after the named version/.test(await snapshotText()), 8000, "stored");
    await restoreDocVersion(WS, noteId, named.id, ANA);
    const fresh = connect(token(ANA, "write"));
    const watcher = connect(token(VIC, "read"));
    await until(() => watcher.provider.isSynced, 8000, "watcher synced");
    await srv.pollOnce();
    await until(() => watcher.events.reset, 8000, "editors told to reload");
    fresh.provider.destroy();
    const reloaded = connect(token(ANA, "write"));
    await until(() => reloaded.provider.isSynced, 10_000, "reloaded");
    assert.doesNotMatch(textOf(reloaded.doc), /Typed after the named version/, "the restored text, not the stale live copy");
    assert.match(textOf(reloaded.doc), /Ana types live/);
    assert.doesNotMatch(await snapshotText(), /Typed after the named version/, "the stale copy was never stored over the restore");
    assert.ok((await listDocVersions(WS, noteId)).some((v) => v.kind === "restore"));
  });
});
