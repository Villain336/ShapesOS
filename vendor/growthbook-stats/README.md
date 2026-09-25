# GrowthBook OSS stats core — vendored artifact + license boundary

**Status (verified 2026-09-25):** the actual OSS package is vendored in this tree.
Nothing under GrowthBook's enterprise surface enters Marketr.

## What is vendored

- **Package:** `gbstats` **0.8.0** (the Python statistics engine published by
  GrowthBook, Inc.) — `wheel-0.8.0/`, extracted verbatim from the PyPI wheel
  `gbstats-0.8.0-py3-none-any.whl` (downloaded 2026-09-25; `pip download gbstats --no-deps`).
- **Source path upstream:** `github.com/growthbook/growthbook` →
  `packages/stats/gbstats` (the OSS monorepo package; PyPI `METADATA` confirms
  `Name: gbstats`, `Version: 0.8.0`, `License: MIT`, `Home-page: …/packages/stats`).
- **License evidence:** `wheel-0.8.0/gbstats-0.8.0.dist-info/LICENSE` — MIT
  License, Copyright (c) 2024 GrowthBook, Inc. Full text included in the wheel.
  MIT is compatible with Marketr's AGPLv3.

## Why the TS engine is a *port* of this package, not a re-download

The stats worker runs **in-process** in Marketr's Next.js runtime (spec §12.3:
"the stats worker runs in-process, not as a second deployable"). Spawning a
Python interpreter per analysis is not viable. Therefore:

- `lib/flywheel/testlab/stats.ts` is a **faithful TypeScript port** of the
  vendored 0.8.0 sources. Every ported function carries a `PORT:` comment naming
  the exact wheel file and function it mirrors
  (e.g. `check_srm` in `gbstats/utils.py`, `SequentialTwoSidedTTest` in
  `gbstats/frequentist/tests.py`, `EffectBayesianABTest` in
  `gbstats/bayesian/tests.py`).
- The wheel remains in the tree as the **audit reference**: any reviewer can
  diff the port against the vendored source.
- One deliberate, documented deviation: the wheel's Bayesian default (v0.8) is
  the *effect* (normal-approximation) test; spec §1.6 requires the classic
  **Beta-Binomial conjugate posterior for binomial metrics**, so the TS engine
  implements exact Beta-Binomial posteriors for binomial metrics and reserves
  the normal-prior form (ported from `EffectBayesianABTest`) for
  count/duration/revenue metrics. This is noted at the top of `stats.ts`.

## OSS/enterprise boundary (verified 2026-09-25 — it has moved before)

Checked against the live upstream repo (`growthbook/growthbook`, `main`):

| Check | Result |
|---|---|
| Wheel contents | Only `gbstats/` Python modules (bayesian, frequentist, models, utils, messages). No front-end/enterprise files are in the package. |
| `packages/front-end/enterprise` | **EXISTS** in upstream (HTTP 200) — this is where the visual editor and other enterprise surfaces live. Nothing was taken from it. |
| `packages/stats-ts` (a newer TS port inside the monorepo) | `package.json`: `"private": true`, `"license": "Mixed"`, depends on the internal `shared` workspace package; contains `banditWeights.ts` / `contextualBanditWeights.ts`. **Not vendored** — private + mixed-license = not safely OSS. |
| Enterprise-locked, per spec §7 | Visual editor, packaged CUPED, SSO — none of these appear in the `gbstats` wheel. CUPED-equivalents remain a v2 reimplementation-from-literature item, never a copy of the packaged enterprise code. |

**Standing rule:** any future upgrade of this vendor dir must re-verify the
boundary (license file, wheel contents, upstream enterprise dir list) before
the new files land. See spec §9 invariant 14.
