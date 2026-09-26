// Marketr — Phase 9 M3: command-bar logic tests.
// Run: npx tsx --test components/command-bar/__tests__/commandbar.test.ts
// These test the pure logic in ../lib.ts — no React, no DOM.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AsyncBudgetExceeded,
  buildAskAuditPayload,
  buildDoAuditPayload,
  buildGoAuditPayload,
  buildTemplateAuditPayload,
  damerauLevenshtein,
  frecencyScore,
  fuzzyScore,
  groupBySection,
  loadFrecency,
  moveSelection,
  rankCommands,
  recordUse,
  renderMissionPrompt,
  saveFrecency,
  shouldPopOnBackspace,
  withTimeout,
  type CommandItem,
  type FrecencyMap,
  type StorageLike,
} from "../lib";

function memStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function item(id: string, section: "go" | "do" | "ask", title: string): CommandItem {
  return { id, section, title, action: "go", href: "/x" };
}

describe("damerauLevenshtein", () => {
  it("scores identical strings 0", () => {
    assert.equal(damerauLevenshtein("reports", "reports"), 0);
  });
  it("counts a single substitution as 1", () => {
    assert.equal(damerauLevenshtein("reports", "reporxs"), 1);
  });
  it("counts an adjacent transposition as 1 (not 2)", () => {
    assert.equal(damerauLevenshtein("abcd", "acbd"), 1);
  });
  it("handles the classic kitten/sitting case", () => {
    assert.equal(damerauLevenshtein("kitten", "sitting"), 3);
  });
  it("is case-insensitive", () => {
    assert.equal(damerauLevenshtein("Reports", "reports"), 0);
  });
});

describe("fuzzyScore", () => {
  it("matches exact substrings with a high score", () => {
    const s = fuzzyScore("report", "Reports & exports");
    assert.ok(s !== null && s > 900, `expected high score, got ${s}`);
  });
  it("tolerates a transposed typo (reprots → Reports)", () => {
    assert.notEqual(fuzzyScore("reprots", "Reports & exports"), null);
  });
  it("tolerates a substituted typo (repirts → Reports)", () => {
    assert.notEqual(fuzzyScore("repirts", "Reports & exports"), null);
  });
  it("is case-insensitive", () => {
    assert.notEqual(fuzzyScore("STUDIO", "Creative studio"), null);
  });
  it("returns null when nothing is close", () => {
    assert.equal(fuzzyScore("zzzqqq", "Reports & exports"), null);
  });
  it("returns 0 for an empty query", () => {
    assert.equal(fuzzyScore("", "anything"), 0);
  });
  it("prefers earlier occurrences over later ones", () => {
    const early = fuzzyScore("studio", "Studio overview")!;
    const late = fuzzyScore("studio", "Open the creative studio")!;
    assert.ok(early > late, `early=${early} late=${late}`);
  });
});

describe("frecency", () => {
  it("recordUse counts up and stamps lastUsed", () => {
    const m = recordUse({}, "a", 1000);
    assert.equal(m["a"].count, 1);
    assert.equal(m["a"].lastUsed, 1000);
    const m2 = recordUse(m, "a", 2000);
    assert.equal(m2["a"].count, 2);
    assert.equal(m2["a"].lastUsed, 2000);
  });
  it("ranks frequent+recent above stale", () => {
    const now = 1_000_000_000;
    const hot = frecencyScore({ count: 5, lastUsed: now - 60_000 }, now);
    const stale = frecencyScore({ count: 5, lastUsed: now - 60 * 86_400_000 }, now);
    const unseen = frecencyScore(undefined, now);
    assert.ok(hot > stale, `hot=${hot} stale=${stale}`);
    assert.equal(unseen, 0);
  });
  it("save/load round-trips through storage", () => {
    const s = memStorage();
    const m: FrecencyMap = { a: { count: 3, lastUsed: 42 } };
    saveFrecency(s, m);
    assert.deepEqual(loadFrecency(s), m);
  });
  it("loadFrecency returns {} on corrupt data", () => {
    const s = memStorage();
    s.data["marketr:command-bar:frecency:v1"] = "not-json{{{";
    assert.deepEqual(loadFrecency(s), {});
  });
});

describe("rankCommands", () => {
  const items = [item("g1", "go", "Overview"), item("g2", "go", "Studio"), item("d1", "do", "Start a mission")];

  it("orders by frecency when the query is empty", () => {
    const now = Date.now();
    const frec: FrecencyMap = {
      g2: { count: 4, lastUsed: now },
      g1: { count: 1, lastUsed: now - 30 * 86_400_000 },
    };
    const ranked = rankCommands(items, "", frec, now);
    assert.equal(ranked[0].id, "g2");
    assert.equal(ranked[1].id, "g1");
  });
  it("filters with typo-tolerant fuzzy match", () => {
    const ranked = rankCommands(items, "studo", {}, Date.now());
    assert.ok(ranked.some((i) => i.id === "g2"), "Studio should match 'studo'");
    assert.ok(!ranked.some((i) => i.id === "g1"), "Overview should not match 'studo'");
  });
  it("keeps Go → Do → Ask section order", () => {
    const mixed = [item("a1", "ask", "Ask"), item("d1", "do", "Do"), item("g1", "go", "Go")];
    const ranked = rankCommands(mixed, "", {}, Date.now());
    assert.deepEqual(ranked.map((i) => i.section), ["go", "do", "ask"]);
  });
});

describe("groupBySection", () => {
  it("groups in Go/Do/Ask order and drops empty sections", () => {
    const groups = groupBySection([item("d1", "do", "Do"), item("g1", "go", "Go")]);
    assert.deepEqual(groups.map((g) => g.section), ["go", "do"]);
    assert.equal(groups[0].label, "Go");
    assert.equal(groups[0].items.length, 1);
  });
});

describe("keyboard contract helpers", () => {
  it("moveSelection wraps down past the end", () => {
    assert.equal(moveSelection(4, 1, 5), 0);
  });
  it("moveSelection wraps up past the start", () => {
    assert.equal(moveSelection(0, -1, 5), 4);
  });
  it("moveSelection steps normally in the middle", () => {
    assert.equal(moveSelection(2, 1, 5), 3);
    assert.equal(moveSelection(2, -1, 5), 1);
  });
  it("moveSelection returns 0 for an empty list", () => {
    assert.equal(moveSelection(0, 1, 0), 0);
  });
  it("Backspace pops only on an empty query in a nested page", () => {
    assert.equal(shouldPopOnBackspace("", true), true);
    assert.equal(shouldPopOnBackspace("", false), false);
    assert.equal(shouldPopOnBackspace("abc", true), false);
  });
});

describe("audit payload shapes", () => {
  it("template payload carries templateId and a rendered prompt (hashed server-side)", () => {
    const p = buildTemplateAuditPayload("home-services:booked-jobs", "Grow booked jobs this quarter", "Mission started.");
    assert.equal(p.kind, "template");
    assert.equal(p.templateId, "home-services:booked-jobs");
    assert.ok(p.prompt?.includes("home-services:booked-jobs"));
    assert.ok(p.prompt?.includes("Grow booked jobs this quarter"));
    assert.ok(!("promptFull" in p), "client payload must never carry a promptFull field");
  });
  it("renderMissionPrompt is canonical and deterministic", () => {
    const a = renderMissionPrompt("t1", "goal");
    const b = renderMissionPrompt("t1", "goal");
    assert.equal(a, b);
    assert.equal(a, 'Start mission from template "t1" with goal "goal".');
  });
  it("ask payload carries the FULL prompt", () => {
    const q = "Which campaign drove the most booked jobs last month?";
    const p = buildAskAuditPayload(q);
    assert.equal(p.kind, "ask");
    assert.equal(p.prompt, q, "free-form asks log the full prompt, verbatim");
    assert.equal(p.templateId, undefined);
  });
  it("go payload logs the route", () => {
    const p = buildGoAuditPayload("/dashboard/studio");
    assert.equal(p.kind, "go");
    assert.ok(p.prompt?.includes("/dashboard/studio"));
  });
  it("do payload labels the action", () => {
    const p = buildDoAuditPayload("Run playbook step", "pb-1 — done");
    assert.equal(p.kind, "do");
    assert.ok(p.prompt?.includes("pb-1"));
  });
});

describe("withTimeout", () => {
  it("resolves fast promises", async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 500), 7);
  });
  it("rejects with AsyncBudgetExceeded when slow", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve(1), 200));
    await assert.rejects(() => withTimeout(slow, 20), AsyncBudgetExceeded);
  });
});
