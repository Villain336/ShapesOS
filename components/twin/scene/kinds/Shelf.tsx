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
  const cross = alongX ? d : w;
  const slots = useMemo(() => shelfSlots(w, d, h), [w, d, h]);
  // A gondola is two-sided: every slot has a facing on each side of the back panel.
  const faces = useMemo(
    () =>
      slots.flatMap((p) =>
        [-1, 1].map((side) => (alongX ? { x: p.x, y: p.y, z: (side * cross) / 4 } : { x: (side * cross) / 4, y: p.y, z: p.z })),
      ),
    [slots, alongX, cross],
  );
  const boxes = useMemo(() => faces.slice(0, palletCount(onHand, faces.length, UNITS_PER_BOX)), [faces, onHand]);
  const step = Math.max(0.5, h) / 3.4;
  const planks = useMemo(() => [0, 1, 2].map((l) => ({ x: 0, y: 0.2 + l * step, z: 0 })), [step]);
  const per = Math.max(1, Math.floor(long / 0.5));
  const along = (long / per) * 0.8;
  const deep = (cross / 2) * 0.7;
  const boxSize = alongX ? { x: along, y: 0.28, z: deep } : { x: deep, y: 0.28, z: along };
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.15} clay={3} />
      <GroundBlock w={alongX ? w : 0.08} d={alongX ? 0.08 : d} h={h} clay={2} />
      <InstancedBoxes positions={planks} size={{ x: w, y: 0.05, z: d }} clay={1} />
      <InstancedBoxes positions={boxes} size={boxSize} clay={3} max={faces.length} />
    </group>
  );
}
