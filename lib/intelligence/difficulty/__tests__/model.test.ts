// Marketr — Phase 10 M5: model math tests.
// Run: npx tsx --test lib/intelligence/difficulty/__tests__/model.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bandToRange,
  blendAuthority,
  ccRankToScore,
  computeDifficulty,
  MODEL_VERSION,
  normalizeDomain,
  type ModelInputs,
} from "../model";
import { estimateFromFixture } from "../service";
import { SYNTHETIC_FIXTURES, FIXTURE_BY_KEYWORD } from "../fixtures";

function inputsFor(keyword: string, volumeBand: string | null = "1K–10K"): ModelInputs {
  const f = FIXTURE_BY_KEYWORD.get(keyword);
  assert.ok(f, `fixture ${keyword} exists`);
  const blends = new Map(
    f.authority.map((raw) => [normalizeDomain(raw.domain), blendAuthority(raw)]),
  );
  const range = volumeBand ? bandToRange(volumeBand) : { lo: 0, hi: 0 };
  // Deep-copy the fixture SERP: tests mutate it (e.g. toggling AIO) and the
  // fixture objects are shared across tests.
  const serp = {
    results: f.serp.results.map((r) => ({ ...r })),
    aiOverviewPresent: f.serp.aiOverviewPresent,
    serpFeatures: [...f.serp.serpFeatures],
  };
  return {
    keyword: f.keyword,
    locale: f.locale,
    serp,
    authority: blends,
    volume: volumeBand
      ? { band: volumeBand, lo: range.lo, hi: range.hi, source: "test" }
      : null,
    ownDomainAuthority: null,
    serpVendor: "test",
  };
}

describe("normalizeDomain", () => {
  it("strips scheme, www, path, port", () => {
    assert.equal(normalizeDomain("https://www.Example.COM:8080/a/b?x=1"), "example.com");
    assert.equal(normalizeDomain("example.com"), "example.com");
  });
});

describe("ccRankToScore", () => {
  it("rank 1 → ~100, last rank → ~0", () => {
    assert.ok(ccRankToScore(1, 90_000_000) > 99);
    assert.ok(ccRankToScore(90_000_000, 90_000_000) < 1);
  });
  it("better rank beats worse rank", () => {
    assert.ok(ccRankToScore(1_000, 90_000_000) > ccRankToScore(10_000_000, 90_000_000));
  });
});

describe("blendAuthority", () => {
  it("blends all three sources with base weights", () => {
    const b = blendAuthority({ domain: "x.com", mozDA: 80, oprInteger: 8, ccPrPos: 10_000 });
    assert.equal(b.domain, "x.com");
    assert.equal(b.sources.length, 3);
    assert.ok(b.score >= 0 && b.score <= 100);
    assert.equal(b.confidence, 1);
    assert.equal(b.ccCapped, false);
  });

  it("caps the CC contribution at 0.50 when CC is the only source", () => {
    const b = blendAuthority({ domain: "lonely.com", ccPrPos: 100_000 });
    assert.equal(b.sources.length, 1);
    assert.equal(b.sources[0].source, "cc_graph");
    assert.ok(
      b.sources[0].weight <= 0.5,
      `CC weight ${b.sources[0].weight} exceeds the 0.50 cap`,
    );
    assert.equal(b.ccCapped, true);
    assert.ok(b.confidence < 0.5, "confidence must reflect the missing sources");
  });

  it("missing sources reduce confidence, not the score", () => {
    const full = blendAuthority({ domain: "x.com", mozDA: 80, oprInteger: 8, ccPrPos: 10_000 });
    const thin = blendAuthority({ domain: "x.com", mozDA: 80 });
    assert.equal(thin.confidence, 0.35);
    assert.ok(Math.abs(thin.score - 80) < 1, `thin score ${thin.score} should track the one signal`);
    assert.ok(full.confidence > thin.confidence);
  });

  it("no signals → neutral score, zero confidence", () => {
    const b = blendAuthority({ domain: "ghost.com" });
    assert.equal(b.score, 50);
    assert.equal(b.confidence, 0);
    assert.equal(b.sources.length, 0);
  });
});

describe("computeDifficulty — known easy/hard order correctly", () => {
  it("easy < medium < hard on synthetic fixtures", () => {
    const easy = computeDifficulty(inputsFor("best ergonomic office chair for short people under $200"));
    const medium = computeDifficulty(inputsFor("project management software for small teams"));
    const hard = computeDifficulty(inputsFor("insurance"));
    assert.ok(easy.estimate < medium.estimate, `easy ${easy.estimate} < medium ${medium.estimate}`);
    assert.ok(medium.estimate < hard.estimate, `medium ${medium.estimate} < hard ${hard.estimate}`);
  });

  it("AI Overview crowding pushes the estimate up", () => {
    const plain = inputsFor("what is a good credit score");
    plain.serp.aiOverviewPresent = false;
    plain.serp.serpFeatures = [];
    const crowded = inputsFor("what is a good credit score"); // fixture has AIO + featured_snippet
    const a = computeDifficulty(plain);
    const b = computeDifficulty(crowded);
    assert.ok(b.components.serpCrowding > a.components.serpCrowding);
    assert.ok(b.estimate > a.estimate, `crowded ${b.estimate} > plain ${a.estimate}`);
  });

  it("authority gap shrinks when the user's own authority rises", () => {
    const fresh = inputsFor("insurance");
    const strong = inputsFor("insurance");
    strong.ownDomainAuthority = 90;
    const a = computeDifficulty(fresh);
    const b = computeDifficulty(strong);
    assert.ok(b.components.authorityGap < a.components.authorityGap);
    assert.ok(b.estimate < a.estimate);
  });
});

describe("computeDifficulty — uncertainty", () => {
  it("widens when the volume band is wide / missing", () => {
    const narrow = computeDifficulty(inputsFor("best ergonomic office chair for short people under $200", "100–1K"));
    const missing = computeDifficulty(inputsFor("best ergonomic office chair for short people under $200", null));
    assert.ok(
      missing.uncertainty > narrow.uncertainty,
      `missing volume ±${missing.uncertainty} should exceed narrow band ±${narrow.uncertainty}`,
    );
  });

  it("widens when authority coverage is thin", () => {
    const full = computeDifficulty(inputsFor("insurance"));
    const none = computeDifficulty(inputsFor("quantum ferret habitat setup guide"));
    assert.ok(
      none.uncertainty > full.uncertainty,
      `no-authority ±${none.uncertainty} should exceed full-coverage ±${full.uncertainty}`,
    );
    assert.ok(none.uncertainty <= 25, "uncertainty is capped at ±25");
  });

  it("estimate always sits inside its own band", () => {
    for (const f of SYNTHETIC_FIXTURES) {
      const out = computeDifficulty(inputsFor(f.keyword));
      assert.ok(out.uncertaintyBand[0] <= out.estimate && out.estimate <= out.uncertaintyBand[1]);
    }
  });
});

describe("computeDifficulty — provenance", () => {
  it("records serp vendor, authority sources, volume band, model version", () => {
    const out = computeDifficulty(inputsFor("insurance"));
    const p = out.inputsProvenance;
    assert.equal(p.serpVendor, "test");
    assert.equal(p.volumeBand, "1K–10K");
    assert.equal(p.modelVersion, MODEL_VERSION);
    assert.equal(out.modelVersion, MODEL_VERSION);
    assert.equal(p.authoritySources.length, 3);
    const moz = p.authoritySources.find((s) => s.source === "moz");
    assert.ok(moz && moz.domainsCovered === 10);
  });

  it("flags the fresh-site baseline when own authority is unknown", () => {
    const out = computeDifficulty(inputsFor("insurance"));
    assert.equal(out.inputsProvenance.ownAuthorityProvided, false);
  });
});

describe("bandToRange", () => {
  it("maps every M6 band to a numeric range", () => {
    assert.deepEqual(bandToRange("0–10"), { lo: 0, hi: 10 });
    assert.deepEqual(bandToRange("1K–10K"), { lo: 1000, hi: 10000 });
    assert.deepEqual(bandToRange("1M+"), { lo: 1000000, hi: 10000000 });
  });
  it("unknown band → widest range (honest, not invented)", () => {
    const r = bandToRange("nonsense");
    assert.ok(r.hi - r.lo >= 10_000_000);
  });
});

describe("estimateFromFixture", () => {
  it("runs the whole model from a fixture with no I/O", () => {
    const f = FIXTURE_BY_KEYWORD.get("insurance");
    assert.ok(f);
    const out = estimateFromFixture({
      keyword: f.keyword,
      locale: f.locale,
      serp: f.serp,
      authorityRaw: f.authority,
      volumeBand: f.volumeBand,
      serpVendor: "fixture",
    });
    assert.ok(out.estimate > 0);
    assert.equal(out.modelVersion, MODEL_VERSION);
  });
});
