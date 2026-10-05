// ShapesOS — Phase 13 (twinui): a bin zone — a floor marking with small bins,
// one per SKU (capped by the zone's area); empty when nothing is on hand.

"use client";

import { useMemo } from "react";
import type { KindProps } from "../context";
import { GroundBlock, InstancedBoxes } from "../primitives";

export default function BinZone({ o }: KindProps) {
  const { w, d } = o.footprint;
  const skus = o.state.kind === "bin_zone" || o.state.kind === "rack" || o.state.kind === "shelf" ? o.state.skuCount : 0;
  const onHand = o.state.kind === "bin_zone" || o.state.kind === "rack" || o.state.kind === "shelf" ? o.state.onHand : 0;
  const bins = useMemo(() => {
    const cols = Math.max(1, Math.floor((w - 0.4) / 0.8));
    const rows = Math.max(1, Math.floor((d - 0.4) / 0.8));
    const n = onHand > 0 ? Math.min(cols * rows, Math.max(1, skus)) : 0;
    const out: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      out.push({ x: -w / 2 + 0.2 + 0.8 * (c + 0.5), y: 0.3, z: -d / 2 + 0.2 + 0.8 * (r + 0.5) });
    }
    return out;
  }, [w, d, skus, onHand]);
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.04} clay={3} />
      <GroundBlock w={w - 0.2} d={d - 0.2} h={0.05} clay={1} />
      <InstancedBoxes positions={bins} size={{ x: 0.6, y: 0.5, z: 0.6 }} clay={2} />
    </group>
  );
}
