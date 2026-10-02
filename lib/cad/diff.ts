// Marketr — CAD + Hardware slice 1: pure visual-diff metadata.
// Compares two per-version geometry snapshots. The honesty rule from
// geometry.ts applies here too: a diff is "computed" only when BOTH sides
// yielded real parsed stats; otherwise availability is "unavailable" and
// every numeric delta is null — the UI says "not computable", never a guess.

import type { ModelDiffResult, VersionGeometrySnapshot } from "./types";

type V = [number, number, number];

function size(min: V, max: V): V {
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

function center(min: V, max: V): V {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function dist(a: V, b: V): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

/**
 * Compute diff metadata between two version snapshots. Pure and total: the
 * same pair always yields the same row (idempotent — re-running overwrites
 * with an identical record).
 */
export function computeModelDiff(
  from: VersionGeometrySnapshot,
  to: VersionGeometrySnapshot,
): ModelDiffResult {
  const bothHaveCounts =
    from.triangleCount !== null && to.triangleCount !== null;
  const bothHaveBbox =
    from.bboxMin !== null && from.bboxMax !== null &&
    to.bboxMax !== null && to.bboxMin !== null;

  if (!bothHaveCounts || !bothHaveBbox) {
    return {
      availability: "unavailable",
      triangleDelta: null,
      sizeDelta: null,
      centerDelta: null,
      volumeFrom: null,
      volumeTo: null,
      volumeDelta: null,
    };
  }

  const fromSize = size(from.bboxMin as V, from.bboxMax as V);
  const toSize = size(to.bboxMin as V, to.bboxMax as V);
  const centerDelta = dist(
    center(from.bboxMin as V, from.bboxMax as V),
    center(to.bboxMin as V, to.bboxMax as V),
  );

  const volumeFrom = from.volumeEstimate;
  const volumeTo = to.volumeEstimate;
  const volumeDelta =
    volumeFrom !== null && volumeTo !== null ? volumeTo - volumeFrom : null;

  return {
    availability: "computed",
    triangleDelta: (to.triangleCount as number) - (from.triangleCount as number),
    sizeDelta: [
      toSize[0] - fromSize[0],
      toSize[1] - fromSize[1],
      toSize[2] - fromSize[2],
    ],
    centerDelta,
    volumeFrom,
    volumeTo,
    volumeDelta,
  };
}
