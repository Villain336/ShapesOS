// Marketr — Legal/Compliance: dashboard app (client).
// Slice 1: obligation checklist. Slice 2: deadline engine (computed deadlines
// with escalation tiers). Tabs follow the Agentic OS pill-tab pattern.
// Every view carries the information-not-advice label from the API.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, CalendarClock, ListChecks, Loader2 } from "lucide-react";
import { ChecklistView, type ObligationView } from "./views/ChecklistView";
import {
  DeadlinesView,
  type DeadlineView,
  type NeedsDateView,
} from "./views/DeadlinesView";
import { DocumentsView, type DocumentView } from "./views/DocumentsView";
import { ProfileStep, type ProfileDraft } from "./views/ProfileStep";

type Tab = "obligations" | "deadlines" | "documents";

export function LegalApp() {
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<Tab>("obligations");
  const [profile, setProfile] = useState<ProfileDraft | null>(null);
  const [obligations, setObligations] = useState<ObligationView[]>([]);
  const [deadlines, setDeadlines] = useState<DeadlineView[]>([]);
  const [needsDate, setNeedsDate] = useState<NeedsDateView[]>([]);
  const [documents, setDocuments] = useState<DocumentView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [disclaimer, setDisclaimer] = useState("");

  const refresh = useCallback(async () => {
    const [oblRes, dlRes, docRes] = await Promise.all([
      fetch("/api/legal/obligations"),
      fetch("/api/legal/deadlines"),
      fetch("/api/legal/documents"),
    ]);
    if (oblRes.ok) {
      const json = await oblRes.json();
      setDisclaimer(json.disclaimer ?? "");
      setProfile(json.profile ?? null);
      setObligations(json.obligations ?? []);
    }
    if (dlRes.ok) {
      const json = await dlRes.json();
      setDisclaimer((prev) => prev || (json.disclaimer ?? ""));
      setDeadlines(json.deadlines ?? []);
      setNeedsDate(json.needsDate ?? []);
    }
    if (docRes.ok) {
      const json = await docRes.json();
      setDisclaimer((prev) => prev || (json.disclaimer ?? ""));
      setDocuments(json.documents ?? []);
      setWorkspaceId(json.workspaceId ?? "");
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
        Loading your legal workspace
      </div>
    );
  }

  if (!profile || editing) {
    return (
      <ProfileStep
        initial={editing ? profile : null}
        onSaved={(p) => {
          setProfile(p);
          setEditing(false);
          void refresh();
        }}
      />
    );
  }

  const attention = deadlines.filter(
    (d) => d.status === "open" && d.tier && d.tier !== "due_90" && d.tier !== null,
  ).length;
  const docAttention = documents.filter(
    (d) => d.tier && d.tier !== "due_90",
  ).length;

  const tabs = [
    { id: "obligations" as const, label: "Obligations", icon: ListChecks, badge: null as number | null },
    {
      id: "deadlines" as const,
      label: "Deadlines",
      icon: CalendarClock,
      badge: attention > 0 ? attention : null,
    },
    {
      id: "documents" as const,
      label: "Documents",
      icon: Archive,
      badge: docAttention > 0 ? docAttention : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2" role="tablist" aria-label="Legal views">
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
              {t.badge !== null && (
                <span
                  className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[11px] ${
                    active ? "bg-white text-black" : "bg-black text-white"
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "obligations" ? (
        <ChecklistView
          obligations={obligations}
          disclaimer={disclaimer}
          onChanged={() => void refresh()}
          onEditProfile={() => setEditing(true)}
        />
      ) : tab === "deadlines" ? (
        <DeadlinesView
          deadlines={deadlines}
          needsDate={needsDate}
          disclaimer={disclaimer}
          onChanged={() => void refresh()}
        />
      ) : (
        <DocumentsView
          documents={documents}
          workspaceId={workspaceId}
          disclaimer={disclaimer}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
