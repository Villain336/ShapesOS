// ShapesOS — Phase 18.1 (WS=find): Spotlight pure parts (unit, no database).
//   query parsing · the ranking blend · the source registry (kinds,
//   catalogue labels, actions are registered Tier-checked tools) · the
//   full-text expressions match the migration · text extraction + chunking ·
//   record refs · meaning-search statuses.
// Run: npx tsx --test lib/search/__tests__/spotlight.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { normalizeQuery, parseQuery, likePattern } from "../query";
import { blend, compareItems, meaningComponent, nameComponent, orderHits, RANK_WEIGHTS, textComponent } from "../rank";
import { KIND_ALIASES, RECORD_KINDS, RECORD_KIND_LABELS, MATCH_MODES } from "../kinds";
import { SOURCES } from "../sources";
import { FTS_DOCS, ftsIndexSql, ftsVector, qualify } from "../fts";
import { chunkText, extractFileText, stripTags, TEXT_INDEX_LIMITS } from "../text-index";
import { parseRecordRef } from "../tool";
import { queryVector, setSpotlightEmbedder } from "../semantic";
import { en } from "@/lib/i18n/messages/en";
import { es } from "@/lib/i18n/messages/es";
import { getTool, toolAction, toolGroup } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("query parsing", () => {
  it("normalizes and refuses tiny queries", () => {
    assert.equal(normalizeQuery("  a \u0000 b  "), "a b");
    assert.equal(normalizeQuery("x"), null);
    assert.equal(normalizeQuery(42), null);
    assert.equal(normalizeQuery("y".repeat(300))?.length, 100);
  });

  it("splits filters, phrases, exclusions and OR", () => {
    const q = parseQuery('q3 "board memo" in:files -draft or budget kind:deal')!;
    assert.deepEqual(q.kinds.sort(), ["deal", "file", "file_content"].sort());
    assert.equal(q.name, "q3 board memo budget");
    assert.equal(q.fts, 'q3 "board memo" -draft or budget');
    assert.deepEqual(q.phrases, ["board memo"]);
    assert.deepEqual(q.excluded, ["draft"]);
    assert.deepEqual(q.terms, ["q3", "budget"]);
  });

  it("unknown kinds stay words; filters alone are not a query", () => {
    assert.equal(parseQuery("in:spaceships rocket")!.name, "in:spaceships rocket");
    assert.equal(parseQuery("kind:file"), null);
    assert.equal(parseQuery("-only"), null);
  });

  it("LIKE wildcards are literal", () => {
    assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
  });
});

describe("ranking blend", () => {
  it("weights sum to 1 and every component is 0..1", () => {
    assert.equal(RANK_WEIGHTS.name + RANK_WEIGHTS.text + RANK_WEIGHTS.meaning, 1);
    assert.equal(textComponent(0), 0);
    assert.ok(textComponent(10) > 0.98 && textComponent(10) < 1);
    assert.equal(meaningComponent(null), 0);
    assert.equal(meaningComponent(0.2), 0, "below the noise floor");
    assert.equal(meaningComponent(1), 1);
  });

  it("exact > prefix > contains > similar > nothing", () => {
    const base = { query: "acme", nameSim: 0.5, nameHit: true };
    const exact = nameComponent({ ...base, title: "Acme" });
    const prefix = nameComponent({ ...base, title: "Acme Corp" });
    const contains = nameComponent({ ...base, title: "The Acme Corp" });
    const similar = nameComponent({ title: "Acne", query: "acme", nameSim: 0.4, nameHit: false });
    const none = nameComponent({ title: "Zed", query: "acme", nameSim: 0.1, nameHit: false });
    assert.ok(exact > prefix && prefix > contains && contains > similar && similar > none);
    assert.equal(exact, 1);
    assert.equal(none, 0);
  });

  it("a name match beats a text-only match; meaning alone can't beat a literal hit", () => {
    const name = blend({ title: "Ostrava plan", query: "ostrava", nameSim: 0.6, nameHit: true, ftsRank: 0, vsim: null });
    const text = blend({ title: "Report", query: "ostrava", nameSim: 0, nameHit: false, ftsRank: 0.1, vsim: null });
    const meaning = blend({ title: "Report", query: "ostrava", nameSim: 0, nameHit: false, ftsRank: 0, vsim: 0.9 });
    assert.ok(name.score > text.score && text.score > meaning.score);
    assert.deepEqual(name.match, ["name"]);
    assert.deepEqual(text.match, ["text"]);
    assert.deepEqual(meaning.match, ["meaning"]);
    assert.deepEqual(blend({ title: "x", query: "ostrava", nameSim: 0, nameHit: false, ftsRank: 0, vsim: 0.1 }), { score: 0, match: [] });
  });

  it("orders deterministically: groups by best score, ties by recency, kind order, id", () => {
    const d = (s: string) => new Date(s);
    const hits = [
      { kind: "file" as const, id: "b", score: 0.4, updatedAt: d("2026-01-01") },
      { kind: "lead" as const, id: "a", score: 0.9, updatedAt: d("2026-01-01") },
      { kind: "file" as const, id: "a", score: 0.4, updatedAt: d("2026-01-01") },
      { kind: "file" as const, id: "c", score: 0.95, updatedAt: d("2025-01-01") },
      { kind: "lead" as const, id: "z", score: 0.9, updatedAt: d("2026-02-01") },
    ];
    assert.deepEqual(orderHits(hits).map((h) => `${h.kind}:${h.id}`), ["file:c", "file:a", "file:b", "lead:z", "lead:a"]);
    assert.ok(compareItems(hits[2]!, hits[0]!) < 0, "same score + date → id order");
  });
});

describe("source registry", () => {
  it("one source per kind, in kind order, with labels in both languages", () => {
    assert.deepEqual(SOURCES.map((s) => s.kind), [...RECORD_KINDS]);
    for (const k of RECORD_KINDS) {
      assert.ok(RECORD_KIND_LABELS[k], `label ${k}`);
      assert.ok((en.records.kinds as Record<string, string>)[k], `en ${k}`);
      assert.ok((es.records.kinds as Record<string, string>)[k], `es ${k}`);
    }
    for (const s of SOURCES) for (const m of s.modes) assert.ok((MATCH_MODES as readonly string[]).includes(m));
    for (const kinds of Object.values(KIND_ALIASES)) for (const k of kinds) assert.ok((RECORD_KINDS as readonly string[]).includes(k));
  });

  it("act-on-it actions are registered tools, keep their tiers, and are labelled", () => {
    const spot = en.commandBar.spotlight as unknown as { actions: Record<string, string> };
    const spotEs = es.commandBar.spotlight as unknown as { actions: Record<string, string> };
    for (const s of SOURCES) {
      for (const a of s.actions ?? []) {
        const tool = getTool(a.tool);
        assert.ok(tool, `${s.kind}: ${a.tool} is a registered tool`);
        assert.ok(spot.actions[a.id] && spotEs.actions[a.id], `label for action ${a.id}`);
        // The tier comes from the tool, never from Spotlight: a money tool stays Tier 3.
        if (a.tool === "ops_send_invoice") {
          assert.equal(evaluateTier({ kind: toolAction(a.tool), description: `${tool!.name}: ${tool!.description}` }, { automationAllows: true, smallActionThresholdCents: 10_000 }), 3);
        }
      }
    }
  });

  it("search_workspace is a safe, Tier-0 workspace tool", () => {
    const tool = getTool("search_workspace")!;
    assert.equal(tool.kind, "safe");
    assert.equal(toolGroup("search_workspace"), "workspace");
    assert.equal(evaluateTier({ kind: toolAction("search_workspace"), description: `search_workspace: ${tool.description}` }, { automationAllows: true, smallActionThresholdCents: 10_000 }), 0);
  });
});

describe("full-text expressions", () => {
  const migration = readFileSync(join(ROOT, "prisma/migrations/20261020200100_p18_find_spotlight/migration.sql"), "utf8");
  it("every indexed document in lib/search/fts.ts is in the migration verbatim", () => {
    for (const t of Object.keys(FTS_DOCS) as Array<keyof typeof FTS_DOCS>) assert.ok(migration.includes(ftsIndexSql(t)), `${t} index matches`);
  });
  it("qualify() prefixes columns only", () => {
    assert.equal(qualify("name || ' ' || coalesce(email, '')", "t"), "t.name || ' ' || coalesce(t.email, '')");
    assert.equal(qualify("coalesce(goal ->> 'label', template)", "m"), "coalesce(m.goal ->> 'label', m.template)");
    assert.equal(ftsVector("ops_ticket_messages", "mm"), "(to_tsvector('simple', left(mm.body, 20000)) || to_tsvector('english', left(mm.body, 20000)))");
  });
  it("only immutable functions in index expressions", () => {
    for (const doc of Object.values(FTS_DOCS)) assert.doesNotMatch(doc, /concat_ws|array_to_string|now\(|::text\[\]/);
  });
});

describe("text extraction and chunking", () => {
  it("extracts PDF, Markdown, CSV, HTML and plain text; refuses binaries honestly", async () => {
    const ops = "BT (Hello tamarillo) Tj ET\n";
    const d = deflateSync(Buffer.from(ops, "latin1"));
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${d.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), d, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    assert.deepEqual(await extractFileText("a.pdf", "application/pdf", pdf), { status: "indexed", text: "Hello tamarillo", extractor: "pdf" });
    assert.equal((await extractFileText("a.md", "text/markdown", Buffer.from("# Title\nBody"))).status, "indexed");
    assert.match((await extractFileText("a.csv", "text/csv", Buffer.from("name,city\nAna,Lima\n"))).text, /name: Ana \| city: Lima/);
    assert.equal((await extractFileText("a.html", "text/html", Buffer.from("<p>Hi <b>there</b></p><script>x()</script>"))).text.replace(/\s+/g, " ").trim(), "Hi there");
    assert.equal((await extractFileText("a.txt", "text/plain", Buffer.from("plain words"))).text, "plain words");
    assert.equal((await extractFileText("a.png", "image/png", Buffer.from([0x89, 0x50]))).status, "unsupported");
    assert.equal((await extractFileText("a.txt", "text/plain", Buffer.from("bin\u0000ary"))).status, "unsupported");
    const broken = await extractFileText("b.pdf", "application/pdf", Buffer.from("%PDF-1.4 nothing here"));
    assert.equal(broken.status, "failed");
    assert.match(broken.error ?? "", /no extractable text/);
  });

  it("strips tags and scripts", () => {
    assert.equal(stripTags("<style>.a{}</style><div>One</div><p>Two &amp; three</p>").replace(/\s+/g, " ").trim(), "One Two & three");
  });

  it("chunks at paragraph / sentence / word boundaries within the size, capped", () => {
    const para = "Sentence one is here. ".repeat(30);
    const chunks = chunkText(`${para}\n\n${para}`, 200);
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((c) => c.length <= 201 && c.length > 0));
    assert.ok(chunks.slice(0, -1).every((c) => /[.\w]$/.test(c)), "no chunk ends mid-space");
    assert.deepEqual(chunkText("   "), []);
    assert.deepEqual(chunkText(""), []);
    const huge = "word ".repeat(200_000);
    const capped = chunkText(huge);
    assert.ok(capped.join(" ").length <= TEXT_INDEX_LIMITS.maxChars + capped.length);
  });
});

describe("record refs and meaning-search status", () => {
  it("parses only known kinds and safe ids", () => {
    assert.deepEqual(parseRecordRef("file_content:abc_123"), { kind: "file_content", id: "abc_123" });
    assert.equal(parseRecordRef("spaceship:abc"), null);
    assert.equal(parseRecordRef("file:../../etc/passwd"), null);
    assert.equal(parseRecordRef(42), null);
  });

  it("reports off / skipped / warming / used honestly", async () => {
    assert.equal((await queryVector("anything", { env: { SPOTLIGHT_SEMANTIC: "off" } as unknown as NodeJS.ProcessEnv })).status, "off");
    setSpotlightEmbedder(async () => new Array(384).fill(0.05));
    assert.equal((await queryVector("ab")).status, "skipped", "too short");
    const used = await queryVector("revenue forecast");
    assert.equal(used.status, "used");
    assert.match(used.vector ?? "", /^\[0\.05,/);
    setSpotlightEmbedder(async () => new Promise((r) => setTimeout(() => r(new Array(384).fill(0)), 200)));
    assert.equal((await queryVector("slow query", { budgetMs: 10 })).status, "skipped", "over budget");
    setSpotlightEmbedder(null);
  });
});
