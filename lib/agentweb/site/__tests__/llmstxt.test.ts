// Phase 21A (WS=agentweb): llms.txt, golden output. The format is llmstxt.org's:
// an H1 title, a blockquote summary, optional prose, then H2 sections of
// "- [title](url): notes" links; a section named "Optional" is skippable.
// (Honest limit: llms.txt is on roughly 9% of the top 1,000 sites and one study
// found no verified AI-crawler fetches of it. We emit it because it is cheap and
// harmless, not because it is proven to matter.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLlmsTxt, parseLlmsTxt } from "../llmstxt";

const INPUT = {
  name: "Riverside Dental",
  summary: "A family dental practice in Riverside. NHS and private appointments.",
  details: "We are open Monday to Friday, 9:00 to 17:00.",
  sections: [
    {
      title: "Pages",
      links: [
        { title: "Opening hours", url: "https://riverside.test/hours", notes: "When we are open" },
        { title: "Prices", url: "https://riverside.test/prices" },
      ],
    },
    { title: "Optional", links: [{ title: "Blog", url: "https://riverside.test/blog", notes: "Oral health articles" }] },
  ],
};

const GOLDEN = `# Riverside Dental

> A family dental practice in Riverside. NHS and private appointments.

We are open Monday to Friday, 9:00 to 17:00.

## Pages

- [Opening hours](https://riverside.test/hours): When we are open
- [Prices](https://riverside.test/prices)

## Optional

- [Blog](https://riverside.test/blog): Oral health articles
`;

describe("buildLlmsTxt", () => {
  it("matches the golden file", () => assert.equal(buildLlmsTxt(INPUT), GOLDEN));

  it("keeps each field on one line and drops links that are not absolute web addresses", () => {
    const out = buildLlmsTxt({
      name: "A\nB",
      summary: "line one\nline two",
      sections: [{ title: "Pages", links: [{ title: "Good [x]", url: "https://a.test/x" }, { title: "Bad", url: "javascript:alert(1)" }, { title: "Relative", url: "/x" }] }],
    });
    assert.equal(out, "# A B\n\n> line one line two\n\n## Pages\n\n- [Good x](https://a.test/x)\n");
  });

  it("omits an empty section and the optional prose", () => {
    assert.equal(buildLlmsTxt({ name: "X", summary: "S", sections: [{ title: "Empty", links: [] }] }), "# X\n\n> S\n");
  });

  it("refuses a missing name", () => {
    assert.throws(() => buildLlmsTxt({ name: "  ", summary: "s", sections: [] }), /name/);
  });
});

describe("parseLlmsTxt", () => {
  it("reads what buildLlmsTxt wrote", () => {
    const p = parseLlmsTxt(GOLDEN);
    assert.deepEqual([p.valid, p.title, p.summary, p.sections.map((s) => [s.title, s.links.length])], [true, "Riverside Dental", "A family dental practice in Riverside. NHS and private appointments.", [["Pages", 2], ["Optional", 1]]]);
  });
  it("says what is wrong with a file that is not llms.txt", () => {
    const p = parseLlmsTxt("<html><body>Not found</body></html>");
    assert.equal(p.valid, false);
    assert.deepEqual(p.problems, ["There is no # title on the first line.", "There is no > summary line.", "There are no sections with links."]);
  });
});
