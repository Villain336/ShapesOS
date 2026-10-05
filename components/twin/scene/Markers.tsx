// ShapesOS — Phase 13 (twinui): billboards floating over objects — agent
// markers (the aos status colour + shape in a white pill: the ONLY status
// colours in the scene), alert bells (black, never red) and one hover /
// selection label (neutral pill; equipment says "estimated").
//
// They are plain DOM in a layer over the canvas (MarkerLayer), positioned by
// MarkerProjector inside the scene: on every rendered frame (frameloop is
// "demand", so only when the camera or scene changes) it projects each
// anchor to screen space and writes the transform straight to the node —
// no React render per frame, and no extra React roots (drei <Html> mounts one
// per billboard).

"use client";

import { useEffect, type MutableRefObject } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { BellRing } from "lucide-react";
import { StatusShape } from "@/components/aos/StatusShape";
import { STATUS_META } from "@/lib/aos/status";
import type { TwinAgentMarker, TwinObject } from "@/lib/twin/types";
import { cellToWorld, footprintCenter, type SiteGrid } from "@/lib/twin/scene-kit";
import { objectBounds } from "./ObjectShell";

export type MarkerNodes = MutableRefObject<Map<string, HTMLElement>>;

export interface MarkerAnchor {
  key: string;
  x: number;
  y: number;
  z: number;
}

/** Where an object's billboard floats (world space). */
export function markerAnchor(o: TwinObject, grid: SiteGrid): { x: number; y: number; z: number } {
  const p = o.state.kind === "equipment" ? cellToWorld(o.state.position.x, o.state.position.z, grid) : footprintCenter(o.footprint, grid);
  return { x: p.x, y: objectBounds(o).h + (o.kind === "building" ? 0.5 : 1.2), z: p.z };
}

const v = new THREE.Vector3();

/** Inside <Canvas>: project anchors → screen and move the DOM nodes. */
export function MarkerProjector({ anchors, nodes }: { anchors: MarkerAnchor[]; nodes: MarkerNodes }) {
  const invalidate = useThree((s) => s.invalidate);
  // New / moved anchors need a frame to be placed.
  useEffect(() => {
    invalidate();
  }, [anchors, invalidate]);
  useFrame(({ camera, size }) => {
    for (const a of anchors) {
      const el = nodes.current.get(a.key);
      if (!el) continue;
      v.set(a.x, a.y, a.z).project(camera);
      const visible = v.z >= -1 && v.z <= 1 && Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2;
      const px = ((v.x + 1) / 2) * size.width;
      const py = ((1 - v.y) / 2) * size.height;
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
      el.style.visibility = visible ? "visible" : "hidden";
    }
  });
  return null;
}

function register(nodes: MarkerNodes, key: string) {
  return (el: HTMLElement | null) => {
    if (el) nodes.current.set(key, el);
    else nodes.current.delete(key);
  };
}

/** Outside <Canvas>, over it: the billboards themselves. */
export function MarkerLayer({
  marked,
  agents,
  focus,
  focusedId,
  nodes,
  onSelect,
}: {
  /** objects with agents or an alert */
  marked: TwinObject[];
  agents: Map<string, TwinAgentMarker[]>;
  /** the hovered (else selected) object */
  focus: TwinObject | null;
  focusedId: string | null;
  nodes: MarkerNodes;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={marked.length === 0 && !focus}>
      {marked.map((o) => {
        const list = agents.get(o.id) ?? [];
        const focused = focusedId === o.id;
        return (
          <div key={o.id} ref={register(nodes, `m:${o.id}`)} className="absolute left-0 top-0" style={{ visibility: "hidden" }}>
            <div className="flex -translate-x-1/2 -translate-y-full items-center gap-1 pb-1">
              {list.slice(0, 3).map((a) => (
                <button
                  key={a.runId}
                  type="button"
                  title={`${STATUS_META[a.status].label}: ${a.label}`}
                  onClick={() => onSelect(o.id)}
                  className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-paper px-2 text-xs font-semibold text-ink shadow-raised"
                >
                  <StatusShape status={a.status} size={12} label={`${STATUS_META[a.status].label}, ${o.label}`} />
                  {focused ? <span className="max-w-[180px] truncate">{a.label}</span> : null}
                </button>
              ))}
              {o.alert && (
                <span
                  title={o.alert.message}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink text-paper"
                  role="img"
                  aria-label={`Alert on ${o.label}: ${o.alert.message}`}
                >
                  <BellRing size={14} aria-hidden />
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div ref={register(nodes, "focus")} className="absolute left-0 top-0" style={{ visibility: "hidden" }}>
        {focus ? (
          <span className="inline-flex h-6 -translate-x-1/2 translate-y-1 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-2.5 text-xs font-semibold text-ink shadow-hairline">
            {focus.label}
            {focus.pill ? <span className="font-medium text-muted">{focus.pill}</span> : null}
            {focus.kind === "equipment" ? <span className="font-medium text-muted">· estimated</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
