// ShapesOS — Phase 13 (twinui): a dock door (frame, door leaf, leveller,
// bumpers) plus a Truck when its booking is arrived / loading / unloading.
// The door leaf is up while a truck is docked.

"use client";

import { lazy, Suspense } from "react";
import { useTwinScene, type KindProps } from "../context";
import { Block, GroundBlock } from "../primitives";

const Truck = lazy(() => import("./Truck"));

export default function DockDoor({ o }: KindProps) {
  useTwinScene();
  const { w, d } = o.footprint;
  const h = Math.max(2.5, o.footprint.h);
  const st = o.state.kind === "dock_door" ? o.state : null;
  const docked = !!st?.booking && ["arrived", "loading", "unloading"].includes(st.booking.status);
  const open = docked || st?.status === "occupied";
  const post = 0.3;
  const leafH = open ? 0.5 : h - 0.4;
  return (
    <group>
      {/* frame */}
      <Block size={[post, h, d]} at={[-w / 2 + post / 2, h / 2, 0]} clay={3} />
      <Block size={[post, h, d]} at={[w / 2 - post / 2, h / 2, 0]} clay={3} />
      <Block size={[w, 0.4, d]} at={[0, h - 0.2, 0]} clay={3} />
      {/* door leaf (rolled up when open) */}
      <Block size={[w - post * 2, leafH, d * 0.4]} at={[0, h - 0.4 - leafH / 2, 0]} clay={open ? 3 : 2} />
      {/* leveller plate + bumpers on the front */}
      <GroundBlock w={w - post * 2} d={1.2} h={1.05} z={d / 2 + 0.6} clay={1} />
      <Block size={[0.3, 0.4, 0.2]} at={[-w / 2 + 0.6, 0.9, d / 2 + 1.25]} clay={4} />
      <Block size={[0.3, 0.4, 0.2]} at={[w / 2 - 0.6, 0.9, d / 2 + 1.25]} clay={4} />
      {docked && (
        <Suspense fallback={null}>
          <group position={[0, 0, 1.3]}>
            <Truck doorDepth={d} />
          </group>
        </Suspense>
      )}
    </group>
  );
}
