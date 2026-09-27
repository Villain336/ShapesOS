// Marketr — Phase 12 persona seeds: registry + prompt contract tests.
//
// Pins the structural contract for the Agency-Agents distillations
// (lib/expert/personas/): five personas, provenance on every file, the
// approved surface mapping, and the prompt-layering contract (global hard
// rules FIRST, persona seed second, grounding/task after — same contract
// as constitutionSystemPrompt()).
//
// Note: these tests deliberately do NOT import the wiring points
// (lib/playbooks/store.ts, lib/orchestrator/executors/planner.ts,
// lib/chat/agent.ts) — those modules pull in prisma, skills, and
// connector runtimes with import-time side effects. The wiring functions
// (playbookGeneratorPrompt / missionPlannerPrompt / advisorSystemPrompt)
// are thin wrappers over the registry tested here and are covered by tsc.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PERSONAS,
  PERSONA_IDS,
  personasForSurface,
  personaSystemPrompt,
  assertPersonaForSurface,
  type PersonaSurface,
} from "../index";
import { GLOBAL_HARD_RULES } from "../../constitution";

describe("persona registry", () => {
  it("has exactly the five approved personas", () => {
    assert.deepEqual([...PERSONA_IDS], [
      "multi-agent-systems-architect",
      "workflow-architect",
      "studio-producer",
      "business-strategist",
      "agents-orchestrator",
    ]);
    assert.equal(new Set(PERSONA_IDS).size, 5, "ids must be unique");
    assert.deepEqual(Object.keys(PERSONAS).sort(), [...PERSONA_IDS].sort());
  });

  it("every persona carries provenance (source repo, MIT, exact file, date)", () => {
    for (const id of PERSONA_IDS) {
      const p = PERSONAS[id];
      assert.equal(
        p.provenance.repo,
        "msitarzewski/agency-agents",
        `${id}: source repo`,
      );
      assert.equal(p.provenance.license, "MIT", `${id}: license`);
      assert.ok(
        p.provenance.sourceFile.endsWith(".md"),
        `${id}: source file path`,
      );
      assert.match(
        p.provenance.retrieved,
        /^\d{4}-\d{2}-\d{2}$/,
        `${id}: retrieved date`,
      );
      assert.ok(p.name.length > 0, `${id}: display name`);
      assert.ok(p.description.length > 40, `${id}: picker description`);
    }
  });

  it("maps to the approved surfaces (playbooks 2, missions 1, csa 2)", () => {
    assert.deepEqual(personasForSurface("playbooks"), [
      "multi-agent-systems-architect",
      "workflow-architect",
    ]);
    assert.deepEqual(personasForSurface("missions"), ["studio-producer"]);
    assert.deepEqual(personasForSurface("csa"), [
      "business-strategist",
      "agents-orchestrator",
    ]);
    const surfaces: PersonaSurface[] = ["playbooks", "missions", "csa"];
    for (const id of PERSONA_IDS) {
      assert.ok(
        PERSONAS[id].surfaces.length >= 1,
        `${id}: must be selectable on at least one surface`,
      );
      for (const s of PERSONAS[id].surfaces) {
        assert.ok(surfaces.includes(s), `${id}: unknown surface ${s}`);
      }
    }
  });

  it("rejects a persona on a surface it is not approved for", () => {
    assert.throws(
      () => assertPersonaForSurface("studio-producer", "playbooks"),
      /not selectable on surface "playbooks"/,
    );
    assert.throws(
      () => assertPersonaForSurface("business-strategist", "missions"),
      /not selectable on surface "missions"/,
    );
    // And returns the seed when the surface matches.
    assert.equal(
      assertPersonaForSurface("workflow-architect", "playbooks").id,
      "workflow-architect",
    );
  });
});

describe("persona prompt contract", () => {
  it("places the global hard rules FIRST, before the persona seed", () => {
    for (const id of PERSONA_IDS) {
      const prompt = personaSystemPrompt(id);
      assert.ok(
        prompt.startsWith(GLOBAL_HARD_RULES),
        `${id}: prompt must start with the global hard rules`,
      );
      assert.ok(
        prompt.indexOf(PERSONAS[id].systemPrompt) > GLOBAL_HARD_RULES.length,
        `${id}: persona seed must come after the hard rules`,
      );
    }
  });

  it("hard rules carry the non-negotiables", () => {
    const prompt = personaSystemPrompt("multi-agent-systems-architect");
    for (const phrase of [
      "Zero custody of client spend",
      "Autopilot never buys media",
      "Propose / execute separation",
      "Honest labeling",
      "No invented proof",
    ]) {
      assert.ok(prompt.includes(phrase), `missing hard rule: ${phrase}`);
    }
  });

  it("seeds are Marketr-voice distillations, not copied source text", () => {
    for (const id of PERSONA_IDS) {
      const seed = PERSONAS[id].systemPrompt;
      assert.ok(seed.length > 1500, `${id}: seed is substantial`);
      // Constitution voice markers: structure + anti-patterns + voice line.
      assert.ok(
        seed.includes("**Anti-patterns:**"),
        `${id}: anti-patterns section`,
      );
      assert.ok(seed.includes("**Voice.**"), `${id}: voice line`);
      assert.ok(
        seed.includes("No emoji."),
        `${id}: voice restraint (no emoji)`,
      );
      // The source files' emoji signatures must not have leaked in.
      for (const emoji of ["🕸️", "🗺️", "🎬", "♟️", "🎛️", "🧠", "🚨"]) {
        assert.ok(!seed.includes(emoji), `${id}: leaked emoji ${emoji}`);
      }
    }
  });

  it("each seed names its own persona heading", () => {
    assert.ok(
      PERSONAS["multi-agent-systems-architect"].systemPrompt.includes(
        "## Persona — Multi-Agent Systems Architect",
      ),
    );
    assert.ok(
      PERSONAS["workflow-architect"].systemPrompt.includes(
        "## Persona — Workflow Architect",
      ),
    );
    assert.ok(
      PERSONAS["studio-producer"].systemPrompt.includes(
        "## Persona — Studio Producer",
      ),
    );
    assert.ok(
      PERSONAS["business-strategist"].systemPrompt.includes(
        "## Persona — Business Strategist",
      ),
    );
    assert.ok(
      PERSONAS["agents-orchestrator"].systemPrompt.includes(
        "## Persona — Agents Orchestrator",
      ),
    );
  });
});
