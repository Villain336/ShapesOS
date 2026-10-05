// ShapesOS — Phase 13 (twinui): a work centre — a machine block on a plinth
// with a top housing and a control post on its front. Its state (running,
// paused, stopped, idle) is a neutral pill in the overlays, never a colour.

"use client";

import type { KindProps } from "../context";
import { Block, GroundBlock } from "../primitives";

export default function WorkCentre({ o }: KindProps) {
  const { w, d } = o.footprint;
  const h = Math.max(1.2, o.footprint.h);
  const running = o.state.kind === "work_center" && o.state.status === "running";
  const bodyH = h * 0.62;
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.18} clay={1} />
      <GroundBlock w={w - 0.8} d={d - 1.2} h={bodyH} base={0.18} z={-0.2} clay={2} />
      <GroundBlock w={(w - 0.8) * 0.55} d={(d - 1.2) * 0.6} h={h * 0.25} base={0.18 + bodyH} x={-(w - 0.8) * 0.15} z={-0.3} clay={3} />
      {/* spindle / chute */}
      <GroundBlock w={0.5} d={0.5} h={running ? h * 0.15 : 0.08} base={0.18 + bodyH} x={(w - 0.8) * 0.3} z={0} clay={4} />
      {/* control post on the front */}
      <GroundBlock w={0.25} d={0.25} h={1.1} base={0.18} x={w / 2 - 0.7} z={d / 2 - 0.4} clay={4} />
      <Block size={[0.6, 0.45, 0.12]} at={[w / 2 - 0.7, 1.45, d / 2 - 0.35]} clay={3} />
    </group>
  );
}
