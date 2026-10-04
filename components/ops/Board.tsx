// ShapesOS Phase 10 (ops-core) — generic kanban board (HTML5 drag-and-drop;
// drop = move). Extracted from the CRM lead board (components/crm/
// KanbanBoard.tsx now renders through it) so deals, tasks and applicants
// share ONE board implementation and the same kanban atoms.

"use client";

import { useState } from "react";
import { kanbanCardCls, kanbanColCls, kanbanColOverCls } from "@/components/crm/ui";
import { activateOnKey } from "@/lib/ui/keyboard";

export interface BoardColumn {
  id: string;
  label: string;
}

export function Board<T extends { id: string }>({
  columns,
  items,
  columnOf,
  renderHeader,
  renderCard,
  cardLabel,
  onOpen,
  onMove,
  emptyHint = "Drop here",
  minHeight = 420,
}: {
  columns: BoardColumn[];
  items: T[];
  columnOf: (item: T) => string;
  renderHeader: (col: BoardColumn, items: T[]) => React.ReactNode;
  renderCard: (item: T) => React.ReactNode;
  cardLabel: (item: T) => string;
  onOpen?: (id: string) => void;
  onMove: (id: string, toColumn: string) => Promise<void>;
  emptyHint?: string;
  minHeight?: number;
}) {
  const [overCol, setOverCol] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const drop = async (colId: string) => {
    setOverCol(null);
    if (!dragId || moving) return;
    const item = items.find((i) => i.id === dragId);
    setDragId(null);
    if (!item || columnOf(item) === colId) return;
    setMoving(true);
    try {
      await onMove(item.id, colId);
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight }}>
      {columns.map((c) => {
        const col = items.filter((i) => columnOf(i) === c.id);
        return (
          <div
            key={c.id}
            className={overCol === c.id ? `${kanbanColCls} ${kanbanColOverCls}` : kanbanColCls}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(c.id);
            }}
            onDragLeave={() => setOverCol((o) => (o === c.id ? null : o))}
            onDrop={() => drop(c.id)}
            aria-label={c.label}
          >
            <div className="flex items-center justify-between px-3 pb-2 pt-3">{renderHeader(c, col)}</div>
            <div className="flex flex-col gap-2 overflow-y-auto px-2.5 pb-3">
              {col.map((item) => (
                <div
                  key={item.id}
                  className={kanbanCardCls}
                  draggable
                  onDragStart={() => setDragId(item.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverCol(null);
                  }}
                  onClick={() => onOpen?.(item.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={cardLabel(item)}
                  onKeyDown={activateOnKey(() => onOpen?.(item.id))}
                  style={{ opacity: dragId === item.id ? 0.5 : 1 }}
                >
                  {renderCard(item)}
                </div>
              ))}
              {col.length === 0 && (
                <div className="rounded-md border border-dashed border-control px-3 py-6 text-center text-[12px] text-subtle">{emptyHint}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
