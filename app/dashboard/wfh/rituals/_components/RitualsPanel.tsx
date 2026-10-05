// Marketr — Wave 2 WFH mode slice 5: rituals panel (client).
// Ritual cards with subscribe/participate, dead-ritual warnings with retire,
// and a create form seeded from the ritual-type presets.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, AlertTriangle } from "lucide-react";
import { runUndoable } from "@/lib/ui/feedback";

interface RitualHealth {
  dead: boolean;
  reason: string | null;
  suggestion: string | null;
}

interface Ritual {
  id: string;
  type: string;
  meta: { name: string; description: string; prompt: string } | null;
  title: string;
  description: string;
  cadence: string;
  anchorDate: string;
  active: boolean;
  subscriberCount: number;
  subscribed: boolean;
  nextOccurrence: string;
  participations: { userId: string; note: string | null; occurredAt: string }[];
  health: RitualHealth;
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";
const labelCls = "block text-xs font-semibold text-muted";
// Ritual states are workflow states, not agent states — neutrals only.
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control";

const PRESETS = [
  { type: "wins", label: "Wins" },
  { type: "kudos", label: "Kudos" },
  { type: "virtual-coffee", label: "Virtual coffee" },
  { type: "demo-friday", label: "Demo Friday" },
];

export default function RitualsPanel() {
  const [rituals, setRituals] = useState<Ritual[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [newType, setNewType] = useState("wins");
  const [newCadence, setNewCadence] = useState("weekly");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  async function reload() {
    const res = await fetch("/api/wfh/rituals");
    if (res.ok) {
      const data = await res.json();
      setRituals(data.rituals);
    }
    setLoaded(true);
  }

  useEffect(() => {
    reload();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/rituals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: newType,
          cadence: newCadence,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Create failed"));
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSubscribe(r: Ritual) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/rituals/${r.id}/subscribe`, {
        method: r.subscribed ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Subscription failed");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Subscription failed");
    } finally {
      setBusy(false);
    }
  }

  async function participate(r: Ritual) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/rituals/${r.id}/participate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDrafts[r.id] || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Participation failed");
      }
      setNoteDrafts((d) => ({ ...d, [r.id]: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Participation failed");
    } finally {
      setBusy(false);
    }
  }

  // Retiring is soft (active=false; reactivating flips it back), so it runs
  // immediately and the toast offers Undo instead of a confirm dialog.
  async function retire(r: Ritual) {
    const setActive = async (active: boolean) => {
      const res = await fetch(`/api/wfh/rituals/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(active ? { active } : { active, wasDead: r.health.dead }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? (active ? "Reactivate failed" : "Retire failed"));
      }
    };
    setBusy(true);
    try {
      await runUndoable({
        title: `Retired "${r.title}"`,
        run: () => setActive(false),
        undo: () => setActive(true),
        onUndone: () => void reload(),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retire failed");
    } finally {
      setBusy(false);
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rituals…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
          role="alert"
        >
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Create */}
      <div className="rounded-lg bg-paper px-4 py-4 shadow-hairline">
        <h2 className="aos-subheading flex items-center gap-2">
          <Plus className="h-4 w-4" /> Start a ritual
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <div>
            <label className={labelCls}>Type</label>
            <select className={`${inputCls} mt-1`} value={newType} onChange={(e) => setNewType(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.type} value={p.type}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Cadence</label>
            <select className={`${inputCls} mt-1`} value={newCadence} onChange={(e) => setNewCadence(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every two weeks</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        </div>
        <button type="button" onClick={create} disabled={busy} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Start ritual
        </button>
      </div>

      {/* Rituals */}
      {rituals.length === 0 ? (
        <p className="rounded-lg bg-paper px-4 py-6 text-center text-sm text-muted shadow-hairline">
          No rituals yet. Start one above — wins and kudos are the cheapest culture wins there are.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rituals.map((r) => (
            <div key={r.id} className={`rounded-lg bg-paper px-4 py-4 shadow-hairline ${r.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{r.title}</h3>
                  <p className="mt-0.5 text-sm text-muted">{r.description}</p>
                </div>
                <span className={chip}>
                  {r.active ? r.cadence : "retired"}
                </span>
              </div>

              {r.health.dead && r.active && (
                <div className="mt-2 rounded-md bg-canvas px-3 py-2 text-xs text-muted">
                  <p className="flex items-center gap-1.5 font-semibold text-ink">
                    <AlertTriangle className="h-3.5 w-3.5" /> This ritual looks dead: {r.health.reason}
                  </p>
                  {r.health.suggestion && <p className="mt-0.5">{r.health.suggestion}</p>}
                </div>
              )}

              <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                <span>{r.subscriberCount} subscribed</span>
                <span>{r.participations.length} recent participations</span>
                {r.active && <span>Next: {fmtDate(r.nextOccurrence)}</span>}
              </div>

              {r.meta?.prompt && (
                <p className="mt-2 text-sm italic text-muted">“{r.meta.prompt}”</p>
              )}

              {r.active && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input
                      className={`${inputCls} flex-1`}
                      value={noteDrafts[r.id] ?? ""}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      placeholder="What did you share? (optional)"
                    />
                    <button type="button" onClick={() => participate(r)} disabled={busy} className={btnPrimary}>
                      I joined
                    </button>
                    <button type="button" onClick={() => toggleSubscribe(r)} disabled={busy} className={btnGhost}>
                      {r.subscribed ? "Unsubscribe" : "Subscribe"}
                    </button>
                  </div>
                  {r.health.dead && (
                    <button type="button" onClick={() => retire(r)} disabled={busy} className={`${btnDeny} mt-2`}>
                      Retire this ritual
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
