// ShapesOS — Phase 17 (latency, A6): the chat turn's pre-model reads run in
// ONE concurrent round (fake loaders that each take 60 ms and record when
// they start and end — no database, no model).
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/pre-model.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTurnInputs, type TurnLoaders, type AgentTurnInput } from "../agent";

const TURN: AgentTurnInput = { projectId: "p", workspaceId: "ws", userId: "u", role: "editor", threadId: "th", userContent: "hi", agentKey: "lead", grant: null, mode: "default" };

function fakes(ms = 60) {
  // Start/end are sequence numbers (the order things happened), not
  // wall-clock times: exact on a slow, busy CI runner too.
  const log: Array<{ name: string; start: number; end: number }> = [];
  let tick = 0;
  const slow =
    <T,>(name: string, value: T) =>
    async () => {
      const start = tick++;
      await new Promise((r) => setTimeout(r, ms));
      log.push({ name, start, end: tick++ });
      return value;
    };
  const loaders: TurnLoaders = {
    delegationSettings: slow("delegation", null),
    isLive: slow("isLive", true),
    styleRules: slow("styleRules", []),
    connectorTools: slow("connectorTools", []),
    pendingProposal: slow("pendingProposal", null),
    declineWaiting: slow("declineWaiting", 0),
  };
  return { log, loaders };
}

describe("pre-model phase (Phase 17)", () => {
  it("issues every read before any of them finishes (one round, not a chain)", async () => {
    const { log, loaders } = fakes();
    const out = await loadTurnInputs(TURN, false, loaders);
    assert.equal(out.live, true);
    assert.deepEqual(log.map((l) => l.name).sort(), ["connectorTools", "declineWaiting", "delegation", "isLive", "styleRules"]);
    const lastStart = Math.max(...log.map((l) => l.start));
    const firstEnd = Math.min(...log.map((l) => l.end));
    assert.ok(lastStart < firstEnd, `all started (last start #${lastStart}) before the first finished (#${firstEnd}) — one round, not a chain`);
  });

  it("a confirming turn looks the proposal up (and never declines)", async () => {
    const { log, loaders } = fakes(5);
    await loadTurnInputs(TURN, true, loaders);
    const names = log.map((l) => l.name);
    assert.ok(names.includes("pendingProposal"));
    assert.ok(!names.includes("declineWaiting"));
  });
});
