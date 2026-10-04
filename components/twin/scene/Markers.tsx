// ShapesOS — Phase 13 (twinui): HTML billboards floating over objects —
// agent markers (the aos status colour + shape in a white pill: the ONLY
// status colours in the scene), alert bells (black, never red) and ONE
// persistent hover/selection label (neutral pill; equipment says
// "estimated"). Each <Html> is its own React root, so they stay mounted and
// only their content changes — mounting one per hover makes React unmount a
// root mid-render.

"use client";

import { Html } from "@react-three/drei";
import { BellRing } from "lucide-react";
import { StatusShape } from "@/components/aos/StatusShape";
import { STATUS_META } from "@/lib/aos/status";
import type { TwinAgentMarker, TwinObject } from "@/lib/twin/types";
import { cellToWorld, footprintCenter } from "@/lib/twin/scene-kit";
import { useTwinScene } from "./context";
import { objectBounds } from "./ObjectShell";

function anchor(o: TwinObject, grid: { gridW: number; gridD: number }) {
  if (o.state.kind === "equipment") return cellToWorld(o.state.position.x, o.state.position.z, grid);
  return footprintCenter(o.footprint, grid);
}

const Z = [30, 10] as [number, number];

/** Agent markers + alert bell for one object (mounted only while it has either). */
export function ObjectMarkers({ o, agents }: { o: TwinObject; agents: TwinAgentMarker[] }) {
  const ctx = useTwinScene();
  const p = anchor(o, ctx.grid);
  const top = objectBounds(o).h + (o.kind === "building" ? 0.5 : 1.2);
  const focused = ctx.hoverId === o.id || ctx.selectedId === o.id;
  return (
    <Html position={[p.x, top, p.z]} center zIndexRange={Z} style={{ pointerEvents: "none" }}>
      <div className="flex items-center gap-1" style={{ transform: "translateY(-50%)" }}>
        {agents.slice(0, 3).map((a) => (
          <button
            key={a.runId}
            type="button"
            title={`${STATUS_META[a.status].label}: ${a.label}`}
            onClick={() => ctx.onSelect(o.id)}
            className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-paper px-2 text-xs font-semibold text-ink shadow-raised"
          >
            <StatusShape status={a.status} size={12} label={STATUS_META[a.status].label} />
            {focused ? <span className="max-w-[180px] truncate">{a.label}</span> : null}
          </button>
        ))}
        {o.alert && (
          <span
            title={o.alert.message}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink text-paper"
            role="img"
            aria-label={`Alert: ${o.alert.message}`}
          >
            <BellRing size={14} aria-hidden />
          </span>
        )}
      </div>
    </Html>
  );
}

/** The hovered (else selected) object's name + state, under its markers. Always mounted. */
export function FocusLabel({ objects }: { objects: TwinObject[] }) {
  const ctx = useTwinScene();
  const id = ctx.hoverId ?? ctx.selectedId;
  const o = id ? objects.find((x) => x.id === id) : undefined;
  const p = o ? anchor(o, ctx.grid) : { x: 0, z: 0 };
  const top = o ? objectBounds(o).h + (o.kind === "building" ? 0.5 : 1.2) : -100;
  return (
    <Html position={[p.x, top, p.z]} center zIndexRange={Z} style={{ pointerEvents: "none" }}>
      {o ? (
        <span
          className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-2.5 text-xs font-semibold text-ink shadow-hairline"
          style={{ transform: "translateY(60%)" }}
        >
          {o.label}
          {o.pill ? <span className="font-medium text-muted">{o.pill}</span> : null}
          {o.kind === "equipment" ? <span className="font-medium text-muted">· estimated</span> : null}
        </span>
      ) : null}
    </Html>
  );
}
