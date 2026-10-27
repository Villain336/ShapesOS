// Marketr — Growth Missions list + template picker (Phase 9, M4; Agentic OS 4d).
//
// Each mission is a kit agent card (agent-blocks.png) titled by the
// mission: the status band shows its CURRENT agent state (running, needs
// you, failed, done, queued, paused — never identity), the line says what
// the lead and its sub-agents are doing, and the one action goes where the
// state points (Review / Open run / Open mission). States come from GET
// /api/missions → lib/aos/agents deriveMission, the same derivation the
// Overview and sidebar use. Archived missions have no agent state and sit
// in a neutral list.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { closeOnEscape } from "@/lib/ui/keyboard";
import { AgentCard, FilterPill, aosButton } from "@/components/aos";
import { SUB_AGENTS, type MissionView } from "@/lib/aos/agents";
import { stepCounter } from "@/lib/aos/run-steps";
import { byStatusThenRecent, type AosStatus } from "@/lib/aos/status";

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

// Template metadata (type, goal counts) is category information, not agent
// state — always a neutral chip.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

// Launch = Run (running fill, per the action table).
const btnRun = aosButton({ variant: "run", size: "sm" });

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
  /** Agent state (null = archived: no agent state). */
  agent: MissionView | null;
}

// ── Template picker (modal) ──────────────────────────────────────────────────

function TemplatePicker({ onClose, hiddenTemplateIds = [] }: { onClose: () => void; hiddenTemplateIds?: string[] }) {
  const router = useRouter();
  // Phase 18.2 (WS=content): templates the workspace removed in the Store are not offered.
  const grouped = useMemo(() => {
    const all = templatesByBusinessType();
    if (hiddenTemplateIds.length === 0) return all;
    const hidden = new Set(hiddenTemplateIds);
    return Object.fromEntries(Object.entries(all).map(([k, list]) => [k, list.filter((t) => !hidden.has(t.id))])) as typeof all;
  }, [hiddenTemplateIds]);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
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

type StatusFilter = AosStatus | "archived" | "all";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string; shape?: AosStatus }> = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you", shape: "needs" },
  { value: "running", label: "Running", shape: "running" },
  { value: "failed", label: "Failed", shape: "failed" },
  { value: "queued", label: "Queued", shape: "queued" },
  { value: "paused", label: "Paused", shape: "paused" },
  { value: "done", label: "Done", shape: "done" },
  { value: "archived", label: "Archived" },
];

/** The tools of the sub-agents the lead delegated to (card chips). */
function missionTools(v: MissionView): string[] {
  const seen = new Set<string>();
  for (const b of v.branches) {
    const key = b.key as keyof typeof SUB_AGENTS;
    for (const t of SUB_AGENTS[key]?.tools ?? []) seen.add(t);
  }
  return [...seen].slice(0, 3);
}

function cardAction(m: MissionListItem, v: MissionView) {
  if (m.status === "planned") return { label: "Review plan", href: `/dashboard/missions/${m.id}#plan` };
  if (v.status === "needs") return { label: "Review", href: `/dashboard/missions/${m.id}#approvals` };
  if (v.status === "failed" && v.runId) return { label: "Open run", href: `/dashboard/runs/${v.runId}` };
  return { label: "Open mission", href: `/dashboard/missions/${m.id}` };
}

function cardMeta(m: MissionListItem, v: MissionView): string {
  if (v.status === "done") return "Finished";
  if (v.progress) return stepCounter(v.progress.done, v.progress.total);
  return m.nextCheckpoint ? `Next: ${m.nextCheckpoint}` : `${Math.round(m.progress * 100)}% of plan`;
}

export function MissionsApp({ hiddenTemplateIds = [] }: { hiddenTemplateIds?: string[] } = {}) {
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [fType, setFType] = useState("");
  const [fStatus, setFStatus] = useState<StatusFilter>("all");
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

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: missions.length };
    for (const m of missions) {
      const k = m.agent?.status ?? "archived";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [missions]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return missions.filter((m) => {
      if (fType && m.businessType !== fType) return false;
      if (fStatus !== "all" && (m.agent?.status ?? "archived") !== fStatus) return false;
      if (needle && !(m.name.toLowerCase().includes(needle) || m.goalSummary.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [missions, fType, fStatus, q]);

  const live = useMemo(
    () =>
      filtered
        .filter((m): m is MissionListItem & { agent: MissionView } => !!m.agent)
        .sort((a, b) => byStatusThenRecent(a.agent, b.agent)),
    [filtered],
  );
  const archived = useMemo(() => filtered.filter((m) => !m.agent), [filtered]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by state">
          {STATUS_FILTERS.filter((f) => f.value === "all" || (counts[f.value] ?? 0) > 0 || f.value === fStatus).map((f) => (
            <FilterPill key={f.value} selected={fStatus === f.value} status={f.shape} count={counts[f.value] ?? 0} onClick={() => setFStatus(f.value)}>
              {f.label}
            </FilterPill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={fType} onChange={(e) => setFType(e.target.value)} className={inputCls} aria-label="Filter by business type">
            <option value="">All business types</option>
            {BUSINESS_TYPES.map((id) => (
              <option key={id} value={id}>{BUSINESS_TYPE_LABELS[id]}</option>
            ))}
          </select>
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search missions" aria-label="Search missions" className={`${inputCls} w-full pl-9`} />
          </div>
          <button onClick={() => setPickerOpen(true)} className={aosButton({ variant: "primary", size: "sm", className: "ml-auto" })}>
            <Plus size={15} aria-hidden /> New mission
          </button>
        </div>
      </div>

      {loading && missions.length === 0 ? (
        <p className="flex items-center gap-2 text-md text-muted">
          <Loader2 size={16} className="aos-spin" aria-hidden /> Loading missions…
        </p>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
          <Target size={28} className="text-subtle" aria-hidden />
          <h2 className="aos-subheading">{missions.length === 0 ? "Hand the lead agent a goal" : "No missions match these filters"}</h2>
          <p className="max-w-[46ch] text-md text-muted">
            {missions.length === 0
              ? "Pick a template, set the target and launch. Strategist plans it and hands each step to a sub-agent; nothing goes out without your approval."
              : "Clear the search or pick another state to see the rest."}
          </p>
          {missions.length === 0 ? (
            <button onClick={() => setPickerOpen(true)} className={aosButton({ variant: "primary", size: "sm" })}>
              <Plus size={15} aria-hidden /> New mission
            </button>
          ) : null}
        </div>
      ) : null}

      {live.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {live.map((m) => {
            const v = m.agent;
            const team = v.branches.map((b) => b.name);
            return (
              <AgentCard
                key={m.id}
                status={v.status}
                title={m.name}
                eyebrow={team.length ? `Strategist → ${team.join(", ")}` : "Strategist · Lead"}
                description={v.line}
                tools={missionTools(v)}
                meta={cardMeta(m, v)}
                action={cardAction(m, v)}
              >
                <p className="mt-3 flex min-w-0 items-center gap-1.5 text-sm text-muted">
                  <Target size={13} className="shrink-0" aria-hidden />
                  <span className="truncate">
                    {m.businessTypeLabel} · {m.goalSummary}
                  </span>
                </p>
              </AgentCard>
            );
          })}
        </div>
      ) : null}

      {archived.length > 0 ? (
        <section aria-labelledby="archived-h" className="flex flex-col gap-2">
          <h2 id="archived-h" className="aos-subheading">
            Archived
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-lg bg-paper shadow-hairline">
            {archived.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/dashboard/missions/${m.id}`}
                  className="flex min-h-12 items-center gap-3 px-4 py-2.5 transition-[background-color] duration-150 hover:bg-hover-paper"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-ink">{m.name}</span>
                    <span className="block truncate text-sm text-muted">
                      {m.businessTypeLabel} · {m.goalSummary}
                    </span>
                  </span>
                  <span className="inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">Archived</span>
                  <ChevronRight size={16} className="text-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-sm text-muted">
        <span className="font-semibold text-ink">Kill switches are always on. </span>
        Every mission can be paused instantly; the workspace freeze halts everything. Resume re-verifies budgets, data
        freshness and goal assumptions before anything continues.
      </p>

      {pickerOpen && <TemplatePicker hiddenTemplateIds={hiddenTemplateIds} onClose={() => { setPickerOpen(false); void load(); }} />}
    </div>
  );
}
