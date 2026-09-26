// Marketr — Knowledge Brain canvas client.
// Light futuristic neural graph of the M9 corpus: canvas force layout,
// drag/pan/zoom, hover tooltips, click-to-inspect, pillar/tier filters,
// search, plus real corpus management (propose source, flag removal,
// rebuild job with progress).
// House style diffed against app/dashboard/studio/StudioApp.tsx:
// page shell in page.tsx; Chip atoms, inputCls/btnPrimary/btnGhost,
// dense detail panel, filter toolbar (dropdowns + search + violet button),
// info notes border-stone-200 bg-stone-50. Lucide icons only, no emoji.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  Plus,
  RefreshCw,
  Search,
  X,
  Flag,
  FlagOff,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Link2,
  Upload,
  Type,
  Sparkles,
  Database,
  Info,
} from "lucide-react";
import { createLayout, type ForceLayout } from "@/lib/intelligence/corpus/graph-layout";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";

// ── Atoms (mirroring StudioApp.tsx) ──────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" | "pink" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
    pink: "bg-pink-50 text-pink-700 border-pink-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40";

const PILLAR_COLORS: Record<BrainPillar, string> = {
  marketing: "#7c3aed",
  growth: "#0284c7",
  design: "#db2777",
};
const PILLAR_TONE: Record<BrainPillar, "violet" | "blue" | "pink"> = {
  marketing: "violet",
  growth: "blue",
  design: "pink",
};
const PILLAR_LABEL: Record<BrainPillar, string> = {
  marketing: "Marketing",
  growth: "Growth",
  design: "Design",
};

// ── Component ────────────────────────────────────────────────────────────────

export function BrainClient({ canManage }: { canManage: boolean }) {
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pillarFilter, setPillarFilter] = useState<Set<BrainPillar>>(new Set(["marketing", "growth", "design"]));
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set(["1", "2", "1S"]));
  const [showAdd, setShowAdd] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [flagReason, setFlagReason] = useState("");
  const [flagging, setFlagging] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<ForceLayout | null>(null);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ mode: "node" | "pan"; id?: string; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const filterRef = useRef({ q: "", pillars: pillarFilter, tiers: tierFilter });
  filterRef.current = { q: query, pillars: pillarFilter, tiers: tierFilter };
  hoverRef.current = hoverId;
  selectedRef.current = selectedId;

  const fetchGraph = useCallback(async () => {
    try {
      const res = await fetch("/api/corpus/graph");
      if (!res.ok) throw new Error(`graph ${res.status}`);
      setGraph(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const nodeById = useMemo(() => {
    const m = new Map<string, BrainNode>();
    graph?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph]);

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  const visible = useCallback(
    (n: BrainNode) => {
      const f = filterRef.current;
      if (!f.pillars.has(n.pillar)) return false;
      if (!f.tiers.has(n.tier)) return false;
      if (f.q) {
        const q = f.q.toLowerCase();
        return (
          n.title.toLowerCase().includes(q) ||
          n.teaches.toLowerCase().includes(q) ||
          n.author.toLowerCase().includes(q)
        );
      }
      return true;
    },
    [],
  );

  // ── Canvas: layout + render loop ──
  useEffect(() => {
    if (!graph || !canvasRef.current || !wrapRef.current) return;
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
      return { w: r.width, h: r.height, dpr };
    };
    let { w, h, dpr } = resize();

    const radiusOf = (n: BrainNode) =>
      n.kind === "proposed" ? 9 : Math.min(26, 8 + Math.sqrt(Math.max(n.chunks, 1)) * 1.35);

    const sim = createLayout(
      graph.nodes.map((n) => ({ id: n.id, pillar: n.pillar, radius: radiusOf(n) })),
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
        if (!n || !visible(n)) continue;
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
        if (!a || !b || !na || !nb || !visible(na) || !visible(nb)) continue;
        const pa = toScreen(a.x, a.y);
        const pb = toScreen(b.x, b.y);
        ctx.strokeStyle = "rgba(124, 58, 237, 0.16)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        // Traveling pulse — the "thinking" signal.
        const phase = (t * 0.25 + (edgePhase.get(`${e.from}→${e.to}`) ?? 0)) % 1;
        const px = pa.x + (pb.x - pa.x) * phase;
        const py = pa.y + (pb.y - pa.y) * phase;
        ctx.save();
        ctx.shadowColor = "rgba(124, 58, 237, 0.8)";
        ctx.shadowBlur = 8;
        ctx.fillStyle = "rgba(124, 58, 237, 0.85)";
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Nodes.
      for (const [id, p] of pos) {
        const n = nodeById.get(id);
        if (!n || !visible(n)) continue;
        const s = toScreen(p.x, p.y);
        if (s.x < -60 || s.x > w + 60 || s.y < -60 || s.y > h + 60) continue;
        const color = PILLAR_COLORS[n.pillar];
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

        // Tier ring treatment.
        ctx.lineWidth = 1.6;
        if (n.kind === "proposed") {
          ctx.strokeStyle = "#a8a29e";
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.kind === "removal-flagged") {
          ctx.strokeStyle = "#ef4444";
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.tier === "1") {
          ctx.strokeStyle = "#f59e0b";
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 7.5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (n.tier === "1S") {
          ctx.strokeStyle = color;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (isSel) {
          ctx.strokeStyle = "#4c1d95";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 9, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();

        // Labels: only the largest neurons plus hovered/selected, with a
        // halo so text stays readable over the graph.
        if (r >= 20 || isHover || isSel) {
          ctx.font = `${isSel ? "600 " : ""}11px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          const label = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(250,250,247,0.9)";
          ctx.strokeText(label, s.x, s.y + r + 14);
          ctx.fillStyle = "#44403c";
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
        setHoverId(hitNode(sx, sy));
      }
    };
    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.mode === "node" && d.id) {
        sim.unpin(d.id);
        const rect = canvas.getBoundingClientRect();
        const moved = Math.hypot(ev.clientX - rect.left - d.sx, ev.clientY - rect.top - d.sy);
        if (moved < 5) setSelectedId(d.id);
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
      if (!dragRef.current) setHoverId(null);
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
  }, [graph, nodeById, visible]);

  const toggleSet = (set: Set<string>, v: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next as never);
  };

  const doFlag = async (unflag: boolean) => {
    if (!selected || !canManage) return;
    setFlagging(true);
    setActionMsg(null);
    try {
      if (unflag) {
        const res = await fetch(`/api/corpus/remove?sourceId=${encodeURIComponent(selected.id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error("unflag failed");
        setActionMsg({ tone: "green", text: "Removal flag cleared." });
      } else {
        const res = await fetch("/api/corpus/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: selected.id, reason: flagReason || "Flagged from the Knowledge Brain." }),
        });
        if (!res.ok) throw new Error("flag failed");
        setActionMsg({ tone: "green", text: "Source flagged for removal — takes effect on the next rebuild." });
        setFlagReason("");
      }
      await fetchGraph();
    } catch {
      setActionMsg({ tone: "red", text: "Action failed — please retry." });
    } finally {
      setFlagging(false);
    }
  };

  if (loadError) {
    return (
      <div className="rounded-md border border-stone-200 bg-stone-50 p-6 text-[13px] text-stone-600">
        Could not load the corpus graph: {loadError}
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="flex h-96 items-center justify-center gap-2 text-[13px] text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Growing the brain…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sources…"
            className={`${inputCls} w-52 pl-8`}
          />
        </div>
        {(["marketing", "growth", "design"] as BrainPillar[]).map((p) => (
          <button
            key={p}
            onClick={() => toggleSet(pillarFilter, p, (s) => setPillarFilter(s as Set<BrainPillar>))}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
              pillarFilter.has(p)
                ? "border-transparent text-white"
                : "border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
            }`}
            style={pillarFilter.has(p) ? { backgroundColor: PILLAR_COLORS[p] } : undefined}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: pillarFilter.has(p) ? "#fff" : PILLAR_COLORS[p] }} />
            {PILLAR_LABEL[p]}
          </button>
        ))}
        {(["1", "2", "1S"] as const).map((t) => (
          <button
            key={t}
            onClick={() => toggleSet(tierFilter, t, setTierFilter)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-medium ${
              tierFilter.has(t)
                ? "border-violet-600 bg-violet-600 text-white"
                : "border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
            }`}
          >
            Tier {t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[12px] text-stone-500 md:inline">
            {graph.stats.sources} sources · {graph.stats.chunks.toLocaleString()} chunks · corpus v{graph.version}
          </span>
          {canManage && (
            <>
              <button className={btnGhost} onClick={() => setShowAdd(true)}>
                <Plus className="h-3.5 w-3.5" /> Add source
              </button>
              <button className={btnPrimary} onClick={() => setShowRebuild(true)}>
                <RefreshCw className="h-3.5 w-3.5" /> Rebuild corpus
              </button>
            </>
          )}
        </div>
      </div>

      {actionMsg && (
        <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${actionMsg.tone === "green" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
          {actionMsg.tone === "green" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {actionMsg.text}
          <button className="ml-auto" onClick={() => setActionMsg(null)}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Canvas + detail panel */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div
          ref={wrapRef}
          className="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border border-stone-200 bg-[#FAFAF7]"
          style={{ backgroundImage: "radial-gradient(circle, #e7e5e4 1px, transparent 1px)", backgroundSize: "28px 28px", cursor: "grab" }}
        >
          <canvas ref={canvasRef} className="absolute inset-0" />
          {/* Legend */}
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-md border border-stone-200 bg-white/90 px-2.5 py-2 backdrop-blur">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-700">
              <Brain className="h-3.5 w-3.5 text-violet-600" /> Legend
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#f59e0b]" /> Tier 1 · official
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-[#7c3aed]" /> Tier 1S · Marketr synthesis
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dotted border-stone-400" /> Proposed
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#7c3aed]" /> Node size ∝ chunks
            </div>
          </div>
          {hoverId && nodeById.get(hoverId) && (
            <div className="pointer-events-none absolute left-3 bottom-3 max-w-[280px] rounded-md border border-stone-200 bg-white/95 px-2.5 py-2 shadow-sm backdrop-blur">
              <div className="text-[12px] font-semibold text-stone-900">{nodeById.get(hoverId)!.title}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-stone-500">{nodeById.get(hoverId)!.teaches}</div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="w-full shrink-0 lg:w-80">
          {selected ? (
            <NodePanel
              node={selected}
              canManage={canManage}
              flagReason={flagReason}
              setFlagReason={setFlagReason}
              flagging={flagging}
              onFlag={() => doFlag(false)}
              onUnflag={() => doFlag(true)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-white/60 p-6 text-center">
              <Sparkles className="h-6 w-6 text-violet-300" />
              <p className="max-w-[220px] text-[13px] text-stone-500">
                Click any neuron to inspect the source — what it taught Marketr, its
                license basis, and its chunk weight.
              </p>
            </div>
          )}
        </div>
      </div>

      {showAdd && <AddSourceDialog onClose={() => setShowAdd(false)} onAdded={async () => { setShowAdd(false); await fetchGraph(); }} />}
      {showRebuild && <RebuildDialog onClose={() => setShowRebuild(false)} onDone={fetchGraph} />}
    </div>
  );
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function NodePanel({
  node,
  canManage,
  flagReason,
  setFlagReason,
  flagging,
  onFlag,
  onUnflag,
  onClose,
}: {
  node: BrainNode;
  canManage: boolean;
  flagReason: string;
  setFlagReason: (s: string) => void;
  flagging: boolean;
  onFlag: () => void;
  onUnflag: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex max-h-[560px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-start gap-2 border-b border-stone-100 p-3">
        <span className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: PILLAR_COLORS[node.pillar] }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-stone-900">{node.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip tone={PILLAR_TONE[node.pillar]}>{PILLAR_LABEL[node.pillar]}</Chip>
            <Chip tone="violet">Tier {node.tier}</Chip>
            {node.kind === "proposed" && <Chip tone="amber">proposed</Chip>}
            {node.kind === "removal-flagged" && <Chip tone="red">flagged for removal</Chip>}
            {node.status === "pending" && node.kind === "source" && <Chip tone="amber">pending</Chip>}
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <dl className="space-y-2.5 text-[13px]">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">What Marketr learned</dt>
            <dd className="mt-0.5 leading-snug text-stone-700">{node.teaches}</dd>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Chunks</dt>
              <dd className="mt-0.5 font-semibold text-stone-900">{node.chunks.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Mode</dt>
              <dd className="mt-0.5 text-stone-700">{node.mode === "verbatim" ? "Ingested verbatim" : "Marketr synthesis"}</dd>
            </div>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Author</dt>
            <dd className="mt-0.5 text-stone-700">{node.author}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">License basis</dt>
            <dd className="mt-0.5 leading-snug text-stone-700">{node.licenseBasis}</dd>
          </div>
          {node.synthesizedFrom.length > 0 && (
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Distilled from</dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {node.synthesizedFrom.map((s) => (
                  <Chip key={s} tone="slate">{s}</Chip>
                ))}
              </dd>
            </div>
          )}
          {node.removalReason && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-red-500">Removal reason</dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-red-800">{node.removalReason}</dd>
            </div>
          )}
        </dl>
      </div>
      {canManage && node.kind === "source" && (
        <div className="border-t border-stone-100 p-3">
          <div className="flex flex-col gap-2">
            <input
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              placeholder="Reason for removal…"
              className={inputCls}
            />
            <button onClick={onFlag} disabled={flagging} className="flex items-center justify-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[13px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40">
              {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flag className="h-3.5 w-3.5" />}
              Flag for removal
            </button>
            <p className="text-[11px] leading-snug text-stone-400">
              Flagging only marks the source — ingested data is never deleted here. Flags take effect on the next rebuild.
            </p>
          </div>
        </div>
      )}
      {canManage && node.kind === "removal-flagged" && (
        <div className="border-t border-stone-100 p-3">
          <button onClick={onUnflag} disabled={flagging} className={btnGhost}>
            {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlagOff className="h-3.5 w-3.5" />}
            Clear removal flag
          </button>
        </div>
      )}
    </div>
  );
}

// ── Add-source dialog ────────────────────────────────────────────────────────

function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<"url" | "upload" | "text">("url");
  const [title, setTitle] = useState("");
  const [pillar, setPillar] = useState<BrainPillar>("marketing");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [teaches, setTeaches] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileB64, setFileB64] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (![".md", ".txt", ".pdf"].includes(ext)) {
      setErr("Only .md, .txt, .pdf files are accepted.");
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setErr("File must be ≤ 2MB.");
      return;
    }
    const buf = await f.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    setFileB64(btoa(bin));
    setFileName(f.name);
    setErr(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/corpus/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, pillar, kind, url, text, teaches, fileName, fileBase64: fileB64 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "proposal failed");
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "proposal failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-100 p-4">
          <h2 className="text-[15px] font-semibold text-stone-900">Propose a source</h2>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex gap-1 rounded-md bg-stone-100 p-1">
            {([["url", "URL", Link2], ["upload", "Upload", Upload], ["text", "Paste text", Type]] as const).map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[13px] font-medium ${kind === k ? "bg-white text-violet-700 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Source title" className={`${inputCls} w-full`} />
          <div className="grid grid-cols-2 gap-2">
            <select value={pillar} onChange={(e) => setPillar(e.target.value as BrainPillar)} className={inputCls}>
              <option value="marketing">Marketing</option>
              <option value="growth">Growth</option>
              <option value="design">Design</option>
            </select>
            <input value={teaches} onChange={(e) => setTeaches(e.target.value)} placeholder="What should it teach? (optional)" className={inputCls} />
          </div>
          {kind === "url" && (
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={`${inputCls} w-full`} />
          )}
          {kind === "upload" && (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50 p-6 text-center">
              <Upload className="h-5 w-5 text-stone-400" />
              <span className="text-[13px] text-stone-600">{fileName || "Drop a .md, .txt, or .pdf file (≤ 2MB)"}</span>
              <input type="file" accept=".md,.txt,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          )}
          {kind === "text" && (
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text Marketr should learn from (min 200 characters)…" rows={6} className={`${inputCls} w-full resize-y`} />
          )}
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 p-2.5 text-[11px] leading-snug text-stone-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" />
            Proposed sources appear as dotted nodes immediately, but nothing is ingested until you run a corpus rebuild — and pasted text must be yours to give (no scraped or pirated material).
          </div>
          {err && <p className="text-[13px] text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-100 p-4">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={busy || !title.trim()} onClick={submit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Propose source
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rebuild dialog ─────────────────────────────────────────────────────────

function RebuildDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<{ state: string; startedAt: string | null; finishedAt: string | null; error: string | null } | null>(null);
  const [logTail, setLogTail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/corpus/rebuild");
      const j = await res.json();
      setStatus(j.status);
      setLogTail(j.logTail ?? "");
      return j.status.state;
    } catch {
      return "unknown";
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(async () => {
      const s = await poll();
      if (s === "succeeded" || s === "failed") {
        clearInterval(t);
        if (s === "succeeded") onDone();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [poll, onDone]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/corpus/rebuild", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "rebuild failed to start");
      setStatus(j.status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rebuild failed to start");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-100 p-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
            <Database className="h-4 w-4 text-violet-600" /> Rebuild corpus
          </h2>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-[13px] leading-snug text-stone-600">
            Runs the full ingest pipeline (fetch → chunk → embed → manifest). This rewrites
            the corpus and bumps its version. Removal flags take effect here.
          </p>
          {status && (
            <div className="flex items-center gap-2 text-[13px]">
              {status.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-violet-600" />}
              {status.state === "succeeded" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
              {status.state === "failed" && <AlertTriangle className="h-4 w-4 text-red-600" />}
              <span className="font-medium text-stone-800">Status: {status.state}</span>
              {status.startedAt && <span className="text-stone-400">started {new Date(status.startedAt).toLocaleTimeString()}</span>}
            </div>
          )}
          {logTail && (
            <pre className="max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-stone-950 p-3 font-mono text-[11px] leading-relaxed text-stone-200">
              {logTail}
            </pre>
          )}
          {status?.error && <p className="text-[13px] text-red-600">{status.error}</p>}
          {err && <p className="text-[13px] text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-100 p-4">
          <button className={btnGhost} onClick={onClose}>Close</button>
          <button className={btnPrimary} disabled={busy || status?.state === "running"} onClick={start}>
            {busy || status?.state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {status?.state === "running" ? "Rebuilding…" : "Start rebuild"}
          </button>
        </div>
      </div>
    </div>
  );
}
