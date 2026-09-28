// Marketr — Phase 13B persona voice layer tests.
//
// Pins: (1) prompt assembly includes the voice block with the hard-rules >
// seed > voice layering contract; (2) a PersonaProfile override wins over
// the built-in default field-by-field; (3) the sycophancy guard rejects
// banned openers on seeded outputs. DB-free: assemblePersonaPrompt() and
// personaVoiceBlock() are pure; getPersonaProfileOverride() is the only
// DB touch and is covered by the RLS battery's workspace scoping.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PERSONA_VOICES,
  resolvePersonaVoice,
  personaVoiceBlock,
  BANNED_SYCOPHANCY_OPENERS,
  assertNoSycophancyOpener,
  PERSONA_IDS,
  personaSystemPrompt,
  type PersonaVoice,
} from "../index";
import { assemblePersonaPrompt } from "../profiles";
import { GLOBAL_HARD_RULES } from "../../constitution";

const IDS = [...PERSONA_IDS] as const;

describe("voice definitions (built-in defaults)", () => {
  it("covers exactly the five personas", () => {
    assert.deepEqual(Object.keys(DEFAULT_PERSONA_VOICES).sort(), [...IDS].sort());
  });

  it("every persona has register, manner, 2-3 quirks, taboos, uncertainty style, proactivity triggers", () => {
    for (const id of IDS) {
      const v: PersonaVoice = DEFAULT_PERSONA_VOICES[id];
      assert.ok(v.register.length > 20, `${id}: register`);
      assert.ok(v.manner.length > 20, `${id}: manner`);
      assert.ok(
        v.quirks.length >= 2 && v.quirks.length <= 3,
        `${id}: 2-3 quirks, got ${v.quirks.length}`,
      );
      assert.ok(v.taboos.length >= 3, `${id}: taboos`);
      assert.ok(v.uncertaintyStyle.length > 20, `${id}: uncertaintyStyle`);
      assert.ok(v.proactivityTriggers.length >= 2, `${id}: proactivityTriggers`);
    }
  });

  it("every persona's taboos ban sycophancy openers explicitly", () => {
    for (const id of IDS) {
      const joined = DEFAULT_PERSONA_VOICES[id].taboos.join(" ").toLowerCase();
      assert.ok(
        joined.includes("sycophancy") || joined.includes("you're absolutely right"),
        `${id}: taboos must name the sycophancy ban`,
      );
    }
  });

  it("quirks are habits, not gimmicks — no emojis, no catchphrases", () => {
    for (const id of IDS) {
      for (const q of DEFAULT_PERSONA_VOICES[id].quirks) {
        assert.ok(!/\p{Extended_Pictographic}/u.test(q), `${id}: quirk must not contain emoji`);
        assert.ok(q.length > 15, `${id}: quirk must be a real sentence, not a catchphrase`);
      }
    }
  });
});

describe("voice block rendering", () => {
  it("renders all voice sections from the built-in default", () => {
    const block = personaVoiceBlock("business-strategist", null);
    assert.ok(block.includes("## Voice — Business Strategist"));
    assert.ok(block.includes("Register:"));
    assert.ok(block.includes("Manner:"));
    assert.ok(block.includes("Recognizable tics"));
    assert.ok(block.includes("Never:"));
    assert.ok(block.includes("Uncertainty:"));
    assert.ok(block.includes("Volunteer unprompted"));
    assert.ok(
      block.includes("Match the user's register. Never sycophantic, never robotic-formal."),
      "shared honesty footer",
    );
    assert.ok(!block.includes("Continuity"), "no continuity section without notes");
  });

  it("override wins field-by-field; absent fields keep defaults", () => {
    const override = {
      voice: { register: "Terse. Half the words." } as Partial<PersonaVoice>,
      continuityNotes: "User decided to kill the Reddit pilot on 2026-09-20.",
      uncertaintyStyle: null,
    };
    const { voice, continuityNotes } = resolvePersonaVoice("studio-producer", override);
    assert.equal(voice.register, "Terse. Half the words.");
    assert.equal(voice.manner, DEFAULT_PERSONA_VOICES["studio-producer"].manner);
    assert.equal(voice.uncertaintyStyle, DEFAULT_PERSONA_VOICES["studio-producer"].uncertaintyStyle);
    assert.equal(continuityNotes, "User decided to kill the Reddit pilot on 2026-09-20.");

    const block = personaVoiceBlock("studio-producer", override);
    assert.ok(block.includes("Terse. Half the words."), "override register in block");
    assert.ok(block.includes("Continuity"), "continuity notes appear in block");
    assert.ok(
      block.includes("User decided to kill the Reddit pilot on 2026-09-20."),
      "continuity notes content in block",
    );
  });

  it("empty quirks/taboos arrays in an override fall back to defaults", () => {
    const { voice } = resolvePersonaVoice("agents-orchestrator", {
      voice: { quirks: [], taboos: [] },
      continuityNotes: null,
      uncertaintyStyle: null,
    });
    assert.deepEqual(voice.quirks, DEFAULT_PERSONA_VOICES["agents-orchestrator"].quirks);
    assert.deepEqual(voice.taboos, DEFAULT_PERSONA_VOICES["agents-orchestrator"].taboos);
  });
});

describe("prompt assembly (voice layered into the system prompt)", () => {
  it("assembles hard rules > seed > voice block, in that order", () => {
    const prompt = assemblePersonaPrompt("multi-agent-systems-architect", null);
    const hardIdx = prompt.indexOf(GLOBAL_HARD_RULES.slice(0, 60));
    const seedIdx = prompt.indexOf("## Persona — Multi-Agent Systems Architect");
    const voiceIdx = prompt.indexOf("## Voice — Multi Agent Systems Architect");
    assert.ok(hardIdx >= 0, "hard rules present");
    assert.ok(seedIdx > hardIdx, "seed comes after hard rules");
    assert.ok(voiceIdx > seedIdx, "voice block comes after the seed");
    assert.ok(
      prompt.includes(DEFAULT_PERSONA_VOICES["multi-agent-systems-architect"].uncertaintyStyle),
      "voice block carries the uncertainty style",
    );
  });

  it("an override changes the assembled prompt's voice layer only", () => {
    const override = {
      voice: { manner: "Calm and quietly thorough." } as Partial<PersonaVoice>,
      continuityNotes: null,
      uncertaintyStyle: null,
    };
    const withOverride = assemblePersonaPrompt("workflow-architect", override);
    const baseline = assemblePersonaPrompt("workflow-architect", null);
    assert.ok(withOverride.includes("Calm and quietly thorough."));
    assert.ok(!baseline.includes("Calm and quietly thorough."));
    // Seed untouched by the override.
    assert.ok(withOverride.includes("## Persona — Workflow Architect"));
    assert.ok(withOverride.startsWith(GLOBAL_HARD_RULES.slice(0, 60)));
  });

  it("sync personaSystemPrompt keeps the legacy shape (hard rules + seed, no voice block)", () => {
    const prompt = personaSystemPrompt("business-strategist");
    assert.ok(prompt.startsWith(GLOBAL_HARD_RULES.slice(0, 60)));
    assert.ok(!prompt.includes("## Voice —"), "legacy sync path must not add a voice block");
  });
});

describe("sycophancy guard", () => {
  it("every banned opener is actually banned", () => {
    assert.ok(BANNED_SYCOPHANCY_OPENERS.includes("You're absolutely right"));
    assert.ok(BANNED_SYCOPHANCY_OPENERS.includes("Great question"));
  });

  it("rejects seeded sycophantic outputs", () => {
    const bad: [string, string][] = [
      ["strategist", "You're absolutely right — the TAM is huge and the moat is wide."],
      ["orchestrator", "Great question! Let me lay out the phases for you..."],
      ["architect", "Great point! The topology you described is perfect."],
      ["workflow", "You nailed it — every branch is covered."],
      ["producer", "Couldn't agree more, this slate is going to crush it."],
      ["case-insensitive", "  you're absolutely right, this changes everything."],
    ];
    for (const [label, output] of bad) {
      assert.throws(
        () => assertNoSycophancyOpener(output),
        /sycophancy guard/,
        `${label}: should throw`,
      );
    }
  });

  it("accepts honest, non-sycophantic seeded outputs", () => {
    const good = [
      "The real choice here is X, which means deprioritizing Y.",
      "Current state: analysis done, plan in flight, verification blocked since Tuesday.",
      "What happens when this step times out — or when two of them fail at once?",
      "My best read is X — I'd put it at 60/40. What would move me: Y evidence.",
      "The risk I'm naming: X. If it lands, we do Z.",
      "I disagree: the moat here is an illusion. Here's why.",
    ];
    for (const output of good) {
      assert.doesNotThrow(() => assertNoSycophancyOpener(output), `should pass: ${output}`);
    }
  });
});
