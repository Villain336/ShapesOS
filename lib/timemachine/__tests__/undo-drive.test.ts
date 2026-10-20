// ShapesOS — Phase 21B (WS=drive): "Undo this agent run" plans for Drive files (unit).
// What it CAN reverse: a file the run created (-> Trash), a file it replaced (-> the
// earlier version comes back as a new version), a file it moved (-> back where it was),
// a file it trashed (-> restored). What it CANNOT: anything not reported as touched.
// Run: npx tsx --test lib/timemachine/__tests__/undo-drive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planUndo } from "../undo";

const ev = (seq: number, tool: string, touched: unknown[]) => ({ runId: "r1", seq, createdAt: new Date(`2026-11-02T10:00:0${seq}Z`), payload: { kind: "tool_result", status: "executed", tool, touched } });
const kinds = (tool: string) => (tool.startsWith("share") ? "publish" : "publish");

describe("planUndo for Drive files", () => {
  it("classifies create / update / move / trash as revertible with what is needed to revert them", () => {
    const plan = planUndo({
      runId: "r1",
      runIds: ["r1"],
      sites: [],
      toolKind: kinds,
      events: [
        ev(1, "save_drive_file", [{ kind: "drive_file", id: "f1", op: "create", before: { version: 1, path: "/agents/r1/a.md" } }]),
        ev(2, "replace_drive_file", [{ kind: "drive_file", id: "f2", op: "update", before: { version: 2, path: "/shared/R/b.md", writtenVersion: 3 } }]),
        ev(3, "move_drive_file", [{ kind: "drive_file", id: "f3", op: "move", before: { path: "/shared/R/c.md", movedTo: "/shared/R/d.md" } }]),
        ev(4, "trash_drive_file", [{ kind: "drive_file", id: "f4", op: "trash", before: { path: "/shared/R/e.md" } }]),
      ],
    });
    assert.deepEqual(plan.items.map((i) => [i.kind, i.revertible]), [["drive_create", true], ["drive_update", true], ["drive_move", true], ["drive_trash", true]]);
    assert.equal(plan.revertible, 4);
    assert.deepEqual(plan.items[1]!.ref?.before, { version: 2, path: "/shared/R/b.md", writtenVersion: 3 });
  });

  it("a Drive write with no record of what it changed is listed as unknown, never guessed", () => {
    const plan = planUndo({ runId: "r1", runIds: ["r1"], sites: [], toolKind: kinds, events: [ev(1, "save_drive_file", [])] });
    assert.deepEqual(plan.items.map((i) => [i.kind, i.revertible, i.reason]), [["unknown", false, "unknown"]]);
  });

  it("a trash-many call yields one revertible item per file", () => {
    const plan = planUndo({
      runId: "r1",
      runIds: ["r1"],
      sites: [],
      toolKind: kinds,
      events: [ev(1, "trash_many_drive_files", ["a", "b", "c"].map((x) => ({ kind: "drive_file", id: x, op: "trash", before: { path: `/shared/${x}.md` } })))],
    });
    assert.equal(plan.items.length, 3);
    assert.ok(plan.items.every((i) => i.kind === "drive_trash" && i.revertible));
  });
});
