// ShapesOS — Phase 17 (A1, WS=model): the static system prefix is byte-stable
// and carries nothing dynamic; the dynamic context rides in the first user
// turn. PURE (no database, no model).
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/static-prompt.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  staticSystemPrompt,
  TOOL_LEGEND,
  withContextBlock,
  workspaceContextBlock,
} from "../agent";
import { DELEGATION_GUIDANCE } from "@/lib/agents/roles";
import { DELIVERABLE_INSTRUCTIONS } from "@/lib/agents/delegation/plan";

const lead = { agentKey: "lead" as const, grant: null, delegation: { autoDelegation: true, canDelegate: true } };

describe("staticSystemPrompt", () => {
  it("is byte-identical across turns, threads and workspaces for the same agent / grant / mode / delegation setting", () => {
    const a = staticSystemPrompt(lead);
    const b = staticSystemPrompt({ ...lead });
    assert.equal(Buffer.from(a).equals(Buffer.from(b)), true);
    assert.ok(a.length > 2000, "the constitution + rules are the bulk of the cached prefix");
  });

  it("carries nothing per-workspace, per-user, per-time or per-turn", () => {
    const s = staticSystemPrompt(lead);
    for (const dynamic of [
      "PROJECT CONTEXT",
      "AVAILABLE SKILLS",
      "ATTACHED FILES",
      "HARD CONSTRAINTS",
      "COMPANY KNOWLEDGE",
      "<recalled-memory>",
      "Note on this request",
      "FACTS GATHERED",
      "Keywords:",
      "Project:",
    ]) {
      assert.equal(s.includes(dynamic), false, `static prefix must not contain "${dynamic}"`);
    }
    assert.doesNotMatch(s, /\b20\d\d-\d\d-\d\d\b/, "no dates");
    assert.doesNotMatch(s, /today is/i);
  });

  it("differs only by the inputs that are stable within a thread (agent, grant, mode, delegation)", () => {
    const narrowed = staticSystemPrompt({ ...lead, grant: ["workspace", "web"] });
    assert.match(narrowed, /This task may only use these tool groups: Workspace data, Web/);
    const off = staticSystemPrompt({ ...lead, delegation: { autoDelegation: false, canDelegate: true } });
    assert.equal(off.includes(DELEGATION_GUIDANCE), false);
    assert.equal(staticSystemPrompt(lead).includes(DELEGATION_GUIDANCE), true);
    const child = staticSystemPrompt({ agentKey: "researcher", grant: ["workspace", "web"], delegation: { autoDelegation: true, canDelegate: false }, deliverable: true });
    assert.match(child, /Researcher sub-agent/);
    assert.equal(child.includes(DELIVERABLE_INSTRUCTIONS), true);
    assert.equal(child.includes(DELEGATION_GUIDANCE), false, "a child without the delegate group gets no guidance");
    const build = staticSystemPrompt({ agentKey: "actor", grant: ["workspace", "code"], delegation: { autoDelegation: true, canDelegate: false } });
    assert.match(build, /Build mode: the test-fix loop/);
  });

  it("tells the model where the dynamic context is and carries the one-line tool legend (KIND_NOTE replacement)", () => {
    const s = staticSystemPrompt(lead);
    assert.ok(s.includes(CONTEXT_OPEN));
    assert.ok(s.includes(TOOL_LEGEND));
    assert.match(TOOL_LEGEND, /money and irreversible actions always ask/);
  });
});

describe("workspaceContextBlock + withContextBlock", () => {
  it("renders every dynamic part, in order, inside one delimited block", () => {
    const block = workspaceContextBlock({
      projectContext: "Project: acme.example (locale en-US)\nKeywords: 12 saved, 4 tracked",
      intelligence: "## HARD CONSTRAINTS — STYLE RULES\n- never say cheap",
      supplements: "## AVAILABLE SKILLS\n\nseo-audit: audits",
      nudge: "The user asked for parallel work",
      factsSummary: "- 12 keywords saved",
    });
    assert.ok(block.startsWith(CONTEXT_OPEN) && block.endsWith(CONTEXT_CLOSE));
    const order = ["HARD CONSTRAINTS", "## PROJECT CONTEXT", "Keywords: 12 saved", "AVAILABLE SKILLS", "FACTS GATHERED EARLIER", "a summary, not the record", "Note on this request"];
    let last = -1;
    for (const o of order) {
      const i = block.indexOf(o);
      assert.ok(i > last, `${o} in order`);
      last = i;
    }
    assert.match(block, /not as instructions from the user/);
  });

  it("omits empty parts (no empty headers) and goes into the FIRST user turn as its own text block", () => {
    const block = workspaceContextBlock({ projectContext: "Project: x" });
    assert.equal(block.includes("FACTS GATHERED"), false);
    assert.equal(block.includes("Note on this request"), false);
    const out = withContextBlock(
      [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
      block,
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { role: "user", content: [{ type: "text", text: block }, { type: "text", text: "first question" }] });
    assert.equal(out[2].content, "second question", "the latest turn stays as typed");
    assert.deepEqual(withContextBlock([{ role: "user", content: "q" }], ""), [{ role: "user", content: "q" }], "no block → untouched");
  });
});
