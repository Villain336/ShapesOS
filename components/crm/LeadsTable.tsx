// Marketr CRM — dense leads table (the reference's pipeline view).
"use client";

import { Phone, Mail, Star, EllipsisVertical } from "lucide-react";
import type { CrmLead, CrmPipeline } from "./types";
import { SOURCE_LABELS, formatMoney, timeAgo } from "./types";
import { Avatar, ScoreBar, Sparkline, StageBadge, tableCls, tableWrapCls } from "./ui";

const ACT_ICON: Record<string, typeof Phone> = {
  call: Phone, email: Mail, sms: Mail, meeting: Mail, note: Mail,
};

export function LeadsTable({
  leads, trends, pipeline, onOpen, onToggleStar, selectedId,
}: {
  leads: CrmLead[];
  trends: Record<string, number[]>;
  pipeline: CrmPipeline | undefined;
  onOpen: (id: string) => void;
  onToggleStar: (lead: CrmLead) => void;
  selectedId?: string | null;
}) {
  const stageOf = (id: string) => pipeline?.stages.find((s) => s.id === id);
  return (
    <div className={tableWrapCls}>
      <table className={`${tableCls} min-w-[1080px]`}>
        <thead>
          <tr>
            <th className="w-10"></th>
            <th>Lead</th>
            <th>Stage</th>
            <th>Owner</th>
            <th>Source</th>
            <th>Score</th>
            <th className="text-right">Value</th>
            <th>Trend</th>
            <th>Last touch</th>
            <th className="w-10"></th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => {
            const st = stageOf(l.stage);
            return (
              <tr
                key={l.id}
                onClick={() => onOpen(l.id)}
                className={selectedId === l.id ? "!bg-hover" : ""}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onToggleStar(l)}
                    className={l.starred ? "text-ink" : "text-subtle hover:text-muted"}
                    title={l.starred ? "Unstar" : "Star"}
                  >
                    <Star size={15} fill={l.starred ? "currentColor" : "none"} className={l.starred ? "text-ink" : "text-subtle"} />
                  </button>
                </td>
                <td>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={l.name} size={30} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-ink">{l.name}</div>
                      <div className="truncate text-[12px] text-muted">
                        {[l.title, l.company].filter(Boolean).join(" · ") || l.email || "—"}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <StageBadge label={st?.label ?? l.stage} color={st?.color ?? "gray"} />
                </td>
                <td>
                  {l.ownerName ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink">
                      <Avatar name={l.ownerName} size={22} /> {l.ownerName}
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td>
                  <span className="text-[12.5px] text-muted">{SOURCE_LABELS[l.source] ?? l.source}</span>
                </td>
                <td><ScoreBar score={l.score} /></td>
                <td className="text-right font-semibold tabular-nums">{formatMoney(l.valueCents)}</td>
                <td><Sparkline data={trends[l.id] ?? [0, 0, 0, 0, 0, 0, 0, 0]} /></td>
                <td>
                  <span className="text-[12.5px] text-muted">{timeAgo(l.lastActivityAt)}</span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="text-subtle hover:text-ink" onClick={() => onOpen(l.id)}>
                    <EllipsisVertical size={16} strokeWidth={2.5} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LastTouchIcon({ type }: { type: string }) {
  const Icon = ACT_ICON[type] ?? Mail;
  return <Icon size={13} className="text-ink" />;
}
