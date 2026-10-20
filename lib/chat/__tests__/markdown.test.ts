// ShapesOS — Phase 22 (chat): the transcript's markdown parser (PURE).
// Raw HTML is never rendered: it stays text. Links keep only safe schemes.
// Run: env -u DATABASE_URL npx tsx --test lib/chat/__tests__/markdown.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, safeHref, type MdBlock } from "../markdown";

describe("parseMarkdown", () => {
  it("paragraphs, headings, emphasis, inline code and links", () => {
    const blocks = parseMarkdown("# Rankings\n\nThree pages **rank** for `espresso` — see [the report](/dashboard/reports/1).\nSecond line.");
    assert.deepEqual(blocks[0], { t: "h", level: 1, c: [{ t: "text", v: "Rankings" }] });
    const p = blocks[1] as Extract<MdBlock, { t: "p" }>;
    assert.deepEqual(p.c, [
      { t: "text", v: "Three pages " },
      { t: "strong", c: [{ t: "text", v: "rank" }] },
      { t: "text", v: " for " },
      { t: "code", v: "espresso" },
      { t: "text", v: " — see " },
      { t: "link", href: "/dashboard/reports/1", c: [{ t: "text", v: "the report" }] },
      { t: "text", v: "." },
      { t: "br" },
      { t: "text", v: "Second line." },
    ]);
  });

  it("bullet and numbered lists, nested one level, and task items", () => {
    const blocks = parseMarkdown("- one\n- two\n  - two.a\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done");
    const ul = blocks[0] as Extract<MdBlock, { t: "ul" }>;
    assert.equal(ul.items.length, 2);
    assert.deepEqual(ul.items[0], [{ t: "p", c: [{ t: "text", v: "one" }] }]);
    assert.equal((ul.items[1]![1] as Extract<MdBlock, { t: "ul" }>).items.length, 1);
    const ol = blocks[1] as Extract<MdBlock, { t: "ol" }>;
    assert.equal(ol.start, 1);
    assert.equal(ol.items.length, 2);
    const tasks = blocks[2] as Extract<MdBlock, { t: "ul" }>;
    assert.deepEqual(tasks.checks, [false, true]);
  });

  it("fenced code keeps its text verbatim (no inline parsing) and its language", () => {
    const blocks = parseMarkdown("```ts\nconst a = **not bold**;\n```\nafter");
    assert.deepEqual(blocks[0], { t: "code", lang: "ts", v: "const a = **not bold**;" });
    assert.deepEqual(blocks[1], { t: "p", c: [{ t: "text", v: "after" }] });
  });

  it("GFM tables with alignment, block quotes and rules", () => {
    const blocks = parseMarkdown("| Keyword | Volume |\n|:--|--:|\n| espresso | 1200 |\n\n> quoted\n\n---");
    const table = blocks[0] as Extract<MdBlock, { t: "table" }>;
    assert.deepEqual(table.head.map((c) => c[0]), [{ t: "text", v: "Keyword" }, { t: "text", v: "Volume" }]);
    assert.deepEqual(table.align, ["left", "right"]);
    assert.deepEqual(table.rows[0]![1], [{ t: "text", v: "1200" }]);
    assert.deepEqual(blocks[1], { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "quoted" }] }] });
    assert.deepEqual(blocks[2], { t: "hr" });
  });

  it("raw HTML is text, never markup", () => {
    const blocks = parseMarkdown('<script>alert(1)</script> and <b onclick="x">bold</b>');
    const p = blocks[0] as Extract<MdBlock, { t: "p" }>;
    assert.deepEqual(p.c, [{ t: "text", v: '<script>alert(1)</script> and <b onclick="x">bold</b>' }]);
  });

  it("links keep http(s), mailto and in-app paths; javascript:, data: and protocol-relative are dropped to text", () => {
    assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(safeHref("mailto:ops@example.com"), "mailto:ops@example.com");
    assert.equal(safeHref("/dashboard/ops/leads/1"), "/dashboard/ops/leads/1");
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("JavaScript:alert(1)"), null);
    assert.equal(safeHref("data:text/html,x"), null);
    assert.equal(safeHref("//evil.example"), null);
    const p = parseMarkdown("[x](javascript:alert(1))")[0] as Extract<MdBlock, { t: "p" }>;
    assert.deepEqual(p.c, [{ t: "text", v: "x" }]);
  });

  it("unterminated emphasis and stray markers stay literal", () => {
    const p = parseMarkdown("a * b ** c `d")[0] as Extract<MdBlock, { t: "p" }>;
    assert.deepEqual(p.c, [{ t: "text", v: "a * b ** c `d" }]);
  });
});
