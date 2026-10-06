// ShapesOS — Phase 18.2 (WS=content): Notes, pure parts (unit).
// Run: npx tsx --test lib/notes/__tests__/notes.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_MAX_BYTES,
  deriveNoteTitle,
  emptyNoteDoc,
  normalizeFolder,
  normalizeTags,
  noteText,
  textToNoteDoc,
  validateNoteDoc,
} from "../content";
import { canDeleteNote, canEditNote, canReadNote, canShareNote, normalizeLinks } from "../service";
import { recordHref } from "../links";
import { RECORD_KINDS } from "@/lib/search/kinds";
import { NOTE_TOOLS, create_note, read_note } from "../tools";
import { TOOL_ACTION, TOOL_GROUP, getTool } from "@/lib/chat/tools";
import { evaluateTier, TIER1_KINDS } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";
import { shouldSnapshotBeforeSave, shouldSnapshotLive, AUTO_SNAPSHOT_IDLE_MS, AUTO_SNAPSHOT_EVERY_MS } from "@/lib/univer/versions";

describe("note content", () => {
  it("validates the Tiptap document shape and refuses junk", () => {
    assert.equal(validateNoteDoc(emptyNoteDoc()).ok, true);
    assert.equal(validateNoteDoc(null).ok, false);
    assert.equal(validateNoteDoc({ type: "paragraph", content: [] }).ok, false);
    assert.equal(validateNoteDoc({ type: "doc" }).ok, false);
    assert.equal(validateNoteDoc({ type: "doc", content: [{ type: "<script>" }] }).ok, false);
    assert.equal(validateNoteDoc({ type: "doc", content: [{ type: "paragraph", text: 5 }] }).ok, false);
    let deep: Record<string, unknown> = { type: "paragraph" };
    for (let i = 0; i < 60; i++) deep = { type: "blockquote", content: [deep] };
    assert.equal(validateNoteDoc({ type: "doc", content: [deep] }).ok, false, "too deep");
    const big = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(NOTE_MAX_BYTES) }] }] };
    assert.equal(validateNoteDoc(big).ok, false, "too large");
  });

  it("turns light Markdown into blocks and back into text", () => {
    const doc = textToNoteDoc("# Sync\n- ship Friday\n- tell Ana\n[ ] draft the post\n[x] book the room\n1. one\n2. two\n> quoted\n---\nplain line");
    assert.equal(validateNoteDoc(doc).ok, true);
    const types = doc.content.map((n) => n.type);
    assert.deepEqual(types, ["heading", "bulletList", "taskList", "orderedList", "blockquote", "horizontalRule", "paragraph"]);
    const text = noteText(doc);
    assert.match(text, /^# Sync/);
    assert.match(text, /- ship Friday/);
    assert.match(text, /\[ \] draft the post/);
    assert.match(text, /\[x\] book the room/);
    assert.match(text, /2\. two/);
    assert.match(text, /plain line$/);
    assert.deepEqual(textToNoteDoc(""), emptyNoteDoc());
    assert.equal(noteText({ nope: true }), "", "invalid docs have no text");
  });

  it("derives a title from the first meaningful line", () => {
    assert.equal(deriveNoteTitle("\n\n# Weekly sync\nbody"), "Weekly sync");
    assert.equal(deriveNoteTitle("- [ ] call Bob"), "call Bob");
    assert.equal(deriveNoteTitle(""), "Untitled note");
    assert.equal(deriveNoteTitle("x".repeat(200)).length, 80);
  });

  it("normalizes tags and folders", () => {
    assert.deepEqual(normalizeTags(["#Ideas", "ideas", " Big Plans ", "", "<x>"]), ["ideas", "big-plans"]);
    assert.deepEqual(normalizeTags("a, b ,c"), ["a", "b", "c"]);
    assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 12);
    assert.equal(normalizeFolder("  Client / Acme  "), "Client Acme");
    assert.equal(normalizeFolder("   "), null);
    assert.equal(normalizeFolder(7), null);
  });
});

describe("note permissions", () => {
  const mine = { shareState: "private", createdBy: "u1" };
  const shared = { shareState: "workspace", createdBy: "u1" };
  it("a private note is its maker's alone, whatever the role", () => {
    assert.equal(canReadNote(mine, { userId: "u1" }), true);
    assert.equal(canReadNote(mine, { userId: "u2" }), false);
    assert.equal(canEditNote(mine, { userId: "u2", role: "owner" }), false);
    assert.equal(canDeleteNote(mine, { userId: "u2", role: "owner" }), false);
  });
  it("a shared note: everyone reads, editors edit, admins delete, the maker always can", () => {
    assert.equal(canReadNote(shared, { userId: "u2" }), true);
    assert.equal(canEditNote(shared, { userId: "u2", role: "viewer" }), false);
    assert.equal(canEditNote(shared, { userId: "u2", role: "editor" }), true);
    assert.equal(canDeleteNote(shared, { userId: "u2", role: "editor" }), false);
    assert.equal(canDeleteNote(shared, { userId: "u2", role: "admin" }), true);
    assert.equal(canEditNote(shared, { userId: "u1", role: "viewer" }), true);
  });
  it("sharing with the workspace is the maker at editor+, or an admin", () => {
    assert.equal(canShareNote(mine, { userId: "u1", role: "viewer" }), false);
    assert.equal(canShareNote(mine, { userId: "u1", role: "editor" }), true);
    assert.equal(canShareNote(mine, { userId: "u2", role: "editor" }), false);
    assert.equal(canShareNote(mine, { userId: "u2", role: "admin" }), true);
  });
});

describe("note links", () => {
  it("accepts known record kinds and safe ids only, deduplicated", () => {
    assert.deepEqual(normalizeLinks([{ kind: "deal", id: "d1", label: "  Acme  renewal " }, { kind: "deal", id: "d1" }]), [{ kind: "deal", id: "d1", label: "Acme renewal" }]);
    assert.throws(() => normalizeLinks([{ kind: "users", id: "x" }]), /Unknown record kind/);
    assert.throws(() => normalizeLinks([{ kind: "lead", id: "a b" }]), /record id/);
    assert.throws(() => normalizeLinks([{ kind: "mail", id: "t1", label: "Re: salary" }]), /personal/, "a member's own mail threads never link to a (shareable) note");
    assert.throws(() => normalizeLinks(Array.from({ length: 26 }, (_, i) => ({ kind: "lead", id: `l${i}` }))), /at most 25/);
  });
  it("every record kind opens somewhere real", () => {
    for (const k of RECORD_KINDS) assert.match(recordHref(k, "abc"), /^\/dashboard/, k);
    assert.equal(recordHref("note", "n1"), "/dashboard/notes?note=n1");
    assert.equal(recordHref("file", "f1"), "/dashboard/files?file=f1");
  });
});

describe("version snapshots", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("keeps the old state only after an idle gap, once", () => {
    const fresh = new Date(now.getTime() - AUTO_SNAPSHOT_IDLE_MS + 1000);
    const idle = new Date(now.getTime() - AUTO_SNAPSHOT_IDLE_MS - 1000);
    assert.equal(shouldSnapshotBeforeSave({ updatedAt: fresh, lastVersionAt: null, now }), false);
    assert.equal(shouldSnapshotBeforeSave({ updatedAt: idle, lastVersionAt: null, now }), true);
    assert.equal(shouldSnapshotBeforeSave({ updatedAt: idle, lastVersionAt: new Date(idle.getTime() + 1), now }), false, "already kept");
    assert.equal(shouldSnapshotLive({ lastVersionAt: null, now }), true);
    assert.equal(shouldSnapshotLive({ lastVersionAt: new Date(now.getTime() - AUTO_SNAPSHOT_EVERY_MS + 1000), now }), false);
  });
});

describe("notes agent tools", () => {
  it("are registered with deliberate groups and tiers", () => {
    assert.equal(getTool("read_note"), read_note);
    assert.equal(getTool("create_note"), create_note);
    assert.equal(NOTE_TOOLS.length, 2);
    assert.equal(read_note.kind, "safe");
    assert.equal(TOOL_GROUP.read_note, "workspace");
    assert.equal(create_note.kind, "publish");
    assert.equal(TOOL_GROUP.create_note, "content");
    assert.equal(TOOL_ACTION.create_note, "write_internal_note");
    assert.ok(TIER1_KINDS.has("write_internal_note"));
    const auto = { smallActionThresholdCents: 10_000, automationAllows: true };
    const ask = { smallActionThresholdCents: 10_000, automationAllows: false };
    assert.equal(evaluateTier({ kind: "write_internal_note", description: `create_note: ${create_note.description}` }, auto), 1);
    assert.equal(evaluateTier({ kind: "write_internal_note", description: `create_note: ${create_note.description}` }, ask), 2, "asks without a rule");
    assert.equal(evaluateTier({ kind: "read_note", description: `read_note: ${read_note.description}` }, ask), 0);
    assert.ok(KNOWN_ACTIONS.some((a) => a.action === "write_internal_note"));
  });
});
