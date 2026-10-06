// ShapesOS — ⌘K "Records" section (Phase 4a), pure parts.
// Run: npx tsx --test components/command-bar/__tests__/records.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SECTION_ORDER,
  SECTION_LABELS,
  groupBySection,
  mergeBySection,
  moveSelection,
  recordCommandItems,
  shouldSearchRecords,
  type CommandItem,
} from "../lib";
import { RECORD_KIND_LABELS } from "@/lib/search/kinds";

const item = (id: string, section: CommandItem["section"]): CommandItem => ({ id, section, title: id, action: "go", href: "/dashboard" });

describe("records section", () => {
  it("sits between Go and Do (after the kit's Agents, Actions and Tools)", () => {
    assert.deepEqual(SECTION_ORDER, ["agents", "actions", "tools", "go", "records", "do", "ask"]);
    assert.equal(SECTION_LABELS.records, "Records");
  });

  it("searches only on the root page with at least two characters", () => {
    assert.equal(shouldSearchRecords("a", true), false);
    assert.equal(shouldSearchRecords("  ab ", true), true);
    assert.equal(shouldSearchRecords("ada", false), false);
  });

  it("maps results to go-actions with kind labels and drops off-site links", () => {
    const items = recordCommandItems(
      [
        { kind: "lead", id: "l1", title: "Ada", subtitle: "Acme", href: "/dashboard/crm?lead=l1" },
        { kind: "doc", id: "d1", title: "Plan", subtitle: null, href: "/dashboard/office?open=d1" },
        { kind: "lead", id: "x", title: "Evil", subtitle: null, href: "https://evil.test" },
        { kind: "lead", id: "y", title: "Evil", subtitle: null, href: "//evil.test" },
      ],
      RECORD_KIND_LABELS,
    );
    assert.deepEqual(
      items.map((i) => [i.id, i.section, i.action, i.href, i.subtitle]),
      [
        ["record:lead:l1", "records", "go", "/dashboard/crm?lead=l1", "Lead · Acme"],
        ["record:doc:d1", "records", "go", "/dashboard/office?open=d1", "Doc"],
      ],
    );
  });

  it("merges records so the flat (keyboard) order matches the visual groups", () => {
    const ranked = [item("g1", "go"), item("g2", "go"), item("d1", "do")];
    const merged = mergeBySection(ranked, [item("r1", "records"), item("r2", "records")]);
    assert.deepEqual(merged.map((i) => i.id), ["g1", "g2", "r1", "r2", "d1"]);
    const groups = groupBySection(merged);
    assert.deepEqual(groups.map((g) => g.section), ["go", "records", "do"]);
    // ↓ from the last Go row lands on the first record.
    assert.equal(merged[moveSelection(1, 1, merged.length)]!.id, "r1");
  });
});

// Phase 18.1 (Spotlight): records carry the match, the snippet and the
// record itself (for Ask about this / Act on it), group by kind, and the
// hand-off message names the record the agent reads with search_workspace.
import { recordKindRuns, recordTaskMessage, snippetSegments, RECORD_LIMIT, RECORD_LIMIT_EVERYTHING } from "../lib";

describe("Spotlight records (Phase 18.1)", () => {
  const results = [
    { kind: "file_content", id: "f1", title: "q3.pdf", subtitle: "/files/q3.pdf", href: "/dashboard/files", score: 0.4, match: ["text"], snippet: "the ⟦tamarillo⟧ plan", actions: [{ id: "summarize", tool: "create_content_draft", instruction: "Summarize." }] },
    { kind: "file_content", id: "f2", title: "q4.pdf", subtitle: null, href: "/dashboard/files", match: ["meaning"] },
    { kind: "ticket", id: "t1", title: "#7 Jam", subtitle: "open", href: "/dashboard/ops/helpdesk?ticket=t1" },
  ];

  it("keeps the record, its match and snippet on the palette item", () => {
    const items = recordCommandItems(results, { file_content: "Inside files and docs", ticket: "Ticket" });
    assert.equal(items[0]!.record?.id, "f1");
    assert.deepEqual(items[0]!.match, ["text"]);
    assert.equal(items[0]!.snippet, "the ⟦tamarillo⟧ plan");
    assert.equal(items[0]!.subtitle, "Inside files and docs · /files/q3.pdf");
    assert.equal(items[1]!.snippet, undefined);
  });

  it("groups consecutive records by kind for the sub-headings", () => {
    const items = recordCommandItems(results, {});
    assert.deepEqual(recordKindRuns(items), [
      { kind: "file_content", start: 0, count: 2 },
      { kind: "ticket", start: 2, count: 1 },
    ]);
  });

  it("splits snippet marks into emphasis segments (text only, never markup)", () => {
    assert.deepEqual(snippetSegments("a ⟦b⟧ c ⟦<i>⟧"), [
      { text: "a ", hit: false },
      { text: "b", hit: true },
      { text: " c ", hit: false },
      { text: "<i>", hit: true },
    ]);
    assert.deepEqual(snippetSegments(null), []);
  });

  it("the hand-off message carries the record reference for search_workspace", () => {
    const msg = recordTaskMessage("Tell me about this file: q3.pdf", results[0]!);
    assert.match(msg, /^Tell me about this file: q3\.pdf\n\nRecord: file_content:f1 — q3\.pdf \(\/dashboard\/files\)/);
    assert.match(msg, /Matched: the tamarillo plan/);
    assert.match(msg, /search_workspace/);
    assert.ok(RECORD_LIMIT_EVERYTHING > RECORD_LIMIT);
  });
});
