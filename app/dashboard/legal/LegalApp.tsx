// Marketr — Legal/Compliance slice 1: dashboard app (client).
// Profile capture step first (no profile yet), then the computed checklist.
// Agentic OS: tokens only, Lucide icons only, sentence case, black pill
// primary actions, pills for pressables, cards white radius-lg.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ChecklistView, type ObligationView } from "./views/ChecklistView";
import { ProfileStep, type ProfileDraft } from "./views/ProfileStep";

export function LegalApp() {
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState<ProfileDraft | null>(null);
  const [obligations, setObligations] = useState<ObligationView[]>([]);
  const [disclaimer, setDisclaimer] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/legal/obligations");
    if (res.ok) {
      const json = await res.json();
      setDisclaimer(json.disclaimer ?? "");
      setProfile(json.profile ?? null);
      setObligations(json.obligations ?? []);
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
        Loading your obligation map
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

  return (
    <ChecklistView
      obligations={obligations}
      disclaimer={disclaimer}
      onChanged={() => void refresh()}
      onEditProfile={() => setEditing(true)}
    />
  );
}
