// Marketr milestone 17 — fixture tests for the programmatic SEO engine
// (substitution, slug building, CSV parsing, Tiptap helpers, hashing,
// quality gates). Pure functions only: no database, no network.
//
// Run: npx tsx scripts/verify-m17-programmatic.mts

import {
  buildPageUrl,
  duplicateRate,
  evaluateGates,
  extractVariables,
  generatePage,
  hashPageContent,
  normalizeUrlPattern,
  parseCsv,
  QUALITY_FLAGS,
  requiredVariables,
  resolveRowValues,
  simpleBlocksToTiptap,
  slugify,
  substitute,
  templateVariables,
  tiptapText,
  tiptapToHtml,
  tiptapToSimpleBlocks,
  tiptapWordCount,
} from "@/lib/seo/programmatic";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function ok(cond: boolean, name: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
  }
}

// --- normalizeUrlPattern ---
eq(normalizeUrlPattern("/services/{city}/{service}"), "/services/{{city}}/{{service}}", "url pattern: single braces normalized");
eq(normalizeUrlPattern("/services/{{city}}/{{service}}"), "/services/{{city}}/{{service}}", "url pattern: double braces untouched");
eq(normalizeUrlPattern("/a/{x}/{{y}}/z"), "/a/{{x}}/{{y}}/z", "url pattern: mixed forms");

// --- extractVariables ---
const vars = extractVariables("Hello {{city}}, {{service|general}} and {{city}}");
eq(vars, [{ name: "city" }, { name: "service", fallback: "general" }], "extractVariables dedupe + fallback");
eq(requiredVariables(vars), ["city"], "requiredVariables excludes fallback vars");
eq(extractVariables("no vars here"), [], "extractVariables empty");

// --- slugify ---
eq(slugify("New York"), "new-york", "slugify spaces");
eq(slugify("Café & Bar!"), "cafe-bar", "slugify diacritics + symbols");
eq(slugify("  ---  "), "page", "slugify empty → page");
ok(slugify("a".repeat(200)).length <= 96, "slugify length cap");

// --- substitute ---
eq(substitute("Hi {{name}}", { name: "Bo" }), { text: "Hi Bo", missing: [] }, "substitute basic");
eq(substitute("Hi {{name|friend}}", {}), { text: "Hi friend", missing: [] }, "substitute fallback used");
eq(substitute("Hi {{name|friend}}", { name: "  " }), { text: "Hi friend", missing: [] }, "substitute blank value → fallback");
eq(substitute("Hi {{name}}", {}), { text: "Hi ", missing: ["name"] }, "substitute missing reported");
eq(substitute("{{a}} {{a}}", {}), { text: " ", missing: ["a"] }, "substitute missing deduped");

// --- buildPageUrl ---
eq(
  buildPageUrl("/services/{city}/{service}", { city: "New York", service: "Plumbing" }),
  { url: "/services/new-york/plumbing", missing: [], slug: "services/new-york/plumbing" },
  "buildPageUrl full",
);
eq(
  buildPageUrl("/services/{{city}}", {}),
  { url: "/services/page", missing: ["city"], slug: "services/page" },
  "buildPageUrl missing var → slugified empty segment",
);

// --- parseCsv ---
const csv1 = parseCsv('city,service\nAustin,Plumbing\n"Dallas, TX","Roof Repair"\n');
eq(csv1.columns, ["city", "service"], "csv columns");
eq(csv1.rows, [
  { city: "Austin", service: "Plumbing" },
  { city: "Dallas, TX", service: "Roof Repair" },
], "csv quoted comma");
const csv2 = parseCsv('a,b\r\n"x\ny","p""q"\r\n');
eq(csv2.rows, [{ a: "x\ny", b: 'p"q' }], "csv quoted newline + escaped quote + CRLF");
const csv3 = parseCsv('\uFEFFa\n1\n\n');
eq(csv3, { columns: ["a"], rows: [{ a: "1" }] }, "csv BOM + trailing blank line");
eq(parseCsv(""), { columns: [], rows: [] }, "csv empty");

// --- Tiptap helpers ---
const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plumbing in Austin" }] },
    { type: "paragraph", content: [{ type: "text", text: "Best " }, { type: "text", marks: [{ type: "bold" }], text: "plumbers" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Fast" }] }] }] },
  ],
};
eq(tiptapText(doc), "Plumbing in Austin\nBest plumbers\nFast", "tiptapText");
eq(tiptapWordCount(doc), 6, "tiptapWordCount");
const html = tiptapToHtml(doc);
ok(html.includes("<h1>Plumbing in Austin</h1>"), "tiptapToHtml heading");
ok(html.includes("<strong>plumbers</strong>"), "tiptapToHtml bold");
ok(html.includes("<ul><li><p>Fast</p></li></ul>"), "tiptapToHtml bullet list");
ok(tiptapToHtml({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<script>" }] }] }).includes("&lt;script&gt;"), "tiptapToHtml escapes");
eq(tiptapWordCount({ type: "doc", content: [] }), 0, "tiptapWordCount empty");

// --- simple blocks round-trip ---
const simple = [
  { type: "h1" as const, text: "{{service}} in {{city}}" },
  { type: "paragraph" as const, text: "Call us today" },
  { type: "bullet" as const, text: "Licensed" },
];
const back = tiptapToSimpleBlocks(simpleBlocksToTiptap(simple));
eq(back, simple, "simple blocks round-trip");

// --- hashing ---
const h1 = hashPageContent({ title: "A", description: "B", blocks: doc });
const h2 = hashPageContent({ title: "A ", description: "  B", blocks: doc });
eq(h1, h2, "hash whitespace-insensitive");
ok(h1 !== hashPageContent({ title: "A", description: "C", blocks: doc }), "hash changes with content");
ok(/^[0-9a-f]{64}$/.test(h1), "hash is sha256 hex");

// --- duplicateRate ---
eq(duplicateRate(["a", "b", "c"]), 0, "duplicateRate all unique");
eq(duplicateRate(["a", "a", "b", "c"]), 0.5, "duplicateRate half duplicated");
eq(duplicateRate(["a", "a", "a"]), 1, "duplicateRate all same");
eq(duplicateRate(["a"]), 0, "duplicateRate single");
eq(duplicateRate([null, undefined, "a", "a"]), 1, "duplicateRate ignores nulls");

// --- generatePage ---
const template = {
  urlPattern: "/services/{city}/{service}",
  titleTemplate: "{{service}} in {{city}}",
  descriptionTemplate: "Top {{service}} in {{city|your area}}.",
  contentBlocks: simpleBlocksToTiptap([
    { type: "h1", text: "{{service}} in {{city}}" },
    { type: "paragraph", text: "We offer {{service}} across {{city}}. Call {{phone}} today for a free quote on {{service}}." },
  ]),
  minWordCount: 5,
  duplicateRateCap: 0.05,
};
const gen = generatePage(template, { city: "Austin", service: "Plumbing" }, "https://example.com");
eq(gen.url, "/services/austin/plumbing", "generatePage url");
eq(gen.title, "Plumbing in Austin", "generatePage title");
eq(gen.canonical, "https://example.com/services/austin/plumbing", "generatePage canonical");
eq(gen.missingVariables, ["phone"], "generatePage missing vars");
ok(gen.flags.includes(QUALITY_FLAGS.missingVariable), "generatePage missing_variable flag");
ok(!gen.flags.includes(QUALITY_FLAGS.thinContent), "generatePage not thin");
ok(gen.wordCount >= 5, "generatePage word count");

const genFallback = generatePage(
  { ...template, descriptionTemplate: "Top {{service}} in {{city|your area}}." },
  { service: "Plumbing" },
  "https://example.com",
);
eq(genFallback.description, "Top Plumbing in your area.", "generatePage fallback in description");

const thinTemplate = { ...template, minWordCount: 1000 };
const genThin = generatePage(thinTemplate, { city: "Austin", service: "Plumbing", phone: "555" }, "https://example.com");
ok(genThin.flags.includes(QUALITY_FLAGS.thinContent), "generatePage thin_content flag");

eq(
  templateVariables(template).map((v) => v.name).sort(),
  ["city", "phone", "service"],
  "templateVariables union",
);

// --- resolveRowValues ---
eq(
  resolveRowValues(["city", "service"], ["City", "Service"], { City: "Austin", Service: "Plumbing" }, {}),
  { city: "Austin", service: "Plumbing" },
  "resolveRowValues case-insensitive auto-map",
);
eq(
  resolveRowValues(["city"], ["town"], { town: "Austin" }, { city: "town" }),
  { city: "Austin" },
  "resolveRowValues explicit mapping",
);
eq(
  resolveRowValues(["city"], ["town"], { town: "Austin" }, {}),
  { city: "" },
  "resolveRowValues unmapped → empty",
);

// --- evaluateGates ---
const base = {
  flags: [] as string[],
  missingVariables: [] as string[],
  wordCount: 400,
  minWordCount: 300,
  templateDuplicateRate: 0,
  duplicateRateCap: 0.05,
  checkDuplicateRate: false,
};
eq(evaluateGates(base), { pass: true, reasons: [] }, "gates pass clean");
ok(!evaluateGates({ ...base, flags: [QUALITY_FLAGS.missingVariable], missingVariables: ["city"] }).pass, "gates block missing var");
ok(
  evaluateGates({ ...base, flags: [QUALITY_FLAGS.missingVariable], missingVariables: ["city"] }).reasons[0].includes("city"),
  "gates name the missing variable",
);
ok(!evaluateGates({ ...base, flags: [QUALITY_FLAGS.thinContent], wordCount: 10 }).pass, "gates block thin content");
ok(!evaluateGates({ ...base, flags: [QUALITY_FLAGS.duplicateContent] }).pass, "gates block duplicates");
ok(!evaluateGates({ ...base, flags: [QUALITY_FLAGS.slugCollision] }).pass, "gates block slug collision");
// Duplicate-rate cap only enforced on publish.
ok(evaluateGates({ ...base, templateDuplicateRate: 0.5, checkDuplicateRate: false }).pass, "approve ignores duplicate-rate cap");
const blocked = evaluateGates({ ...base, templateDuplicateRate: 0.5, checkDuplicateRate: true });
ok(!blocked.pass && blocked.reasons[0].includes("50.0%"), "publish enforces duplicate-rate cap");

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
