// Marketr — Knowledge Brain command center.
// State, data fetching, toolbar (search + fly-to, pillar/tier filters,
// 2D/3D toggle), 3D viewport, source dossier, systemized sources table,
// corpus-health audit strip, and the real activity feed. House style per
// app/dashboard/studio/StudioApp.tsx. The 3D scene is code-split.

"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  RefreshCw,
  Search,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Orbit,
  Network,
  Crosshair,
} from "lucide-react";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";
import { BrainCanvas2D, type FocusRequest } from "./BrainCanvas2D";
import { NodePanel } from "./NodePanel";
import { BrainSourcesTable } from "./BrainSourcesTable";
import { BrainHealthStrip } from "./BrainHealthStrip";
import { BrainActivityFeed } from "./BrainActivityFeed";
import { AddSourceDialog, RebuildDialog } from "./BrainDialogs";
import { inputCls, btnPrimary, btnGhost, PILLAR_COLORS, PILLAR_LABEL } from "./brain-ui";

const BrainScene3D = dynamic(() => import("./BrainScene3D").then((m) => m.BrainScene3D), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[420px] flex-1 items-center justify-center gap-2 rounded-lg border border-stone-200 bg-[#FAFAF7] text-[13px] text-stone-500">
      <Loader2 className="h-4 w-4 animate-spin" /> Growing the brain…
    </div>
  ),
});

export function BrainClient({ canManage }: { canManage: boolean }) {
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"3d" | "2d">("3d");
  const [pillarFilter, setPillarFilter] = useState<Set<BrainPillar>>(
    new Set(["marketing", "growth", "design"]),
  );
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set(["1", "2", "1S"]));
  const [showAdd, setShowAdd] = useState(false);
  const [showRebuild, setShowRebuild] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [flagReason, setFlagReason] = useState("");
  const [flagging, setFlagging] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [activityKey, setActivityKey] = useState(0);
  const [actionMsg, setActionMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const filterRef = useRef({ q: "", pillars: pillarFilter, tiers: tierFilter });
  filterRef.current = { q: query, pillars: pillarFilter, tiers: tierFilter };

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

  // Stable visibility predicate (shared by both views; backed by a ref so
  // the canvases never rebuild their scenes on keystroke).
  const isVisible = useCallback((n: BrainNode) => {
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
  }, []);
  const isDimmed = useCallback((n: BrainNode) => !isVisible(n), [isVisible]);

  // Search matches for the fly-to dropdown.
  const matches = useMemo(() => {
    if (!graph || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return graph.nodes
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.teaches.toLowerCase().includes(q) ||
          n.author.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [graph, query]);

  const flyTo = useCallback((id: string) => {
    setSelectedId(id);
    setFocusRequest({ id, nonce: Date.now() });
    setShowResults(false);
  }, []);

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
        const res = await fetch(`/api/corpus/remove?sourceId=${encodeURIComponent(selected.id)}`, {
          method: "DELETE",
        });
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
      setActivityKey((k) => k + 1);
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
      {/* Corpus health — the audit strip. Every metric is real data. */}
      <BrainHealthStrip graph={graph} />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowResults(true);
            }}
            onFocus={() => setShowResults(true)}
            onBlur={() => setTimeout(() => setShowResults(false), 150)}
            placeholder="Search sources…"
            className={`${inputCls} w-52 pl-8`}
          />
          {showResults && matches.length > 0 && (
            <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg">
              {matches.map((n) => (
                <button
                  key={n.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => flyTo(n.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-violet-50/60"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: PILLAR_COLORS[n.pillar] }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-stone-900">{n.title}</span>
                    <span className="block truncate text-[11px] text-stone-400">
                      {PILLAR_LABEL[n.pillar]} · Tier {n.tier}
                    </span>
                  </span>
                  <Crosshair className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                </button>
              ))}
            </div>
          )}
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
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: pillarFilter.has(p) ? "#fff" : PILLAR_COLORS[p] }}
            />
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
        {/* 2D / 3D toggle */}
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {(
            [
              ["3d", "3D", Orbit],
              ["2d", "2D", Network],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium ${
                view === v ? "bg-violet-600 text-white shadow-sm" : "text-stone-500 hover:text-stone-700"
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
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
        <div
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${
            actionMsg.tone === "green"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {actionMsg.tone === "green" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          {actionMsg.text}
          <button className="ml-auto" onClick={() => setActionMsg(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Viewport + dossier rail */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="flex min-h-[420px] flex-1 flex-col gap-3">
          {view === "3d" ? (
            <BrainScene3D
              graph={graph}
              nodeById={nodeById}
              isDimmed={isDimmed}
              selectedId={selectedId}
              hoverId={hoverId}
              onHover={setHoverId}
              onSelect={setSelectedId}
              focusRequest={focusRequest}
            />
          ) : (
            <BrainCanvas2D
              graph={graph}
              nodeById={nodeById}
              isVisible={isVisible}
              selectedId={selectedId}
              hoverId={hoverId}
              onHover={setHoverId}
              onSelect={setSelectedId}
              focusRequest={focusRequest}
            />
          )}

          {/* Systemized sources register */}
          <BrainSourcesTable graph={graph} selectedId={selectedId} onFlyTo={flyTo} />
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
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
              evalQuestions={graph.stats.eval?.questions ?? null}
            />
          ) : (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-white/60 p-6 text-center">
              <Orbit className="h-6 w-6 text-violet-300" />
              <p className="max-w-[220px] text-[13px] text-stone-500">
                Click any neuron to inspect the source — what it taught Marketr, its license basis,
                and its provenance.
              </p>
            </div>
          )}
          <BrainActivityFeed refreshKey={activityKey} />
        </div>
      </div>

      <p className="text-[11px] text-stone-400">
        Every metric on this page is real: it reads the corpus manifest, the eval results file, the
        retrieval-usage log, and the proposal/removal/rebuild records. Nothing is fabricated —
        counters read 0 until the event actually happens.
      </p>

      {showAdd && (
        <AddSourceDialog
          onClose={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await fetchGraph();
            setActivityKey((k) => k + 1);
          }}
        />
      )}
      {showRebuild && (
        <RebuildDialog
          onClose={() => setShowRebuild(false)}
          onDone={() => {
            fetchGraph();
            setActivityKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
