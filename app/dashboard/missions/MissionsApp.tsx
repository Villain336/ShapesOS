// Marketr — Growth Missions list + template picker (Phase 9, M4).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Briefcase,
  Building2,
  ChevronRight,
  Home,
  Loader2,
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
import { activateOnKey, closeOnEscape } from "@/lib/ui/keyboard";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

// ── Atoms (Agentic OS) ───────────────────────────────────────────────────────

// All mission-list metadata (type, goal counts) is category information,
// not agent state — always a neutral chip. The tone prop stays for
// call-site compatibility.
function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: string }) {
  void tone;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

// Mission statuses ARE genuine agent states: active work runs, paused holds,
// complete finishes, planned waits its turn. Archived is just a shelf.
function MissionStatusBadge({ status }: { status: string }) {
  const base =
    "inline-flex h-badge items-center gap-1.5 rounded-full px-3 text-sm font-semibold";
  const shape = (extra: string) => (
    <span className={`aos-shape ${extra}`} style={{ color: "inherit" }} aria-hidden />
  );
  switch (status) {
    case "active":
      return (
        <span className={`${base} bg-running text-white`}>
          {shape("aos-shape--running aos-is-live")} Active
        </span>
      );
    case "paused":
      return (
        <span className={`${base} bg-line text-ink`}>
          {shape("aos-shape--paused")} Paused
        </span>
      );
    case "complete":
      return (
        <span className={`${base} bg-done text-white`}>
          {shape("aos-shape--done")} Complete
        </span>
      );
    case "planned":
      return (
        <span className={`${base} bg-paper text-ink shadow-outline`}>
          {shape("aos-shape--queued")} Planned
        </span>
      );
    default:
      return (
        <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
          Archived
        </span>
      );
  }
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- style token for future ghost buttons
const btnRun =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";

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
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-ink" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-muted">{Math.round(value * 100)}%</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-paper shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h3 className="aos-subheading">New mission</h3>
            <p className="text-xs text-muted">Pick a template for your business type, set the target, launch.</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-line px-4">
          {BUSINESS_TYPES.map((id) => {
            const Icon = BT_ICONS[id];
            return (
              <button
                key={id}
                onClick={() => { setBt(id); setSelectedId(null); }}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                  bt === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
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
                className={`cursor-pointer rounded-lg border px-3.5 py-3 ${
                  selectedId === t.id ? "border-ink bg-canvas" : "border-line bg-paper hover:border-control"
                }`}
                role="presentation"
                onClick={() => setSelectedId(t.id === selectedId ? null : t.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* Keyboard path: the card is a mouse target; the name is the button. */}
                  <button
                    type="button"
                    aria-expanded={selectedId === t.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(t.id === selectedId ? null : t.id);
                    }}
                    className="rounded-sm text-left text-sm font-semibold text-ink"
                  >
                    {t.name}
                  </button>
                  <Chip>{t.goals.length} goals</Chip>
                </div>
                <p className="mt-0.5 text-xs text-muted">{t.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.goals.map((g) => (
                    <Chip key={g.metric}>
                      <Target size={10} /> {g.label}: {g.targetValue}{g.unit ? ` ${g.unit}` : ""} / {g.timeframeDays}d
                    </Chip>
                  ))}
                </div>

                {selectedId === t.id && (
                  <div className="mt-3 space-y-2.5 border-t border-line pt-3" onClick={(e) => e.stopPropagation()}>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-muted">Goal</span>
                        <select value={goalIdx} onChange={(e) => setGoalIdx(Number(e.target.value))} className={`${inputCls} w-full`}>
                          {t.goals.map((g, i) => (
                            <option key={g.metric} value={i}>{g.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-muted">Mission name (optional)</span>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} className={`${inputCls} w-full`} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-muted">
                          Target ({t.goals[goalIdx]?.unit || "value"})
                        </span>
                        <input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} inputMode="decimal" className={`${inputCls} w-full`} />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-semibold text-muted">Timeframe (days)</span>
                        <input value={timeframeDays} onChange={(e) => setTimeframeDays(e.target.value)} inputMode="numeric" className={`${inputCls} w-full`} />
                      </label>
                    </div>
                    {t.goals[goalIdx]?.baselineHint && (
                      <p className="text-xs text-subtle">Baseline hint: {t.goals[goalIdx].baselineHint}</p>
                    )}
                    {error && (
                      <p role="alert" className="flex items-center gap-1.5 text-sm text-failed-text">
                        <span className="size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
                        {error}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <button onClick={launch} disabled={busy} className={btnRun}>
                        {busy && <Loader2 size={14} className="aos-spin" />} Launch mission
                      </button>
                      <span className="text-xs text-subtle">
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
        <select value={fType} onChange={(e) => setFType(e.target.value)} className={inputCls} aria-label="Filter by business type">
          <option value="">All business types</option>
          {BUSINESS_TYPES.map((id) => (
            <option key={id} value={id}>{BUSINESS_TYPE_LABELS[id]}</option>
          ))}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputCls} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="planned">Planned</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="complete">Complete</option>
          <option value="archived">Archived</option>
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search missions…" className={`${inputCls} w-44 pl-9`} />
        </div>
        <div className="ml-auto">
          <button onClick={() => setPickerOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New mission
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 font-semibold">Goal</th>
              <th className="px-3 py-2 font-semibold">Progress</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Next checkpoint</th>
              <th className="px-3 py-2 font-semibold"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const Icon = BT_ICONS[m.businessType] ?? Target;
              return (
                <tr
                  key={m.id}
                  onClick={() => router.push(`/dashboard/missions/${m.id}`)}
                  tabIndex={0}
                  onKeyDown={activateOnKey(() => router.push(`/dashboard/missions/${m.id}`))}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper"
                >
                  <td className="px-3 py-2 font-medium text-ink">{m.name}</td>
                  <td className="px-3 py-2">
                    <Chip><Icon size={10} /> {m.businessTypeLabel}</Chip>
                  </td>
                  <td className="px-3 py-2 text-muted">{m.goalSummary}</td>
                  <td className="px-3 py-2"><ProgressBar value={m.progress} /></td>
                  <td className="px-3 py-2">
                    <MissionStatusBadge status={m.status} />
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-muted" title={m.nextCheckpoint ?? ""}>
                    {m.nextCheckpoint ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ChevronRight size={14} className="ml-auto text-subtle" />
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-subtle">
                  {missions.length === 0
                    ? "No missions yet — launch the first one with “New mission”."
                    : "No missions match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
        <span className="font-medium text-ink">Kill switches always on. </span>
        Every mission can be paused instantly; the workspace freeze halts everything. Resume re-verifies
        budgets, data freshness, and goal assumptions before anything continues.
      </div>

      {pickerOpen && <TemplatePicker onClose={() => { setPickerOpen(false); void load(); }} />}
    </div>
  );
}
