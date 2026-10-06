// Marketr — Knowledge Brain: 2D canvas view.
// Extracted verbatim out of BrainClient.tsx (3D rebuild refactor) and turned
// into a props-driven component so the client can toggle between 2D and 3D.
// Force layout, drag/pan/zoom, hover tooltips, click-to-inspect — unchanged.

"use client";

import { useEffect, useRef } from "react";
import { Brain } from "lucide-react";
import { createLayout, type ForceLayout } from "@/lib/intelligence/corpus/graph-layout";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";
import { pillarColorHex, resolveToken } from "./brain-ui";

export interface FocusRequest {
  id: string;
  nonce: number;
}

export function BrainCanvas2D({
  graph,
  nodeById,
  isVisible,
  selectedId,
  hoverId,
  onHover,
  onSelect,
  focusRequest,
}: {
  graph: BrainGraph;
  nodeById: Map<string, BrainNode>;
  isVisible: (n: BrainNode) => boolean;
  selectedId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  focusRequest: FocusRequest | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ForceLayout | null>(null);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef({ w: 800, h: 600 });
  const dragRef = useRef<{ mode: "node" | "pan"; id?: string; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;
  hoverRef.current = hoverId;
  selectedRef.current = selectedId;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Center the view on a node (search fly-to in 2D).
  useEffect(() => {
    if (!focusRequest || !simRef.current) return;
    const pos = simRef.current.positions().get(focusRequest.id);
    if (!pos) return;
    const v = viewRef.current;
    const { w, h } = sizeRef.current;
    v.x = w / (2 * v.k) - pos.x;
    v.y = h / (2 * v.k) - pos.y;
  }, [focusRequest]);

  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(300, r.width * dpr);
      canvas.height = Math.max(300, r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      sizeRef.current = { w: r.width, h: r.height };
      return { w: r.width, h: r.height, dpr };
    };
    let { w, h, dpr } = resize();

    const radiusOf = (n: BrainNode) =>
      n.kind === "proposed" || n.kind === "catalog"
        ? 9
        : Math.min(26, 8 + Math.sqrt(Math.max(n.chunks, 1)) * 1.35);

    const sim = createLayout(
      graph.nodes.map((n) => ({ id: n.id, pillar: n.pillar as BrainPillar, radius: radiusOf(n) })),
      graph.edges,
      { width: w, height: h },
    );
    simRef.current = sim;

    const ro = new ResizeObserver(() => {
      const s = resize();
      w = s.w;
      h = s.h;
      dpr = s.dpr;
    });
    ro.observe(wrap);

    let raf = 0;
    let t = 0;
    const edgePhase = new Map<string, number>();
    graph.edges.forEach((e, i) => edgePhase.set(`${e.from}→${e.to}`, (i * 0.37) % 1));

    // Token colors resolved once (canvas cannot parse var()).
    const INK = resolveToken("--aos-ink");
    const MUTED = resolveToken("--aos-text-muted");
    const SUBTLE = resolveToken("--aos-text-subtle");
    const FAILED = resolveToken("--aos-failed");
    // Phase 18.1: edges, pulses and label halos from tokens (they read on
    // dark chrome too), with the transparency applied through globalAlpha.
    const PAPER = resolveToken("--aos-paper");

    const toScreen = (x: number, y: number) => {
      const v = viewRef.current;
      return { x: (x + v.x) * v.k, y: (y + v.y) * v.k };
    };
    const toWorld = (x: number, y: number) => {
      const v = viewRef.current;
      return { x: x / v.k - v.x, y: y / v.k - v.y };
    };

    const hitNode = (sx: number, sy: number): string | null => {
      const p = toWorld(sx, sy);
      let best: string | null = null;
      let bestD = Infinity;
      for (const [id, pos] of sim.positions()) {
        const n = nodeById.get(id);
        if (!n || !visibleRef.current(n)) continue;
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d < pos.radius + 8 && d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    };

    const draw = () => {
      t += 1 / 60;
      if (!document.hidden && dragRef.current?.mode !== "node") {
        for (let i = 0; i < 2; i++) sim.step();
      }
      const pos = sim.positions();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Edges.
      for (const e of graph.edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        const na = nodeById.get(e.from);
        const nb = nodeById.get(e.to);
        if (!a || !b || !na || !nb || !visibleRef.current(na) || !visibleRef.current(nb)) continue;
        const pa = toScreen(a.x, a.y);
        const pb = toScreen(b.x, b.y);
        // Edges: ink at low alpha (neutral — categories never take status color).
        ctx.save();
        ctx.strokeStyle = INK;
        ctx.globalAlpha = 0.14;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        ctx.restore();
        // Traveling pulse — the "thinking" signal (neutral ink glow).
        const phase = (t * 0.25 + (edgePhase.get(`${e.from}→${e.to}`) ?? 0)) % 1;
        const px = pa.x + (pb.x - pa.x) * phase;
        const py = pa.y + (pb.y - pa.y) * phase;
        ctx.save();
        ctx.shadowColor = INK;
        ctx.shadowBlur = 8;
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Nodes.
      for (const [id, p] of pos) {
        const n = nodeById.get(id);
        if (!n || !visibleRef.current(n)) continue;
        const s = toScreen(p.x, p.y);
        if (s.x < -60 || s.x > w + 60 || s.y < -60 || s.y > h + 60) continue;
        const color = pillarColorHex(n.pillar);
        const isHover = hoverRef.current === id;
        const isSel = selectedRef.current === id;
        const r = p.radius + (isHover || isSel ? 3 : 0);

        ctx.save();
        // Glow.
        ctx.shadowColor = color;
        ctx.shadowBlur = isHover || isSel ? 26 : 14;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.92;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        // Nucleus.
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(2.5, r * 0.38), 0, Math.PI * 2);
        ctx.fill();

        // Tier ring treatment (neutral; only the removal flag carries a status color).
        ctx.lineWidth = 1.6;
        if (n.kind === "proposed" || n.kind === "catalog") {
          ctx.strokeStyle = SUBTLE;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.kind === "removal-flagged") {
          ctx.strokeStyle = FAILED;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.tier === "1") {
          ctx.strokeStyle = INK;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 7.5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (n.tier === "1S") {
          ctx.strokeStyle = INK;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (isSel) {
          ctx.strokeStyle = INK;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();

        // Labels: only the largest neurons plus hovered/selected, with a
        // paper halo so text stays readable over the graph.
        if (r >= 20 || isHover || isSel) {
          ctx.font = `${isSel ? "600 " : ""}11px Archivo, system-ui, sans-serif`;
          ctx.textAlign = "center";
          const label = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
          ctx.lineWidth = 3;
          ctx.strokeStyle = PAPER;
          ctx.globalAlpha = 0.92;
          ctx.strokeText(label, s.x, s.y + r + 14);
          ctx.globalAlpha = 1;
          ctx.fillStyle = MUTED;
          ctx.fillText(label, s.x, s.y + r + 14);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    // Pointer interactions.
    const onDown = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const hit = hitNode(sx, sy);
      canvas.setPointerCapture(ev.pointerId);
      if (hit) {
        const p = sim.positions().get(hit)!;
        const wp = toWorld(sx, sy);
        sim.pin(hit, p.x, p.y);
        dragRef.current = { mode: "node", id: hit, sx, sy, vx: wp.x - p.x, vy: wp.y - p.y };
      } else {
        const v = viewRef.current;
        dragRef.current = { mode: "pan", sx, sy, vx: v.x, vy: v.y };
      }
    };
    const onMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const d = dragRef.current;
      if (d?.mode === "node" && d.id) {
        const wp = toWorld(sx, sy);
        sim.pin(d.id, wp.x - d.vx, wp.y - d.vy);
      } else if (d?.mode === "pan") {
        const v = viewRef.current;
        v.x = d.vx + (sx - d.sx) / v.k;
        v.y = d.vy + (sy - d.sy) / v.k;
      } else {
        onHoverRef.current(hitNode(sx, sy));
      }
    };
    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.mode === "node" && d.id) {
        sim.unpin(d.id);
        const rect = canvas.getBoundingClientRect();
        const moved = Math.hypot(ev.clientX - rect.left - d.sx, ev.clientY - rect.top - d.sy);
        if (moved < 5) onSelectRef.current(d.id);
      }
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const v = viewRef.current;
      const k2 = Math.min(3, Math.max(0.4, v.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const wx = sx / v.k - v.x;
      const wy = sy / v.k - v.y;
      v.k = k2;
      v.x = sx / k2 - wx;
      v.y = sy / k2 - wy;
    };
    const onLeave = () => {
      if (!dragRef.current) onHoverRef.current(null);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, nodeById, isVisible]);

  const hoverNode = hoverId ? nodeById.get(hoverId) : undefined;

  return (
    <div
      ref={wrapRef}
      className="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border border-line bg-canvas"
      style={{
        backgroundImage: "radial-gradient(circle, var(--aos-line-strong) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
        cursor: "grab",
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      {/* Legend */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-md bg-paper px-2.5 py-2 shadow-raised">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Brain className="h-3.5 w-3.5" /> Legend
        </div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-ink" /> Tier 1 · official
        </div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-ink" /> Tier 1S · ShapesOS synthesis
        </div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dotted border-subtle" /> Proposed
        </div>
        <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink" /> Node size ∝ chunks
        </div>
      </div>
      {hoverNode && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[280px] rounded-md bg-paper px-2.5 py-2 shadow-raised">
          <div className="text-[0.75rem] font-semibold text-ink">{hoverNode.title}</div>
          <div className="mt-0.5 line-clamp-2 text-[0.6875rem] leading-snug text-muted">{hoverNode.teaches}</div>
        </div>
      )}
    </div>
  );
}
