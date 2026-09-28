// Marketr — Phase 13C Worker 5: brand-kit caption fidelity + style-rule gate.
// Run: npx tsx --test lib/clipper/__tests__/captions-brandkit.test.ts
// Injectable deps: pure builders + the DB-free style-check core —
// no DB, no network, no keys.
//
// 1) buildAss must render the workspace brand-kit style faithfully
//    (ASS &HAABBGGRR color encoding, karaoke word highlight).
// 2) buildSrt must emit valid sequential SRT blocks.
// 3) The style-rule gate — checkOutputAgainstRules -> enforceAgainstRules,
//    the DB-free core behind applyStyleRulesToCaptions — must throw
//    StyleRuleBlockedError on a severity=block ban hit.
//
// 13B product decisions (RESOLVED 2026-09-27, asserted as decided behavior):
// (1) tone rules never block — severity=block on a tone rule is downgraded
//     to flag (flagged for review, let through). Hard ban rules on banned
//     words/phrases stay blocking.
// (2) ban-pattern matching is whole-word: plain phrases are wrapped in
//     \b...\b, so "ass" never matches "class".

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAss, buildSrt } from "../captions";
import type { CaptionStyle, Word } from "../types";
import {
  checkOutputAgainstRules,
  enforceAgainstRules,
  StyleRuleBlockedError,
} from "../../intelligence/company/style-check";
import type { StyleRule } from "@prisma/client";

const BRAND_STYLE: CaptionStyle = {
  font: "Inter",
  color: "#7C3AED",
  highlightColor: "#F5F3FF",
  position: "bottom",
  wordHighlight: true,
};

function fixtureWords(): Word[] {
  const text = "Stop scrolling. This is the hook. Watch what happens next.";
  const words: Word[] = [];
  let t = 0;
  for (const w of text.split(" ")) {
    const dur = 0.3;
    words.push({ w, start: +t.toFixed(2), end: +(t + dur).toFixed(2) });
    t += dur + 0.05;
  }
  return words;
}

/** Seeded brand-kit style rule: ban "guaranteed", severity block. */
function banRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: "rule_test_1",
    workspaceId: "ws_test",
    kind: "ban",
    pattern: "guaranteed",
    replacement: null,
    severity: "block",
    pinned: false,
    active: true,
    source: "test",
    createdAt: new Date("2026-09-27T00:00:00.000Z"),
    updatedAt: new Date("2026-09-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("captions: brand-kit fidelity", () => {
  it("buildAss renders the brand font and colors in ASS encoding", () => {
    const ass = buildAss(fixtureWords(), BRAND_STYLE);

    // Font name lands on the Style line verbatim.
    assert.ok(ass.includes("Inter"), "ASS must contain the brand font name");

    // ASS colors are &HAABBGGRR (alpha 00 = opaque), NOT CSS #RRGGBB.
    //   "#F5F3FF" (highlight) -> &H00FFF3F5   (PrimaryColour = karaoke target)
    //   "#7C3AED" (base)      -> &H00ED3A7C   (SecondaryColour = unsung text)
    assert.ok(
      ass.includes("&H00FFF3F5"),
      "ASS must contain the highlight color in &HAABBGGRR encoding",
    );
    assert.ok(
      ass.includes("&H00ED3A7C"),
      "ASS must contain the base color in &HAABBGGRR encoding",
    );
    assert.ok(
      !ass.includes("#F5F3FF") && !ass.includes("#7C3AED"),
      "raw CSS hex must not leak into the ASS document",
    );

    // Exact Style line: font, size 64, highlight, base, outline/back,
    // bold, alignment 2 (bottom), margins, MarginV 220 (bottom overlay zone).
    const styleLine =
      "Style: Clip,Inter,64,&H00FFF3F5,&H00ED3A7C," +
      "&H80000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,220,1";
    assert.ok(
      ass.includes(styleLine),
      `ASS Style line must match exactly.\nGot:\n${ass
        .split("\n")
        .find((l) => l.startsWith("Style:"))}`,
    );

    // Karaoke word highlight: per-word \k timing overrides present.
    assert.ok(
      ass.includes("{\\k"),
      "wordHighlight=true must emit karaoke \\k timing overrides",
    );
    assert.ok(ass.includes("[V4+ Styles]"), "must be a v4+ ASS document");
    assert.ok(ass.includes("Dialogue:"), "must emit caption events");
  });

  it("buildAss omits karaoke markers when wordHighlight is off", () => {
    const ass = buildAss(fixtureWords(), { ...BRAND_STYLE, wordHighlight: false });
    assert.ok(
      !ass.includes("{\\k"),
      "wordHighlight=false must not emit karaoke overrides",
    );
    assert.ok(ass.includes("Dialogue:"), "caption events must still be emitted");
  });

  it("buildSrt produces valid sequential SRT blocks", () => {
    const srt = buildSrt(fixtureWords());
    const blocks = srt.trim().split(/\n{2,}/);
    assert.ok(blocks.length >= 2, `expected >=2 cues, got ${blocks.length}`);

    const toMs = (ts: string): number => {
      const m = ts.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
      assert.ok(m, `bad SRT timestamp: ${ts}`);
      return (
        (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 +
        Number(m[4])
      );
    };

    let prevStart = -1;
    blocks.forEach((block, i) => {
      const lines = block.split("\n");
      assert.equal(lines[0], String(i + 1), "SRT cue numbers must be sequential");
      assert.match(
        lines[1],
        /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/,
        "cue must carry an SRT time range",
      );
      const [startTs, endTs] = lines[1].split(" --> ");
      const start = toMs(startTs);
      const end = toMs(endTs);
      assert.ok(end > start, "cue end must be after cue start");
      assert.ok(
        start >= prevStart,
        "cue start times must be monotonically non-decreasing",
      );
      prevStart = start;
      assert.ok(
        lines.slice(2).join(" ").trim().length > 0,
        "cue must carry non-empty text",
      );
    });
  });
});

describe("captions: style-rule gate (DB-free core)", () => {
  it("throws StyleRuleBlockedError on a severity=block ban hit", () => {
    const rule = banRule();
    const text = "This system is guaranteed to double your revenue.";
    const { violations } = checkOutputAgainstRules(text, [rule]);

    assert.equal(violations.length, 1, "the banned word must be detected");
    assert.equal(violations[0].kind, "ban");
    assert.equal(violations[0].severity, "block");

    // This is the applyStyleRulesToCaptions-equivalent gate: block -> throw.
    let caught: unknown;
    try {
      enforceAgainstRules(violations);
      assert.fail("expected StyleRuleBlockedError to be thrown");
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught instanceof StyleRuleBlockedError,
      "a severity=block ban must throw StyleRuleBlockedError",
    );
    assert.equal(
      (caught as StyleRuleBlockedError).violations[0].severity,
      "block",
    );
  });

  it("passes clean caption text through unblocked", () => {
    const { violations } = checkOutputAgainstRules(
      "This system helps teams ship faster.",
      [banRule()],
    );
    assert.equal(violations.length, 0, "clean text must not violate");
    const result = enforceAgainstRules(violations);
    assert.equal(result.blocked, false);
  });

  it("decided behavior: tone rules flag (never block), ban patterns use word boundaries", () => {
    // (1) tone is machine-checked but never machine-enforced: severity=block
    // on a tone rule downgrades to flag — flagged for review, let through.
    const toneRule = banRule({ id: "rule_test_tone", kind: "tone", pattern: "hype" });
    const toneResult = checkOutputAgainstRules("hype hype hype", [toneRule]);
    assert.equal(
      toneResult.violations.length,
      1,
      "DECIDED behavior: tone match produces a flag violation",
    );
    assert.equal(
      toneResult.violations[0].severity,
      "flag",
      "DECIDED behavior: block on tone downgrades to flag",
    );
    assert.doesNotThrow(() => enforceAgainstRules(toneResult.violations));

    // (2) plain phrases are wrapped in \b...\b: "guarantee" must not match
    // inside "guaranteed", but must match as a standalone word.
    const boundaryRule = banRule({ id: "rule_test_wb", pattern: "guarantee" });
    const inside = checkOutputAgainstRules("Results are guaranteed.", [
      boundaryRule,
    ]);
    assert.equal(
      inside.violations.length,
      0,
      "CURRENT behavior: ban pattern must not match inside a longer word",
    );
    const standalone = checkOutputAgainstRules("We guarantee results.", [
      boundaryRule,
    ]);
    assert.equal(
      standalone.violations.length,
      1,
      "CURRENT behavior: ban pattern matches a standalone word",
    );
  });
});
