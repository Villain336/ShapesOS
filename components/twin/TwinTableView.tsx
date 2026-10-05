// ShapesOS — Phase 13 (twinui): the table-only view of a site — every object
// grouped by kind, each a focusable button that selects it (the inspector
// opens beside). For screen readers and browsers without WebGL.

"use client";

import type { TwinObjectKind, TwinSnapshot } from "@/lib/twin/types";
import { TWIN_OBJECT_KINDS } from "@/lib/twin/types";
import { STATUS_META } from "@/lib/aos/status";
import { StatusShape } from "@/components/aos/StatusShape";
import { KIND_LABEL, agentsByObject } from "@/lib/twin/view-model";
import { occupiedRect } from "@/lib/twin/scene-kit";
import { tableCls, tableWrapCls, tdCls, thCls } from "@/components/crm/ui";
import { cn } from "@/lib/utils";

const PLURAL: Record<TwinObjectKind, string> = {
  building: "Buildings",
  dock_door: "Dock doors",
  rack: "Racks",
  bin_zone: "Bin zones",
  yard_slot: "Yard slots",
  work_center: "Work centres",
  register: "Registers",
  shelf: "Shelves",
  path: "Paths",
  equipment: "Equipment",
};

export function TwinTableView({ snapshot, selectedId, onSelect }: { snapshot: TwinSnapshot; selectedId: string | null; onSelect: (id: string) => void }) {
  const agents = agentsByObject(snapshot);
  const groups = TWIN_OBJECT_KINDS.map((k) => ({ kind: k, objects: snapshot.objects.filter((o) => o.kind === k) })).filter((g) => g.objects.length > 0);
  if (groups.length === 0) return <p className="text-sm text-muted">This site has no objects yet. Use Edit layout to place the first one.</p>;
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.kind} aria-labelledby={`twin-tv-${g.kind}`}>
          <h3 id={`twin-tv-${g.kind}`} className="mb-1.5 text-sm font-semibold text-ink">
            {PLURAL[g.kind]} <span className="font-medium text-muted tabular-nums">{g.objects.length}</span>
          </h3>
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Name</th>
                  <th className={thCls}>State</th>
                  <th className={thCls}>Bound to</th>
                  <th className={thCls}>Where</th>
                  <th className={thCls}>Agents</th>
                </tr>
              </thead>
              <tbody>
                {g.objects.map((o) => {
                  const r = occupiedRect(o.footprint);
                  const marks = agents.get(o.id) ?? [];
                  return (
                    <tr key={o.id} className={cn(selectedId === o.id && "bg-hover-paper")}>
                      <td className={tdCls}>
                        <button
                          type="button"
                          aria-pressed={selectedId === o.id}
                          onClick={() => onSelect(o.id)}
                          className="rounded-sm text-left font-semibold text-ink underline-offset-2 hover:underline"
                        >
                          {o.label}
                          <span className="sr-only">, {KIND_LABEL[o.kind]}</span>
                        </button>
                        {o.alert ? <p className="text-xs text-muted">Alert: {o.alert.message}</p> : null}
                      </td>
                      <td className={tdCls}>{o.pill ?? "—"}</td>
                      <td className={cn(tdCls, "aos-mono text-xs")}>{o.bindingBroken ? "Unbound" : (o.binding?.label ?? "—")}</td>
                      <td className={cn(tdCls, "tabular-nums text-muted")}>
                        {o.state.kind === "equipment"
                          ? `≈ ${Math.round(o.state.position.x)}, ${Math.round(o.state.position.z)} (estimated)`
                          : `${r.x0}, ${r.z0} · ${r.x1 - r.x0} × ${r.z1 - r.z0} m`}
                      </td>
                      <td className={tdCls}>
                        {marks.length === 0
                          ? "—"
                          : marks.map((a) => (
                              <span key={a.runId} className="mr-2 inline-flex items-center gap-1.5 text-xs font-semibold">
                                <StatusShape status={a.status} size={10} />
                                {STATUS_META[a.status].label}: {a.label}
                              </span>
                            ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
