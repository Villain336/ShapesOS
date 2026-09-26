// Marketr — Growth Missions list + template picker (Phase 9, M4).
// House style: StudioApp.tsx class-by-class (dense table, violet primary,
// icon sub-tabs, Lucide only, light mode).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Briefcase,
  Building2,
  CheckCircle2,
  ChevronRight,
  Home,
  Loader2,
  PauseCircle,
  Plus,
  Rocket,
  Search,
  ShoppingBag,
  Target,
  X,
} from "lucide-react";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  getTemplate,
  templatesByBusinessType,
  type BusinessType,
  type MissionTemplate,
} from "@/lib/missions/templates";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

// ── Atoms (from StudioApp.tsx) ───────────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "active": return "violet";
    case "paused": return "amber";
    case "complete": return "green";
    case "archived": return "slate";
    default: return "slate";
  }
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";

const btnGhost = "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- style token for future ghost buttons

const BT_ICONS: Record<BusinessType, typeof Home> = {
  "home-services": Home,
  "local-services": Building2,
  saas: Rocket,
  ecommerce: ShoppingBag,
  "professional-services": Briefcase,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface MissionListItem {
  id: string;
  name: string;
  template: string;
  businessType: BusinessType;
  businessTypeLabel: string;
  goalSummary: string;
  status: string;
  progress: number;
  nextCheckpoint: string | null;
  createdAt: string | null;
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-violet-600" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-stone-500">{Math.round(value * 100)}%</span>
    </div>
  );
}

// ── Template picker (modal) ──────────────────────────────────────────────────

function TemplatePicker({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const grouped = useMemo(() => templatesByBusinessType(), []);
  const [bt, setBt] = useState<BusinessType>("home-services");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goalIdx, setGoalIdx] = useState(0);
  const [targetValue, setTargetValue] = useState("");
  const [timeframeDays, setTimeframeDays] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected: MissionTemplate | null = selectedId ? getTemplate(selectedId) : null;

  useEffect(() => {
    if (selected) {
      setGoalIdx(0);
      setTargetValue(String(selected.goals[0].targetValue));
      setTimeframeDays(String(selected.goals[0].timeframeDays));
      setError(null);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected && selected.goals[goalIdx]) {
      setTargetValue(String(selected.goals[goalIdx].targetValue));
      setTimeframeDays(String(selected.goals[goalIdx].timeframeDays));
    }
  }, [goalIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  async function launch() {
    if (!selected) return;
    const goal = selected.goals[goalIdx];
    const tv = Number(targetValue);
    const tf = Number(timeframeDays);
    if (!Number.isFinite(tv) || tv <= 0) {
      setError("Target must be a positive number.");
      return;
    }
    if (!Number.isInteger(tf) || tf < 1 || tf > 365) {
      setError("Timeframe must be 1–365 days.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mission: { id: string } }>("/api/missions", {
        method: "POST",
        body: JSON.stringify({
          templateId: selected.id,
          goal: {
            metric: goal.metric,
            targetValue: tv,
            unit: goal.unit,
            timeframeDays: tf,
            direction: goal.direction,
          },
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      router.push(`/dashboard/missions/${r.mission.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
          <div>
            <h3 className="text-[15px] font-semibold text-stone-900">New mission</h3>
            <p className="text-[12.5px] text-stone-500">Pick a template for your business type, set the target, launch.</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-stone-200 px-4">
          {BUSINESS_TYPES.map((id) => {
            const Icon = BT_ICONS[id];
            return (
              <button
                key={id}
                onClick={() => { setBt(id); setSelectedId(null); }}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                  bt === id ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
                }`}
              >
                <Icon size={15} />
                {BUSINESS_TYPE_LABELS[id]}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-2">
            {grouped[bt].map((t) => (
              <div
                key={t.id}
                className={`cursor-pointer rounded-lg border px-3.5 py-3 transition ${
                  selectedId === t.id ? "border-violet-400 bg-violet-50/40" : "border-stone-200 bg-white hover:border-stone-300"
                }`}
                onClick={() => setSelectedId(t.id === selectedId ? null : t.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[14px] font-semibold text-stone-900">{t.name}</div>
                  <Chip tone={selectedId === t.id ? "violet" : "slate"}>{t.goals.length} goals</Chip>
                </div>
                <p className="mt-0.5 text-[12.5px] text-stone-500">{t.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.goals.map((g) => (
                    <Chip key={g.metric}>
                      <Target size={10} /> {g.label}: {g.targetValue}{g.unit ? ` ${g.unit}` : ""} / {g.timeframeDays}d
                    </Chip>
                  ))}
                </div>

                {selectedId === t.id && (
                  <div className="mt-3 space-y-2.5 border-t border-stone-200 pt-3" onClick={(e) => e.stopPropagation()}>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-stone-500">Goal</span>
                        <select value={goalIdx} onChange={(e) => setGoalIdx(Number(e.target.value))} className={`${inputCls} w-full`}>
                          {t.goals.map((g, i) => (
                            <option key={g.metric} value={i}>{g.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-stone-500">Mission name (optional)</span>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} className={`${inputCls} w-full`} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-stone-500">
                          Target ({t.goals[goalIdx]?.unit || "value"})
                        </span>
                        <input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} inputMode="decimal" className={`${inputCls} w-full`} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-stone-500">Timeframe (days)</span>
                        <input value={timeframeDays} onChange={(e) => setTimeframeDays(e.target.value)} inputMode="numeric" className={`${inputCls} w-full`} />
                      </label>
                    </div>
                    {t.goals[goalIdx]?.baselineHint && (
                      <p className="text-[12px] text-stone-400">Baseline hint: {t.goals[goalIdx].baselineHint}</p>
                    )}
                    {error && <p className="text-[12.5px] text-red-600">{error}</p>}
                    <div className="flex items-center gap-2">
                      <button onClick={launch} disabled={busy} className={btnPrimary}>
                        {busy && <Loader2 size={14} className="animate-spin" />} Launch mission
                      </button>
                      <span className="text-[12px] text-stone-400">
                        Tier 0 — launching drafts a plan; nothing executes without your approvals.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Missions list ────────────────────────────────────────────────────────────

export function MissionsApp() {
  const router = useRouter();
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [fType, setFType] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ missions: MissionListItem[] }>("/api/missions");
      setMissions(r.missions);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return missions.filter((m) => {
      if (fType && m.businessType !== fType) return false;
      if (fStatus && m.status !== fStatus) return false;
      if (needle && !(m.name.toLowerCase().includes(needle) || m.goalSummary.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [missions, fType, fStatus, q]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fType} onChange={(e) => setFType(e.target.value)} className={inputCls}>
          <option value="">All business types</option>
          {BUSINESS_TYPES.map((id) => (
            <option key={id} value={id}>{BUSINESS_TYPE_LABELS[id]}</option>
          ))}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputCls}>
          <option value="">All statuses</option>
          <option value="planned">Planned</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="complete">Complete</option>
          <option value="archived">Archived</option>
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search missions…" className={`${inputCls} w-44 pl-8`} />
        </div>
        <div className="ml-auto">
          <button onClick={() => setPickerOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New mission
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Goal</th>
              <th className="px-3 py-2 font-medium">Progress</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Next checkpoint</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const Icon = BT_ICONS[m.businessType] ?? Target;
              return (
                <tr
                  key={m.id}
                  onClick={() => router.push(`/dashboard/missions/${m.id}`)}
                  className="cursor-pointer border-b border-stone-100 last:border-0 hover:bg-violet-50/40"
                >
                  <td className="px-3 py-2 font-medium text-stone-900">{m.name}</td>
                  <td className="px-3 py-2">
                    <Chip tone="slate"><Icon size={10} /> {m.businessTypeLabel}</Chip>
                  </td>
                  <td className="px-3 py-2 text-stone-600">{m.goalSummary}</td>
                  <td className="px-3 py-2"><ProgressBar value={m.progress} /></td>
                  <td className="px-3 py-2">
                    <Chip tone={statusTone(m.status)}>
                      {m.status === "paused" && <PauseCircle size={10} />}
                      {m.status === "complete" && <CheckCircle2 size={10} />}
                      {m.status}
                    </Chip>
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-stone-500" title={m.nextCheckpoint ?? ""}>
                    {m.nextCheckpoint ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ChevronRight size={14} className="ml-auto text-stone-300" />
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  {missions.length === 0
                    ? "No missions yet — launch the first one with “New mission”."
                    : "No missions match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12.5px] text-stone-600">
        <span className="font-medium text-stone-800">Kill switches always on. </span>
        Every mission can be paused instantly; the workspace freeze halts everything. Resume re-verifies
        budgets, data freshness, and goal assumptions before anything continues.
      </div>

      {pickerOpen && <TemplatePicker onClose={() => { setPickerOpen(false); void load(); }} />}
    </div>
  );
}
