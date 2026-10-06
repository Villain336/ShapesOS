// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor's pure model
// (lib/aos/processes.ts) and the Terminal's pure command helpers
// (lib/terminal/service.ts checkCommand / checkCwd / wrapCommand / splitCwd).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { budgetUsed, canStopProcess, elapsedMs, formatCost, formatElapsed, orderProcesses, type ProcessRow } from "../processes";
import { checkCommand, checkCwd, splitCwd, wrapCommand, TERMINAL_COMMAND_MAX } from "@/lib/terminal/service";

function row(p: Partial<ProcessRow> & Pick<ProcessRow, "key">): ProcessRow {
  const [type, id] = p.key.split(":") as [ProcessRow["type"], string];
  return {
    type,
    id,
    title: id,
    subtitle: null,
    status: "running",
    state: "running",
    live: true,
    startedAt: "2026-10-06T10:00:00.000Z",
    endedAt: null,
    costMicroUsd: null,
    budget: null,
    startedBy: null,
    parentKey: null,
    href: null,
    stop: { allowed: true },
    ...p,
  };
}

describe("Activity Monitor model", () => {
  it("elapsed time runs to now while live and stops at the end", () => {
    const now = Date.parse("2026-10-06T10:03:12.000Z");
    assert.equal(elapsedMs(row({ key: "run:a" }), now), 192_000);
    assert.equal(elapsedMs(row({ key: "run:a", endedAt: "2026-10-06T10:00:45.000Z" }), now), 45_000);
    assert.equal(elapsedMs(row({ key: "run:a", startedAt: "2026-10-06T11:00:00.000Z" }), now), 0, "clock skew never goes negative");
  });

  it("formats elapsed time and cost compactly", () => {
    assert.equal(formatElapsed(45_400), "45s");
    assert.equal(formatElapsed(192_000), "3m 12s");
    assert.equal(formatElapsed(3_840_000), "1h 4m");
    assert.equal(formatCost(null), "—");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(3_000), "<$0.01");
    assert.equal(formatCost(420_000), "$0.42");
    assert.equal(formatCost(12_400_000), "$12");
  });

  it("budget used is the larger of cost and time, capped at 1", () => {
    const now = Date.parse("2026-10-06T10:05:00.000Z");
    const budget = { costMicroUsd: 1_000_000, ms: 20 * 60_000 };
    assert.equal(budgetUsed(row({ key: "run:a" }), now), null, "no budget → null");
    assert.equal(budgetUsed(row({ key: "run:a", budget, costMicroUsd: 500_000 }), now), 0.5);
    assert.equal(budgetUsed(row({ key: "run:a", budget, costMicroUsd: 10_000 }), now), 0.25, "time dominates");
    assert.equal(budgetUsed(row({ key: "run:a", budget, costMicroUsd: 9_000_000 }), now), 1);
  });

  it("orders live work first, newest first, sub-agents right under their lead", () => {
    const rows = [
      row({ key: "run:old", live: false, startedAt: "2026-10-06T09:00:00.000Z" }),
      row({ key: "run:child2", parentKey: "run:lead", startedAt: "2026-10-06T10:02:00.000Z" }),
      row({ key: "run:lead", startedAt: "2026-10-06T10:00:00.000Z" }),
      row({ key: "run:child1", parentKey: "run:lead", startedAt: "2026-10-06T10:01:00.000Z" }),
      row({ key: "sandbox:s1", parentKey: "run:child1", startedAt: "2026-10-06T10:01:30.000Z" }),
      row({ key: "job:j", startedAt: "2026-10-06T10:04:00.000Z" }),
      row({ key: "job:orphan", parentKey: "run:not-loaded", startedAt: "2026-10-06T08:00:00.000Z" }),
    ];
    assert.deepEqual(
      orderProcesses(rows).map((r) => r.key),
      ["job:j", "run:lead", "run:child1", "sandbox:s1", "run:child2", "job:orphan", "run:old"],
    );
  });

  it("Stop: the person who started it or an admin, only while live and stoppable", () => {
    const base = { live: true, stoppable: true, startedBy: "u1", viewerId: "u1", viewerIsAdmin: false };
    assert.deepEqual(canStopProcess(base), { allowed: true });
    assert.deepEqual(canStopProcess({ ...base, viewerId: "u2" }), { allowed: false, reason: "not_yours" });
    assert.deepEqual(canStopProcess({ ...base, viewerId: "u2", viewerIsAdmin: true }), { allowed: true });
    assert.deepEqual(canStopProcess({ ...base, startedBy: null, viewerId: "u2" }), { allowed: false, reason: "not_yours" }, "system work: admins only");
    assert.deepEqual(canStopProcess({ ...base, live: false, viewerIsAdmin: true }), { allowed: false, reason: "finished" });
    assert.deepEqual(canStopProcess({ ...base, stoppable: false, viewerIsAdmin: true }), { allowed: false, reason: "not_stoppable" });
  });
});

describe("Terminal command helpers", () => {
  it("accepts a command, normalises line endings, refuses empty / NUL / too long", () => {
    assert.equal(checkCommand("ls -la\r\n"), "ls -la\n");
    assert.throws(() => checkCommand("   "), /Type a command/);
    assert.throws(() => checkCommand(42), /command is text/);
    assert.throws(() => checkCommand("echo \u0000"), /NUL/);
    assert.throws(() => checkCommand("x".repeat(TERMINAL_COMMAND_MAX + 1)), /at most/);
  });

  it("only takes an absolute, plain working directory from the client", () => {
    assert.equal(checkCwd("/workspace/app", "/workspace"), "/workspace/app");
    assert.equal(checkCwd("relative", "/workspace"), "/workspace");
    assert.equal(checkCwd("/tmp\n; rm", "/workspace"), "/workspace");
    assert.equal(checkCwd(undefined, "/workspace"), "/workspace");
  });

  it("wraps the command so the directory is carried over, quoting it safely", () => {
    const line = wrapCommand("cd src && ls", "/w/it's here");
    assert.match(line, /^cd '\/w\/it'\\''s here' 2>\/dev\/null \|\| cd ~; cd src && ls\n/);
    assert.match(line, /exit \$__shapes_rc$/);
  });

  it("splits the directory marker off the output", () => {
    const out = "file-a\nfile-b\n\n\u001eSHAPES_CWD:/workspace/src\n";
    assert.deepEqual(splitCwd(out), { text: "file-a\nfile-b\n", cwd: "/workspace/src" });
    assert.deepEqual(splitCwd("no marker"), { text: "no marker", cwd: null });
  });
});
