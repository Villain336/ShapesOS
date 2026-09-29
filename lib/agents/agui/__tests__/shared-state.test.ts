// Marketr — Phase 16 slice 4: shared-state domain tests (pure, no DB).
// Run: npx tsx --test lib/agents/agui/__tests__/shared-state.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mapPostsToCalendar,
  mapMissionToState,
  mapItemsToApprovals,
  diffSharedState,
  mergeSharedState,
  updateCalendarRowInState,
  changedCalendarRows,
  postTextExcerpt,
  missionGoalSummary,
  type SharedAgentState,
} from "../shared-state";

const T0 = "2026-09-29T10:00:00.000Z";
const T1 = "2026-09-29T12:00:00.000Z";
const T2 = "2026-09-30T09:00:00.000Z";

describe("mapPostsToCalendar", () => {
  it("mirrors SocialPost rows as calendar rows, scheduled-first", () => {
    const state = mapPostsToCalendar([
      {
        id: "p_draft",
        content: { text: "Draft post with a very long body ".repeat(10) },
        services: ["twitter"],
        scheduledFor: null,
        status: "draft",
        updatedAt: T1,
      },
      {
        id: "p_sched",
        content: { text: "Hello world" },
        services: ["twitter", "linkedin"],
        scheduledFor: T2,
        status: "scheduled",
        updatedAt: T0,
      },
    ]);
    assert.equal(state.rows.length, 2);
    // Scheduled rows sort before unscheduled drafts.
    assert.equal(state.rows[0].id, "p_sched");
    assert.equal(state.rows[1].id, "p_draft");
    assert.equal(state.rows[0].channels.join(","), "twitter,linkedin");
    assert.equal(state.rows[0].scheduledFor, T2);
    assert.equal(state.rows[1].scheduledFor, null);
    // Excerpt is truncated and one-line.
    assert.ok(state.rows[1].text.length <= 140);
    assert.ok(!state.rows[1].text.includes("  "));
    assert.equal(state.updatedAt, T1);
  });

  it("handles string content and missing channels", () => {
    const state = mapPostsToCalendar([
      {
        id: "p1",
        content: "plain string",
        services: [],
        scheduledFor: null,
        status: "draft",
        updatedAt: T0,
      },
    ]);
    assert.equal(state.rows[0].text, "plain string");
    assert.deepEqual(state.rows[0].channels, []);
  });
});

describe("postTextExcerpt / missionGoalSummary", () => {
  it("postTextExcerpt falls back to caption, then empty", () => {
    assert.equal(postTextExcerpt({ caption: "cap" }), "cap");
    assert.equal(postTextExcerpt({}), "");
    assert.equal(postTextExcerpt(null), "");
  });

  it("missionGoalSummary reads objective/summary/title from goal JSON", () => {
    assert.equal(missionGoalSummary("just do it"), "just do it");
    assert.equal(missionGoalSummary({ objective: "Grow traffic" }), "Grow traffic");
    assert.equal(missionGoalSummary({ title: "T" }), "T");
    assert.equal(missionGoalSummary(null), "Mission");
  });
});

describe("mapMissionToState", () => {
  const base = {
    id: "m1",
    template: "seo-sprint",
    goal: { objective: "Rank for 10 keywords" },
    updatedAt: T1,
  };

  it("planned mission with no checkpoints has 0 progress", () => {
    const s = mapMissionToState({ ...base, status: "planned", checkpoints: [] }, []);
    assert.equal(s.progress, 0);
    assert.equal(s.goal, "Rank for 10 keywords");
    assert.equal(s.lastEvent, null);
  });

  it("complete mission has progress 1; checkpoints count as done", () => {
    const s = mapMissionToState(
      {
        ...base,
        status: "complete",
        checkpoints: [
          { reason: "plan approved", at: T0, snapshot: {} },
          { reason: "drafts done", at: T1, snapshot: {} },
        ],
      },
      [
        { step: "draft", tool: "content", ts: T0 },
        { step: "publish", tool: "ghost", ts: T1 },
      ],
    );
    assert.equal(s.progress, 1);
    assert.equal(s.checkpoints.length, 2);
    assert.ok(s.checkpoints.every((c) => c.done));
    // lastEvent is the latest event.
    assert.equal(s.lastEvent?.tool, "ghost");
    assert.equal(s.lastEvent?.at, T1);
  });

  it("active mission with checkpoints has partial progress", () => {
    const s = mapMissionToState(
      { ...base, status: "active", checkpoints: [{ reason: "a", at: T0, snapshot: {} }] },
      [],
    );
    assert.equal(s.progress, 0.5);
  });
});

describe("mapItemsToApprovals", () => {
  it("counts pending and sorts pending-first", () => {
    const s = mapItemsToApprovals([
      { id: "a1", kind: "decay_refresh", title: "Old post", status: "approved", ruleId: "r1", updatedAt: T0 },
      { id: "a2", kind: "keyword_brief", title: "New brief", status: "pending", ruleId: "r1", updatedAt: T1 },
      { id: "a3", kind: "keyword_brief", title: "Older brief", status: "pending", ruleId: "r2", updatedAt: T0 },
    ]);
    assert.equal(s.pendingCount, 2);
    assert.equal(s.items[0].id, "a2"); // pending, newest first
    assert.equal(s.items[1].id, "a3");
    assert.equal(s.items[2].id, "a1");
  });
});

describe("diffSharedState", () => {
  const prev: SharedAgentState = {
    calendar: { rows: [], updatedAt: T0 },
    mission: null,
    approvals: { pendingCount: 0, items: [], updatedAt: T0 },
  };

  it("returns no ops when nothing changed", () => {
    assert.deepEqual(diffSharedState(prev, { ...prev }), []);
  });

  it("emits one replace op per changed domain", () => {
    const next: SharedAgentState = {
      ...prev,
      calendar: {
        rows: [
          {
            id: "p1",
            scheduledFor: T2,
            text: "hi",
            channels: ["twitter"],
            status: "scheduled",
            updatedAt: T1,
          },
        ],
        updatedAt: T1,
      },
    };
    const patch = diffSharedState(prev, next);
    assert.equal(patch.length, 1);
    assert.equal(patch[0].op, "replace");
    assert.equal(patch[0].path, "/calendar");
    assert.deepEqual((patch[0] as { value: unknown }).value, next.calendar);
  });
});

describe("mergeSharedState", () => {
  it("overlay wins per-domain; missing domains keep the base", () => {
    const base: SharedAgentState = {
      calendar: { rows: [], updatedAt: T0 },
      approvals: { pendingCount: 1, items: [], updatedAt: T0 },
    };
    const overlay: SharedAgentState = {
      calendar: { rows: [], updatedAt: T1 },
    };
    const merged = mergeSharedState(base, overlay);
    assert.equal(merged.calendar?.updatedAt, T1);
    assert.equal(merged.approvals?.pendingCount, 1);
    assert.equal(merged.mission, undefined);
  });
});

describe("updateCalendarRowInState", () => {
  const state: SharedAgentState = {
    calendar: {
      rows: [
        { id: "p1", scheduledFor: null, text: "one", channels: [], status: "draft", updatedAt: T0 },
        { id: "p2", scheduledFor: null, text: "two", channels: [], status: "draft", updatedAt: T0 },
      ],
      updatedAt: T0,
    },
  };

  it("edits only the targeted row and bumps updatedAt", () => {
    const next = updateCalendarRowInState(state, "p1", {
      scheduledFor: T2,
      status: "scheduled",
    });
    const rows = next.calendar?.rows ?? [];
    assert.equal(rows[0].scheduledFor, T2);
    assert.equal(rows[0].status, "scheduled");
    assert.equal(rows[1].status, "draft");
    assert.ok((next.calendar?.updatedAt ?? "") >= T0);
    // Original untouched (pure).
    assert.equal(state.calendar?.rows[0].status, "draft");
  });
});

describe("changedCalendarRows", () => {
  const prev: SharedAgentState = {
    calendar: {
      rows: [
        { id: "p1", scheduledFor: T1, text: "one", channels: [], status: "scheduled", updatedAt: T0 },
      ],
      updatedAt: T0,
    },
  };

  it("detects scheduledFor/status changes; ignores new rows", () => {
    const next: SharedAgentState = {
      calendar: {
        rows: [
          { id: "p1", scheduledFor: T2, text: "one", channels: [], status: "cancelled", updatedAt: T1 },
          { id: "p_new", scheduledFor: T2, text: "new", channels: [], status: "draft", updatedAt: T1 },
        ],
        updatedAt: T1,
      },
    };
    const changes = changedCalendarRows(prev, next);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, "p1");
    assert.equal(changes[0].scheduledFor, T2);
    assert.equal(changes[0].status, "cancelled");
  });

  it("returns empty when nothing changed", () => {
    assert.deepEqual(changedCalendarRows(prev, prev), []);
  });
});
