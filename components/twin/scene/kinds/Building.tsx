// ShapesOS — Phase 13 (twinui): a building. A hall that holds other objects
// is drawn cut-away (floor slab, full back walls, low walls on the sides that
// face the camera, no roof) so its racks and machines stay visible; a building
// with nothing inside is a solid block with a roof slab and parapet.

"use client";

import { facingWalls } from "@/lib/twin/scene-kit";
import { useTwinScene, type KindProps } from "../context";
import { Block, GroundBlock } from "../primitives";

const WALL = 0.3;
const LOW = 0.7;

export default function Building({ o }: KindProps) {
  const { hollowBuildings, quadrant } = useTwinScene();
  const { w, d } = o.footprint;
  const h = Math.max(1, o.footprint.h);
  if (!hollowBuildings.has(o.id)) {
    return (
      <group>
        <GroundBlock w={w} d={d} h={h} clay={2} />
        <GroundBlock w={w - 0.4} d={d - 0.4} h={0.12} base={h} clay={1} />
        <GroundBlock w={w * 0.18} d={d * 0.22} h={0.6} base={h} x={-w * 0.22} z={-d * 0.15} clay={3} />
      </group>
    );
  }
  // Local space is unrotated; map the world-facing walls back through the
  // object's rotation so the cut stays on the camera side.
  const steps = (o.footprint.rotation / 90) % 4;
  const q = (((quadrant - steps) % 4) + 4) % 4;
  const face = facingWalls(q as 0 | 1 | 2 | 3);
  const wallH = (low: boolean) => (low ? LOW : h);
  return (
    <group>
      <GroundBlock w={w} d={d} h={0.08} clay={1} />
      {/* north (−z) and south (+z) */}
      <Block size={[w, wallH(face.north), WALL]} at={[0, wallH(face.north) / 2, -d / 2 + WALL / 2]} clay={2} />
      <Block size={[w, wallH(face.south), WALL]} at={[0, wallH(face.south) / 2, d / 2 - WALL / 2]} clay={2} />
      {/* west (−x) and east (+x) */}
      <Block size={[WALL, wallH(face.west), d]} at={[-w / 2 + WALL / 2, wallH(face.west) / 2, 0]} clay={2} />
      <Block size={[WALL, wallH(face.east), d]} at={[w / 2 - WALL / 2, wallH(face.east) / 2, 0]} clay={2} />
      {/* cap on the tall walls */}
      {!face.north && <Block size={[w, 0.15, WALL + 0.1]} at={[0, h + 0.07, -d / 2 + WALL / 2]} clay={3} />}
      {!face.west && <Block size={[WALL + 0.1, 0.15, d]} at={[-w / 2 + WALL / 2, h + 0.07, 0]} clay={3} />}
      {!face.south && <Block size={[w, 0.15, WALL + 0.1]} at={[0, h + 0.07, d / 2 - WALL / 2]} clay={3} />}
      {!face.east && <Block size={[WALL + 0.1, 0.15, d]} at={[w / 2 - WALL / 2, h + 0.07, 0]} clay={3} />}
    </group>
  );
}
