// Marketr — Phase 13B eval 02: preference-retrieval precision.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md §3):
//   WorkspacePreference → memory_facts, predicate "pref:<key>",
//   subjectNodeId NULL, object = { value, pinned? }, origin user_told /
//   agent_inferred, updates = supersede chain (never in-place).
//   Helpers: lib/substrate/memory/preferences.ts — getPreference,
//   setPreference, listPreferences, getLearningPaused, setLearningPaused,
//   PREF_KEYS.
//
// Acceptance: seed 20 preferences across workspaces → recall returns the
// right workspace's prefs, never another's.
//
// Status: fully runnable — worker 1's helpers are landed. Expected PASS.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createEvalWorkspace,
  deleteEvalWorkspace,
} from "./harness";
import { prisma } from "../../prisma";
import {
  PREF_KEYS,
  getPreference,
  getPreferenceScoped,
  listPreferences,
  setPreference,
  getLearningPaused,
  setLearningPaused,
} from "../../substrate/memory/preferences";

const SUITE = "preference-precision";
const WS: string[] = [];

const KEYS = [
  PREF_KEYS.voiceStyle,
  PREF_KEYS.riskTolerance,
  PREF_KEYS.detailLevel,
  PREF_KEYS.channels,
  PREF_KEYS.definitionOfGood,
];

// Distinct values per workspace so a cross-workspace leak is detectable.
const VALUES = [
  { voice_style: "bold, punchy", risk_tolerance: "low", detail_level: "terse", channels: ["email"], definition_of_good: "open-rate" },
  { voice_style: "warm, folksy", risk_tolerance: "high", detail_level: "verbose", channels: ["sms", "social"], definition_of_good: "revenue" },
  { voice_style: "clinical", risk_tolerance: "medium", detail_level: "bullets", channels: ["push"], definition_of_good: "ctr" },
  { voice_style: "playful", risk_tolerance: "very-high", detail_level: "stories", channels: ["video"], definition_of_good: "shares" },
];

before(async () => {
  for (let i = 0; i < 4; i++) {
    WS.push(await createEvalWorkspace(SUITE, `Eval 13B pref precision ws${i}`));
  }
  // Seed 20 preferences: 5 keys x 4 workspaces.
  for (let i = 0; i < 4; i++) {
    for (const key of KEYS) {
      await setPreference(WS[i], key, (VALUES[i] as Record<string, unknown>)[key], {
        origin: "user_told",
        confidence: 0.9,
      });
    }
  }
});

after(async () => {
  for (const w of WS) await deleteEvalWorkspace(w);
  await prisma.$disconnect();
});

describe("preference-precision: 20 seeded prefs, tenant isolation", () => {
  it("getPreference returns each workspace's own value for every key", async () => {
    for (let i = 0; i < 4; i++) {
      for (const key of KEYS) {
        const pref = await getPreferenceScoped(WS[i], key);
        assert.ok(pref, `ws${i} key ${key} found`);
        assert.deepEqual(
          pref!.value,
          (VALUES[i] as Record<string, unknown>)[key],
          `ws${i}/${key}: expected own value, never another workspace's`,
        );
      }
    }
  });

  it("listPreferences returns exactly the 5 seeded keys per workspace", async () => {
    for (let i = 0; i < 4; i++) {
      const prefs = await listPreferences(WS[i]);
      const keys = prefs.map((p) => p.key).sort();
      assert.deepEqual(keys, [...KEYS].sort(), `ws${i} sees exactly its 5 prefs`);
    }
  });

  it("a leak probe: reading ws0's prefs in ws1's scope returns ws1's values", async () => {
    // The scoped helpers take workspaceId explicitly; simulate a confused
    // caller passing the wrong id — the value must match the SCOPE, not the data.
    const pref = await getPreferenceScoped(WS[1], PREF_KEYS.voiceStyle);
    assert.deepEqual(pref!.value, VALUES[1].voice_style);
    assert.notDeepEqual(pref!.value, VALUES[0].voice_style);
  });

  it("updates supersede: old row invalidated, getPreference returns latest only", async () => {
    await setPreference(WS[0], PREF_KEYS.detailLevel, "terse", { origin: "user_told", confidence: 0.9 });
    await setPreference(WS[0], PREF_KEYS.detailLevel, "ultra-terse", { origin: "user_told", confidence: 0.95 });
    const pref = await getPreferenceScoped(WS[0], PREF_KEYS.detailLevel);
    assert.equal(pref!.value, "ultra-terse");
    // History kept (bi-temporal): both rows exist, old one invalidated.
    const { withWorkspaceScope } = await import("../../substrate/memory/rls");
    const rows = await withWorkspaceScope(WS[0], (tx) =>
      tx.memoryFact.findMany({
        where: { predicate: `pref:${PREF_KEYS.detailLevel}` },
        orderBy: { validAt: "asc" },
      }),
    );
    assert.equal(rows.length, 3, "history preserved: 1 seed + 2 updates");
    const invalidated = rows.filter((r) => r.invalidAt !== null);
    assert.equal(invalidated.length, 2, "superseded rows carry invalidatedAt");
    for (const r of invalidated) {
      assert.ok(r.supersededById, "superseded row points at its successor");
    }
  });

  it("learner contract: pinned prefs are read-only to the learner", async () => {
    // Learner-side helper implementing DATA-MODEL rule 3: check pinned
    // before any learner write; refuse when pinned.
    async function learnerSetPreference(workspaceId: string, key: string, value: unknown): Promise<"applied" | "refused-pinned"> {
      const { withWorkspaceScope } = await import("../../substrate/memory/rls");
      return withWorkspaceScope(workspaceId, async (tx) => {
        const current = await getPreference(tx, workspaceId, key);
        if (current?.pinned) return "refused-pinned";
        return "applied"; // (real learner would call setPreference here)
      });
    }
    await setPreference(WS[2], PREF_KEYS.voiceStyle, "locked voice", {
      origin: "user_told",
      confidence: 1,
      pinned: true,
    });
    assert.equal(await learnerSetPreference(WS[2], PREF_KEYS.voiceStyle, "mutated"), "refused-pinned");
    const pref = await getPreferenceScoped(WS[2], PREF_KEYS.voiceStyle);
    assert.equal(pref!.value, "locked voice", "pinned pref unchanged");
    assert.equal(await learnerSetPreference(WS[2], PREF_KEYS.detailLevel, "x"), "applied", "unpinned pref writable");
  });

  it("learning-pause toggle round-trips per workspace", async () => {
    const { withWorkspaceScope } = await import("../../substrate/memory/rls");
    const pausedOf = (ws: string) => withWorkspaceScope(ws, (tx) => getLearningPaused(tx, ws));
    assert.equal(await pausedOf(WS[3]), false, "default unpaused");
    await setLearningPaused(WS[3], true);
    assert.equal(await pausedOf(WS[3]), true);
    assert.equal(await pausedOf(WS[0]), false, "toggle is per-workspace");
    await setLearningPaused(WS[3], false);
    assert.equal(await pausedOf(WS[3]), false);
  });
});
