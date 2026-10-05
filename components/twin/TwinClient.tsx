// ShapesOS — Phase 13 (twinui): the twin page's client shell.
//
// Server-rendered like any client component — top bar, KPI cards, the
// top-down SVG, inspector frame, shipment stepper and tables all paint in the
// first HTML. Only the WebGL canvas is a client-only chunk (next/dynamic with
// ssr:false); the SVG holds its place until the first frame, and stays as the
// 2D view and the no-WebGL fallback. Live updates: useTwinLive (SSE patches,
// polling fallback). Selection is shared by the scene, SVG, tables, search
// and inspector.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Info } from "lucide-react";
import type { TwinFootprint, TwinObject, TwinSnapshot } from "@/lib/twin/types";
import { pickShipment, type TwinSearchHit } from "@/lib/twin/view-model";
import { useGatedPatch } from "@/components/ops/shared";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import { btnPrimarySm, errorBoxCls } from "@/components/crm/ui";
import { TWIN_SLUGS } from "@/lib/twin/client-api";
import { cn } from "@/lib/utils";
import type { TwinCameraApi } from "./camera-api";
import { TwinTopBar, type TwinSiteSummary } from "./TwinTopBar";
import { TwinKpis } from "./TwinKpis";
import { TwinControls, type TwinView } from "./TwinControls";
import { TwinInspector } from "./TwinInspector";
import { TwinShipmentStepper } from "./TwinShipmentStepper";
import { TwinTables } from "./TwinTables";
import { TwinTableView } from "./TwinTableView";
import { TwinTopDownSvg } from "./TwinTopDownSvg";
import { TwinLayoutEditor, useLayoutWrites, type Placing } from "./TwinLayoutEditor";
import { useTwinLive } from "./useTwinLive";

const TwinCanvas = dynamic(() => import("./scene/TwinCanvas").then((m) => m.TwinCanvas), { ssr: false, loading: () => null });

function detectWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface TwinClientProps {
  initial: TwinSnapshot;
  sites: TwinSiteSummary[];
  canEdit: boolean;
  /** false for the dev fixture harness (no live stream) */
  live?: boolean;
  startEditing?: boolean;
  /** site links are `${hrefBase}${siteId}` (serialisable: the server page passes it) */
  hrefBase?: string;
}

export function TwinClient({ initial, sites, canEdit, live = true, startEditing = false, hrefBase }: TwinClientProps) {
  const { snapshot, status, resync } = useTwinLive(initial, { enabled: live });
  const [view, setView] = useState<TwinView>("3d");
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [api, setApi] = useState<TwinCameraApi | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing && canEdit);
  const [placing, setPlacing] = useState<Placing>(null);

  useEffect(() => {
    const ok = detectWebGL();
    setWebgl(ok);
    if (!ok) setView("2d");
  }, []);

  const selected = useMemo(() => snapshot.objects.find((o) => o.id === selectedId) ?? null, [snapshot.objects, selectedId]);
  const shipment = useMemo(() => pickShipment(snapshot, selectedId), [snapshot, selectedId]);
  const writes = useLayoutWrites(snapshot, resync);
  const publish = useGatedPatch(TWIN_SLUGS.sites, useCallback(() => void resync(), [resync]));

  const select = useCallback(
    (id: string | null, fly = false) => {
      setSelectedId(id);
      if (id && fly) api?.flyTo(id);
    },
    [api],
  );
  const onPick = useCallback((h: TwinSearchHit) => select(h.objectId, true), [select]);
  const onSceneSelect = useCallback((id: string | null) => select(id), [select]);
  const onHover = useCallback((id: string | null) => setHoverId(id), []);
  const onMove = useCallback((o: TwinObject, fp: TwinFootprint) => writes.move(o, fp), [writes]);
  const onPlace = useCallback(
    (cell: { x: number; z: number }) => {
      if (!placing) return;
      void writes.place(placing.kind, cell);
      setPlacing(null);
    },
    [placing, writes],
  );
  const onReady = useCallback(() => setReady(true), []);
  const onFail = useCallback((reason: string) => {
    setFailure(reason);
    setWebgl(false);
    setView("2d");
  }, []);

  const show3d = view === "3d" && webgl === true;
  const showSvg = view === "2d" || webgl === false || (view === "3d" && !ready);
  const svgInteractive = view === "2d" || webgl === false;

  const panel = editing ? (
    <TwinLayoutEditor
      snapshot={snapshot}
      selected={selected}
      placing={placing}
      onPlacing={setPlacing}
      writes={writes}
      onDeselect={() => setSelectedId(null)}
      className="lg:pointer-events-auto lg:absolute lg:right-4 lg:top-4 lg:max-h-[calc(100%-21rem)] lg:w-[360px]"
    />
  ) : (
    <TwinInspector
      object={selected}
      snapshot={snapshot}
      canEdit={canEdit}
      onChanged={resync}
      onClose={() => setSelectedId(null)}
      className={cn(
        "lg:pointer-events-auto lg:absolute lg:right-4 lg:top-4 lg:w-[340px]",
        view === "table" ? "lg:max-h-[calc(100%-2rem)]" : "lg:max-h-[calc(100%-22rem)]",
      )}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <TwinTopBar
        snapshot={snapshot}
        sites={sites}
        status={status}
        canEdit={canEdit}
        editing={editing}
        onToggleEdit={() => {
          setEditing((v) => !v);
          setPlacing(null);
        }}
        onPick={onPick}
        hrefBase={hrefBase}
      />

      {snapshot.site.status === "draft" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-paper px-4 py-2.5">
          <p className="text-sm text-ink">
            <span className="font-semibold">Draft</span> — only editors see this layout until it&rsquo;s published.
          </p>
          {canEdit && !publish.pending ? (
            <button type="button" className={btnPrimarySm} disabled={publish.busy} onClick={() => publish.request({ id: snapshot.site.id, status: "published" }, `publish ${snapshot.site.name} (${snapshot.site.code})`)}>
              Publish layout
            </button>
          ) : null}
          {publish.error ? <p className={cn(errorBoxCls, "w-full")}>{publish.error}</p> : null}
          {publish.pending ? (
            <div className="w-full">
              <OpsApprovalCard
                pending={publish.pending}
                busy={publish.busy}
                executeLabel="Publish layout"
                onApprove={() => publish.decide("approved")}
                onDeny={() => publish.decide("denied")}
                onExecute={publish.execute}
              />
            </div>
          ) : null}
        </div>
      )}
      {/* Phase 14: a publish an automation rule approved says so (the draft banner is gone). */}
      {publish.note && snapshot.site.status === "published" ? (
        <p role="status" className="rounded-lg border border-line bg-paper px-4 py-2.5 text-sm text-ink">
          Published. {publish.note}
        </p>
      ) : null}

      {(webgl === false || failure) && view !== "table" ? (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-muted">
          <Info size={15} aria-hidden />
          {failure ?? "This browser can't show the 3D view (no WebGL), so you're seeing the top-down plan."} The table view lists every object.
        </p>
      ) : null}

      {view === "table" ? (
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_340px] lg:items-start">
          <div className="flex flex-col gap-3">
            <TwinControls api={api} view={view} onView={setView} webgl={webgl !== false} />
            <TwinKpis kpis={snapshot.kpis} />
            <TwinTableView snapshot={snapshot} selectedId={selectedId} onSelect={(id) => select(id)} />
          </div>
          <div className="lg:sticky lg:top-0">
            <TwinInspector object={selected} snapshot={snapshot} canEdit={canEdit} onChanged={resync} onClose={() => setSelectedId(null)} />
          </div>
        </div>
      ) : (
        <div className="relative lg:h-[min(80vh,880px)] lg:min-h-[640px]">
          {/* the stage */}
          <div className="relative h-[440px] overflow-hidden rounded-lg border border-line bg-canvas lg:absolute lg:inset-0 lg:h-auto" data-twin-stage={view}>
            {webgl === true ? (
              <div className={cn("absolute inset-0", !show3d && "invisible")} aria-hidden={!show3d}>
                <TwinCanvas
                  snapshot={snapshot}
                  selectedId={selectedId}
                  hoverId={hoverId}
                  editing={editing}
                  placing={placing}
                  onSelect={onSceneSelect}
                  onHover={onHover}
                  onMove={onMove}
                  onPlace={onPlace}
                  onApi={setApi}
                  onReady={onReady}
                  onFail={onFail}
                />
              </div>
            ) : null}
            {showSvg ? (
              <div className="absolute inset-0 flex items-center justify-center bg-canvas p-4 lg:px-[380px] lg:pb-[19rem] lg:pt-28">
                <TwinTopDownSvg
                  snapshot={snapshot}
                  selectedId={selectedId}
                  hoverId={hoverId}
                  onSelect={svgInteractive ? onSceneSelect : undefined}
                  onHover={svgInteractive ? onHover : undefined}
                  onCellClick={svgInteractive && editing && placing ? onPlace : undefined}
                  className="h-full max-h-full w-full"
                />
              </div>
            ) : null}
          </div>
          {/* overlays: absolute over the stage on large screens, stacked below it on small ones */}
          <div className="mt-3 flex flex-col gap-3 lg:pointer-events-none lg:absolute lg:inset-0 lg:mt-0 lg:block">
            <div className="flex flex-col gap-2 lg:pointer-events-auto lg:absolute lg:left-4 lg:top-4 lg:max-w-[calc(100%-400px)]">
              <TwinKpis kpis={snapshot.kpis} />
              <TwinControls api={api} view={view} onView={setView} webgl={webgl !== false} />
            </div>
            {panel}
            <TwinShipmentStepper shipment={shipment} className="lg:pointer-events-auto lg:absolute lg:bottom-4 lg:left-4 lg:w-[380px]" />
            <TwinTables
              snapshot={snapshot}
              selectedId={selectedId}
              onSelect={(id) => select(id, true)}
              className="max-h-[320px] lg:pointer-events-auto lg:absolute lg:bottom-4 lg:right-4 lg:h-[288px] lg:w-[min(620px,calc(100%-420px))]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
