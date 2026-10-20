// Marketr — Phase 18 slice 5: audience/geo/budget planner.
//
// The $250 Ad Studio minimum is enforced as a planner floor: plans below it
// are flagged, never silently accepted. Audience fields are a planning
// worksheet persisted locally; budget math comes from planSpotifyBudget().

"use client";

import { useEffect, useState } from "react";
import { Calculator, Loader2, TriangleAlert, CircleCheck } from "lucide-react";
import {
  SpotifyGuidedError,
  SPOTIFY_MIN_BUDGET_USD,
  planSpotifyBudget,
  type SpotifyBudgetPlan,
} from "@/lib/adplatforms/spotify/planning";

const STORAGE_PREFIX = "marketr-spotify-planner:";

const WORKSHEET_FIELDS = [
  { id: "locations", label: "Locations", placeholder: "e.g. United States — Southeast; Raleigh-Durham DMA" },
  { id: "demographics", label: "Age & gender", placeholder: "e.g. 25–44, all genders" },
  { id: "interests", label: "Interests & genres", placeholder: "e.g. indie rock, true-crime podcasts, fitness" },
  { id: "context", label: "Listening context", placeholder: "e.g. morning commute, workout, work-from-home focus" },
] as const;

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

export default function BudgetPlanner() {
  const [budget, setBudget] = useState("250");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [worksheet, setWorksheet] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<SpotifyBudgetPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + "worksheet");
      if (raw) setWorksheet(JSON.parse(raw) as Record<string, string>);
    } catch {
      // Corrupt storage is not worth an error UI.
    }
  }, []);

  function setField(id: string, value: string) {
    setWorksheet((prev) => {
      const next = { ...prev, [id]: value };
      try {
        localStorage.setItem(STORAGE_PREFIX + "worksheet", JSON.stringify(next));
      } catch {
        // Storage may be unavailable; the input still works.
      }
      return next;
    });
  }

  function check() {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const budgetUsd = Number(budget);
      setPlan(
        planSpotifyBudget({
          budgetUsd,
          startDate: start.trim() || undefined,
          endDate: end.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(
        e instanceof SpotifyGuidedError ? e.message : "Could not check the plan",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-3 shadow-hairline">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Lifetime budget (USD)
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
            placeholder="250.00"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Flight start (optional)
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Flight end (optional)
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {WORKSHEET_FIELDS.map((f) => (
          <label key={f.id} className="flex flex-col gap-1 text-xs font-semibold text-muted">
            {f.label}
            <input
              value={worksheet[f.id] ?? ""}
              onChange={(e) => setField(f.id, e.target.value)}
              placeholder={f.placeholder}
              className={inputCls}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={check}
          disabled={busy}
          className={btnPrimarySm}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
          {busy ? "Checking…" : "Check plan"}
        </button>
        <span className="text-xs text-subtle">
          Ad Studio minimum: ${SPOTIFY_MIN_BUDGET_USD} lifetime budget
        </span>
      </div>
      {error && (
        <p className="rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">{error}</p>
      )}
      {plan && (
        <div className="rounded-lg border border-line bg-paper px-3 py-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            {plan.ok ? <CircleCheck className="h-4 w-4 shrink-0" /> : <TriangleAlert className="h-4 w-4 shrink-0" />}
            {plan.ok
              ? "Plan meets the Ad Studio minimum"
              : `Below the $${SPOTIFY_MIN_BUDGET_USD} minimum — this plan cannot launch as-is`}
          </p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm text-muted">
            {plan.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
