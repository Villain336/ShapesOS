// Marketr — Knowledge Brain: 3D hemisphere layout tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/brain3d-layout.test.ts
//
// Only the pure data mapping is tested here (hemisphere gap, volume
// containment, determinism, sizing, filter dimming). WebGL rendering is
// verified via screenshots, not unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  layoutBrain3D,
  nodeRadius3D,
  isDimmed3D,
  insideBrain,
  mulberry32,
  normalizedRadius,
  LOBE_Z_BAND,
  TIER_RADIAL_BAND,
  BRAIN_RX,
  BRAIN_RY,
  BRAIN_RZ,
  BRAIN_GAP,
  type Brain3DInput,
} from "../brain3d-layout";
import type { BrainPillar, BrainNode } from "../graph";

function input(partial: Partial<Brain3DInput> & { id: string }): Brain3DInput {
  return {
    pillar: "marketing",
    chunks: 50,
    kind: "source",
    tier: "2",
    ...partial,
  };
}

function corpusLike(n: number): Brain3DInput[] {
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

describe("layoutBrain3D — hemisphere invariants", () => {
  it("places every node inside the brain ellipsoid with the fissure gap respected", () => {
    const placed = layoutBrain3D(corpusLike(48));
    assert.equal(placed.length, 48);
    for (const p of placed) {
      assert.ok(Math.abs(p.x) >= BRAIN_GAP - 1e-9, `${p.id}: |x|=${p.x} violates gap`);
      assert.ok(insideBrain(p.x, p.y, p.z), `${p.id} outside the brain volume`);
      assert.ok(p.hemisphere === -1 || p.hemisphere === 1);
      assert.equal(p.hemisphere, p.x < 0 ? -1 : 1);
    }
  });

  it("splits each pillar across both hemispheres", () => {
    const placed = layoutBrain3D(corpusLike(48));
    for (const pillar of ["marketing", "growth", "design"] as BrainPillar[]) {
      const sides = new Set(placed.filter((p) => p.pillar === pillar).map((p) => p.hemisphere));
      assert.deepEqual([...sides].sort(), [-1, 1], `${pillar} missing a hemisphere`);
    }
  });

  it("is deterministic: same input → identical output", () => {
    const a = layoutBrain3D(corpusLike(48));
    const b = layoutBrain3D(corpusLike(48));
    assert.deepEqual(a, b);
  });

  it("handles tiny corpora (1 node) and empty input without crashing", () => {
    assert.equal(layoutBrain3D([]).length, 0);
    const one = layoutBrain3D([input({ id: "solo" })]);
    assert.equal(one.length, 1);
    assert.ok(insideBrain(one[0].x, one[0].y, one[0].z));
  });

  it("two nodes never share an identical position", () => {
    const placed = layoutBrain3D(corpusLike(48));
    const keys = new Set(placed.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`));
    assert.equal(keys.size, 48);
  });
});

describe("nodeRadius3D — sizing", () => {
  it("grows monotonically with chunk count and clamps", () => {
    const r = (c: number) => nodeRadius3D(c, "source");
    assert.ok(r(10) < r(100) && r(100) < r(500));
    assert.ok(r(100000) <= 0.46, "clamped at the max");
    assert.ok(r(0) >= 0.11, "clamped at the min");
  });

  it("proposed nodes get the minimum radius regardless of chunks", () => {
    assert.equal(nodeRadius3D(999, "proposed"), 0.11);
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

describe("brain volume constants", () => {
  it("gap is positive and smaller than the x semi-axis", () => {
    assert.ok(BRAIN_GAP > 0 && BRAIN_GAP < BRAIN_RX);
    assert.ok(BRAIN_RX > 0 && BRAIN_RY > 0 && BRAIN_RZ > 0);
  });
});

describe("layoutBrain3D — lobe organization", () => {
  it("places pillars in front→back lobes: marketing z > 0, design z < 0, growth near the middle", () => {
    const placed = layoutBrain3D(corpusLike(60));
    for (const p of placed) {
      if (p.pillar === "marketing") assert.ok(p.z > 0.05, `${p.id} marketing z=${p.z.toFixed(2)}`);
      if (p.pillar === "design") assert.ok(p.z < -0.05, `${p.id} design z=${p.z.toFixed(2)}`);
      if (p.pillar === "growth") assert.ok(Math.abs(p.z) < 1.0, `${p.id} growth z=${p.z.toFixed(2)}`);
    }
  });

  it("lobe bands are disjoint and ordered front→back", () => {
    assert.ok(LOBE_Z_BAND.marketing[0] > LOBE_Z_BAND.growth[1]);
    assert.ok(LOBE_Z_BAND.growth[0] > LOBE_Z_BAND.design[1]);
  });

  it("bands tiers core→rim: tier 1 inner, tier 2 middle, 1S outer, proposed on the rim", () => {
    const tiers: BrainNode["tier"][] = ["1", "2", "1S"];
    const inputs: Brain3DInput[] = [];
    tiers.forEach((t, ti) =>
      ["marketing", "growth", "design"].forEach((pillar, pi) =>
        inputs.push(
          input({ id: `t${ti}-${pi}`, pillar: pillar as BrainPillar, tier: t, chunks: 100 }),
        ),
      ),
    );
    inputs.push(input({ id: "prop-1", kind: "proposed", tier: "1S", chunks: 0, pillar: "marketing" }));
    const placed = layoutBrain3D(inputs);
    const rho = (id: string) => {
      const p = placed.find((x) => x.id === id)!;
      return normalizedRadius(p.x, p.y, p.z);
    };
    const bands: Record<string, [number, number]> = {
      "1": [0.42, 0.68],
      "2": [0.59, 0.84],
      "1S": [0.75, 0.97],
    };
    for (const t of tiers) {
      for (const id of inputs.filter((i) => i.tier === t && i.kind !== "proposed").map((i) => i.id)) {
        const r = rho(id);
        assert.ok(r >= bands[t][0] && r <= bands[t][1], `${id} tier ${t} rho=${r.toFixed(2)}`);
      }
    }
    assert.ok(rho("prop-1") >= 0.87, `proposed rho=${rho("prop-1").toFixed(2)}`);
    const mean = (t: string) =>
      inputs.filter((i) => i.tier === t && i.kind !== "proposed").reduce((a, i) => a + rho(i.id), 0) /
      inputs.filter((i) => i.tier === t && i.kind !== "proposed").length;
    assert.ok(mean("1") < mean("2") && mean("2") < mean("1S"), "tier means ordered core→rim");
  });

  it("tier band constants are ordered and inside the unit ball", () => {
    const b = TIER_RADIAL_BAND;
    assert.ok(b["1"][0] < b["1"][1] && b["1"][1] <= b["2"][0]);
    assert.ok(b["2"][0] < b["2"][1] && b["2"][1] <= b["1S"][0]);
    assert.ok(b["1S"][0] < b["1S"][1] && b["1S"][1] < 1);
    assert.ok(b.proposed[0] < b.proposed[1] && b.proposed[1] <= 1);
    // Rims touch: 1S outer edge meets the proposed rim.
    assert.ok(b.proposed[0] <= b["1S"][1]);
  });
});
