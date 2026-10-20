// ShapesOS — Phase 18.2 (WS=content): Notes against real Postgres.
//   - createNote (THE server API) writes univer_docs kind "note" + links;
//     private = its maker only, shared = every member; edit/delete rules
//   - note links: a record's notes; another workspace never; FORCE RLS on
//     note_links / univer_doc_versions / univer_doc_collab_states (fail-closed)
//   - version history: idle snapshot before an overwrite, named versions,
//     restore = the current state kept + a new version, collab state dropped
//   - optimistic concurrency: a stale expectedVersion is refused (409)
//   - Spotlight kind "note": found by a word inside, private notes only for
//     their maker, never through Office docs / file contents; Office never
//     lists notes; the agents' read_note / create_note / search_workspace
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/notes/__tests__/notes-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.SPOTLIGHT_INDEX_ON_WRITE = "off"; // indexed explicitly below (no background race)

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { createNote, deleteNote, getNote, linkNote, listNotes, unlinkNote, updateNote, type NoteActor } from "../service";
import { textToNoteDoc } from "../content";
import { listDocVersions, restoreDocVersion, saveNamedVersion } from "@/lib/univer/versions";
import { indexUniverDocText } from "@/lib/search/text-index";
import { spotlight } from "@/lib/search/records";
import { search_workspace } from "@/lib/search/tool";
import { listUniverDocs, getUniverDoc } from "@/lib/univer/docs";
import { create_note, read_note } from "../tools";
import type { ToolContext } from "@/lib/chat/tools";

const RUN = randomUUID().slice(0, 8);
const WS = `p182n-${RUN}`;
const OTHER = `p182n-o-${RUN}`;
const ANA = `p182n-ana-${RUN}`;
const BEN = `p182n-ben-${RUN}`;
const VIC = `p182n-vic-${RUN}`;

const ana: NoteActor = { workspaceId: WS, userId: ANA, role: "editor" };
const ben: NoteActor = { workspaceId: WS, userId: BEN, role: "editor" };
const vic: NoteActor = { workspaceId: WS, userId: VIC, role: "viewer" };
const admin: NoteActor = { workspaceId: WS, userId: `p182n-adm-${RUN}`, role: "admin" };

function toolCtx(userId: string, role: ToolContext["role"]): ToolContext {
  return { projectId: "none", workspaceId: WS, userId, role, confirmed: true };
}

before(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: BEN } });
});

after(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Notes (DB)", () => {
  let privateId = "";
  let sharedId = "";

  it("createNote writes a note (kind note) with links; private is its maker's alone", async () => {
    const priv = await createNote({ workspaceId: WS, createdBy: ANA, body: "# Gift ideas\n- a lantern of zircophane\n[ ] wrap it", tags: ["Home"], folder: "Personal" });
    privateId = priv.id;
    assert.equal(priv.title, "Gift ideas", "title from the first line");
    assert.equal(priv.shareState, "private");
    assert.deepEqual(priv.tags, ["home"]);
    assert.equal(priv.folder, "Personal");
    const row = await withWorkspaceScope(WS, (tx) => tx.univerDoc.findFirst({ where: { id: priv.id, workspaceId: WS } }));
    assert.equal(row?.kind, "note");
    assert.equal(row?.createdBy, ANA);

    const shared = await createNote({
      workspaceId: WS,
      createdBy: ANA,
      title: "Acme renewal call",
      body: "Decisions: renew for two years. Codeword quellwort.",
      shareState: "workspace",
      links: [{ kind: "deal", id: "deal-acme", label: "Acme renewal" }, { kind: "lead", id: "lead-1" }],
      sourceRef: "meet:m1",
    });
    sharedId = shared.id;
    assert.equal(shared.links.length, 2);
    assert.equal(shared.sourceRef, "meet:m1");

    assert.equal(await getNote(ben, privateId), null, "a teammate never sees a private note");
    assert.ok(await getNote(ben, sharedId), "a teammate sees a shared note");
    assert.ok(await getNote(ana, privateId));
    const benList = await listNotes(ben);
    assert.ok(benList.some((n) => n.id === sharedId) && !benList.some((n) => n.id === privateId));
  });

  it("edit and delete rules: viewer reads only; editor edits shared; only the maker or an admin deletes", async () => {
    await assert.rejects(updateNote(vic, sharedId, { title: "Hijacked" }), /read this note but not change it/);
    const byBen = await updateNote(ben, sharedId, { tags: ["clients"] });
    assert.deepEqual(byBen.tags, ["clients"]);
    await assert.rejects(updateNote(ben, privateId, { title: "x" }), /not found/i, "a private note is invisible, not forbidden");
    await assert.rejects(updateNote(ben, sharedId, { shareState: "private" }), /maker/, "only the maker (or an admin) changes who sees it");
    await assert.rejects(deleteNote(ben, sharedId), /maker or an admin/);
    const temp = await createNote({ workspaceId: WS, createdBy: BEN, body: "temp", shareState: "workspace" });
    await deleteNote(admin, temp.id);
    assert.equal(await getNote(ben, temp.id), null);
  });

  it("links: a record lists its notes; another workspace's notes never; links RLS is fail-closed", async () => {
    const forDeal = await listNotes(ben, { record: { kind: "deal", id: "deal-acme" } });
    assert.deepEqual(forDeal.map((n) => n.id), [sharedId]);
    const otherNote = await createNote({ workspaceId: OTHER, createdBy: BEN, body: "theirs", shareState: "workspace", links: [{ kind: "deal", id: "deal-acme" }] });
    assert.ok(!(await listNotes(ben, { record: { kind: "deal", id: "deal-acme" } })).some((n) => n.id === otherNote.id));
    assert.equal(await getNote(ben, otherNote.id), null, "another workspace's note is not found");
    await linkNote(ana, privateId, { kind: "project", id: "proj-1", label: "Site" });
    const unlinked = await unlinkNote(ana, privateId, "project", "proj-1");
    assert.equal(unlinked.links.length, 0);
    await assert.rejects(linkNote(ana, privateId, { kind: "nope", id: "x" }), /Unknown record kind/);
    for (const table of ["note_links", "univer_doc_versions", "univer_doc_collab_states"]) {
      assert.equal(await countWithoutScope(table), 0, `${table}: zero rows without the tenant GUC`);
    }
    const otherSees = await withWorkspaceScope(OTHER, (tx) => tx.noteLink.count({ where: { workspaceId: WS } }));
    assert.equal(otherSees, 0, "RLS hides another workspace's links even when asked for them");
  });

  it("optimistic concurrency: a stale version is refused", async () => {
    const n = await getNote(ana, sharedId);
    const saved = await updateNote(ana, sharedId, { content: textToNoteDoc("Decisions: renew for two years. Codeword quellwort. Also: invoice monthly."), expectedVersion: n!.version });
    assert.equal(saved.version, n!.version + 1);
    await assert.rejects(updateNote(ben, sharedId, { content: textToNoteDoc("stale"), expectedVersion: n!.version }), /changed since you opened it/);
  });

  it("version history: idle snapshot before an overwrite, a named version, restore keeps the current state", async () => {
    // The note sat idle for an hour → the next save keeps how it was.
    await withWorkspaceScope(WS, (tx) => tx.$executeRaw`UPDATE univer_docs SET updated_at = now() - interval '1 hour' WHERE id = ${sharedId} AND workspace_id = ${WS}`);
    const before = await getNote(ana, sharedId);
    await updateNote(ana, sharedId, { content: textToNoteDoc("Rewritten completely."), expectedVersion: before!.version });
    let versions = await listDocVersions(WS, sharedId);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.kind, "auto");
    assert.equal(versions[0]!.docVersion, before!.version);
    // A second save right away keeps nothing new (not idle).
    const mid = await getNote(ana, sharedId);
    await updateNote(ana, sharedId, { content: textToNoteDoc("Rewritten completely, twice."), expectedVersion: mid!.version });
    assert.equal((await listDocVersions(WS, sharedId)).length, 1);

    const named = await saveNamedVersion(WS, sharedId, "After the rewrite", ANA);
    assert.equal(named.kind, "named");
    // Live-collab state exists → a restore drops it so every editor reloads.
    await withWorkspaceScope(WS, (tx) => tx.univerDocCollabState.create({ data: { docId: sharedId, workspaceId: WS, state: Buffer.from([0, 0]) } }));
    const auto = versions[0]!;
    const cur = await getNote(ana, sharedId);
    const res = await restoreDocVersion(WS, sharedId, auto.id, ANA);
    assert.equal(res.version, cur!.version + 1);
    const restored = await getNote(ana, sharedId);
    assert.match(JSON.stringify(restored!.content), /invoice monthly/);
    versions = await listDocVersions(WS, sharedId);
    assert.deepEqual(versions.map((v) => v.kind).sort(), ["auto", "named", "restore"]);
    const collab = await withWorkspaceScope(WS, (tx) => tx.univerDocCollabState.count({ where: { workspaceId: WS, docId: sharedId } }));
    assert.equal(collab, 0);
    // Another workspace can't restore (or see) this doc's versions.
    await assert.rejects(restoreDocVersion(OTHER, sharedId, auto.id, BEN), /not found/i);
    assert.deepEqual(await listDocVersions(OTHER, sharedId), []);
  });

  it("Spotlight kind note: words inside, maker-only for private notes, never via Office or file contents", async () => {
    await indexUniverDocText(WS, privateId);
    await indexUniverDocText(WS, sharedId);
    const anaHits = (await spotlight(WS, "viewer", "zircophane", { userId: ANA })).hits;
    const hit = anaHits.find((h) => h.id === privateId);
    assert.ok(hit, `found: ${JSON.stringify(anaHits.map((h) => [h.kind, h.title]))}`);
    assert.equal(hit.kind, "note");
    assert.equal(hit.href, `/dashboard/notes?note=${privateId}`);
    assert.match(hit.snippet ?? "", /⟦zircophane⟧/);
    assert.ok(!anaHits.some((h) => h.kind === "file_content" || h.kind === "doc"), "notes never show as Office docs or file contents");
    const benHits = (await spotlight(WS, "viewer", "zircophane", { userId: BEN })).hits;
    assert.ok(!benHits.some((h) => h.id === privateId), "a teammate never finds a private note");
    assert.ok((await spotlight(WS, "viewer", "invoice monthly", { userId: BEN })).hits.some((h) => h.id === sharedId), "a shared note is found by the words inside");
    assert.ok((await spotlight(WS, "viewer", "Acme renewal call", { userId: BEN })).hits.some((h) => h.id === sharedId && h.match.includes("name")));
    // Office never lists or opens a note.
    assert.ok(!(await listUniverDocs(WS)).some((d) => d.id === sharedId));
    assert.equal(await getUniverDoc(WS, sharedId), null);
  });

  it("agents: create_note (as the person), read_note, and search_workspace reading a note", async () => {
    const made = await create_note.execute(toolCtx(BEN, "editor"), { body: "Follow up with Orla about the kelpwire quote", links: ["deal:deal-acme"], tags: "sales, followups" });
    assert.match(made.summary, /Saved the note/);
    const id = (made.details as { note: { id: string } }).note.id;
    const note = await getNote(ben, id);
    assert.equal(note?.createdBy, BEN);
    assert.equal(note?.shareState, "private");
    assert.deepEqual(note?.tags, ["sales", "followups"]);
    assert.match(note?.sourceRef ?? "", /^agent/);
    const viewerShare = await create_note.execute(toolCtx(VIC, "viewer"), { body: "x", share: "workspace" });
    assert.match(viewerShare.summary, /needs the editor role/);
    const read = await read_note.execute(toolCtx(BEN, "editor"), { note: `note:${id}` });
    assert.match(read.summary, /kelpwire/);
    assert.match(read.summary, /linked to deal:deal-acme/);
    const denied = await read_note.execute(toolCtx(BEN, "editor"), { note: privateId });
    assert.match(denied.summary, /No note/, "an agent working for Ben can't read Ana's private note");
    const viaSearch = await search_workspace.execute(toolCtx(ANA, "viewer"), { record: `note:${privateId}` });
    assert.match(viaSearch.summary, /zircophane/);
    // Integration: asking for the private note as an Office doc or as file
    // content goes through the note's rule too (no back door for Ben's agent).
    for (const as of ["doc", "file_content"]) {
      const sneaky = await search_workspace.execute(toolCtx(BEN, "editor"), { record: `${as}:${privateId}` });
      assert.doesNotMatch(sneaky.summary, /zircophane/, `${as}: never Ana's private note`);
      assert.match(sneaky.summary, /No note/);
    }
    assert.match((await search_workspace.execute(toolCtx(ANA, "viewer"), { record: `doc:${privateId}` })).summary, /zircophane/, "its maker still reads it");
  });
});
