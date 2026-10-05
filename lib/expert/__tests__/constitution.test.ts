// Marketr — Expert Constitution Pack v1: drift tripwire tests.
//
// The constitutions and exemplars in ../constitution.ts are transcribed
// VERBATIM from docs/specs/EXPERT-CONSTITUTION.md. These tests pin the structural
// contract (counts, ordering, key hard-rule phrases) so a careless edit
// fails loudly. They do not pin full text (that would duplicate the doc);
// a doc revision must re-transcribe the module and bump
// CONSTITUTION_VERSION by hand.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONSTITUTION_VERSION,
  EXPERT_ROLES,
  EXPERT_EXEMPLARS,
  GLOBAL_HARD_RULES,
  CHIEF_STRATEGY_CONSTITUTION,
  MISSION_PLANNER_CONSTITUTION,
  PLAYBOOK_GENERATOR_CONSTITUTION,
  CONTENT_BRIEF_CONSTITUTION,
  constitutionSystemPrompt,
  exemplarsFor,
  groundedPrompt,
} from "../constitution";

describe("expert constitution pack", () => {
  it("is versioned", () => {
    assert.equal(CONSTITUTION_VERSION, "1");
  });

  it("covers exactly the four expert roles", () => {
    assert.deepEqual([...EXPERT_ROLES], [
      "chief-strategy",
      "mission-planner",
      "playbook-generator",
      "content-brief",
    ]);
  });

  it("preserves all 12 exemplars, 3 per role", () => {
    assert.equal(EXPERT_EXEMPLARS.length, 12);
    for (const role of EXPERT_ROLES) {
      assert.equal(exemplarsFor(role).length, 3, `role ${role} must have 3 exemplars`);
    }
    const ids = EXPERT_EXEMPLARS.map((e) => e.id);
    assert.equal(new Set(ids).size, 12, "exemplar ids must be unique");
  });

  it("exemplars are SFT-shaped: situation + trace + output", () => {
    for (const e of EXPERT_EXEMPLARS) {
      assert.ok(e.situation.length > 20, `${e.id}: situation`);
      assert.ok(e.thoughtProcess.length >= 3, `${e.id}: trace steps`);
      assert.ok(e.output.length > 20, `${e.id}: output`);
    }
  });

  it("global hard rules carry the non-negotiables", () => {
    for (const phrase of [
      "Zero custody of client spend",
      "Autopilot never buys media",
      "Propose / execute separation",
      "Honest labeling",
      "No invented proof",
      "Voice restraint",
    ]) {
      assert.ok(GLOBAL_HARD_RULES.includes(phrase), `missing: ${phrase}`);
    }
  });

  it("system prompt puts global hard rules FIRST, then the role constitution", () => {
    const sys = constitutionSystemPrompt("chief-strategy");
    assert.ok(sys.startsWith(GLOBAL_HARD_RULES), "must start with the global hard rules");
    assert.ok(sys.includes(CHIEF_STRATEGY_CONSTITUTION.slice(0, 80)));
    assert.ok(
      sys.indexOf("Zero custody of client spend") <
        sys.indexOf("Mandatory reasoning order"),
      "hard rules must precede the role constitution",
    );
  });

  it("each role constitution is non-empty and distinct", () => {
    const consts = [
      CHIEF_STRATEGY_CONSTITUTION,
      MISSION_PLANNER_CONSTITUTION,
      PLAYBOOK_GENERATOR_CONSTITUTION,
      CONTENT_BRIEF_CONSTITUTION,
    ];
    for (const c of consts) assert.ok(c.length > 1000);
    assert.equal(new Set(consts).size, 4);
  });

  it("groundedPrompt orders constitution → grounding → task", () => {
    const p = groundedPrompt({
      role: "content-brief",
      grounding: "GROUNDING_MARKER",
      task: "TASK_MARKER",
    });
    const iConst = p.indexOf("Zero custody of client spend");
    const iGround = p.indexOf("GROUNDING_MARKER");
    const iTask = p.indexOf("TASK_MARKER");
    assert.ok(iConst >= 0 && iGround > iConst && iTask > iGround);
  });
});
