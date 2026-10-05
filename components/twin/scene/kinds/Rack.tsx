// ShapesOS — Phase 13 (twinui): a pallet rack. Uprights and beams are one
// instanced mesh; pallets are another, their count from the bound location's
// on-hand quantity (scene-kit palletCount, capped by the rack's slots).

"use client";

import { useMemo } from "react";
import { palletCount, rackSlots } from "@/lib/twin/scene-kit";
import type { KindProps } from "../context";
import { InstancedBoxes } from "../primitives";

export default function Rack({ o }: KindProps) {
  const { w, d } = o.footprint;
  const h = Math.max(1.5, o.footprint.h);
  const onHand = o.state.kind === "rack" || o.state.kind === "bin_zone" || o.state.kind === "shelf" ? o.state.onHand : 0;
  const alongX = w >= d;
  const long = alongX ? w : d;
  const deep = alongX ? d : w;
  const slots = useMemo(() => rackSlots(w, d, h), [w, d, h]);
  const bays = slots.length / Math.max(1, Math.floor(Math.max(1, h) / 1.25));
  const levels = Math.max(1, Math.floor(Math.max(1, h) / 1.25));

  const frame = useMemo(() => {
    const uprights: { x: number; y: number; z: number }[] = [];
    const beams: { x: number; y: number; z: number }[] = [];
    const bay = long / bays;
    for (let b = 0; b <= bays; b++) {
      const t = -long / 2 + b * bay;
      for (const s of [-1, 1]) {
        const u = s * (deep / 2 - 0.05);
        uprights.push(alongX ? { x: t, y: h / 2, z: u } : { x: u, y: h / 2, z: t });
      }
    }
    for (let l = 0; l < levels; l++) {
      const y = 0.15 + l * 1.25;
      for (const s of [-1, 1]) {
        const u = s * (deep / 2 - 0.05);
        beams.push(alongX ? { x: 0, y, z: u } : { x: u, y, z: 0 });
      }
    }
    return { uprights, beams };
  }, [alongX, long, deep, bays, levels, h]);

  const pallets = useMemo(() => slots.slice(0, palletCount(onHand, slots.length)), [slots, onHand]);
  const bayLen = long / bays;
  const loadSize = alongX ? { x: bayLen * 0.8, y: 0.7, z: deep * 0.8 } : { x: deep * 0.8, y: 0.7, z: bayLen * 0.8 };
  const baseSize = alongX ? { x: bayLen * 0.86, y: 0.14, z: deep * 0.86 } : { x: deep * 0.86, y: 0.14, z: bayLen * 0.86 };
  const bases = useMemo(() => pallets.map((p) => ({ x: p.x, y: p.y - 0.42, z: p.z })), [pallets]);
  return (
    <group>
      <InstancedBoxes positions={frame.uprights} size={{ x: 0.1, y: h, z: 0.1 }} clay={4} />
      <InstancedBoxes
        positions={frame.beams}
        size={alongX ? { x: long, y: 0.1, z: 0.08 } : { x: 0.08, y: 0.1, z: long }}
        clay={3}
      />
      <InstancedBoxes positions={bases} size={baseSize} clay={3} max={slots.length} />
      <InstancedBoxes positions={pallets} size={loadSize} clay={2} max={slots.length} />
    </group>
  );
}
