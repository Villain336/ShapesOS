// Marketr — Wave 2 WFH mode slice 1: WorkMode domain tests.
// Pure contract tests: setup validation, the setup gate, transitions,
// hybrid day-effectiveness, and the chrome indicator.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSetupInput,
  enableWfhMode,
  disableToOffice,
  toggleMode,
  isWfhEffectiveOn,
  modeIndicator,
  WfhModeError,
  type WorkModeState,
} from "../mode";

const goodSetup = {
  wfhDays: ["mon", "tue", "wed", "thu", "fri"],
  focusStartMin: 540,
  focusEndMin: 1020,
  focusBlockMinutes: 90,
  standupCadence: "daily",
  notificationProfile: "batched",
};

function state(over: Partial<WorkModeState> = {}): WorkModeState {
  return { mode: "office", wfhDays: [], setupCompletedAt: null, ...over };
}

describe("validateSetupInput", () => {
  it("accepts a complete valid setup", () => {
    const v = validateSetupInput(goodSetup);
    assert.equal(v.ok, true);
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.normalized?.wfhDays, ["mon", "tue", "wed", "thu", "fri"]);
    assert.equal(v.normalized?.focusStartMin, 540);
    assert.equal(v.normalized?.standupCadence, "daily");
  });

  it("rejects empty wfh days", () => {
    const v = validateSetupInput({ ...goodSetup, wfhDays: [] });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /WFH day/);
  });

  it("drops invalid day codes but keeps valid ones", () => {
    const v = validateSetupInput({ ...goodSetup, wfhDays: ["mon", "funday", "fri"] });
    assert.equal(v.ok, true);
    assert.deepEqual(v.normalized?.wfhDays, ["mon", "fri"]);
  });

  it("dedupes repeated day codes", () => {
    const v = validateSetupInput({ ...goodSetup, wfhDays: ["mon", "mon", "tue"] });
    assert.equal(v.ok, true);
    assert.deepEqual(v.normalized?.wfhDays, ["mon", "tue"]);
  });

  it("rejects an inverted focus window", () => {
    const v = validateSetupInput({ ...goodSetup, focusStartMin: 1020, focusEndMin: 540 });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /Focus hours/);
  });

  it("rejects a focus window smaller than one block", () => {
    const v = validateSetupInput({ ...goodSetup, focusStartMin: 540, focusEndMin: 570, focusBlockMinutes: 90 });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /at least one focus block/);
  });

  it("rejects out-of-range block lengths", () => {
    assert.equal(validateSetupInput({ ...goodSetup, focusBlockMinutes: 5 }).ok, false);
    assert.equal(validateSetupInput({ ...goodSetup, focusBlockMinutes: 600 }).ok, false);
  });

  it("rejects unknown cadence and profile values", () => {
    const v = validateSetupInput({ ...goodSetup, standupCadence: "hourly", notificationProfile: "carrier-pigeon" });
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 2);
  });

  it("accepts string-encoded minute values", () => {
    const v = validateSetupInput({ ...goodSetup, focusStartMin: "540", focusEndMin: "1020" });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.focusStartMin, 540);
  });
});

describe("enableWfhMode — the setup gate", () => {
  it("fails closed with SETUP_REQUIRED when a returning user has no completed setup", () => {
    const current = state({ mode: "office", setupCompletedAt: null });
    assert.throws(() => enableWfhMode(current, "wfh", { wfhDays: [] }), (e: unknown) => {
      assert.ok(e instanceof WfhModeError);
      assert.equal(e.code, "SETUP_REQUIRED");
      return true;
    });
  });

  it("fails closed with VALIDATION_FAILED for a fresh user with invalid setup", () => {
    assert.throws(() => enableWfhMode(null, "wfh", { wfhDays: [] }), (e: unknown) => {
      assert.ok(e instanceof WfhModeError);
      assert.equal(e.code, "VALIDATION_FAILED");
      return true;
    });
  });

  it("enables with valid setup in the same call and returns the normalized setup", () => {
    const t = enableWfhMode(null, "wfh", goodSetup);
    assert.equal(t.previousMode, "office");
    assert.equal(t.newMode, "wfh");
    assert.deepEqual(t.setup?.wfhDays, ["mon", "tue", "wed", "thu", "fri"]);
  });

  it("skips the gate when setup was already completed", () => {
    const current = state({ mode: "office", setupCompletedAt: new Date("2026-01-01T00:00:00Z") });
    const t = enableWfhMode(current, "hybrid");
    assert.equal(t.newMode, "hybrid");
    assert.equal(t.setup, null);
  });

  it("enabling hybrid records the previous mode for history", () => {
    const current = state({ mode: "wfh", setupCompletedAt: new Date() });
    const t = enableWfhMode(current, "hybrid");
    assert.equal(t.previousMode, "wfh");
    assert.equal(t.newMode, "hybrid");
  });
});

describe("disableToOffice / toggleMode", () => {
  it("disabling never requires the setup gate", () => {
    const t = disableToOffice(state({ mode: "wfh", setupCompletedAt: null }));
    assert.equal(t.newMode, "office");
    assert.equal(t.previousMode, "wfh");
  });

  it("toggle flips wfh -> office without the gate", () => {
    const t = toggleMode(state({ mode: "wfh", setupCompletedAt: new Date() }));
    assert.equal(t.newMode, "office");
  });

  it("toggle office -> wfh enforces the setup gate", () => {
    assert.throws(() => toggleMode(state({ mode: "office" })), (e: unknown) => {
      assert.ok(e instanceof WfhModeError);
      assert.equal(e.code, "SETUP_REQUIRED");
      return true;
    });
  });

  it("toggle office -> wfh passes with valid setup input", () => {
    const t = toggleMode(state({ mode: "office" }), goodSetup);
    assert.equal(t.newMode, "wfh");
    assert.notEqual(t.setup, null);
  });
});

describe("isWfhEffectiveOn", () => {
  // 2026-10-05 is a Monday, 2026-10-03 is a Saturday (verified against the date table).
  const monday = new Date(2026, 9, 5, 12, 0, 0);
  const saturday = new Date(2026, 9, 3, 12, 0, 0);
  assert.equal(monday.getDay(), 1);
  assert.equal(saturday.getDay(), 6);

  it("wfh mode is effective every day", () => {
    const s = state({ mode: "wfh" });
    assert.equal(isWfhEffectiveOn(s, monday), true);
    assert.equal(isWfhEffectiveOn(s, saturday), true);
  });

  it("office mode is never effective", () => {
    const s = state({ mode: "office" });
    assert.equal(isWfhEffectiveOn(s, monday), false);
  });

  it("hybrid is effective only on configured wfh days", () => {
    const s = state({ mode: "hybrid", wfhDays: ["mon", "tue", "wed", "thu", "fri"] });
    assert.equal(isWfhEffectiveOn(s, monday), true);
    assert.equal(isWfhEffectiveOn(s, saturday), false);
  });

  it("null state is never effective", () => {
    assert.equal(isWfhEffectiveOn(null, monday), false);
  });
});

describe("modeIndicator", () => {
  it("shows the office label when off", () => {
    assert.deepEqual(modeIndicator(null), { active: false, label: "Office mode", tone: "office" });
    assert.deepEqual(modeIndicator(state({ mode: "office" })), {
      active: false,
      label: "Office mode",
      tone: "office",
    });
  });

  it("shows the WFH label when on", () => {
    assert.deepEqual(modeIndicator(state({ mode: "wfh" })), {
      active: true,
      label: "WFH mode",
      tone: "wfh",
    });
  });

  it("distinguishes hybrid", () => {
    assert.deepEqual(modeIndicator(state({ mode: "hybrid" })), {
      active: true,
      label: "Hybrid · WFH days on",
      tone: "wfh",
    });
  });
});
