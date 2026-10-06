// Marketr — Funding/VC slices 1–4: dashboard app (client).
// Five tabs: Network (funding graph, Boardy first), Pipeline (investor
// CRM kanban, slice 2), Data room (versioned docs + expiring share links +
// per-viewer analytics, slice 3), Readiness (round checklist + cap table +
// SAFE picker + deck review, slice 4), and Raise (the founder's target investor
// profile — the front door). Pill tabs per the Agentic OS pattern; tokens
// only; Lucide icons only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Files, KanbanSquare, Loader2, Target, Users } from "lucide-react";
import {
  NetworkView,
  type ContactView,
  type IntroRequestView,
} from "./views/NetworkView";
import { PipelineView } from "./views/PipelineView";
import { DataRoomView } from "./views/DataRoomView";
import { RaiseView, type RoundView } from "./views/RaiseView";
import { ReadinessView } from "./views/ReadinessView";

type Tab = "network" | "pipeline" | "dataroom" | "raise" | "readiness";

export function FundingApp() {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("network");
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [introRequests, setIntroRequests] = useState<IntroRequestView[]>([]);
  const [round, setRound] = useState<RoundView | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/funding/graph");
    if (res.ok) {
      const json = await res.json();
      setContacts(json.contacts ?? []);
      setRound(json.round ?? null);
      setIntroRequests(json.introRequests ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading your funding workspace
      </div>
    );
  }

  const tabs = [
    { id: "network" as const, label: "Network", icon: Users },
    { id: "pipeline" as const, label: "Pipeline", icon: KanbanSquare },
    { id: "dataroom" as const, label: "Data room", icon: Files },
    { id: "readiness" as const, label: "Readiness", icon: ClipboardCheck },
    { id: "raise" as const, label: "Raise", icon: Target },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2" role="tablist" aria-label="Funding views">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`aos-press flex h-10 items-center gap-2 rounded-full px-4 text-[0.875rem] font-semibold ${
                active ? "bg-black text-white" : "bg-paper text-muted shadow-hairline"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "network" ? (
        <NetworkView contacts={contacts} introRequests={introRequests} loading={false} />
      ) : tab === "pipeline" ? (
        <PipelineView />
      ) : tab === "dataroom" ? (
        <DataRoomView />
      ) : tab === "readiness" ? (
        round ? (
          <ReadinessView roundId={round.id} />
        ) : (
          <div className="rounded-lg bg-paper p-4 text-[0.875rem] text-muted shadow-hairline">
            Save your raise profile on the Raise tab first — readiness tracks against your active round.
          </div>
        )
      ) : (
        <RaiseView round={round} onSaved={setRound} />
      )}
    </div>
  );
}
