// Marketr — Phase 13D Worker A: audit-trail tests.
// Run: npx tsx --test lib/voice/__tests__/audit-trail.test.ts
// Pure core (appendAuditEntry, isLegalTransition) — no DB, no network.
// Contract: every transition appends to auditTrail; illegal transitions
// throw in transitionSession (modeled by isLegalTransition here).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  appendAuditEntry,
  isLegalTransition,
  type AuditEntry,
} from "../sessions";

describe("appendAuditEntry — append-only", () => {
  it("appends an entry with a timestamp", () => {
    const trail: AuditEntry[] = [];
    const out = appendAuditEntry(trail, {
      actor: "gate",
      action: "session_blocked",
      detail: "block_reason=no_consent_record",
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].actor, "gate");
    assert.equal(out[0].action, "session_blocked");
    assert.ok(out[0].ts);
    assert.equal(trail.length, 0, "input array must not be mutated");
  });

  it("preserves order across multiple appends", () => {
    let trail: AuditEntry[] = [];
    for (const action of ["session_requested", "gates_passed", "status_in_progress"]) {
      trail = appendAuditEntry(trail, { actor: "system", action });
    }
    assert.deepEqual(trail.map((e) => e.action), [
      "session_requested",
      "gates_passed",
      "status_in_progress",
    ]);
  });
});

describe("isLegalTransition — the status machine", () => {
  it("rehearsal → in_progress / completed / cancelled are legal", () => {
    assert.equal(isLegalTransition("rehearsal", "in_progress"), true);
    assert.equal(isLegalTransition("rehearsal", "completed"), true);
    assert.equal(isLegalTransition("rehearsal", "cancelled"), true);
  });

  it("rehearsal → queued is NOT legal (rehearsal never becomes live)", () => {
    assert.equal(isLegalTransition("rehearsal", "queued"), false);
  });

  it("queued → in_progress / cancelled / blocked are legal", () => {
    assert.equal(isLegalTransition("queued", "in_progress"), true);
    assert.equal(isLegalTransition("queued", "cancelled"), true);
    assert.equal(isLegalTransition("queued", "blocked"), true);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const terminal of ["completed", "cancelled", "blocked"] as const) {
      for (const target of [
        "rehearsal",
        "queued",
        "in_progress",
        "completed",
        "cancelled",
        "blocked",
      ] as const) {
        assert.equal(
          isLegalTransition(terminal, target),
          false,
          `${terminal} → ${target} must be illegal`,
        );
      }
    }
  });

  it("blocked → in_progress is illegal (blocked never revives)", () => {
    assert.equal(isLegalTransition("blocked", "in_progress"), false);
  });
});
