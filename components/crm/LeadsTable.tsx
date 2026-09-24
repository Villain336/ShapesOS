// Marketr CRM — dense leads table (the reference's pipeline view).
"use client";

import { Phone, EnvelopeSimple, Star, DotsThreeVertical } from "@phosphor-icons/react";
import type { CrmLead, CrmPipeline } from "./types";
import { SOURCE_LABELS, formatMoney, timeAgo } from "./types";
import { StageBadge, ScoreBar, Sparkline, Avatar } from "./ui";

const ACT_ICON: Record<string, typeof Phone> = {
  call: Phone, email: EnvelopeSimple, sms: EnvelopeSimple, meeting: EnvelopeSimple, note: EnvelopeSimple,
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
    <div className="overflow-x-auto rounded-[10px] border border-stone-200 bg-white">
      <table className="crm-table w-full min-w-[1080px]">
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
                className={selectedId === l.id ? "!bg-violet-50" : ""}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onToggleStar(l)}
                    className={l.starred ? "text-violet-600" : "text-stone-300 hover:text-stone-500"}
                    title={l.starred ? "Unstar" : "Star"}
                  >
                    <Star size={15} weight={l.starred ? "fill" : "regular"} />
                  </button>
                </td>
                <td>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={l.name} size={30} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-stone-900">{l.name}</div>
                      <div className="truncate text-[12px] text-stone-500">
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
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-stone-700">
                      <Avatar name={l.ownerName} size={22} /> {l.ownerName}
                    </span>
                  ) : (
                    <span className="text-stone-400">—</span>
                  )}
                </td>
                <td>
                  <span className="text-[12.5px] text-stone-600">{SOURCE_LABELS[l.source] ?? l.source}</span>
                </td>
                <td><ScoreBar score={l.score} /></td>
                <td className="text-right font-semibold tabular-nums">{formatMoney(l.valueCents)}</td>
                <td><Sparkline data={trends[l.id] ?? [0, 0, 0, 0, 0, 0, 0, 0]} /></td>
                <td>
                  <span className="text-[12.5px] text-stone-500">{timeAgo(l.lastActivityAt)}</span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="text-stone-400 hover:text-stone-700" onClick={() => onOpen(l.id)}>
                    <DotsThreeVertical size={16} weight="bold" />
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
  const Icon = ACT_ICON[type] ?? EnvelopeSimple;
  return <Icon size={13} className="text-violet-600" />;
}
