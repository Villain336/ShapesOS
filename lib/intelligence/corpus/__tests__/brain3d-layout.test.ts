// Marketr — Knowledge Brain: 3D galaxy layout tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/brain3d-layout.test.ts
//
// Only the pure data mapping is tested here (determinism, chunk→source
// assignment, orbital ring math, sizing, filter dimming). WebGL rendering is
// verified via screenshots, not unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  layoutGalaxy3D,
  layoutChunkSparkles,
  nodeRadius3D,
  isDimmed3D,
  mulberry32,
  ringNormal,
  GALAXY_RADIUS,
  PILLAR_CLUSTER_CENTER,
  HERO_RING_FRACTION,
  type GalaxyCoreInput,
} from "../brain3d-layout";
import type { BrainPillar, BrainNode } from "../graph";

function input(partial: Partial<GalaxyCoreInput> & { id: string }): GalaxyCoreInput {
  return {
    pillar: "marketing",
    chunks: 50,
    kind: "source",
    tier: "2",
    ...partial,
  };
}

function corpusLike(n: number): GalaxyCoreInput[] {
  const pillars: BrainPillar[] = ["marketing", "growth", "design"];
  const tiers: BrainNode["tier"][] = ["1", "2", "1S"];
  return Array.from({ length: n }, (_, i) =>
    input({
      id: `src-${i}`,
      pillar: pillars[i % 3],
      tier: tiers[i % 3],
      chunks: 5 + ((i * 37) % 500),
      kind: i % 11 === 0 ? "removal-flagged" : "source",
    }),
  );
}

describe("layoutGalaxy3D — galaxy invariants", () => {
  it("places every core inside the galaxy volume", () => {
    const cores = layoutGalaxy3D(corpusLike(48));
    assert.equal(cores.length, 48);
    for (const c of cores) {
      const d = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
      assert.ok(d <= GALAXY_RADIUS + 1e-9, `${c.id} outside galaxy volume`);
    }
  });

  it("is deterministic: same input → identical output", () => {
    const a = layoutGalaxy3D(corpusLike(48));
    const b = layoutGalaxy3D(corpusLike(48));
    assert.deepEqual(a, b);
    const sa = layoutChunkSparkles(corpusLike(48), a);
    const sb = layoutChunkSparkles(corpusLike(48), b);
    assert.deepEqual(sa, sb);
  });

  it("handles tiny corpora (1 node) and empty input without crashing", () => {
    assert.equal(layoutGalaxy3D([]).length, 0);
    assert.equal(layoutChunkSparkles([], []).length, 0);
    const one = layoutGalaxy3D([input({ id: "solo" })]);
    assert.equal(one.length, 1);
    assert.equal(layoutChunkSparkles([input({ id: "solo" })], one).length, 50);
  });

  it("two cores never share an identical position", () => {
    const cores = layoutGalaxy3D(corpusLike(48));
    const keys = new Set(cores.map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)}`));
    assert.equal(keys.size, 48);
  });

  it("hero is the max-chunk input; satellite is 2nd-largest in the hero's pillar", () => {
    const inputs = corpusLike(48);
    const cores = layoutGalaxy3D(inputs);
    const heroes = cores.filter((c) => c.hero);
    assert.equal(heroes.length, 1);
    const maxChunks = Math.max(...inputs.map((i) => i.chunks));
    assert.equal(heroes[0].chunks, maxChunks);
    assert.ok(heroes[0].ringRadius > 0, "hero gets an orbital ring radius");
    const sats = cores.filter((c) => c.satellite);
    assert.equal(sats.length, 1);
    assert.equal(sats[0].pillar, heroes[0].pillar);
    const pillarSorted = inputs
      .filter((i) => i.pillar === heroes[0].pillar && i.id !== heroes[0].id)
      .sort((a, b) => b.chunks - a.chunks);
    assert.equal(sats[0].id, pillarSorted[0].id);
  });

  it("pillars cluster near their organic centers", () => {
    const cores = layoutGalaxy3D(corpusLike(48));
    for (const pillar of ["marketing", "growth", "design"] as BrainPillar[]) {
      const c = PILLAR_CLUSTER_CENTER[pillar];
      const group = cores.filter((x) => x.pillar === pillar && !x.hero);
      const meanD =
        group.reduce(
          (a, x) => a + Math.sqrt((x.x - c[0]) ** 2 + (x.y - c[1]) ** 2 + (x.z - c[2]) ** 2),
          0,
        ) / group.length;
      assert.ok(meanD < 5.5, `${pillar} mean distance ${meanD.toFixed(2)} too far from its center`);
    }
  });

  it("cores respect minimum separation (no luminous overlap)", () => {
    const cores = layoutGalaxy3D(corpusLike(48));
    for (let a = 0; a < cores.length; a++) {
      for (let b = a + 1; b < cores.length; b++) {
        const A = cores[a];
        const B = cores[b];
        if ((A.hero && B.satellite) || (A.satellite && B.hero)) continue;
        const d = Math.sqrt((A.x - B.x) ** 2 + (A.y - B.y) ** 2 + (A.z - B.z) ** 2);
        assert.ok(d >= A.radius + B.radius + 0.4, `${A.id}↔${B.id} overlap d=${d.toFixed(2)}`);
      }
    }
  });
});

describe("layoutChunkSparkles — chunk assignment", () => {
  it("assigns exactly chunk-count sparkles per source (proposed → 0)", () => {
    const inputs = [...corpusLike(20), input({ id: "prop-1", kind: "proposed", chunks: 0 })];
    const cores = layoutGalaxy3D(inputs);
    const sparkles = layoutChunkSparkles(inputs, cores);
    const bySource = new Map<string, number>();
    for (const s of sparkles) bySource.set(s.sourceId, (bySource.get(s.sourceId) ?? 0) + 1);
    for (const n of inputs) {
      assert.equal(bySource.get(n.id) ?? 0, n.chunks, `${n.id}: sparkle count mismatch`);
    }
    const total = inputs.reduce((a, n) => a + n.chunks, 0);
    assert.equal(sparkles.length, total);
  });

  it("hero ring sparkles sit on the tilted ring plane at ringRadius", () => {
    const inputs = corpusLike(24);
    const cores = layoutGalaxy3D(inputs);
    const hero = cores.find((c) => c.hero)!;
    const sparkles = layoutChunkSparkles(inputs, cores);
    const ring = sparkles.filter((s) => s.ring);
    const expected = Math.round(hero.chunks * HERO_RING_FRACTION);
    assert.equal(ring.length, expected);
    assert.ok(ring.length > 0, "hero has ring sparkles");
    const n = ringNormal(hero.ringTilt);
    for (const s of ring) {
      const ox = s.x - hero.x;
      const oy = s.y - hero.y;
      const oz = s.z - hero.z;
      const radial = Math.sqrt(ox * ox + oy * oy + oz * oz);
      assert.ok(
        Math.abs(radial - hero.ringRadius) < 0.2,
        `ring sparkle radial ${radial.toFixed(2)} ≠ ringRadius ${hero.ringRadius.toFixed(2)}`,
      );
      const plane = Math.abs(ox * n[0] + oy * n[1] + oz * n[2]);
      assert.ok(plane < 0.25, `ring sparkle off-plane by ${plane.toFixed(2)}`);
    }
    // Only the hero has ring sparkles.
    assert.ok(ring.every((s) => s.sourceId === hero.id));
  });

  it("all sparkles stay inside the galaxy volume", () => {
    const inputs = corpusLike(48);
    const cores = layoutGalaxy3D(inputs);
    const sparkles = layoutChunkSparkles(inputs, cores);
    for (const s of sparkles) {
      const d = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
      assert.ok(d <= GALAXY_RADIUS * 1.6, `sparkle of ${s.sourceId} escaped: d=${d.toFixed(2)}`);
    }
  });

  it("sparkle sizes and births are sane", () => {
    const inputs = corpusLike(12);
    const cores = layoutGalaxy3D(inputs);
    for (const s of layoutChunkSparkles(inputs, cores)) {
      assert.ok(s.size > 0 && s.size < 0.3, `size ${s.size}`);
      assert.ok(s.birth >= 0.4 && s.birth <= 2.0, `birth ${s.birth}`);
      assert.ok(["marketing", "growth", "design"].includes(s.pillar));
    }
  });
});

describe("ringNormal — tilted plane math", () => {
  it("returns a unit vector", () => {
    const n = ringNormal([0.5, 0.35]);
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    assert.ok(Math.abs(len - 1) < 1e-9);
  });

  it("zero tilt gives the XZ-plane normal", () => {
    assert.deepEqual(ringNormal([0, 0]), [0, 1, 0]);
  });
});

describe("nodeRadius3D — sizing", () => {
  it("grows monotonically with chunk count and clamps", () => {
    const r = (c: number) => nodeRadius3D(c, "source");
    assert.ok(r(10) < r(100) && r(100) < r(500));
    assert.ok(r(100000) <= 0.85, "clamped at the max");
    assert.ok(r(0) >= 0.16, "clamped at the min");
  });

  it("proposed nodes get the minimum radius regardless of chunks", () => {
    assert.equal(nodeRadius3D(999, "proposed"), 0.14);
  });
});

describe("isDimmed3D — filter dimming", () => {
  const node: Pick<BrainNode, "pillar" | "tier" | "title" | "teaches" | "author"> = {
    pillar: "marketing",
    tier: "1",
    title: "Scientific Advertising",
    teaches: "salesmanship in print",
    author: "Claude Hopkins",
  };
  const open = { pillars: new Set(["marketing", "growth", "design"] as BrainPillar[]), tiers: new Set(["1", "2", "1S"]), q: "" };

  it("keeps matching nodes lit", () => {
    assert.equal(isDimmed3D(node, open), false);
  });

  it("dims on pillar, tier, and query mismatch", () => {
    assert.equal(isDimmed3D(node, { ...open, pillars: new Set(["growth", "design"] as BrainPillar[]) }), true);
    assert.equal(isDimmed3D(node, { ...open, tiers: new Set(["2", "1S"]) }), true);
    assert.equal(isDimmed3D(node, { ...open, q: "zzz-no-match" }), true);
  });

  it("matches query against title, teaches, and author", () => {
    assert.equal(isDimmed3D(node, { ...open, q: "hopkins" }), false);
    assert.equal(isDimmed3D(node, { ...open, q: "salesmanship" }), false);
    assert.equal(isDimmed3D(node, { ...open, q: "SCIENTIFIC" }), false);
  });
});

describe("mulberry32 — seeded PRNG", () => {
  it("repeats its sequence per seed and differs across seeds", () => {
    const a = [mulberry32(7)(), mulberry32(7)(), mulberry32(7)()];
    const b = [mulberry32(7)(), mulberry32(7)(), mulberry32(7)()];
    const c = mulberry32(8)();
    assert.deepEqual(a, b);
    assert.notEqual(a[0], c);
  });
});
