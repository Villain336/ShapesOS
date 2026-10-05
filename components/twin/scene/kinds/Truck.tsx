// ShapesOS — Phase 13 (twinui): a truck backed onto a dock door. Drawn by
// DockDoor only while a booking is arrived / loading / unloading. Local space
// of the door: the truck's rear is at the door, the cab points outward (+z).

"use client";

import { Block, Cylinder } from "../primitives";

export const TRUCK_LENGTH = 10.5;

export default function Truck({ doorDepth }: { doorDepth: number }) {
  const z0 = doorDepth / 2 + 0.25; // rear bumper
  const trailerL = 8;
  const cabL = 2.2;
  const width = 2.4;
  const wheelZ = [z0 + 1.0, z0 + 2.3, z0 + trailerL + 0.6, z0 + trailerL + 1.7];
  return (
    <group>
      {/* trailer */}
      <Block size={[width, 2.6, trailerL]} at={[0, 1.2 + 1.3, z0 + trailerL / 2]} clay={0} />
      <Block size={[width + 0.04, 0.12, trailerL + 0.04]} at={[0, 1.2 + 2.6, z0 + trailerL / 2]} clay={3} />
      <Block size={[width, 0.25, trailerL]} at={[0, 1.08, z0 + trailerL / 2]} clay={4} />
      {/* cab */}
      <Block size={[width, 2.2, cabL]} at={[0, 0.6 + 1.1, z0 + trailerL + 0.3 + cabL / 2]} clay={3} />
      <Block size={[width - 0.3, 0.7, 0.06]} at={[0, 2.25, z0 + trailerL + 0.3 + cabL + 0.01]} clay={4} />
      {/* wheels */}
      {wheelZ.flatMap((z) => [-1, 1].map((s) => <Cylinder key={`${z}-${s}`} r={0.45} len={0.35} at={[s * (width / 2 - 0.1), 0.45, z]} axis="x" clay={4} />))}
    </group>
  );
}
