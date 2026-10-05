// ShapesOS — Phase 13 (twinui): a path / aisle — a flat strip with a dashed
// centre line (instanced).

"use client";

import { useMemo } from "react";
import type { KindProps } from "../context";
import { GroundBlock, InstancedBoxes } from "../primitives";

export default function Path({ o }: KindProps) {
  const { w, d } = o.footprint;
  const alongX = w >= d;
  const long = alongX ? w : d;
  const dashes = useMemo(() => {
    const n = Math.max(1, Math.floor(long / 2));
    return Array.from({ length: n }, (_, i) => {
      const t = -long / 2 + (long / n) * (i + 0.5);
      return alongX ? { x: t, y: 0.035, z: 0 } : { x: 0, y: 0.035, z: t };
    });
  }, [alongX, long]);
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.02} clay={1} />
      <InstancedBoxes positions={dashes} size={alongX ? { x: 0.9, y: 0.02, z: 0.1 } : { x: 0.1, y: 0.02, z: 0.9 }} clay={3} />
    </group>
  );
}
