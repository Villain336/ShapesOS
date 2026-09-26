// Marketr — Phase 10 M9: corpus tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/corpus.test.ts
//
// No network in tests. CORPUS_DIR points at a temp dir so no fixture data
// touches the real corpus.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertIngestAllowed,
  registryConformance,
  SEED_SOURCES,
  SYNTHESIS_PLAYBOOKS,
  type SynthesisPlaybookRef,
} from "../allowlist";
import {
  chunkDocument,
  splitSections,
  htmlToText,
  plainTextClean,
  assertProvenanceComplete,
} from "../chunker";
import {
  assertSynthesisAllowed,
  ingestSynthesisPlaybook,
  renumberChunks,
  type SynthesisPlaybookDef,
} from "../ingest";
import { appendChunks, loadChunks, clearAsset } from "../store";
import { retrieveExpertContextWithEmbed } from "../retrieve";
import { retrieveExpertContext } from "../index";
import type { ChunkProvenance, CorpusChunk } from "../types";

const PD_PROV: ChunkProvenance = {
  sourceId: "scientific-advertising",
  sourceTitle: "Scientific Advertising",
  author: "Claude Hopkins",
  license: "public-domain",
  licenseUrl: "https://www.gutenberg.org/policy/license.html",
  sourceUrl: "https://www.gutenberg.org/cache/epub/5449/pg5449.txt",
  tier: 2,
  segregatedAsset: false,
  retrievedDate: "2026-09-26",
};

const BY_SA_PROV: ChunkProvenance = {
  ...PD_PROV,
  sourceId: "wikipedia-marketing-clusters",
  sourceTitle: "Wikipedia marketing clusters",
  author: "Wikimedia contributors",
  license: "CC-BY-SA-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourceUrl: "https://en.wikipedia.org/wiki/Marketing",
  segregatedAsset: true,
};

function tmpCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m9-corpus-"));
  process.env.CORPUS_DIR = dir;
  return dir;
}

function makeChunk(text: string, embedding: number[], prov: ChunkProvenance = PD_PROV): CorpusChunk {
  return {
    id: `${prov.sourceId}#0`,
    text,
    provenance: { ...prov },
    headingPath: ["Chapter 1"],
    chunkIndex: 0,
    charOffset: 0,
    embedding,
  };
}

describe("chunker", () => {
  it("preserves full provenance on every chunk", () => {
    const md = "# Salesmanship\n\nCopy is salesmanship in print.\n\n## Headlines\n\nHeadlines do the heavy lifting.";
    const chunks = chunkDocument(md, PD_PROV, { targetChars: 60, minChars: 10 });
    assert.ok(chunks.length >= 2, "expected multiple chunks");
    for (const c of chunks) {
      assert.deepEqual(c.provenance, PD_PROV);
      assert.equal(c.provenance.license, "public-domain");
      assert.ok(c.provenance.licenseUrl.length > 0);
      assert.ok(c.provenance.retrievedDate.length > 0);
      assert.ok(c.id.startsWith("scientific-advertising#"));
    }
  });

  it("records heading paths on chunks", () => {
    const chunks = chunkDocument("# A\n\nbody one\n\n## B\n\nbody two", PD_PROV, {
      targetChars: 40,
      minChars: 5,
    });
    const paths = chunks.map((c) => c.headingPath.join(" > "));
    assert.ok(paths.some((p) => p.includes("A")), `heading A preserved: ${paths}`);
  });

  it("requires license metadata on every chunk (fail if missing)", () => {
    const bad = { ...PD_PROV, license: "" as never, licenseUrl: "" };
    assert.throws(
      () => chunkDocument("some text here with enough length to chunk", bad),
      /provenance incomplete.*license/i,
    );
    assert.throws(() => assertProvenanceComplete({ ...PD_PROV, tier: 3 as never }), /tier/);
  });

  it("strips gutenberg boilerplate from plain text", () => {
    const raw =
      "Some header junk\n*** START OF THIS PROJECT GUTENBERG EBOOK SCIENTIFIC ADVERTISING ***\n\nReal content here.\n\n*** END OF THIS PROJECT GUTENBERG EBOOK ***\nfooter junk";
    const clean = plainTextClean(raw);
    assert.ok(!clean.includes("START OF THIS PROJECT"));
    assert.ok(!clean.includes("END OF THIS PROJECT"));
    assert.ok(clean.includes("Real content here."));
  });

  it("converts html headings for the chunker", () => {
    const html =
      "<html><body><nav>nav junk</nav><h1>SEO Guide</h1><p>Body text here.</p><script>var x=1;</script></body></html>";
    const text = htmlToText(html);
    assert.ok(text.includes("# SEO Guide"), text);
    assert.ok(!text.includes("nav junk"));
    assert.ok(!text.includes("var x=1"));
    assert.equal(splitSections(text).length, 1);
  });

  it("extracts the devsite article and drops <devsite-*> chrome (v3 nav fix)", () => {
    // Corpus v2 leaked ko-locale nav chrome into ~30 GSC chunks because the
    // devsite header/book-nav/TOC are custom elements, not <nav>/<header>.
    const html =
      '<html><body>' +
      "<devsite-header><devsite-top-logo-row>Google Search Central</devsite-top-logo-row>" +
      '<devsite-language-selector><a lang="ko">한국어</a></devsite-language-selector>' +
      "Skip to main content</devsite-header>" +
      "<devsite-book-nav><ul><li>nav junk</li></ul></devsite-book-nav>" +
      '<devsite-content><article class="devsite-article">' +
      '<li class="devsite-breadcrumb-item"><a>Home</a></li>' +
      "<h2>Spam Policies</h2><p>Body text here about spam.</p>" +
      "<devsite-heading-link><a href=\"#x\">#</a></devsite-heading-link>" +
      "</article>" +
      "<devsite-feedback><devsite-thumb-rating>rate this</devsite-thumb-rating></devsite-feedback>" +
      "</devsite-content></body></html>";
    const text = htmlToText(html);
    assert.ok(text.includes("## Spam Policies"), text);
    assert.ok(text.includes("Body text here about spam."));
    assert.ok(!text.includes("nav junk"));
    assert.ok(!text.includes("한국어"));
    assert.ok(!text.includes("Skip to main content"));
    assert.ok(!text.includes("rate this"));
    assert.ok(!text.includes("devsite"));
  });
});

describe("allowlist (binding clean-sourcing tiers)", () => {
  it("allows Tier 1 CC-BY-4.0 (Google Search Central) into the main asset", () => {
    const d = assertIngestAllowed({ id: "x", title: "GSC", tier: 1, license: "CC-BY-4.0" });
    assert.equal(d.allowed, true);
    if (d.allowed) assert.equal(d.segregatedAsset, false);
  });

  it("routes CC-BY-SA-4.0 (Wikipedia) to the segregated asset only", () => {
    const d = assertIngestAllowed({ id: "x", title: "Wiki", tier: 2, license: "CC-BY-SA-4.0" });
    assert.equal(d.allowed, true);
    if (d.allowed) assert.equal(d.segregatedAsset, true);
  });

  it("allows Tier 2 PD / CC-BY / CC0 / MIT", () => {
    for (const lic of ["public-domain", "CC-BY-4.0", "CC-BY-3.0", "CC0-1.0", "MIT"] as const) {
      const d = assertIngestAllowed({ id: "x", title: lic, tier: 2, license: lic });
      assert.equal(d.allowed, true, lic);
    }
  });

  it("REFUSES Tier 3 (purchased books/courses) — never touches the repo", () => {
    assert.throws(
      () => assertIngestAllowed({ id: "reforge", title: "Reforge", tier: 3, license: "unknown" }),
      /Tier 3 = private overlay only/,
    );
  });

  it("REFUSES learn-only academies (Meta Blueprint, Skillshop, TikTok, LinkedIn)", () => {
    for (const id of ["meta-blueprint", "google-skillshop", "tiktok-academy", "linkedin-marketing-labs"]) {
      assert.throws(
        () => assertIngestAllowed({ id, title: id, tier: "learn-only", license: "learn-only" }),
        /never ingested verbatim/,
        id,
      );
    }
  });

  it("REFUSES Tier 1 material that is not CC-BY-4.0", () => {
    assert.throws(
      () => assertIngestAllowed({ id: "x", title: "Blueprint", tier: 1, license: "all-rights-reserved" }),
      /only CC-BY-4.0 platform materials/,
    );
  });

  it("REFUSES NC/ND and unknown licenses", () => {
    assert.throws(
      () => assertIngestAllowed({ id: "x", title: "NC book", tier: 2, license: "CC-BY-NC-SA" }),
      /not a shippable open license/,
    );
  });

  it("the seed registry contains ONLY Tier 1-shippable + Tier 2 ingestables (learn-only correctly refused)", () => {
    const results = registryConformance();
    assert.equal(results.length, SEED_SOURCES.length);
    const bad = results.filter((r) => !r.ok);
    assert.deepEqual(bad, [], `registry violations: ${JSON.stringify(bad)}`);
    const refused = results.filter((r) => r.reason.startsWith("correctly refused"));
    assert.equal(refused.length, 11, `expected exactly 11 learn-only entries refused, got ${refused.length}`);
    for (const s of SEED_SOURCES) {
      if (s.tier !== "learn-only") {
        assert.ok(s.licenseUrl.length > 0, `${s.id}: shippable sources need a license URL`);
      }
    }
  });
});

describe("BY-SA segregation", () => {
  beforeEach(() => {
    tmpCorpus();
  });

  it("BY-SA chunks are refused by the main asset and accepted by the by-sa asset", () => {
    const bySa = makeChunk("marketing definition", [1, 0], BY_SA_PROV);
    assert.throws(() => appendChunks("main", [bySa]), /SEGREGATION VIOLATION/);
    appendChunks("by-sa", [bySa]);
    assert.equal(loadChunks("main").length, 0, "main asset stays clean");
    assert.equal(loadChunks("by-sa").length, 1);
    const loaded = loadChunks("by-sa")[0]!;
    assert.equal(loaded.provenance.license, "CC-BY-SA-4.0");
    assert.equal(loaded.provenance.segregatedAsset, true);
  });

  it("non-BY-SA chunks are refused by the by-sa asset", () => {
    const pd = makeChunk("hopkins text", [1, 0], PD_PROV);
    assert.throws(() => appendChunks("by-sa", [pd]), /refusing to write non-BY-SA/);
  });

  it("chunks without license metadata are refused everywhere", () => {
    const bad = makeChunk("no license", [1, 0], { ...PD_PROV, license: "" as never });
    assert.throws(() => appendChunks("main", [bad]), /without license metadata/);
  });
});

describe("retrieval", () => {
  beforeEach(() => {
    tmpCorpus();
    clearAsset("main");
    clearAsset("by-sa");
  });

  const stubEmbed = async (text: string): Promise<number[]> =>
    text.includes("seo-query") ? [1, 0] : [0, 1];

  it("returns attribution on every hit and ranks by cosine similarity", async () => {
    appendChunks("main", [
      makeChunk("irrelevant copywriting passage", [0, 1]),
      makeChunk("seo-query: crawl budget and indexing guidance", [1, 0]),
    ]);
    const hits = await retrieveExpertContextWithEmbed("seo-query test", { topK: 2 }, stubEmbed);
    assert.equal(hits.length, 2);
    assert.ok(hits[0]!.text.includes("seo-query"), "most similar chunk ranks first");
    for (const h of hits) {
      assert.ok(h.text.length > 0, "text present");
      assert.ok(h.sourceTitle.length > 0, "sourceTitle present");
      assert.ok(h.author.length > 0, "author present");
      assert.ok(h.license.length > 0, "license present");
    }
  });

  it("returns [] on an empty query and an empty corpus (no crash)", async () => {
    assert.deepEqual(await retrieveExpertContextWithEmbed("", undefined, stubEmbed), []);
    assert.deepEqual(await retrieveExpertContextWithEmbed("anything", undefined, stubEmbed), []);
  });

  it("respects topK", async () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`chunk ${i}`, [1, 0], { ...PD_PROV, sourceId: `s${i}` }),
    );
    appendChunks("main", chunks);
    const hits = await retrieveExpertContextWithEmbed("seo-query", { topK: 3 }, stubEmbed);
    assert.equal(hits.length, 3);
  });

  it("public retrieveExpertContext keeps the exact contract signature", () => {
    assert.equal(typeof retrieveExpertContext, "function");
    assert.equal(retrieveExpertContext.length, 2, "signature: (query, opts?)");
  });
});

describe("registry (all 24 target sources)", () => {
  it("covers exactly the 24 sources #1–24 from M9-CORPUS-SOURCES.md", () => {
    assert.equal(SEED_SOURCES.length, 24, `registry has ${SEED_SOURCES.length} sources`);
    const ids = SEED_SOURCES.map((s) => s.id);
    assert.equal(new Set(ids).size, 24, "source ids are unique");
  });

  it("registers exactly 11 Tier 1S synthesis playbooks, one per learn-only source", () => {
    const playbooks: readonly SynthesisPlaybookRef[] = SYNTHESIS_PLAYBOOKS;
    assert.equal(playbooks.length, 11);
    const learnOnly = SEED_SOURCES.filter((s) => s.tier === "learn-only").map((s) => s.id);
    assert.equal(learnOnly.length, 11);
    const playbookIds = new Set(playbooks.map((p) => p.sourceId));
    for (const id of learnOnly) {
      assert.ok(playbookIds.has(id), `learn-only source ${id} needs a 1S playbook`);
    }
    for (const p of playbooks) {
      assert.ok(p.file.endsWith(".md"), `${p.sourceId}: playbook file is markdown`);
      assert.ok(p.synthesizedFrom.length > 0, `${p.sourceId}: synthesizedFrom present`);
    }
  });

  it("every non-learn-only source has fetch URLs or an explicit pending reason", () => {
    for (const s of SEED_SOURCES) {
      if (s.tier === "learn-only") continue;
      const hasUrls = s.fetchUrls.length > 0;
      const hasReason = !!s.pendingReason;
      assert.ok(hasUrls || hasReason, `${s.id}: needs fetchUrls or pendingReason`);
    }
  });
});

const S1S_PROV: ChunkProvenance = {
  sourceId: "1s-hubspot-academy",
  sourceTitle: "Marketr Tier 1S synthesis from HubSpot Academy",
  author: "Marketr (original synthesis)",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourceUrl: "",
  tier: "1S",
  segregatedAsset: false,
  retrievedDate: "2026-09-26",
  synthesizedFrom: ["HubSpot Academy"],
  synthesisDate: "2026-09-26",
  original: true,
};

describe("Tier 1S provenance", () => {
  it("accepts complete 1S provenance (empty sourceUrl allowed for originals)", () => {
    assert.doesNotThrow(() => assertProvenanceComplete(S1S_PROV));
  });

  it("REFUSES 1S provenance missing synthesizedFrom", () => {
    assert.throws(
      () => assertProvenanceComplete({ ...S1S_PROV, synthesizedFrom: [] }),
      /synthesizedFrom/,
    );
  });

  it("REFUSES 1S provenance missing synthesisDate", () => {
    const bad = { ...S1S_PROV } as Record<string, unknown>;
    delete bad.synthesisDate;
    assert.throws(() => assertProvenanceComplete(bad as unknown as ChunkProvenance), /synthesisDate/);
  });

  it("REFUSES 1S provenance with original !== true", () => {
    assert.throws(
      () => assertProvenanceComplete({ ...S1S_PROV, original: false }),
      /original/,
    );
  });

  it("REFUSES empty sourceUrl for non-1S tiers", () => {
    assert.throws(
      () => assertProvenanceComplete({ ...PD_PROV, sourceUrl: "" }),
      /sourceUrl/,
    );
  });

  it("1S chunks are accepted by the main asset (Marketr-original expression, CC-BY-4.0)", () => {
    tmpCorpus();
    clearAsset("main");
    const c = makeChunk("inbound flywheel: attract, engage, delight", [1, 0], S1S_PROV);
    appendChunks("main", [c]);
    assert.equal(loadChunks("main").length, 1);
    assert.equal(loadChunks("main")[0]!.provenance.tier, "1S");
  });
});

describe("1S gate (assertSynthesisAllowed)", () => {
  const registry = [
    { id: "hubspot-academy", tier: "learn-only" as const },
    { id: "google-search-central", tier: 1 as const },
    { id: "scientific-advertising", tier: 2 as const },
  ];
  const goodDef: SynthesisPlaybookDef = {
    sourceId: "hubspot-academy",
    title: "HubSpot Academy",
    author: "Marketr (original synthesis)",
    file: "inbound-marketing-playbook.md",
    synthesizedFrom: ["HubSpot Academy"],
  };

  it("accepts a learn-only source with a substantive existing playbook", () => {
    assert.doesNotThrow(() => assertSynthesisAllowed(goodDef, registry, true, 5000));
  });

  it("REFUSES synthesis for a verbatim-ingestible Tier 1 source (no laundering)", () => {
    assert.throws(
      () => assertSynthesisAllowed({ ...goodDef, sourceId: "google-search-central" }, registry, true, 5000),
      /Tier 1S synthesis is reserved for learn-only/,
    );
  });

  it("REFUSES synthesis for a verbatim-ingestible Tier 2 source (no laundering)", () => {
    assert.throws(
      () => assertSynthesisAllowed({ ...goodDef, sourceId: "scientific-advertising" }, registry, true, 5000),
      /Tier 1S synthesis is reserved for learn-only/,
    );
  });

  it("REFUSES unknown source ids", () => {
    assert.throws(
      () => assertSynthesisAllowed({ ...goodDef, sourceId: "reforge" }, registry, true, 5000),
      /not a registry source/,
    );
  });

  it("REFUSES missing playbook files", () => {
    assert.throws(
      () => assertSynthesisAllowed(goodDef, registry, false, 0),
      /playbook file missing/,
    );
  });

  it("REFUSES thin playbooks (<2000 chars)", () => {
    assert.throws(
      () => assertSynthesisAllowed(goodDef, registry, true, 1999),
      /substantive/,
    );
  });
});

describe("multi-URL chunk ids", () => {
  it("renumberChunks gives globally unique ids across per-URL chunking", () => {
    // Simulate two URLs chunked separately (chunkDocument resets indexes).
    const urlA = chunkDocument("# A\n\ntext ".repeat(20), PD_PROV, { targetChars: 100, minChars: 10 });
    const urlB = chunkDocument("# B\n\ntext ".repeat(20), PD_PROV, { targetChars: 100, minChars: 10 });
    const all = [...urlA, ...urlB];
    renumberChunks(all, "multi-source");
    const ids = all.map((c) => c.id);
    assert.equal(new Set(ids).size, all.length, "chunk ids unique after renumber");
    all.forEach((c, i) => {
      assert.equal(c.chunkIndex, i);
      assert.equal(c.id, `multi-source#${i}`);
    });
  });
});

describe("ingestSynthesisPlaybook (local 1S ingest, no network)", () => {
  it("ingests a Marketr-original playbook into the main asset with 1S provenance", async () => {
    const dir = tmpCorpus();
    clearAsset("main");
    const synthDir = path.join(dir, "synthesis");
    fs.mkdirSync(synthDir, { recursive: true });
    const md = "# Inbound Marketing Playbook\n\n" + "Original words about the flywheel. ".repeat(200);
    fs.writeFileSync(path.join(synthDir, "inbound-marketing-playbook.md"), md, "utf8");

    const def: SynthesisPlaybookDef = {
      sourceId: "hubspot-academy",
      title: "HubSpot Academy",
      targetTitle: "HubSpot Academy",
      author: "Marketr (original synthesis)",
      file: "inbound-marketing-playbook.md",
      synthesizedFrom: ["HubSpot Academy"],
    };
    const { record, chunks } = await ingestSynthesisPlaybook(def, "2026-09-26", {
      synthesisDir: synthDir,
      registry: [{ id: "hubspot-academy", tier: "learn-only" }],
      embed: async () => [1, 0],
    });
    assert.equal(record.status, "active");
    assert.equal(record.mode, "synthesis-1s");
    assert.equal(record.title, "HubSpot Academy");
    assert.ok(chunks.length > 0);
    const stored = loadChunks("main");
    assert.ok(stored.length >= chunks.length);
    for (const c of stored) {
      assert.equal(c.provenance.tier, "1S");
      assert.equal(c.provenance.sourceTitle, "Marketr Tier 1S synthesis from HubSpot Academy");
      assert.equal(c.provenance.original, true);
      assert.deepEqual(c.provenance.synthesizedFrom, ["HubSpot Academy"]);
    }
    // Chunk ids unique within the 1S source.
    const ids = stored.filter((c) => c.provenance.sourceId === "1s-hubspot-academy").map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("stays PENDING (never partial) when the playbook file is missing", async () => {
    const dir = tmpCorpus();
    clearAsset("main");
    const synthDir = path.join(dir, "synthesis");
    fs.mkdirSync(synthDir, { recursive: true });
    const def: SynthesisPlaybookDef = {
      sourceId: "hubspot-academy",
      title: "HubSpot Academy",
      author: "Marketr (original synthesis)",
      file: "missing.md",
      synthesizedFrom: ["HubSpot Academy"],
    };
    const { record, chunks } = await ingestSynthesisPlaybook(def, "2026-09-26", {
      synthesisDir: synthDir,
      registry: [{ id: "hubspot-academy", tier: "learn-only" }],
      embed: async () => [1, 0],
    });
    assert.equal(record.status, "pending");
    assert.deepEqual(chunks, []);
    assert.equal(loadChunks("main").length, 0, "nothing written on failure");
  });
});
