// ShapesOS — Phase 13 (twinui): a forklift / cart. Positioned by the object
// shell at its ESTIMATED position (the last task location; no telemetry) —
// the hover label and inspector say "estimated". Front = +z (the forks).

"use client";

import type { KindProps } from "../context";
import { Block, Cylinder, GroundBlock } from "../primitives";

export default function Equipment({ o }: KindProps) {
  const cart = /cart|trolley/i.test(o.label);
  if (cart) {
    return (
      <group>
        <GroundBlock w={1} d={1.8} h={0.5} base={0.25} clay={2} />
        {[-0.6, 0.6].flatMap((z) => [-0.45, 0.45].map((x) => <Cylinder key={`${x}${z}`} r={0.18} len={0.12} at={[x, 0.18, z]} axis="x" />))}
      </group>
    );
  }
  const charging = o.state.kind === "equipment" && o.state.status === "charging";
  return (
    <group>
      {/* body + counterweight */}
      <GroundBlock w={1.1} d={1.5} h={0.9} base={0.25} z={-0.2} clay={2} />
      <GroundBlock w={1.1} d={0.45} h={0.6} base={0.25} z={-0.95} clay={3} />
      {/* overhead guard */}
      {[-0.45, 0.45].flatMap((x) => [-0.7, 0.35].map((z) => <Block key={`${x}${z}`} size={[0.07, 1.0, 0.07]} at={[x, 1.65, z]} clay={4} />))}
      <Block size={[1.0, 0.06, 1.15]} at={[0, 2.15, -0.17]} clay={3} />
      {/* mast + forks (raised a little while charging = parked) */}
      <Block size={[0.9, 2.1, 0.12]} at={[0, 1.2, 0.62]} clay={4} />
      <Block size={[0.12, 0.06, 1.0]} at={[-0.25, charging ? 0.6 : 0.12, 1.15]} clay={4} />
      <Block size={[0.12, 0.06, 1.0]} at={[0.25, charging ? 0.6 : 0.12, 1.15]} clay={4} />
      {/* wheels */}
      {[-0.55, 0.55].flatMap((x) => [-0.7, 0.35].map((z) => <Cylinder key={`w${x}${z}`} r={0.24} len={0.2} at={[x, 0.24, z]} axis="x" />))}
    </group>
  );
}
