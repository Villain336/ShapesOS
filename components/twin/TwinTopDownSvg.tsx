// ShapesOS — Phase 13 (twinui): top-down SVG of a twin site.
//
// SERVER-RENDERABLE (no hooks, no browser APIs): the page paints it before any
// WebGL loads; it is also the 2D view and the no-WebGL fallback. Same layout
// data as the 3D scene (lib/twin/scene-kit.ts maths), neutral clay fills,
// entity states as text; the only status colours are agent marks.
// Interactive when `onSelect` is passed (client shell): objects become
// focusable buttons; otherwise the whole drawing is one labelled image.

import type { KeyboardEvent, MouseEvent } from "react";
import type { TwinObject, TwinObjectKind, TwinSnapshot } from "@/lib/twin/types";
import { SHAPE_PATHS, STATUS_META } from "@/lib/aos/status";
import { clayVar, occupiedRect, type ClayKey } from "@/lib/twin/scene-kit";
import { KIND_LABEL, SITE_KIND_LABEL, agentsByObject } from "@/lib/twin/view-model";

export interface TwinTopDownSvgProps {
  snapshot: TwinSnapshot;
  selectedId?: string | null;
  hoverId?: string | null;
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  /** Edit mode: a click on empty ground reports the grid cell. */
  onCellClick?: (cell: { x: number; z: number }) => void;
  className?: string;
}

const FILL: Record<TwinObjectKind, ClayKey> = {
  building: 1,
  dock_door: 3,
  rack: 2,
  bin_zone: 2,
  yard_slot: 0,
  work_center: 2,
  register: 3,
  shelf: 2,
  path: 1,
  equipment: 3,
};

/** Draw order: floors first, then shells, then solids, then equipment on top. */
const LAYER: Record<TwinObjectKind, number> = {
  path: 0,
  yard_slot: 0,
  building: 1,
  bin_zone: 2,
  rack: 3,
  shelf: 3,
  work_center: 3,
  register: 3,
  dock_door: 3,
  equipment: 4,
};

function describe(o: TwinObject): string {
  const parts = [o.label, KIND_LABEL[o.kind]];
  if (o.pill) parts.push(o.pill);
  if (o.kind === "equipment") parts.push("position estimated");
  if (o.bindingBroken) parts.push("unbound");
  if (o.alert) parts.push(o.alert.message);
  return parts.join(", ");
}

export function TwinTopDownSvg({ snapshot, selectedId, hoverId, onSelect, onHover, onCellClick, className }: TwinTopDownSvgProps) {
  const { site } = snapshot;
  const W = site.gridW;
  const D = site.gridD;
  const interactive = Boolean(onSelect);
  const agents = agentsByObject(snapshot);
  const titleId = `twin-svg-title-${site.id}`;
  const descId = `twin-svg-desc-${site.id}`;
  const ordered = [...snapshot.objects].sort((a, b) => LAYER[a.kind] - LAYER[b.kind]);

  const onGround = (e: MouseEvent<SVGRectElement>) => {
    if (!onCellClick && !onSelect) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const x = Math.floor(((e.clientX - box.left) / box.width) * W);
    const z = Math.floor(((e.clientY - box.top) / box.height) * D);
    if (onCellClick) onCellClick({ x: Math.max(0, Math.min(W - 1, x)), z: Math.max(0, Math.min(D - 1, z)) });
    else onSelect?.(null);
  };

  const lines: number[] = [];
  for (let i = 1; i < Math.max(W, D); i++) lines.push(i);

  return (
    <svg
      viewBox={`-1 -1 ${W + 2} ${D + 2}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role={interactive ? "group" : "img"}
      aria-labelledby={titleId}
      aria-describedby={descId}
      style={{ fontFamily: "var(--aos-font-sans)" }}
    >
      <title id={titleId}>{`${site.name} (${site.code}) — top-down plan`}</title>
      <desc id={descId}>
        {`${SITE_KIND_LABEL[site.kind]} site, ${W} by ${D} metres, ${snapshot.objects.length} objects. ` +
          snapshot.objects.map(describe).join("; ")}
      </desc>

      {/* ground + 1 m grid (5 m lines a touch stronger) */}
      <rect x={0} y={0} width={W} height={D} fill={clayVar(0)} stroke={clayVar(3)} strokeWidth={0.08} onClick={onGround} aria-hidden />
      <g aria-hidden pointerEvents="none">
        {lines.map((i) =>
          i < W ? (
            <line key={`x${i}`} x1={i} y1={0} x2={i} y2={D} stroke={clayVar("grid")} strokeWidth={i % 5 === 0 ? 0.06 : 0.03} />
          ) : null,
        )}
        {lines.map((i) =>
          i < D ? (
            <line key={`z${i}`} x1={0} y1={i} x2={W} y2={i} stroke={clayVar("grid")} strokeWidth={i % 5 === 0 ? 0.06 : 0.03} />
          ) : null,
        )}
      </g>

      {ordered.map((o) => {
        const r = occupiedRect(o.footprint);
        const isEquip = o.state.kind === "equipment";
        const pos = o.state.kind === "equipment" ? o.state.position : null;
        const x0 = pos ? pos.x - 0.6 : r.x0;
        const z0 = pos ? pos.z - 0.6 : r.z0;
        const w = pos ? 1.2 : r.x1 - r.x0;
        const d = pos ? 1.2 : r.z1 - r.z0;
        const selected = selectedId === o.id;
        const hovered = hoverId === o.id;
        const marks = agents.get(o.id) ?? [];
        const showLabel = !isEquip && o.kind !== "path" && w >= 3 && d >= 1;
        const fontSize = Math.min(0.9, Math.max(0.55, Math.min(w / 6, 0.9)));
        const a11y = interactive
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-label": describe(o),
              "aria-pressed": selected,
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                onSelect?.(o.id);
              },
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(o.id);
                }
              },
              onMouseEnter: () => onHover?.(o.id),
              onMouseLeave: () => onHover?.(null),
              style: { cursor: "pointer" },
            }
          : {};
        return (
          <g key={o.id} data-twin-object={o.id} data-kind={o.kind} {...a11y}>
            {interactive ? null : <title>{describe(o)}</title>}
            {isEquip ? (
              <rect x={x0} y={z0} width={w} height={d} rx={0.3} fill={clayVar(FILL[o.kind])} stroke={clayVar(4)} strokeWidth={0.08} />
            ) : (
              <rect
                x={x0}
                y={z0}
                width={w}
                height={d}
                rx={o.kind === "building" ? 0.15 : 0.08}
                fill={clayVar(FILL[o.kind])}
                fillOpacity={o.kind === "building" ? 0.6 : 1}
                stroke={o.kind === "path" ? "none" : clayVar(o.kind === "building" ? 3 : 4)}
                strokeWidth={o.kind === "building" ? 0.18 : 0.06}
                strokeDasharray={o.kind === "yard_slot" || o.bindingBroken ? "0.4 0.3" : undefined}
              />
            )}
            {o.kind === "dock_door" ? (
              // door leaf on the front edge
              <DoorEdge o={o} />
            ) : null}
            {(selected || hovered) && (
              <rect
                x={x0 - 0.15}
                y={z0 - 0.15}
                width={w + 0.3}
                height={d + 0.3}
                rx={0.2}
                fill="none"
                stroke={selected ? "var(--aos-ink)" : "var(--aos-text-muted)"}
                strokeWidth={selected ? 0.18 : 0.1}
                pointerEvents="none"
              />
            )}
            {showLabel && (
              <text
                x={x0 + w / 2}
                y={o.kind === "building" ? z0 + 1.1 : z0 + d / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={o.kind === "building" ? 0.9 : fontSize}
                fontWeight={600}
                fill={o.kind === "building" ? "var(--aos-text-muted)" : "var(--aos-ink)"}
                pointerEvents="none"
              >
                {o.label}
                {o.pill && o.kind !== "building" && d >= 2 ? (
                  <tspan x={x0 + w / 2} dy={fontSize * 1.25} fontWeight={500} fill="var(--aos-text-muted)" fontSize={fontSize * 0.85}>
                    {o.pill}
                  </tspan>
                ) : null}
              </text>
            )}
            {o.alert && (
              <g transform={`translate(${x0 + w - 0.2} ${z0 - 0.2})`} pointerEvents="none" aria-hidden>
                <circle r={0.55} fill="var(--aos-ink)" />
                <text textAnchor="middle" dominantBaseline="central" fontSize={0.75} fontWeight={800} fill="var(--aos-paper)">
                  !
                </text>
              </g>
            )}
            {marks.slice(0, 3).map((a, i) => {
              const geo = SHAPE_PATHS[a.status];
              const color = STATUS_META[a.status].mark;
              const s = 1.1 / 14;
              return (
                <g key={a.runId} transform={`translate(${x0 + 0.2 + i * 1.5} ${z0 - 1.5}) scale(${s})`} pointerEvents="none" aria-hidden>
                  <circle cx={7} cy={7} r={10} fill="var(--aos-paper)" stroke="var(--aos-line-strong)" strokeWidth={1.2} />
                  {geo.stroke ? (
                    <path d={geo.d} fill="none" stroke={color} strokeWidth={geo.stroke} />
                  ) : (
                    <path d={geo.d} fill={color} stroke={a.status === "needs" ? "var(--aos-ink)" : undefined} strokeWidth={a.status === "needs" ? 1 : undefined} />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** A thicker line on the dock door's front edge (where the truck docks). */
function DoorEdge({ o }: { o: TwinObject }) {
  const r = occupiedRect(o.footprint);
  const rot = o.footprint.rotation;
  const sw = 0.25;
  const [x1, y1, x2, y2] =
    rot === 0
      ? [r.x0, r.z1, r.x1, r.z1]
      : rot === 90
        ? [r.x1, r.z0, r.x1, r.z1]
        : rot === 180
          ? [r.x0, r.z0, r.x1, r.z0]
          : [r.x0, r.z0, r.x0, r.z1];
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--aos-ink)" strokeWidth={sw} pointerEvents="none" aria-hidden />;
}

export default TwinTopDownSvg;
