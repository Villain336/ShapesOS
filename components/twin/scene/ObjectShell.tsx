// ShapesOS — Phase 13 (twinui): wraps one layout object in the scene —
// places and rotates it (grid → world via the scene kit), raycast hover and
// click-select, ink selection edges (no glow), and in edit mode drag-to-move
// with grid snap. Equipment is placed at its estimated position instead of
// its home cell.

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import type { TwinFootprint, TwinObject } from "@/lib/twin/types";
import {
  boxGeometry,
  cellToWorld,
  clampFootprint,
  footprintCenter,
  localSize,
  resolveToken,
  rotationY,
  worldToGrid,
} from "@/lib/twin/scene-kit";
import { useTwinScene } from "./context";
import { KIND_COMPONENTS } from "./registry";

let edgesGeo: THREE.EdgesGeometry | null = null;
const edgeMats = new Map<string, THREE.LineBasicMaterial>();
function edgeMaterial(token: string) {
  let m = edgeMats.get(token);
  if (!m) {
    m = new THREE.LineBasicMaterial({ color: new THREE.Color(resolveToken(token)) });
    edgeMats.set(token, m);
  }
  return m;
}

/** Local bounding box of an object (for selection edges and drag hit area). */
/** Local (unturned) bounding box of an object — for selection edges and labels. */
export function objectBounds(o: TwinObject): { w: number; h: number; d: number } {
  if (o.kind === "equipment") return { w: 1.3, h: 2.3, d: 2.6 };
  const h = o.kind === "path" || o.kind === "yard_slot" ? 0.1 : o.kind === "bin_zone" ? 0.7 : Math.max(0.3, o.footprint.h);
  const s = localSize(o.footprint);
  return { w: s.w, h, d: s.d };
}

/** The object as its kind component sees it: footprint w/d in LOCAL (unturned) space. */
function localObject(o: TwinObject, fp: TwinFootprint): TwinObject {
  const s = localSize(fp);
  return { ...o, footprint: { ...fp, w: s.w, d: s.d } };
}

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export function ObjectShell({ o }: { o: TwinObject }) {
  const ctx = useTwinScene();
  const { camera, gl, invalidate } = useThree();
  const [draft, setDraft] = useState<TwinFootprint | null>(null);
  const drag = useRef<{ dx: number; dz: number; moved: boolean } | null>(null);
  const fp = draft ?? o.footprint;
  const selected = ctx.selectedId === o.id;
  const hovered = ctx.hoverId === o.id;

  // Drop the draft once the server's footprint catches up.
  useEffect(() => setDraft(null), [o.footprint]);

  const pos = useMemo(() => {
    if (o.state.kind === "equipment" && !draft) {
      const p = cellToWorld(o.state.position.x, o.state.position.z, ctx.grid);
      return [p.x, 0, p.z] as const;
    }
    const c = footprintCenter(fp, ctx.grid);
    return [c.x, 0, c.z] as const;
  }, [o.state, fp, ctx.grid, draft]);

  const bounds = objectBounds({ ...o, footprint: fp });
  const Kind = KIND_COMPONENTS[o.kind];

  const groundCell = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const r = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(GROUND, hit)) return null;
    return worldToGrid(hit.x, hit.z, ctx.grid);
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!ctx.editing || !selected || o.kind === "equipment") return;
    e.stopPropagation();
    const g = groundCell(e.nativeEvent.clientX, e.nativeEvent.clientY);
    if (!g) return;
    drag.current = { dx: g.x - o.footprint.x, dz: g.z - o.footprint.z, moved: false };
    if (ctx.controls.current) ctx.controls.current.enabled = false;
    gl.domElement.style.cursor = "grabbing";
    let latest: TwinFootprint = o.footprint;
    const move = (ev: PointerEvent) => {
      const cell = groundCell(ev.clientX, ev.clientY);
      if (!cell || !drag.current) return;
      const next = clampFootprint({ ...o.footprint, x: Math.round(cell.x - drag.current.dx), z: Math.round(cell.z - drag.current.dz) }, ctx.grid);
      if (next.x !== latest.x || next.z !== latest.z) {
        latest = next;
        drag.current.moved = true;
        setDraft(next);
        invalidate();
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (ctx.controls.current) ctx.controls.current.enabled = true;
      gl.domElement.style.cursor = "";
      const moved = drag.current?.moved;
      drag.current = null;
      if (moved && (latest.x !== o.footprint.x || latest.z !== o.footprint.z)) {
        void Promise.resolve(ctx.onMove(o, latest)).then((ok) => {
          if (ok === false) setDraft(null);
        });
      } else setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!edgesGeo) edgesGeo = new THREE.EdgesGeometry(boxGeometry());

  return (
    <group
      position={pos as unknown as [number, number, number]}
      rotation={[0, rotationY(fp.rotation), 0]}
      onPointerOver={(e) => {
        e.stopPropagation();
        ctx.onHover(o.id);
        gl.domElement.style.cursor = ctx.editing && selected ? "grab" : "pointer";
      }}
      onPointerOut={() => {
        ctx.onHover(null);
        gl.domElement.style.cursor = "";
      }}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta > 4) return; // a pan, not a click
        ctx.onSelect(o.id);
      }}
    >
      <Suspense fallback={null}>
        <Kind o={localObject(o, fp)} />
      </Suspense>
      {(selected || hovered) && (
        <lineSegments
          geometry={edgesGeo}
          material={edgeMaterial(selected ? "--aos-ink" : "--aos-text-muted")}
          scale={[bounds.w + 0.2, bounds.h + 0.2, bounds.d + 0.2]}
          position={[0, (bounds.h + 0.2) / 2 - 0.05, 0]}
          raycast={() => null}
        />
      )}
    </group>
  );
}
