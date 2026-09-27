// Marketr — Phase 11 "Canvas" FEATURE 5: template variables + batch tests.
// Run: npx tsx --test lib/design/__tests__/variables.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BATCH_VARIANTS,
  buildBatchPages,
  csvToValueRows,
  extractVariables,
  parseCsv,
  substituteVariables,
  validateSubstitution,
} from "../variables";
import { newId, type DesignPage } from "../types";

function templatePage(text: string): DesignPage {
  return {
    id: "template-page",
    name: "Template",
    width: 1080,
    height: 1080,
    background: "#ffffff",
    elements: [
      {
        id: "el-headline",
        type: "text",
        name: "Headline",
        x: 100,
        y: 100,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        text,
        fontFamily: "Inter",
        fontSize: 64,
        fontStyle: "bold",
        fill: "#1c1917",
        align: "center",
        lineHeight: 1.2,
        letterSpacing: 0,
        width: 880,
      },
    ],
  };
}

describe("extractVariables", () => {
  it("finds placeholders, trims whitespace, dedupes in first-appearance order", () => {
    const vars = extractVariables(
      "50% off {{product}} — ends {{ date }}. {{product}} again, then {{cta_text}}",
    );
    assert.deepEqual(vars, ["product", "date", "cta_text"]);
  });

  it("ignores invalid names: spaces, dashes, empty, lone braces", () => {
    assert.deepEqual(extractVariables("{{product name}} {{price-$}} {{}} {{ }} {notavariable}"), []);
  });

  it("extracts from every text element on a page (and fragments)", () => {
    const page = templatePage("Buy {{product}}");
    const frag = page.elements[0];
    assert.equal(frag.type, "text");
    if (frag.type === "text") {
      frag.fragments = [{ text: "Only {{date}} left" }];
    }
    page.elements.push({
      ...JSON.parse(JSON.stringify(page.elements[0])),
      id: "el-2",
      text: "Use code {{code}}",
      fragments: undefined,
    });
    assert.deepEqual(extractVariables(page), ["product", "date", "code"]);
  });
});

describe("substituteVariables", () => {
  it("replaces known variables and leaves unknown ones intact", () => {
    const out = substituteVariables("{{greeting}}, {{name}}! Sale ends {{date}}.", {
      greeting: "Hello",
      name: "Tico",
    });
    assert.equal(out, "Hello, Tico! Sale ends {{date}}.");
  });

  it("handles values with $ and other replacement-pattern chars literally", () => {
    const out = substituteVariables("Price: {{price}}", { price: "$5 & $10" });
    assert.equal(out, "Price: $5 & $10");
  });

  it("handles empty values and repeated placeholders", () => {
    const out = substituteVariables("{{a}} and {{a}}", { a: "" });
    assert.equal(out, " and ");
  });
});

describe("validateSubstitution", () => {
  it("reports missing variables once each", () => {
    assert.deepEqual(
      validateSubstitution("{{product}} for {{date}} and {{product}}", { product: "X" }).missing,
      ["date"],
    );
    assert.deepEqual(
      validateSubstitution("No placeholders", {}).missing,
      [],
    );
  });
});

describe("parseCsv", () => {
  it("handles quoted commas and escaped quotes", () => {
    const rows = parseCsv('product,headline\n"Widget, Pro","Say ""hi"""\nBasic,Hello');
    assert.deepEqual(rows, [
      ["product", "headline"],
      ["Widget, Pro", 'Say "hi"'],
      ["Basic", "Hello"],
    ]);
  });

  it("handles \\r\\n and drops blank lines", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n\r\n3,4\n");
    assert.deepEqual(rows, [
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("csvToValueRows", () => {
  it("maps headers to variables; reports unmatched headers and missing variables", () => {
    const res = csvToValueRows(
      "product,date,extra\nWidget,Friday,zzz\nGadget,Monday,yyy",
      ["product", "date", "cta"],
    );
    assert.deepEqual(res.rows, [
      { product: "Widget", date: "Friday" },
      { product: "Gadget", date: "Monday" },
    ]);
    assert.deepEqual(res.unmatchedHeaders, ["extra"]);
    assert.deepEqual(res.missingVariables, ["cta"]);
  });

  it("yields no rows when no header matches any variable", () => {
    const res = csvToValueRows("foo,bar\n1,2", ["product"]);
    assert.deepEqual(res.rows, []);
    assert.deepEqual(res.unmatchedHeaders, ["foo", "bar"]);
  });

  it("trims cells and tolerates short rows", () => {
    const res = csvToValueRows("product,date\n  Widget  \n", ["product", "date"]);
    assert.deepEqual(res.rows, [{ product: "Widget", date: "" }]);
  });
});

describe("buildBatchPages", () => {
  it("clones the template per row with substituted text and fresh ids", () => {
    const page = templatePage("50% off {{product}} — ends {{date}}");
    const pages = buildBatchPages(page, [
      { product: "Widget", date: "Friday" },
      { product: "Gadget", date: "Monday" },
    ]);
    assert.equal(pages.length, 2);
    assert.equal(pages[0]!.name, "Variant 1");
    assert.equal(pages[1]!.name, "Variant 2");

    const texts = pages.map(
      (p) => (p.elements[0]!.type === "text" ? (p.elements[0] as { text: string }).text : ""),
    );
    assert.deepEqual(texts, [
      "50% off Widget — ends Friday",
      "50% off Gadget — ends Monday",
    ]);

    // Fresh ids everywhere — no id shared with the template or across variants.
    const ids = pages.flatMap((p) => [p.id, ...p.elements.map((e) => e.id)]);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes("template-page") && !ids.includes("el-headline"));

    // The template itself is untouched (no mutation through shared references).
    assert.equal(
      (page.elements[0] as { text: string }).text,
      "50% off {{product}} — ends {{date}}",
    );
  });

  it("caps output at MAX_BATCH_VARIANTS (100)", () => {
    assert.equal(MAX_BATCH_VARIANTS, 100);
    const page = templatePage("Hi {{name}}");
    const rows = Array.from({ length: 150 }, (_, i) => ({ name: `n${i}` }));
    const pages = buildBatchPages(page, rows);
    assert.equal(pages.length, 100);
    assert.equal(pages[99]!.name, "Variant 100");
  });

  it("leaves unknown variables intact in generated variants", () => {
    const pages = buildBatchPages(templatePage("Use {{code}}"), [{}]);
    const el = pages[0]!.elements[0]!;
    assert.equal(el.type === "text" ? el.text : "", "Use {{code}}");
  });

  it("fresh ids even with zero rows → empty array", () => {
    assert.deepEqual(buildBatchPages(templatePage("x"), []), []);
  });
});

describe("newId freshness", () => {
  it("generates unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("el")));
    assert.equal(ids.size, 500);
  });
});
