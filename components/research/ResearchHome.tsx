"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): Research (/dashboard/research). Three tabs: your
// research sessions, your browsing memory, and the page monitors that start workflows.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toastError } from "@/lib/ui/feedback";
import type { ResearchSummary } from "@/lib/agentweb/research/store";
import type { MemoryItem, MemorySettings } from "@/lib/agentweb/memory/store";
import { MemoryPanel } from "./MemoryPanel";
import { MonitorsPanel, type LinkRow, type MonitorRow, type WorkflowRow } from "./MonitorsPanel";

type Tab = "research" | "memory" | "monitors";

export interface ResearchHomeProps {
  tab: Tab;
  research: ResearchSummary[];
  memory: { settings: MemorySettings; items: MemoryItem[] };
  monitors: { monitors: MonitorRow[]; workflows: WorkflowRow[]; links: LinkRow[] };
  canEdit: boolean;
  focusItem: string | null;
}

export function ResearchHome({ tab: initialTab, research, memory, monitors, canEdit, focusItem }: ResearchHomeProps) {
  const { t, format } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState(false);

  function pick(next: Tab) {
    setTab(next);
    window.history.replaceState(window.history.state, "", next === "research" ? "/dashboard/research" : `/dashboard/research?tab=${next}`);
  }

  async function start() {
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/agentweb/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create", question: q }) });
      const json = (await res.json().catch(() => ({}))) as { research?: { id: string }; error?: string };
      if (!res.ok || !json.research) return toastError(t("researchApp.detail.failed"), json.error);
      router.push(`/dashboard/research/${encodeURIComponent(json.research.id)}`);
    } finally {
      setBusy(false);
    }
  }

  const rows = research.filter((r) => archived || r.status !== "archived");

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("researchApp.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("researchApp.subtitle")}</p>
      </div>
      <Segmented<Tab>
        value={tab}
        onChange={pick}
        label={t("researchApp.title")}
        options={[
          { value: "research", label: t("researchApp.tabs.research") },
          { value: "memory", label: t("researchApp.tabs.memory") },
          { value: "monitors", label: t("researchApp.tabs.monitors") },
        ]}
      />

      {tab === "research" ? (
        <div className="flex flex-col gap-4">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <label className="relative block min-w-[16rem] flex-1">
              <span className="mb-1 block text-sm font-semibold text-ink">{t("researchApp.new.label")}</span>
              <Search className="pointer-events-none absolute bottom-[0.8rem] left-3 size-4 text-muted" aria-hidden />
              <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={2000} placeholder={t("researchApp.new.placeholder")} className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
            </label>
            <button type="submit" disabled={busy || question.trim().length < 3} className={aosButton({ variant: "primary", size: "md" })}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {busy ? t("researchApp.new.starting") : t("researchApp.new.start")}
            </button>
          </form>

          <section aria-labelledby="rs-list" className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="rs-list" className="aos-subheading">{t("researchApp.tabs.research")}</h2>
              {research.some((r) => r.status === "archived") ? (
                <button type="button" onClick={() => setArchived((v) => !v)} aria-pressed={archived} className={aosButton({ variant: "quiet", size: "xs" })}>
                  {t("researchApp.list.showArchived")}
                </button>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
                <p className="text-md font-semibold text-ink">{t("researchApp.list.empty")}</p>
                <p className="max-w-[48ch] text-sm text-muted">{t("researchApp.list.emptyBody")}</p>
              </div>
            ) : (
              <div className="-mx-3 overflow-x-auto sm:-mx-4">
                <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
                  <caption className="sr-only">{t("researchApp.tabs.research")}</caption>
                  <thead>
                    <tr className="border-b border-line text-xs font-semibold text-muted">
                      <th scope="col" className="px-3 py-2 sm:pl-4">{t("researchApp.list.columns.title")}</th>
                      <th scope="col" className="px-3 py-2 text-right">{t("researchApp.list.columns.answers")}</th>
                      <th scope="col" className="px-3 py-2 text-right">{t("researchApp.list.columns.pages")}</th>
                      <th scope="col" className="px-3 py-2">{t("researchApp.list.columns.sharing")}</th>
                      <th scope="col" className="px-3 py-2">{t("researchApp.list.columns.updated")}</th>
                      <th scope="col" className="px-3 py-2 sm:pr-4"><span className="sr-only">{t("researchApp.list.columns.open")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                        <td className="max-w-[28rem] px-3 py-2 sm:pl-4">
                          <Link href={`/dashboard/research/${r.id}`} className="block truncate font-semibold text-ink underline-offset-2 hover:underline">{r.title}</Link>
                          <span className="block truncate text-xs text-muted">{r.question}</span>
                          {!r.owner ? <span className="text-xs text-muted">{t("researchApp.list.byTeammate")}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{r.answers}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{r.pages}</td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap gap-1">
                            <NeutralBadge label={t(`researchApp.list.sharing.${r.shareState === "workspace" ? "workspace" : "private"}` as never)} size="sm" />
                            {r.status === "archived" ? <NeutralBadge label={t("researchApp.list.archived")} size="sm" /> : null}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted">{format.date(r.updatedAt, "date")}</td>
                        <td className="px-3 py-2 text-right sm:pr-4">
                          <Link href={`/dashboard/research/${r.id}`} className={aosButton({ variant: "secondary", size: "xs" })}>{t("researchApp.list.columns.open")}</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === "memory" ? <MemoryPanel initialSettings={memory.settings} initialItems={memory.items} focusItem={focusItem} /> : null}
      {tab === "monitors" ? <MonitorsPanel monitors={monitors.monitors} workflows={monitors.workflows} links={monitors.links} canEdit={canEdit} /> : null}
    </div>
  );
}
