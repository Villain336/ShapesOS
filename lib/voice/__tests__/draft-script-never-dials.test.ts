// Marketr — Phase 13D Worker A: draft-script-never-dials tests.
// Run: npx tsx --test lib/voice/__tests__/draft-script-never-dials.test.ts
// Pure core (canAttachToLiveSession) — no DB, no network.
// Contract: ONLY status='approved' scripts may attach to a live session.
// draft, in_review, rejected, archived all refuse.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canAttachToLiveSession } from "../scripts";

describe("canAttachToLiveSession — drafts never dial", () => {
  it("draft → cannot attach", () => {
    assert.equal(canAttachToLiveSession({ status: "draft" }), false);
  });

  it("in_review → cannot attach", () => {
    assert.equal(canAttachToLiveSession({ status: "in_review" }), false);
  });

  it("rejected → cannot attach", () => {
    assert.equal(canAttachToLiveSession({ status: "rejected" }), false);
  });

  it("archived → cannot attach", () => {
    assert.equal(canAttachToLiveSession({ status: "archived" }), false);
  });

  it("approved → can attach", () => {
    assert.equal(canAttachToLiveSession({ status: "approved" }), true);
  });
});
