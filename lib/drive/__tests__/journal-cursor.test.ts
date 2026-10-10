// ShapesOS — Phase 21B (WS=drive): change-journal cursor and privacy (unit).
// Run: npx tsx --test lib/drive/__tests__/journal-cursor.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CursorError, formatCursor, parseCursor, redactChange, type DriveChange } from "../journal";

const change = (over: Partial<DriveChange> = {}): DriveChange => ({
  seq: 7n,
  type: "create",
  entity: "file",
  entityId: "f1",
  path: "/shared/a.txt",
  prevPath: null,
  version: 1,
  actorUserId: "u1",
  at: "2026-11-01T10:00:00.000Z",
  ...over,
});

describe("cursor", () => {
  it("formats as an opaque versioned token and parses back", () => {
    assert.equal(formatCursor(0n), "v1.0");
    assert.equal(formatCursor(123456789012n), "v1.123456789012");
    assert.equal(parseCursor("v1.42"), 42n);
  });
  it("starts from the beginning when there is no cursor", () => {
    assert.equal(parseCursor(null), 0n);
    assert.equal(parseCursor(""), 0n);
    assert.equal(parseCursor(undefined), 0n);
  });
  it("refuses anything that is not a cursor we issued", () => {
    for (const bad of ["42", "v2.1", "v1.-1", "v1.1.2", "v1.abc", "v1.", "v1. 5", "v1.0x10"]) {
      assert.throws(() => parseCursor(bad), CursorError, bad);
    }
  });
});

describe("redactChange: private homes in the feed", () => {
  it("shows a change in a person's home to that person only", () => {
    const c = change({ path: "/home/u1/a.txt" });
    assert.deepEqual(redactChange(c, "u1"), c);
    assert.equal(redactChange(c, "u2"), null);
  });
  it("hides the private side of a move between a home and the shared area", () => {
    const out = change({ type: "move", path: "/shared/a.txt", prevPath: "/home/u1/a.txt" });
    assert.equal(redactChange(out, "u2")!.prevPath, null, "others see it appear in /shared, not where it came from");
    assert.equal(redactChange(out, "u1")!.prevPath, "/home/u1/a.txt");
    const into = change({ type: "move", path: "/home/u1/a.txt", prevPath: "/shared/a.txt" });
    const seen = redactChange(into, "u2")!;
    assert.equal(seen.type, "delete", "to everyone else it left the shared area");
    assert.equal(seen.path, "/shared/a.txt");
    assert.equal(seen.prevPath, null);
  });
  it("leaves ordinary changes alone", () => {
    const c = change();
    assert.deepEqual(redactChange(c, "u9"), c);
  });
});
