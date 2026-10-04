// ShapesOS — Phase 13 (twinui): a store shelf (gondola) — base, back panel,
// three shelf levels and product boxes instanced from the on-hand quantity.

"use client";

import { useMemo } from "react";
import { palletCount, shelfSlots, UNITS_PER_BOX } from "@/lib/twin/scene-kit";
import type { KindProps } from "../context";
import { GroundBlock, InstancedBoxes } from "../primitives";

export default function Shelf({ o }: KindProps) {
  const { w, d } = o.footprint;
  const h = Math.max(1.2, o.footprint.h);
  const onHand = o.state.kind === "shelf" || o.state.kind === "rack" || o.state.kind === "bin_zone" ? o.state.onHand : 0;
  const alongX = w >= d;
  const long = alongX ? w : d;
  const slots = useMemo(() => shelfSlots(w, d, h), [w, d, h]);
  const boxes = useMemo(() => slots.slice(0, palletCount(onHand, slots.length, UNITS_PER_BOX)), [slots, onHand]);
  const step = Math.max(0.5, h) / 3.4;
  const planks = useMemo(() => [0, 1, 2].map((l) => ({ x: 0, y: 0.2 + l * step, z: 0 })), [step]);
  const per = Math.max(1, Math.floor(long / 0.5));
  const boxSize = alongX ? { x: (long / per) * 0.8, y: 0.28, z: d * 0.7 } : { x: w * 0.7, y: 0.28, z: (long / per) * 0.8 };
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.15} clay={3} />
      <GroundBlock w={alongX ? w : 0.08} d={alongX ? 0.08 : d} h={h} clay={2} />
      <InstancedBoxes positions={planks} size={{ x: w, y: 0.05, z: d }} clay={1} />
      <InstancedBoxes positions={boxes} size={boxSize} clay={2} max={slots.length} />
    </group>
  );
}
