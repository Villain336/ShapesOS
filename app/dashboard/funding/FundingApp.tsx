// Marketr — Funding/VC slice 1: dashboard app (client).
// Two tabs: Network (funding graph, Boardy first) and Raise (the founder's
// target investor profile — the front door). Pill tabs per the Agentic OS
// pattern; tokens only; Lucide icons only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Target, Users } from "lucide-react";
import {
  NetworkView,
  type ContactView,
  type IntroRequestView,
} from "./views/NetworkView";
import { RaiseView, type RoundView } from "./views/RaiseView";

type Tab = "network" | "raise";

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
              className={`aos-press flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold ${
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
      ) : (
        <RaiseView round={round} onSaved={setRound} />
      )}
    </div>
  );
}
