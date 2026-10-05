// ShapesOS — Phase 13 (twinui): tiny shared building blocks for the twin's
// object components — a clay box, a clay cylinder and an instanced box set —
// all on the scene kit's shared geometry + materials (lib/twin/scene-kit.ts).

"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import type * as THREE from "three";
import { boxGeometry, clayMaterial, cylinderGeometry, setInstanceBoxes, type ClayKey } from "@/lib/twin/scene-kit";

type V3 = [number, number, number];

/** A clay box: `size` w×h×d, `at` is its centre. */
export function Block({ size, at, clay = 2, rotY = 0, shadow = true }: { size: V3; at: V3; clay?: ClayKey; rotY?: number; shadow?: boolean }) {
  return (
    <mesh
      geometry={boxGeometry()}
      material={clayMaterial(clay)}
      scale={size}
      position={at}
      rotation={[0, rotY, 0]}
      castShadow={shadow}
      receiveShadow
    />
  );
}

/** A box sitting on the ground (y from `base`). */
export function GroundBlock({ w, h, d, x = 0, z = 0, base = 0, clay = 2 }: { w: number; h: number; d: number; x?: number; z?: number; base?: number; clay?: ClayKey }) {
  return <Block size={[w, Math.max(0.01, h), d]} at={[x, base + Math.max(0.01, h) / 2, z]} clay={clay} shadow={h > 0.05} />;
}

/** A clay cylinder (wheels lie on their side with `axis="x"`). */
export function Cylinder({ r, len, at, clay = 4, axis = "y" }: { r: number; len: number; at: V3; clay?: ClayKey; axis?: "x" | "y" | "z" }) {
  const rotation: V3 = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return <mesh geometry={cylinderGeometry()} material={clayMaterial(clay)} scale={[r * 2, len, r * 2]} position={at} rotation={rotation} castShadow receiveShadow />;
}

/** Many equal boxes in one draw call (pallets, stock boxes, rack uprights). */
export function InstancedBoxes({
  positions,
  size,
  clay = 2,
  max,
}: {
  positions: readonly { x: number; y: number; z: number }[];
  size: { x: number; y: number; z: number };
  clay?: ClayKey;
  /** allocated instance count (≥ positions.length) */
  max?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const cap = Math.max(1, max ?? positions.length);
  const args = useMemo(() => [boxGeometry(), clayMaterial(clay), cap] as const, [clay, cap]);
  useLayoutEffect(() => {
    if (ref.current) setInstanceBoxes(ref.current, positions, size);
  }, [positions, size]);
  if (positions.length === 0) return null;
  return <instancedMesh ref={ref} args={args as unknown as [THREE.BufferGeometry, THREE.Material, number]} castShadow receiveShadow />;
}
