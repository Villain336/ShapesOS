// ShapesOS — Phase 21B (WS=drive): agent folder-grant arithmetic (unit).
// Run: npx tsx --test lib/drive/__tests__/grants.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BULK_TRASH_MIN, checkAgentFileOp, grantRoots, type AgentGrant } from "../grants";

const grant: AgentGrant = { runId: "run1", folders: ["/shared/Reports", "/home/u1/Work"] };

describe("grantRoots", () => {
  it("is the run's own workspace plus the attached folders", () => {
    assert.deepEqual(grantRoots(grant), ["/agents/run1", "/shared/Reports", "/home/u1/Work"]);
  });
});

describe("where an agent may write", () => {
  it("creates new files inside its own workspace and attached folders at Tier 1", () => {
    for (const path of ["/agents/run1/out.csv", "/shared/Reports/q3/summary.md", "/home/u1/Work/notes.txt"]) {
      assert.deepEqual(checkAgentFileOp(grant, { kind: "create", path }), { allowed: true, tier: 1, action: "save_agent_file", alwaysAsk: false }, path);
    }
  });

  it("refuses everything outside the grant, including look-alike prefixes and other runs", () => {
    for (const path of ["/shared/Other/x.txt", "/shared/Reports2/x.txt", "/agents/run10/x.txt", "/agents/run2/x.txt", "/home/u2/x.txt", "/files/x.txt", "/apps/a/i/x.txt"]) {
      const v = checkAgentFileOp(grant, { kind: "create", path });
      assert.equal(v.allowed, false, path);
    }
  });

  it("cannot escape with .. or encoded dots: those paths are refused by the path rules", () => {
    for (const path of ["/agents/run1/../run2/x.txt", "/shared/Reports/../Other/x.txt", "/files/%2e%2e/x"]) {
      const v = checkAgentFileOp(grant, { kind: "create", path });
      assert.equal(v.allowed, false, path);
    }
  });

  it("treats a different spelling of a granted folder (case, Unicode form) as the same folder", () => {
    assert.equal(checkAgentFileOp(grant, { kind: "create", path: "/shared/reports/x.txt" }).allowed, true);
    const g2: AgentGrant = { runId: "r", folders: ["/shared/Café"] };
    assert.equal(checkAgentFileOp(g2, { kind: "create", path: "/shared/Café/x.txt" }).allowed, true);
  });

  it("an empty grant still has its own run workspace and nothing else", () => {
    const g: AgentGrant = { runId: "r9", folders: [] };
    assert.equal(checkAgentFileOp(g, { kind: "create", path: "/agents/r9/a.txt" }).allowed, true);
    assert.equal(checkAgentFileOp(g, { kind: "create", path: "/shared/a.txt" }).allowed, false);
  });
});

describe("tiers by effect (the platform sets them, not the tool)", () => {
  it("reading inside the grant is Tier 0; reading outside is refused", () => {
    assert.deepEqual(checkAgentFileOp(grant, { kind: "read", path: "/shared/Reports/a.md" }), { allowed: true, tier: 0, action: "read_agent_file", alwaysAsk: false });
    assert.equal(checkAgentFileOp(grant, { kind: "read", path: "/shared/Other/a.md" }).allowed, false);
  });

  it("overwriting an existing file is Tier 2 and always asks, never auto", () => {
    assert.deepEqual(checkAgentFileOp(grant, { kind: "overwrite", path: "/shared/Reports/a.md" }), { allowed: true, tier: 2, action: "replace_agent_file", alwaysAsk: true });
  });

  it("moving a file or sending one file to the trash is Tier 2 and always asks", () => {
    assert.deepEqual(checkAgentFileOp(grant, { kind: "move", path: "/shared/Reports/a.md", to: "/shared/Reports/b.md" }), { allowed: true, tier: 2, action: "move_agent_file", alwaysAsk: true });
    assert.deepEqual(checkAgentFileOp(grant, { kind: "trash", path: "/shared/Reports/a.md", count: 1 }), { allowed: true, tier: 2, action: "trash_agent_file", alwaysAsk: true });
  });

  it("a move must stay inside the grant at both ends", () => {
    assert.equal(checkAgentFileOp(grant, { kind: "move", path: "/shared/Reports/a.md", to: "/shared/Other/a.md" }).allowed, false);
    assert.equal(checkAgentFileOp(grant, { kind: "move", path: "/shared/Other/a.md", to: "/shared/Reports/a.md" }).allowed, false);
  });

  it("trashing many files at once is Tier 3 (never auto, a person confirms on the card)", () => {
    assert.equal(BULK_TRASH_MIN, 5);
    const v = checkAgentFileOp(grant, { kind: "trash", path: "/shared/Reports/old", count: 5 });
    assert.deepEqual(v, { allowed: true, tier: 3, action: "delete_many_agent_files", alwaysAsk: true });
    assert.equal((checkAgentFileOp(grant, { kind: "trash", path: "/shared/Reports/old", count: 4 }) as { tier: number }).tier, 2);
  });

  it("an overwrite of a path that does not exist yet is just a create", () => {
    assert.equal((checkAgentFileOp(grant, { kind: "write", path: "/shared/Reports/new.md", exists: false }) as { tier: number }).tier, 1);
    assert.equal((checkAgentFileOp(grant, { kind: "write", path: "/shared/Reports/old.md", exists: true }) as { tier: number }).tier, 2);
  });
});
