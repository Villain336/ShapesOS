// M7b backtest: run the M2 correlation engine (flagImpacts) over the exact
// syntheticSite fixture (3 genuinely-hit pages + 40 noise pages) and report
// detection precision/recall. Pure/offline — no vendor APIs.
import { flagImpacts } from "@/lib/intelligence/radar/correlate";
import type { PageQueryDelta } from "@/lib/intelligence/radar/types";

function delta(over: Partial<PageQueryDelta>): PageQueryDelta {
  return {
    projectId: "proj_1", page: "https://example.com/", query: "example query",
    deltaClicks: 0, deltaImpressions: 0, deltaPosition: 0, magnitude: 0, ...over,
  };
}
const EXPECTED = new Set([
  "https://example.com/hit-1",
  "https://example.com/hit-2",
  "https://example.com/winner-1",
]);
const deltas: PageQueryDelta[] = [];
for (let i = 0; i < 40; i++) {
  deltas.push(delta({
    page: `https://example.com/noise-${i}`, query: `noise query ${i}`,
    deltaClicks: (i % 5) - 2, deltaImpressions: (i % 7) - 3, deltaPosition: (i % 3) - 1,
    magnitude: 2 + (i % 5),
  }));
}
deltas.push(
  delta({ page: "https://example.com/hit-1", query: "money keyword", deltaClicks: -180, deltaImpressions: -900, deltaPosition: 6.2, magnitude: 68 }),
  delta({ page: "https://example.com/hit-2", query: "brand keyword", deltaClicks: -95, deltaImpressions: -400, deltaPosition: 3.1, magnitude: 41 }),
  delta({ page: "https://example.com/winner-1", query: "long tail", deltaClicks: 120, deltaImpressions: 700, deltaPosition: -2.4, magnitude: 52 }),
);
const { impacts, band } = flagImpacts(deltas);
const flagged = new Set(impacts.map((i) => i.page));
const tp = [...flagged].filter((p) => EXPECTED.has(p)).length;
const fp = flagged.size - tp;
const fn = EXPECTED.size - tp;
console.log("deltas considered:", deltas.length);
console.log("noise threshold:", band.threshold.toFixed(2));
console.log("flagged:", [...flagged].join(", "));
console.log(`precision=${tp}/${flagged.size} recall=${tp}/${EXPECTED.size}`);
console.log(`precision=${flagged.size ? (tp / flagged.size).toFixed(2) : "n/a"} recall=${(tp / EXPECTED.size).toFixed(2)}`);
console.log(`false positives=${fp} false negatives=${fn}`);
console.log("directions:", impacts.map((i) => `${i.page.split("/").pop()}=${i.direction}(${i.impactScore})`).join(" "));
