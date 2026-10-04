// ShapesOS — Phase 13 (twinui): HTML billboards floating over objects —
// agent markers (the aos status colour + shape in a white pill: the ONLY
// status colours in the scene), alert bells (black, never red) and the
// hover/selection label (neutral pill; equipment says "estimated").

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

export function ObjectMarkers({ o, agents }: { o: TwinObject; agents: TwinAgentMarker[] }) {
  const ctx = useTwinScene();
  const p = anchor(o, ctx.grid);
  const top = objectBounds(o).h + (o.kind === "building" ? 0.5 : 1.2);
  const showLabel = ctx.hoverId === o.id || ctx.selectedId === o.id;
  if (!agents.length && !o.alert && !showLabel) return null;
  return (
    <Html position={[p.x, top, p.z]} center zIndexRange={Z} style={{ pointerEvents: "none" }}>
      <div className="flex flex-col items-center gap-1" style={{ transform: "translateY(-50%)" }}>
        {(agents.length > 0 || o.alert) && (
          <div className="flex items-center gap-1">
            {agents.slice(0, 3).map((a) => (
              <button
                key={a.runId}
                type="button"
                title={`${STATUS_META[a.status].label}: ${a.label}`}
                onClick={() => ctx.onSelect(o.id)}
                className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-paper px-2 text-xs font-semibold text-ink shadow-raised"
              >
                <StatusShape status={a.status} size={12} label={STATUS_META[a.status].label} />
                {showLabel ? <span className="max-w-[180px] truncate">{a.label}</span> : null}
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
        )}
        {showLabel && (
          <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-2.5 text-xs font-semibold text-ink shadow-hairline">
            {o.label}
            {o.pill ? <span className="font-medium text-muted">{o.pill}</span> : null}
            {o.kind === "equipment" ? <span className="font-medium text-muted">· estimated</span> : null}
          </span>
        )}
      </div>
    </Html>
  );
}
