// Marketr CRM — kanban pipeline board (HTML5 drag-and-drop; drop = stage change).
// Phase 10 (ops-core): renders through the shared board (components/ops/
// Board.tsx) that deals, tasks and recruiting reuse — same look, one DnD.
"use client";

import type { CrmLead, CrmPipeline } from "./types";
import { formatMoney } from "./types";
import { Avatar, EmptyState, ScoreBar, StageBadge } from "./ui";
import { Kanban } from "lucide-react";
import { Board } from "@/components/ops/Board";

export function KanbanBoard({
  leads, pipeline, onOpen, onMove,
}: {
  leads: CrmLead[];
  pipeline: CrmPipeline;
  onOpen: (id: string) => void;
  onMove: (leadId: string, toStage: string) => Promise<void>;
}) {
  if (pipeline.stages.length === 0) {
    return <EmptyState icon={Kanban} title="No stages" hint="This pipeline has no stages configured." />;
  }
  return (
    <Board
      columns={pipeline.stages}
      items={leads}
      columnOf={(l) => l.stage}
      cardLabel={(l) => `Open ${l.name}`}
      onOpen={onOpen}
      onMove={onMove}
      emptyHint="Drop leads here"
      renderHeader={(c, col) => {
        const s = pipeline.stages.find((x) => x.id === c.id)!;
        return (
          <>
            <div className="flex items-center gap-2">
              <StageBadge label={s.label} color={s.color} />
              <span className="text-[0.75rem] font-semibold text-muted tabular-nums">{col.length}</span>
            </div>
            <span className="text-[0.75rem] font-semibold text-muted tabular-nums">
              {formatMoney(col.reduce((a, l) => a + (l.valueCents ?? 0), 0))}
            </span>
          </>
        );
      }}
      renderCard={(l) => (
        <>
          <div className="flex items-center gap-2">
            <Avatar name={l.name} size={24} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.8125rem] font-semibold text-ink">{l.name}</div>
              {l.company && <div className="truncate text-[0.75rem] text-muted">{l.company}</div>}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <ScoreBar score={l.score} showNumber />
            <span className="text-[0.78125rem] font-semibold text-ink tabular-nums">{formatMoney(l.valueCents)}</span>
          </div>
        </>
      )}
    />
  );
}
