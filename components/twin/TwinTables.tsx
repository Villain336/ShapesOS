// ShapesOS — Phase 13 (twinui): the tabbed dense table (bottom-right):
// Docks / Equipment / Trucks for warehouses, Work centres / Orders for
// factories, Registers / Shelves for stores. A row selects its object.

"use client";

import { useState, type KeyboardEvent } from "react";
import type { TwinSnapshot } from "@/lib/twin/types";
import { TWIN_TABS, twinTable, type TwinTabKey } from "@/lib/twin/view-model";
import { tabCls, tableCls, tdCls, thCls } from "@/components/crm/ui";
import { cn } from "@/lib/utils";

export function TwinTables({
  snapshot,
  selectedId,
  onSelect,
  className,
}: {
  snapshot: TwinSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const tabs = TWIN_TABS[snapshot.site.kind];
  const [tab, setTab] = useState<TwinTabKey>(tabs[0]!.key);
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]!.key;
  const table = twinTable(snapshot, active);
  const pick = (id: string | null) => id && onSelect(id);
  return (
    <section aria-label="Site tables" className={cn("flex min-h-0 flex-col rounded-lg bg-paper shadow-hairline", className)}>
      <div role="tablist" aria-label="Tables" className="flex shrink-0 gap-4 border-b border-line px-3">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === active} className={tabCls(t.key === active)} onClick={() => setTab(t.key)}>
            {t.label}
            <span className="text-xs font-medium text-muted tabular-nums">{twinTable(snapshot, t.key).rows.length}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {table.rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">{table.empty}</p>
        ) : (
          <table className={tableCls}>
            <thead className="sticky top-0">
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} className={cn(thCls, c.align === "right" && "text-right")}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => {
                const sel = !!r.objectId && r.objectId === selectedId;
                return (
                  <tr
                    key={r.key}
                    tabIndex={r.objectId ? 0 : -1}
                    aria-selected={sel}
                    onClick={() => pick(r.objectId)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(r.objectId);
                      }
                    }}
                    className={cn(r.objectId && "cursor-pointer hover:bg-hover-paper", sel && "bg-hover-paper")}
                  >
                    {table.columns.map((c, i) => (
                      <td key={c.key} className={cn(tdCls, "py-1.5", c.align === "right" && "text-right tabular-nums", c.mono && "aos-mono text-xs", i === 0 && "font-semibold")}>
                        {c.pill && r.cells[c.key] !== "—" ? (
                          <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">
                            {r.cells[c.key]}
                          </span>
                        ) : (
                          r.cells[c.key]
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
