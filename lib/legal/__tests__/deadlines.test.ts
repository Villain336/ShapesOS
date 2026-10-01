// Marketr — Legal/Compliance slice 2 tests: deadline engine.
// Run: npx tsx --test lib/legal/__tests__/deadlines.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ESCALATION_TIERS,
  RECURRENCE_LABELS,
  TIER_META,
  addMonthsUtc,
  daysUntilDue,
  isValidRecurrence,
  nextDueDate,
  tierAlertBody,
  tierAlertTitle,
  tierForDeadline,
  type EscalationTier,
} from "../deadlines";
import {
  sweepLegalDeadlineAlerts,
  type DeadlineSweepStore,
  type SweepDeadline,
} from "../deadline-sweep";
import { OBLIGATION_TEMPLATES } from "../seeds";
import { LEGAL_DISCLAIMER } from "../types";

const DAY_MS = 86_400_000;
// Fixed "now" so boundary tests are deterministic.
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0, 0)); // 2026-10-01 12:00 UTC

const atDaysOut = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("tierForDeadline", () => {
  it("returns date_needed for a missing due date — never a guessed date", () => {
    assert.equal(tierForDeadline(null, NOW), "date_needed");
  });

  it("escalates 90 → 30 → 7 → overdue at the documented boundaries", () => {
    assert.equal(tierForDeadline(atDaysOut(90), NOW), "due_90");
    assert.equal(tierForDeadline(atDaysOut(91), NOW), null);
    assert.equal(tierForDeadline(atDaysOut(30), NOW), "due_30");
    assert.equal(tierForDeadline(atDaysOut(31), NOW), "due_90");
    assert.equal(tierForDeadline(atDaysOut(7), NOW), "due_7");
    assert.equal(tierForDeadline(atDaysOut(8), NOW), "due_30");
    assert.equal(tierForDeadline(atDaysOut(0), NOW), "due_7");
    assert.equal(tierForDeadline(atDaysOut(-1), NOW), "overdue");
    assert.equal(tierForDeadline(atDaysOut(-400), NOW), "overdue");
  });

  it("stays silent more than 90 days out", () => {
    assert.equal(tierForDeadline(atDaysOut(120), NOW), null);
  });
});

describe("daysUntilDue", () => {
  it("counts whole UTC calendar days", () => {
    assert.equal(daysUntilDue(new Date(Date.UTC(2026, 9, 1, 23, 59)), NOW), 0);
    assert.equal(daysUntilDue(new Date(Date.UTC(2026, 9, 2, 0, 1)), NOW), 1);
    assert.equal(daysUntilDue(new Date(Date.UTC(2026, 8, 30, 12, 0)), NOW), -1);
  });
});

describe("nextDueDate", () => {
  it("computes recurrences anchored to the tenant-set date", () => {
    const anchor = new Date(Date.UTC(2026, 2, 15)); // Mar 15 2026
    assert.equal(nextDueDate(anchor, "annual")!.toISOString(), new Date(Date.UTC(2027, 2, 15)).toISOString());
    assert.equal(nextDueDate(anchor, "semiannual")!.toISOString(), new Date(Date.UTC(2026, 8, 15)).toISOString());
    assert.equal(nextDueDate(anchor, "quarterly")!.toISOString(), new Date(Date.UTC(2026, 5, 15)).toISOString());
    assert.equal(nextDueDate(anchor, "monthly")!.toISOString(), new Date(Date.UTC(2026, 3, 15)).toISOString());
    assert.equal(nextDueDate(anchor, "biennial")!.toISOString(), new Date(Date.UTC(2028, 2, 15)).toISOString());
  });

  it("clamps month-end anchors instead of overflowing (Jan 31 → Feb 28)", () => {
    const anchor = new Date(Date.UTC(2026, 0, 31)); // Jan 31 2026 (non-leap)
    assert.equal(nextDueDate(anchor, "monthly")!.toISOString(), new Date(Date.UTC(2026, 1, 28)).toISOString());
    const leap = new Date(Date.UTC(2028, 0, 31)); // Jan 31 2028 (leap year)
    assert.equal(nextDueDate(leap, "monthly")!.toISOString(), new Date(Date.UTC(2028, 1, 29)).toISOString());
  });

  it("returns null for non-recurring deadlines — no invented next date", () => {
    assert.equal(nextDueDate(new Date(Date.UTC(2026, 2, 15)), "none"), null);
  });
});

describe("addMonthsUtc", () => {
  it("preserves the time of day", () => {
    const d = addMonthsUtc(new Date(Date.UTC(2026, 5, 10, 14, 30)), 2);
    assert.equal(d.toISOString(), new Date(Date.UTC(2026, 7, 10, 14, 30)).toISOString());
  });
});

describe("isValidRecurrence", () => {
  it("accepts only the fixed cadence menu", () => {
    for (const r of ["none", "monthly", "quarterly", "semiannual", "annual", "biennial"]) {
      assert.equal(isValidRecurrence(r), true);
    }
    assert.equal(isValidRecurrence("annually"), false);
    assert.equal(isValidRecurrence(""), false);
    assert.equal(isValidRecurrence(null), false);
    assert.equal(isValidRecurrence(undefined), false);
  });

  it("has a plain-words label for every recurrence", () => {
    for (const tier of Object.keys(RECURRENCE_LABELS)) {
      assert.ok(RECURRENCE_LABELS[tier as keyof typeof RECURRENCE_LABELS].length > 0);
    }
  });
});

describe("escalation severity", () => {
  it("increases with urgency: info → warn → critical", () => {
    const rank = { info: 0, warn: 1, critical: 2 } as const;
    const order: EscalationTier[] = ["due_90", "due_30", "due_7", "overdue"];
    let prev = -1;
    for (const t of order) {
      const r = rank[TIER_META[t].severity];
      assert.ok(r >= prev, `${t} should not de-escalate`);
      prev = r;
    }
    assert.equal(TIER_META.overdue.severity, "critical");
  });

  it("every tier has a sentence-case label", () => {
    for (const t of ESCALATION_TIERS) {
      const label = TIER_META[t].label;
      assert.ok(label.length > 0);
      assert.equal(label[0], label[0].toUpperCase());
    }
  });
});

describe("alert copy", () => {
  it("date-needed copy asks for a date and admits nothing was guessed", () => {
    const body = tierAlertBody({ title: "NC annual report", tier: "date_needed", dueDateText: null, daysUntil: null });
    assert.ok(body.includes("no confirmed due date"));
    assert.ok(body.includes("never guessed"));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body), "no fabricated calendar date in copy");
  });

  it("due-date copy only renders dates the caller supplied", () => {
    const body = tierAlertBody({ title: "NC annual report", tier: "due_30", dueDateText: "Oct 31, 2026", daysUntil: 30 });
    assert.ok(body.includes("Oct 31, 2026"));
    const noDate = tierAlertBody({ title: "NC annual report", tier: "due_30", dueDateText: null, daysUntil: 30 });
    assert.ok(!/Oct 31, 2026/.test(noDate));
  });

  it("titles name the tier in sentence case", () => {
    assert.equal(tierAlertTitle("NC annual report", "overdue"), "NC annual report — overdue");
    assert.equal(tierAlertTitle("NC annual report", "date_needed"), "Set a due date: NC annual report");
  });
});

// ---- Sweep tests (fake store, no DB) ----

function fakeStore(deadlines: SweepDeadline[]): DeadlineSweepStore & { recorded: { id: string; tier: EscalationTier }[] } {
  const recorded: { id: string; tier: EscalationTier }[] = [];
  // Hold live references (no copy) so tests can move a deadline through tiers.
  const rows = new Map(deadlines.map((d) => [d.id, d]));
  return {
    recorded,
    async listOpenDeadlines() {
      return [...rows.values()];
    },
    async recordAlertedTier(_ws: string, id: string, tier: EscalationTier) {
      recorded.push({ id, tier });
      const row = rows.get(id);
      if (row) row.lastAlertedTier = tier;
    },
  };
}

const d = (overrides: Partial<SweepDeadline>): SweepDeadline => ({
  id: "dl-1",
  templateKey: "nc-annual-report",
  title: "NC annual report",
  dueDate: null,
  source: "tenant_set",
  lastAlertedTier: null,
  ...overrides,
});

describe("sweepLegalDeadlineAlerts", () => {
  it("emits once per tier transition and escalates through the ladder", async () => {
    const deadline = d({ dueDate: atDaysOut(80) });
    const store = fakeStore([deadline]);
    const emitted: { dedupKey?: string; severity?: string }[] = [];
    const emit = async (input: { dedupKey?: string; severity?: string }) => {
      emitted.push(input);
      return [];
    };

    // 80 days out → due_90 tier.
    let res = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res.emitted, 1);
    assert.equal(res.fired[0].tier, "due_90");

    // Same tier again → suppressed, no re-emit.
    res = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res.emitted, 0);
    assert.equal(emitted.length, 1);

    // Move to 20 days out → escalates to due_30.
    deadline.dueDate = atDaysOut(20);
    res = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res.emitted, 1);
    assert.equal(res.fired[0].tier, "due_30");

    // Move past due → overdue tier fires.
    deadline.dueDate = atDaysOut(-2);
    res = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res.emitted, 1);
    assert.equal(res.fired[0].tier, "overdue");

    // Dedup keys are tier-scoped so the hub can't collapse escalations.
    const keys = emitted.map((e) => e.dedupKey);
    assert.deepEqual(keys, [
      "legal_deadline:dl-1:due_90",
      "legal_deadline:dl-1:due_30",
      "legal_deadline:dl-1:overdue",
    ]);
    assert.deepEqual(emitted.map((e) => e.severity), ["info", "warn", "critical"]);
  });

  it("stays silent for deadlines more than 90 days out", async () => {
    const store = fakeStore([d({ dueDate: atDaysOut(200) })]);
    let calls = 0;
    const res = await sweepLegalDeadlineAlerts(store, async () => { calls += 1; return []; }, "ws-1", { now: NOW });
    assert.equal(res.emitted, 0);
    assert.equal(calls, 0);
    assert.equal(res.skipped, 1);
  });

  it("alerts date-needed deadlines once and never invents a date for them", async () => {
    const store = fakeStore([d({ dueDate: null })]);
    const bodies: string[] = [];
    const emit = async (input: { body: string }) => {
      bodies.push(input.body);
      return [];
    };
    const res = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res.emitted, 1);
    assert.equal(res.fired[0].tier, "date_needed");
    // The body must not contain any calendar date — none was ever set.
    assert.ok(!/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(bodies[0].split("\n\n")[0]));
    // Second run: same tier already recorded → silent.
    const res2 = await sweepLegalDeadlineAlerts(store, emit, "ws-1", { now: NOW });
    assert.equal(res2.emitted, 0);
  });

  it("every emitted alert carries the information-not-advice disclaimer", async () => {
    const store = fakeStore([
      d({ id: "a", dueDate: atDaysOut(5) }),
      d({ id: "b", dueDate: null }),
    ]);
    const bodies: string[] = [];
    await sweepLegalDeadlineAlerts(
      store,
      async (input: { body: string }) => { bodies.push(input.body); return []; },
      "ws-1",
      { now: NOW },
    );
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(body.includes(LEGAL_DISCLAIMER), "alert body must carry the disclaimer");
    }
  });

  it("uses the legal_deadline trigger and links back to the legal dashboard", async () => {
    const store = fakeStore([d({ dueDate: atDaysOut(3) })]);
    const inputs: { trigger: string; link?: string; workspaceId: string }[] = [];
    await sweepLegalDeadlineAlerts(
      store,
      async (input) => { inputs.push(input); return []; },
      "ws-9",
      { now: NOW },
    );
    assert.equal(inputs[0].trigger, "legal_deadline");
    assert.equal(inputs[0].link, "/dashboard/legal");
    assert.equal(inputs[0].workspaceId, "ws-9");
  });
});

describe("no-fabricated-date scan (guardrail)", () => {
  it("seed templates carry cadence, never calendar dates", () => {
    const dateish = /\b(19|20)\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/(19|20)\d{2}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(st|nd|rd|th)?\b/;
    for (const t of OBLIGATION_TEMPLATES) {
      for (const field of [t.title, t.description, t.sourceRef, t.renewalCadence ?? ""]) {
        assert.ok(
          !dateish.test(field),
          `seed template ${t.key} must not contain a calendar date: ${field.slice(0, 80)}`,
        );
      }
    }
  });

  it("computed dates only derive from tenant anchors or explicit recurrence", () => {
    // The engine has no path from "no date" to a date: nextDueDate(null
    // is impossible by type) and tierForDeadline(null) is date_needed.
    const typed: null = null;
    assert.equal(tierForDeadline(typed, NOW), "date_needed");
    assert.equal(nextDueDate(new Date(Date.UTC(2026, 0, 1)), "none"), null);
  });
});
