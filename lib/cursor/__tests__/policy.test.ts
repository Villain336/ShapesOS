// Phase 19A (WS=server): the spoken-approval gate. Tier 3 and destructive
// actions are never voice-approvable; /approve's rule refuses a spoken yes
// for them (and only for them); saying no is always fine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allTools, getTool, toolAction } from "@/lib/chat/tools";
import { cursorActionPolicy, voiceDecisionAllowed } from "../policy";

const policyOf = (name: string) => {
  const t = getTool(name)!;
  assert.ok(t, `tool ${name} exists`);
  return cursorActionPolicy({ tool: t.name, description: t.description, kind: t.kind, action: toolAction(t.name) });
};

describe("voiceApprovable", () => {
  it("money tools are Tier 3 and click-only", () => {
    for (const name of ["ops_send_invoice", "ops_record_payment", "ops_mark_invoice_paid", "ops_post_journal_entry"]) {
      const p = policyOf(name);
      assert.equal(p.tier, 3, name);
      assert.equal(p.voiceApprovable, false, name);
      assert.ok(p.reason);
    }
  });
  it("a draft (Tier 0–2, not destructive) may be approved by voice", () => {
    const p = policyOf("create_content_draft");
    assert.ok(p.tier < 3);
    assert.equal(p.destructive, false);
    assert.equal(p.voiceApprovable, true);
  });
  it("destructive is click-only whatever its tier", () => {
    const p = cursorActionPolicy({ tool: "archive_note", description: "Archive a note.", kind: "destructive", action: "tool_archive_note" });
    assert.equal(p.destructive, true);
    assert.equal(p.voiceApprovable, false);
  });
  it("Tier-3 wording in a description makes it click-only (delete, refund, transfer…)", () => {
    for (const d of ["Delete the record.", "Refund the customer.", "Transfer funds to a vendor.", "Purchase more seats."]) {
      const p = cursorActionPolicy({ tool: "x_tool", description: d, kind: "publish", action: "tool_x_tool" });
      assert.equal(p.tier, 3, d);
      assert.equal(p.voiceApprovable, false, d);
    }
  });
  it("browser_act (NEVER_AUTO) is click-only too (stricter than the contract)", () => {
    const p = cursorActionPolicy({ tool: "browser_act", description: "Click and type on a web page.", kind: "publish", action: "browser_act" });
    assert.equal(p.voiceApprovable, false);
  });
  it("no Tier-3 or destructive catalogue tool is ever voice-approvable", () => {
    for (const t of allTools()) {
      const p = cursorActionPolicy({ tool: t.name, description: t.description, kind: t.kind, action: toolAction(t.name) });
      if (p.tier === 3 || t.kind === "destructive") assert.equal(p.voiceApprovable, false, t.name);
    }
  });
});

describe("/approve rule", () => {
  it("refuses a spoken approve of a click-only action, allows the click", () => {
    const tier3 = policyOf("ops_send_invoice");
    assert.equal(voiceDecisionAllowed(tier3, "voice", "approve"), false);
    assert.equal(voiceDecisionAllowed(tier3, "click", "approve"), true);
    assert.equal(voiceDecisionAllowed(tier3, "voice", "reject"), true);
  });
  it("allows a spoken approve of a voice-approvable action", () => {
    assert.equal(voiceDecisionAllowed(policyOf("create_content_draft"), "voice", "approve"), true);
  });
});
