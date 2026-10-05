// ShapesOS — Phase 13 (twinui): a yard slot — a painted outline on the ground.

"use client";

import type { KindProps } from "../context";
import { GroundBlock } from "../primitives";

export default function YardSlot({ o }: KindProps) {
  const { w, d } = o.footprint;
  const t = 0.15;
  return (
    <group>
      <GroundBlock w={w} d={t} h={0.03} z={-d / 2 + t / 2} clay={3} />
      <GroundBlock w={w} d={t} h={0.03} z={d / 2 - t / 2} clay={3} />
      <GroundBlock w={t} d={d} h={0.03} x={-w / 2 + t / 2} clay={3} />
      <GroundBlock w={t} d={d} h={0.03} x={w / 2 - t / 2} clay={3} />
    </group>
  );
}
