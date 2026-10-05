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
