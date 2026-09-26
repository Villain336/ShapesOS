// Marketr — Phase 10 M5: fixture-based eval (CI-safe, no API keys).
//
// M7 runs this in CI. It exercises the model over SYNTHETIC_FIXTURES and
// checks the structural properties the model must have REGARDLESS of live
// data:
//
//   1. Ordering: easy < medium < hard on the known fixtures.
//   2. Crowding effect: the AIO-crowded fixture estimates harder than the
//      medium fixture (SERP-feature crowding is a real difficulty input).
//   3. Uncertainty honesty: the no-authority fixture gets the widest band,
//      and wide volume bands widen the interval vs. narrow ones.
//   4. Provenance: every output carries modelVersion + full provenance.
//
// This is NOT the bar that opens the vendor-replacement gate (gate.ts) —
// that requires the live --live run against the DataForSEO reference. The
// fixture eval guards against model-math regressions.

import { SYNTHETIC_FIXTURES } from "./fixtures";
import { estimateFromFixture } from "./service";
import { MODEL_VERSION, type DifficultyOutput } from "./model";

export interface FixtureEvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FixtureEvalReport {
  modelVersion: string;
  passed: boolean;
  checks: FixtureEvalCheck[];
  estimates: Array<{
    keyword: string;
    estimate: number;
    band: [number, number];
    uncertainty: number;
  }>;
}

function check(name: string, passed: boolean, detail: string): FixtureEvalCheck {
  return { name, passed, detail };
}

export function runFixtureEval(): FixtureEvalReport {
  const outputs = new Map<string, DifficultyOutput>();
  const estimates: FixtureEvalReport["estimates"] = [];

  for (const f of SYNTHETIC_FIXTURES) {
    const out = estimateFromFixture({
      keyword: f.keyword,
      locale: f.locale,
      serp: f.serp,
      authorityRaw: f.authority,
      volumeBand: f.volumeBand,
      volumeSource: "fixture",
      serpVendor: "fixture",
    });
    outputs.set(f.keyword, out);
    estimates.push({
      keyword: f.keyword,
      estimate: out.estimate,
      band: out.uncertaintyBand,
      uncertainty: out.uncertainty,
    });
  }

  const get = (kw: string): DifficultyOutput => {
    const o = outputs.get(kw);
    if (!o) throw new Error(`fixture missing: ${kw}`);
    return o;
  };

  const easy = get("best ergonomic office chair for short people under $200");
  const medium = get("project management software for small teams");
  const hard = get("insurance");
  const aio = get("what is a good credit score");
  const unknown = get("quantum ferret habitat setup guide");

  const checks: FixtureEvalCheck[] = [];

  checks.push(
    check(
      "ordering: easy < medium < hard",
      easy.estimate < medium.estimate && medium.estimate < hard.estimate,
      `easy=${easy.estimate} medium=${medium.estimate} hard=${hard.estimate}`,
    ),
  );

  checks.push(
    check(
      "crowding: AIO-heavy estimates harder than medium",
      aio.estimate > medium.estimate,
      `aio=${aio.estimate} (crowding=${aio.components.serpCrowding}) medium=${medium.estimate} (crowding=${medium.components.serpCrowding})`,
    ),
  );

  const maxKnownUncertainty = Math.max(easy.uncertainty, medium.uncertainty, hard.uncertainty, aio.uncertainty);
  checks.push(
    check(
      "uncertainty: no-authority fixture has the widest band",
      unknown.uncertainty > maxKnownUncertainty,
      `unknown=±${unknown.uncertainty} vs max-known=±${maxKnownUncertainty}`,
    ),
  );

  // Same inputs, narrow vs. wide volume band → wider band widens the interval.
  const narrow = estimateFromFixture({
    keyword: "band-test",
    locale: "en-US",
    serp: SYNTHETIC_FIXTURES[0].serp,
    authorityRaw: SYNTHETIC_FIXTURES[0].authority,
    volumeBand: "100–1K",
    volumeSource: "fixture",
    serpVendor: "fixture",
  });
  const wide = estimateFromFixture({
    keyword: "band-test",
    locale: "en-US",
    serp: SYNTHETIC_FIXTURES[0].serp,
    authorityRaw: SYNTHETIC_FIXTURES[0].authority,
    volumeBand: null, // no volume source at all
    serpVendor: "fixture",
  });
  checks.push(
    check(
      "uncertainty: missing volume widens the band vs. a narrow band",
      wide.uncertainty > narrow.uncertainty,
      `narrow(100–1K)=±${narrow.uncertainty} missing=±${wide.uncertainty}`,
    ),
  );

  const provenanceOk = [...outputs.values()].every(
    (o) =>
      o.modelVersion === MODEL_VERSION &&
      o.inputsProvenance.serpVendor === "fixture" &&
      o.inputsProvenance.volumeBand != null &&
      o.inputsProvenance.authoritySources.length === 3,
  );
  checks.push(
    check(
      "provenance: every output carries modelVersion + full provenance",
      provenanceOk,
      `checked ${outputs.size} outputs`,
    ),
  );

  const estimatesInRange = [...outputs.values()].every(
    (o) => o.estimate >= 0 && o.estimate <= 100 && o.uncertaintyBand[0] <= o.estimate && o.estimate <= o.uncertaintyBand[1],
  );
  checks.push(
    check(
      "sanity: estimates in 0–100 and inside their own bands",
      estimatesInRange,
      `checked ${outputs.size} outputs`,
    ),
  );

  return {
    modelVersion: MODEL_VERSION,
    passed: checks.every((c) => c.passed),
    checks,
    estimates,
  };
}
