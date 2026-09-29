// Marketr — Phase 16 slice 4: shared-state AG-UI wire tests.
// Run: npx tsx --test lib/agents/agui/__tests__/shared-state-wire.test.ts
//
// Proves the bidirectional contract with stubbed state (no live DB):
//   agent→UI: STATE_SNAPSHOT right after RUN_STARTED carries the three
//             domains, so the frontend's agent.state re-renders widgets.
//   UI→agent: incomingState in the request is diffed + applied through the
//             injectable applier, then the canonical snapshot is emitted.
//   The AguiEmitter STATE_DELTA path (diffSharedState → stateDelta) is
//   covered too — the orchestrator slice will drive it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EventType,
  type AguiEvent,
  type StateSnapshotEvent,
  type StateDeltaEvent,
} from "../events";
import {
  streamChatTurnAgui,
  AguiEmitter,
  newAguiRunMeta,
  type AguiTurnRequest,
} from "../adapter";
import {
  diffSharedState,
  type AppliedStateChange,
  type SharedAgentState,
} from "../shared-state";
import type { AgentTurnOutput } from "@/lib/chat/agent";

const REQ: AguiTurnRequest = {
  projectId: "p1",
  workspaceId: "ws1",
  userId: "u1",
  role: "editor",
  threadId: "thread1",
  userContent: "hello",
  runId: "run_1",
};

const TURN: AgentTurnOutput = {
  assistantText: "ok",
  toolCalls: [],
  threadTitle: null,
};

const STUB_STATE: SharedAgentState = {
  calendar: {
    rows: [
      {
        id: "post1",
        scheduledFor: "2026-09-30T09:00:00.000Z",
        text: "Launch post",
        channels: ["twitter"],
        status: "scheduled",
        updatedAt: "2026-09-29T10:00:00.000Z",
      },
    ],
    updatedAt: "2026-09-29T10:00:00.000Z",
  },
  mission: {
    id: "m1",
    template: "seo-sprint",
    goal: "Rank for 10 keywords",
    status: "active",
    progress: 0.5,
    checkpoints: [],
    lastEvent: null,
    updatedAt: "2026-09-29T10:00:00.000Z",
  },
  approvals: {
    pendingCount: 2,
    items: [
      {
        id: "a1",
        kind: "keyword_brief",
        title: "Brief",
        status: "pending",
        ruleId: "r1",
        updatedAt: "2026-09-29T10:00:00.000Z",
      },
    ],
    updatedAt: "2026-09-29T10:00:00.000Z",
  },
};

async function collect(
  req: AguiTurnRequest,
  deps: Parameters<typeof streamChatTurnAgui>[1],
): Promise<AguiEvent[]> {
  const events: AguiEvent[] = [];
  for await (const e of streamChatTurnAgui(req, {
    runTurn: async () => TURN,
    logSink: () => undefined,
    ...deps,
  })) {
    events.push(e);
  }
  return events;
}

function snapshotOf(events: AguiEvent[]): StateSnapshotEvent {
  const found = events.find((e) => e.type === EventType.STATE_SNAPSHOT);
  assert.ok(found, "expected a STATE_SNAPSHOT event");
  return found as StateSnapshotEvent;
}

describe("agent→UI: STATE_SNAPSHOT emission", () => {
  it("emits the three domains right after RUN_STARTED", async () => {
    const events = await collect(REQ, {
      loadSharedState: async () => STUB_STATE,
      applySharedStateUpdates: async () => ({ applied: [] }),
    });
    assert.equal(events[0].type, EventType.RUN_STARTED);
    assert.equal(events[1].type, EventType.STATE_SNAPSHOT);
    const snap = snapshotOf(events);
    const state = snap.snapshot as unknown as SharedAgentState;
    assert.equal(state.calendar?.rows.length, 1);
    assert.equal(state.mission?.id, "m1");
    assert.equal(state.approvals?.pendingCount, 2);
    // Turn still completes normally after the snapshot.
    assert.equal(events[events.length - 1].type, EventType.RUN_FINISHED);
  });

  it("skips the snapshot when no loader is wired, turn still streams", async () => {
    const events = await collect(REQ, {
      loadSharedState: async () => {
        throw new Error("db down");
      },
    });
    assert.ok(!events.some((e) => e.type === EventType.STATE_SNAPSHOT));
    assert.equal(events[events.length - 1].type, EventType.RUN_FINISHED);
  });
});

describe("UI→agent: incoming state apply", () => {
  it("diffs incoming state, applies writable rows, re-emits canonical", async () => {
    const incoming: SharedAgentState = {
      calendar: {
        rows: [
          {
            id: "post1",
            scheduledFor: "2026-10-01T09:00:00.000Z", // rescheduled by the user
            text: "Launch post",
            channels: ["twitter"],
            status: "scheduled",
            updatedAt: "2026-09-29T11:00:00.000Z",
          },
        ],
        updatedAt: "2026-09-29T11:00:00.000Z",
      },
    };

    const appliedCalls: Array<{ prev: SharedAgentState; next: SharedAgentState }> = [];
    let loads = 0;
    const events = await collect(
      { ...REQ, incomingState: incoming },
      {
        loadSharedState: async () => {
          loads += 1;
          // Second load (post-apply) returns the canonical applied state.
          return loads === 1 ? STUB_STATE : { ...STUB_STATE, calendar: incoming.calendar };
        },
        applySharedStateUpdates: async (_ctx, prev, next) => {
          appliedCalls.push({ prev, next });
          const applied: AppliedStateChange[] = [
            { domain: "calendar", id: "post1", scheduledFor: "2026-10-01T09:00:00.000Z" },
          ];
          return { applied };
        },
      },
    );

    assert.equal(appliedCalls.length, 1);
    assert.deepEqual(appliedCalls[0].next, incoming);
    assert.equal(loads, 2); // baseline + post-apply reload
    const snap = snapshotOf(events);
    const state = snap.snapshot as unknown as SharedAgentState;
    assert.equal(
      state.calendar?.rows[0].scheduledFor,
      "2026-10-01T09:00:00.000Z",
      "snapshot carries the canonical post-apply state the agent will see",
    );
  });

  it("still emits a merged snapshot when nothing was writable", async () => {
    const events = await collect(
      { ...REQ, incomingState: { mission: null } },
      {
        loadSharedState: async () => STUB_STATE,
        applySharedStateUpdates: async () => ({ applied: [] }),
      },
    );
    const snap = snapshotOf(events);
    const state = snap.snapshot as unknown as SharedAgentState;
    // Baseline domains survive; the incoming mission:null overlay applies.
    assert.equal(state.calendar?.rows.length, 1);
    assert.equal(state.mission, null);
  });
});

describe("AguiEmitter STATE_DELTA via diffSharedState", () => {
  it("emits a STATE_DELTA carrying the domain replace patch", () => {
    const emitter = new AguiEmitter(newAguiRunMeta({ threadId: "t", workspaceId: "ws" }));
    const prev: SharedAgentState = { approvals: { pendingCount: 2, items: [], updatedAt: "x" } };
    const next: SharedAgentState = { approvals: { pendingCount: 1, items: [], updatedAt: "y" } };
    const event = emitter.stateDelta(diffSharedState(prev, next)) as StateDeltaEvent;
    assert.equal(event.type, EventType.STATE_DELTA);
    assert.equal(event.delta.length, 1);
    assert.equal(event.delta[0].path, "/approvals");
  });
});
