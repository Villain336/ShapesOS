// Marketr CRM — kanban pipeline board (HTML5 drag-and-drop; drop = stage change).
"use client";

import { useState } from "react";
import type { CrmLead, CrmPipeline } from "./types";
import { formatMoney } from "./types";
import { Avatar, EmptyState, ScoreBar, StageBadge, kanbanCardCls, kanbanColCls, kanbanColOverCls } from "./ui";
import { Kanban } from "lucide-react";
import { activateOnKey } from "@/lib/ui/keyboard";

export function KanbanBoard({
  leads, pipeline, onOpen, onMove,
}: {
  leads: CrmLead[];
  pipeline: CrmPipeline;
  onOpen: (id: string) => void;
  onMove: (leadId: string, toStage: string) => Promise<void>;
}) {
  const [overCol, setOverCol] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const drop = async (stageId: string) => {
    setOverCol(null);
    if (!dragId || moving) return;
    const lead = leads.find((l) => l.id === dragId);
    setDragId(null);
    if (!lead || lead.stage === stageId) return;
    setMoving(true);
    try {
      await onMove(dragId, stageId);
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: 420 }}>
      {pipeline.stages.map((s) => {
        const col = leads.filter((l) => l.stage === s.id);
        const colValue = col.reduce((a, l) => a + (l.valueCents ?? 0), 0);
        return (
          <div
            key={s.id}
            className={overCol === s.id ? `${kanbanColCls} ${kanbanColOverCls}` : kanbanColCls}
            onDragOver={(e) => { e.preventDefault(); setOverCol(s.id); }}
            onDragLeave={() => setOverCol((o) => (o === s.id ? null : o))}
            onDrop={() => drop(s.id)}
          >
            <div className="flex items-center justify-between px-3 pt-3 pb-2">
              <div className="flex items-center gap-2">
                <StageBadge label={s.label} color={s.color} />
                <span className="text-[12px] font-semibold text-muted tabular-nums">{col.length}</span>
              </div>
              <span className="text-[12px] font-semibold text-muted tabular-nums">
                {formatMoney(colValue)}
              </span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto px-2.5 pb-3">
              {col.map((l) => (
                <div
                  key={l.id}
                  className={kanbanCardCls}
                  draggable
                  onDragStart={() => setDragId(l.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => onOpen(l.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${l.name}`}
                  onKeyDown={activateOnKey(() => onOpen(l.id))}
                  style={{ opacity: dragId === l.id ? 0.5 : 1 }}
                >
                  <div className="flex items-center gap-2">
                    <Avatar name={l.name} size={24} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">{l.name}</div>
                      {l.company && (
                        <div className="truncate text-[12px] text-muted">{l.company}</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <ScoreBar score={l.score} showNumber />
                    <span className="text-[12.5px] font-semibold text-ink tabular-nums">
                      {formatMoney(l.valueCents)}
                    </span>
                  </div>
                </div>
              ))}
              {col.length === 0 && (
                <div className="rounded-md border border-dashed border-control px-3 py-6 text-center text-[12px] text-subtle">
                  Drop leads here
                </div>
              )}
            </div>
          </div>
        );
      })}
      {pipeline.stages.length === 0 && (
        <EmptyState icon={Kanban} title="No stages" hint="This pipeline has no stages configured." />
      )}
    </div>
  );
}
