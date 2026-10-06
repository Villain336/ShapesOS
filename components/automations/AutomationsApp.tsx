"use client";

// ShapesOS — Phase 18.3 (WS=flow): the Automations app (the Shortcuts /
// Power Automate analogue) — ONE list over the automation systems that
// already exist, one trigger catalogue, one action catalogue, and "Describe
// it". No 8th engine: on/off and Run now call each system's OWN route (the
// item carries method + url + body, lib/automations/list.ts), so its checks,
// kill switch and audit apply; Create sends a reviewed draft to the
// scheduler / canvas routes. Status colour + shape only on agent runs
// (scheduled skills); other systems' runs show neutral text.

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, CalendarClock, Play, Search, Sparkles, Workflow, X } from "lucide-react";
import type { WorkspaceRole } from "@prisma/client";
import { aosButton, FilterPill, NeutralBadge, StatusBadge, Switch } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import { AUTOMATION_KINDS, canUse, filterAutomations, workflowGraphBody, type AutomationItem, type AutomationKind, type RouteCall, type RunState } from "@/lib/automations/model";
import type { ActionEntry, TriggerEntry } from "@/lib/automations/catalog";
import type { AutomationDraft, DraftResult } from "@/lib/automations/describe";
import type { AosStatus } from "@/lib/aos/status";
import type { MessageKey } from "@/lib/i18n";

export interface AutomationsAppProps {
  workspaceId: string;
  role: WorkspaceRole;
  initial: { items: AutomationItem[]; unavailable: Array<{ kind: AutomationKind; reason: string }> };
  triggers: TriggerEntry[];
  actions: ActionEntry[];
  skills: Array<{ id: string; name: string }>;
  initialItem: string | null;
}

const AGENT_STATUS: Record<RunState, AosStatus> = { queued: "queued", running: "running", needs_you: "needs", done: "done", failed: "failed", cancelled: "paused", paused: "paused" };

async function callRoute(call: RouteCall): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(call.url, { method: call.method, headers: { "content-type": "application/json" }, body: JSON.stringify(call.body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === "string" ? data.error : `HTTP ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "network" };
  }
}

export function AutomationsApp({ workspaceId, role, initial, triggers, actions, skills, initialItem }: AutomationsAppProps) {
  const { t, format } = useI18n();
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<"list" | "triggers" | "actions">("list");
  const [kind, setKind] = useState<AutomationKind | "all">("all");
  const [state, setState] = useState<"all" | "on" | "off">("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const editor = canUse(role, "editor");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/automations", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setData((await res.json()) as typeof initial);
  }, []);

  const rows = useMemo(() => filterAutomations(data.items, { kind, state, q }), [data.items, kind, state, q]);
  const counts = useMemo(() => {
    const base = filterAutomations(data.items, { state, q });
    const c: Record<string, number> = { all: base.length };
    for (const k of AUTOMATION_KINDS) c[k] = base.filter((i) => i.kind === k).length;
    return c;
  }, [data.items, state, q]);

  async function toggle(item: AutomationItem, on: boolean) {
    if (!item.toggle) return;
    setBusy(item.id);
    const r = await callRoute(on ? item.toggle.on : item.toggle.off);
    setBusy(null);
    if (!r.ok) {
      toastError(t("flow.automations.toggleFailed", { name: item.name }), r.error);
      return;
    }
    toast({ title: t(on ? "flow.automations.turnedOn" : "flow.automations.turnedOff", { name: item.name }), status: "done" });
    await refresh();
  }

  async function runNow(item: AutomationItem) {
    if (!item.run) return;
    setBusy(item.id);
    const r = await callRoute(item.run);
    setBusy(null);
    if (!r.ok) {
      toastError(t("flow.automations.runFailed", { name: item.name }), r.error);
      return;
    }
    toast({ title: t("flow.automations.started", { name: item.name }), status: "running" });
    await refresh();
  }

  function lastRun(item: AutomationItem) {
    if (!item.lastRun) return <span className="text-muted">{t("flow.automations.never")}</span>;
    const label = t(`flow.automations.runStates.${item.lastRun.state}` as MessageKey);
    return (
      <span className="flex flex-col items-start gap-1">
        {item.lastRun.agentRun ? <StatusBadge size="sm" status={AGENT_STATUS[item.lastRun.state]} label={label} /> : <span className="text-ink">{label}</span>}
        <span suppressHydrationWarning className="text-xs text-muted">
          {format.relative(item.lastRun.at)}
        </span>
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("flow.automations.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("flow.automations.subtitle")}</p>
      </div>

      {editor ? <DescribeIt workspaceId={workspaceId} skills={skills} actions={actions} onCreated={refresh} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<"list" | "triggers" | "actions">
          value={tab}
          onChange={setTab}
          label={t("flow.automations.tabsLabel")}
          options={[
            { value: "list", label: t("flow.automations.tabs.list") },
            { value: "triggers", label: t("flow.automations.tabs.triggers") },
            { value: "actions", label: t("flow.automations.tabs.actions") },
          ]}
        />
      </div>

      {tab === "list" ? (
        <section aria-label={t("flow.automations.listLabel")} className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative block min-w-[12rem] flex-1">
              <span className="sr-only">{t("flow.automations.searchLabel")}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("flow.automations.searchPlaceholder")}
                className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
              />
            </label>
            <Segmented<"all" | "on" | "off">
              value={state}
              onChange={setState}
              label={t("flow.automations.stateLabel")}
              options={[
                { value: "all", label: t("flow.automations.states.all") },
                { value: "on", label: t("flow.automations.states.on") },
                { value: "off", label: t("flow.automations.states.off") },
              ]}
            />
          </div>
          <div role="group" aria-label={t("flow.automations.kindFilter")} className="flex flex-wrap gap-1.5">
            {(["all", ...AUTOMATION_KINDS] as const).map((k) =>
              k === "all" || counts[k] ? (
                <FilterPill key={k} selected={kind === k} onClick={() => setKind(k)} count={counts[k] ?? 0}>
                  {t(`flow.automations.kinds.${k}` as MessageKey)}
                </FilterPill>
              ) : null,
            )}
          </div>
          {data.unavailable.map((u) => (
            <p key={u.kind} className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
              {t("flow.automations.unavailable", { kind: t(`flow.automations.kinds.${u.kind}` as MessageKey), reason: u.reason })}
            </p>
          ))}
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-14 text-center">
              <Workflow className="size-6 text-subtle" aria-hidden />
              <p className="text-md font-semibold text-ink">{t("flow.automations.empty")}</p>
              <p className="text-sm text-muted">{t("flow.automations.emptyBody")}</p>
            </div>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
                <caption className="sr-only">{t("flow.automations.listLabel")}</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th scope="col" className="px-2 py-2 font-semibold">{t("flow.automations.cols.name")}</th>
                    <th scope="col" className="px-2 py-2 font-semibold">{t("flow.automations.cols.kind")}</th>
                    <th scope="col" className="px-2 py-2 font-semibold">{t("flow.automations.cols.lastRun")}</th>
                    <th scope="col" className="px-2 py-2 font-semibold">{t("flow.automations.cols.nextRun")}</th>
                    <th scope="col" className="px-2 py-2 font-semibold">{t("flow.automations.cols.on")}</th>
                    <th scope="col" className="px-2 py-2 text-right font-semibold">{t("flow.automations.cols.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id} id={`automation-${i.id.replace(/[^A-Za-z0-9_-]/g, "-")}`} className={`border-b border-line align-top last:border-b-0 hover:bg-hover-paper ${initialItem === i.id ? "bg-hover-paper" : ""}`}>
                      <td className="max-w-[22rem] px-2 py-2.5">
                        <Link href={i.href} className="block truncate font-semibold text-ink underline-offset-2 hover:underline">
                          {i.name}
                        </Link>
                        <span className="block truncate text-xs text-muted">
                          {i.trigger}
                          {i.project ? ` · ${i.project.name}` : ""}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-muted">{t(`flow.automations.kinds.${i.kind}` as MessageKey)}</td>
                      <td className="px-2 py-2.5">{lastRun(i)}</td>
                      <td suppressHydrationWarning className="px-2 py-2.5 whitespace-nowrap text-muted">
                        {i.nextRunAt ? format.date(i.nextRunAt, "dateTime") : "—"}
                      </td>
                      <td className="px-2 py-2.5">
                        {i.toggle && i.enabled !== null ? (
                          <Switch
                            checked={i.enabled}
                            disabled={!canUse(role, i.toggle.minRole) || busy === i.id}
                            onChange={(v) => void toggle(i, v)}
                            label={t("flow.automations.toggleLabel", { name: i.name })}
                          />
                        ) : (
                          <span className="text-xs text-muted">{i.readOnly ? t("flow.automations.readOnly") : "—"}</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {i.run && canUse(role, i.run.minRole) ? (
                          <button type="button" disabled={busy === i.id} onClick={() => void runNow(i)} className={aosButton({ variant: "secondary", size: "xs" })} aria-label={t("flow.automations.runNowLabel", { name: i.name })}>
                            <Play className="size-3.5" aria-hidden />
                            {t("flow.automations.runNow")}
                          </button>
                        ) : i.note ? (
                          <span className="block max-w-[16rem] text-left text-xs text-muted sm:ml-auto">{i.note}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : tab === "triggers" ? (
        <CatalogTable
          label={t("flow.automations.tabs.triggers")}
          head={[t("flow.automations.cols.trigger"), t("flow.automations.cols.source"), t("flow.automations.cols.engines")]}
          rows={triggers.map((tr) => ({
            key: tr.id,
            cells: [
              <span key="n" className="flex flex-col">
                <span className="font-semibold text-ink">{tr.label}</span>
                <span className="text-xs text-muted">{tr.description}</span>
              </span>,
              <span key="s" className="whitespace-nowrap text-muted">{t(`flow.automations.sources.${tr.source}` as MessageKey)}</span>,
              <span key="e" className="text-muted">{tr.engines.map((e) => t(`flow.automations.engines.${e}` as MessageKey)).join(", ")}</span>,
            ],
          }))}
        />
      ) : (
        <CatalogTable
          label={t("flow.automations.tabs.actions")}
          head={[t("flow.automations.cols.action"), t("flow.automations.cols.tier"), t("flow.automations.cols.engine")]}
          rows={actions.map((a) => ({
            key: a.name,
            cells: [
              <span key="n" className="flex flex-col">
                <span className="font-mono text-xs text-ink">{a.name}</span>
                <span className="line-clamp-2 text-xs text-muted">{a.description}</span>
              </span>,
              <span key="t" className="flex flex-col items-start gap-1">
                {a.tier === null ? <span className="text-xs text-muted">{t("flow.automations.canvasGate")}</span> : <NeutralBadge size="sm" label={t("flow.automations.tier", { tier: a.tier })} />}
                {a.alwaysAsks ? <span className="text-xs font-semibold text-ink">{t("flow.automations.alwaysAsks")}</span> : null}
              </span>,
              <span key="e" className="whitespace-nowrap text-muted">{t(`flow.automations.actionEngines.${a.engine}` as MessageKey)}</span>,
            ],
          }))}
        />
      )}
    </div>
  );
}

function CatalogTable({ label, head, rows }: { label: string; head: string[]; rows: Array<{ key: string; cells: React.ReactNode[] }> }) {
  return (
    <section aria-label={label} className="rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              {head.map((h) => (
                <th key={h} scope="col" className="px-2 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                {r.cells.map((c, i) => (
                  <td key={i} className="px-2 py-2">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DescribeIt({ workspaceId, skills, actions, onCreated }: { workspaceId: string; skills: Array<{ id: string; name: string }>; actions: ActionEntry[]; onCreated: () => Promise<void> }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"drafting" | "creating" | null>(null);
  const [result, setResult] = useState<DraftResult | null>(null);

  async function draft() {
    if (!text.trim()) return;
    setBusy("drafting");
    setResult(null);
    const res = await fetch("/api/automations/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    setBusy(null);
    const j = (await res?.json().catch(() => null)) as (DraftResult & { error?: string }) | null;
    if (!res?.ok || !j) {
      toastError(t("flow.automations.describe.failed"), j?.error);
      return;
    }
    setResult(j);
  }

  async function create(d: AutomationDraft) {
    setBusy("creating");
    try {
      if (d.format === "schedule") {
        const r = await callRoute({ method: "POST", url: "/api/schedules", body: { workspaceId, ...d.schedule } });
        if (!r.ok) throw new Error(r.error);
      } else {
        const created = await callRoute({ method: "POST", url: "/api/workflows", body: { projectId: d.workflow.projectId, name: d.name, description: d.why.slice(0, 500) } });
        if (!created.ok) throw new Error(created.error);
        const id = String((created.data?.workflow as { id?: string } | undefined)?.id ?? "");
        const graph = await fetch(`/api/workflows/${encodeURIComponent(id)}/nodes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(workflowGraphBody(d.workflow)) });
        if (!graph.ok) throw new Error(((await graph.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${graph.status}`);
        if (d.workflow.schedule) {
          const s = await callRoute({ method: "PATCH", url: `/api/workflows/${encodeURIComponent(id)}`, body: { schedule: d.workflow.schedule, timezone: d.workflow.timezone } });
          if (!s.ok) throw new Error(s.error);
        }
      }
      toast({ title: t(d.format === "schedule" ? "flow.automations.describe.createdSchedule" : "flow.automations.describe.createdWorkflow", { name: d.name }), status: "done" });
      setResult(null);
      setText("");
      await onCreated();
    } catch (err) {
      toastError(t("flow.automations.describe.createFailed"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const d = result?.draft ?? null;
  const tierOf = (tool: string) => actions.find((a) => a.name === tool)?.tier ?? null;
  return (
    <section aria-labelledby="describe-title" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-muted" aria-hidden />
        <h2 id="describe-title" className="aos-subheading">
          {t("flow.automations.describe.title")}
        </h2>
      </div>
      <p className="text-sm text-muted">{t("flow.automations.describe.body")}</p>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          void draft();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("flow.automations.describe.label")}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={t("flow.automations.describe.placeholder")}
            className="w-full resize-y rounded-md border-[1.5px] border-control bg-paper px-3 py-2.5 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
          />
        </label>
        <button type="submit" disabled={!text.trim() || busy !== null} className={aosButton({ size: "sm" })}>
          {busy === "drafting" ? t("flow.automations.describe.drafting") : t("flow.automations.describe.draft")}
        </button>
      </form>
      {result && !d ? (
        <div role="alert" className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
          <p className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="size-2 shrink-0 bg-failed" />
            {t("flow.automations.describe.problems")}
          </p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {result.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {d ? (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            {d.format === "schedule" ? <CalendarClock className="size-4 text-muted" aria-hidden /> : <Workflow className="size-4 text-muted" aria-hidden />}
            <span className="font-semibold text-ink">{d.name}</span>
            <NeutralBadge size="sm" label={t(d.format === "schedule" ? "flow.automations.describe.formatSchedule" : "flow.automations.describe.formatWorkflow")} />
            {result?.mock ? <NeutralBadge size="sm" label={t("flow.automations.describe.mock")} /> : null}
          </div>
          {d.why ? <p className="text-sm text-ink">{d.why}</p> : null}
          {d.format === "schedule" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">{t("flow.automations.describe.skill")}</dt>
              <dd className="text-ink">{skills.find((s) => s.id === d.schedule.skillId)?.name ?? d.schedule.skillId}</dd>
              <dt className="text-muted">{t("flow.automations.describe.when")}</dt>
              <dd className="font-mono text-xs text-ink">{d.schedule.triggerType === "cron" ? `${d.schedule.cronExpr} (${d.schedule.timezone})` : d.schedule.eventSource}</dd>
              <dt className="text-muted">{t("flow.automations.describe.review")}</dt>
              <dd className="text-ink">{t("flow.automations.describe.supervised")}</dd>
            </dl>
          ) : (
            <ol className="flex flex-col gap-1.5 text-sm">
              {d.workflow.nodes.map((n, idx) => {
                const tool = n.type === "run_agent_tool" ? String(n.config.tool ?? "") : null;
                const tier = tool ? tierOf(tool) : null;
                return (
                  <li key={n.key} className="flex flex-wrap items-center gap-2">
                    <span className="w-5 text-right text-xs text-muted tabular-nums">{idx + 1}.</span>
                    {tool ? <Bot className="size-3.5 text-muted" aria-hidden /> : null}
                    <span className="text-ink">{n.label}</span>
                    <span className="font-mono text-xs text-muted">{tool ?? `${n.kind}/${n.type}`}</span>
                    {tier !== null ? <NeutralBadge size="sm" label={t("flow.automations.tier", { tier })} /> : null}
                  </li>
                );
              })}
              <li className="text-xs text-muted">{t("flow.automations.describe.startsOff")}</li>
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void create(d)} className={aosButton({ size: "sm" })}>
              {busy === "creating" ? t("flow.automations.describe.creating") : t("flow.automations.describe.create")}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => setResult(null)} className={aosButton({ variant: "quiet", size: "sm" })}>
              <X className="size-4" aria-hidden />
              {t("flow.automations.describe.discard")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default AutomationsApp;
