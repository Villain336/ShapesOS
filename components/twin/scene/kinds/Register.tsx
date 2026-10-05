// ShapesOS — Phase 13 (twinui): a register — a counter with a screen facing
// the customer side (front).

"use client";

import type { KindProps } from "../context";
import { Block, GroundBlock } from "../primitives";

export default function Register({ o }: KindProps) {
  const { w, d } = o.footprint;
  const open = o.state.kind === "register" && o.state.status !== "closed";
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.95} clay={2} />
      <GroundBlock w={w + 0.1} d={d + 0.1} h={0.06} base={0.95} clay={1} />
      <GroundBlock w={0.08} d={0.08} h={0.35} base={1.01} x={-w / 4} clay={4} />
      {/* the screen tilts back a little; lit (lighter) while a session is open */}
      <Block size={[0.5, 0.36, 0.05]} at={[-w / 4, 1.5, 0.02]} clay={open ? 0 : 4} />
      <GroundBlock w={0.4} d={0.3} h={0.12} base={1.01} x={w / 5} clay={3} />
    </group>
  );
}
