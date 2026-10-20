// ShapesOS — Phase 21B (WS=drive): "restore this folder as of <time>" planner (unit).
// Run: npx tsx --test lib/drive/__tests__/restore-plan.test.ts
//
// Worked example (all times 2026-11-01 UTC). Folder /shared/Plans, asOf = 12:00.
//   a.md  v1 written 09:00, v2 at 11:00, v3 at 13:00 (current)  -> as of 12:00 it was v2: restore v2
//   b.md  v1 09:00, current, untouched                          -> unchanged
//   c.md  created 14:00                                         -> did not exist: left alone, never deleted
//   d.md  v1 09:00, trashed at 13:00                            -> was live at noon: bring it back
//   e.md  v1 09:00, v2 10:00 current but v1 purged by retention -> as of 12:00 was v2 == current: unchanged
//   f.md  v1 09:00 purged, v2 at 13:00 current                  -> noon bytes are gone: unavailable
//   g.md  trashed at 10:00 (still trashed)                      -> was in the trash at noon: left alone
//   h.md  currently in /shared/Archive, moved there at 13:00    -> was in Plans at noon: restore bytes where it is now
//   i.md  currently /shared/Plans/i.md, live path now taken     -> untrash would collide: conflict

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planRestoreAsOf, type RestoreFileFacts } from "../restore-plan";

const T = (hhmm: string) => new Date(`2026-11-01T${hhmm}:00Z`);
const asOf = T("12:00");

const base = { folder: "/shared/Plans", asOf };
const file = (over: Partial<RestoreFileFacts> & { id: string }): RestoreFileFacts => ({
  currentPath: `/shared/Plans/${over.id}.md`,
  createdAt: T("09:00"),
  currentVersion: 1,
  trashedNow: false,
  trashedAsOf: false,
  movedAfter: [],
  livePathTaken: false,
  versions: [{ version: 1, from: T("09:00"), until: null }],
  ...over,
});

const facts: RestoreFileFacts[] = [
  file({ id: "a", currentVersion: 3, versions: [{ version: 1, from: T("09:00"), until: T("11:00") }, { version: 2, from: T("11:00"), until: T("13:00") }, { version: 3, from: T("13:00"), until: null }] }),
  file({ id: "b" }),
  file({ id: "c", createdAt: T("14:00"), versions: [{ version: 1, from: T("14:00"), until: null }] }),
  file({ id: "d", trashedNow: true }),
  file({ id: "e", currentVersion: 2, versions: [{ version: 2, from: T("10:00"), until: null }] }),
  file({ id: "f", currentVersion: 2, versions: [{ version: 2, from: T("13:00"), until: null }] }),
  file({ id: "g", trashedNow: true, trashedAsOf: true }),
  file({ id: "h", currentPath: "/shared/Archive/h.md", movedAfter: [{ at: T("13:00"), fromPath: "/shared/Plans/h.md" }] }),
  file({ id: "i", trashedNow: true, livePathTaken: true }),
  file({ id: "z", currentPath: "/shared/Other/z.md" }),
];

describe("planRestoreAsOf", () => {
  const plan = planRestoreAsOf({ ...base, files: facts });
  const by = (id: string) => plan.items.find((i) => i.fileId === id);

  it("restores the version that was current at the time, as a new version", () => {
    assert.deepEqual(by("a"), { fileId: "a", path: "/shared/Plans/a.md", action: "restore_version", toVersion: 2, untrash: false, movedFrom: null, reason: null });
  });
  it("leaves unchanged files alone", () => {
    assert.equal(by("b")!.action, "unchanged");
    assert.equal(by("e")!.action, "unchanged");
  });
  it("never deletes: files that did not exist yet are left", () => {
    assert.equal(by("c")!.action, "skip_created_after");
  });
  it("brings back a file that was live then and is in the trash now", () => {
    assert.deepEqual(by("d"), { fileId: "d", path: "/shared/Plans/d.md", action: "untrash", toVersion: null, untrash: true, movedFrom: null, reason: null });
  });
  it("says so when the version history for that moment was purged", () => {
    const f = by("f")!;
    assert.equal(f.action, "unavailable");
    assert.match(f.reason!, /history/i);
  });
  it("leaves files that were already in the trash at that time", () => {
    assert.equal(by("g")!.action, "skip_trashed_then");
  });
  it("includes a file that lived in the folder then, reporting where it is now", () => {
    const h = by("h")!;
    assert.equal(h.path, "/shared/Archive/h.md");
    assert.equal(h.movedFrom, "/shared/Plans/h.md");
    assert.equal(h.action, "unchanged");
  });
  it("reports a collision instead of overwriting a live file", () => {
    const i = by("i")!;
    assert.equal(i.action, "conflict");
    assert.match(i.reason!, /already/i);
  });
  it("ignores files that were never in the folder", () => {
    assert.equal(by("z"), undefined);
  });
  it("totals the plan", () => {
    assert.deepEqual(plan.summary, { restoreVersion: 1, untrash: 1, unchanged: 3, skipped: 2, unavailable: 1, conflicts: 1 });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.willDelete, 0, "a restore never deletes anything");
  });
  it("includes nested folders but not a sibling with the same prefix", () => {
    const nested = planRestoreAsOf({ ...base, files: [file({ id: "n", currentPath: "/shared/Plans/deep/er/n.md" }), file({ id: "s", currentPath: "/shared/Plans2/s.md" })] });
    assert.deepEqual(nested.items.map((i) => i.fileId), ["n"]);
  });
});
