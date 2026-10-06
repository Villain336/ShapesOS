"use client";

// ShapesOS — Phase 18.3 (WS=trust): the data access log — which agent read
// which app's data, and when. scope "me" (Settings → You → Privacy) or
// "workspace" (Privacy and security → Data access log, admins). Reads
// GET /api/trust/data-access; derived from the runs' own tool steps.

import { useId, useState } from "react";
import Link from "next/link";
import { aosButton } from "@/components/aos/button";
import { AgentAvatar } from "@/components/aos/AgentAvatar";
import { LEAD_AGENT } from "@/lib/aos/agents";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import type { DataAccessRow } from "@/lib/privacy/data-access";
import { fieldCls, labelCls, rowCls, tableCls, tableWrapCls, tdCls, thCls } from "./kit";

const AGENT_NAMES: Record<string, string> = { lead: LEAD_AGENT.name };

export function DataAccessTable({ scope, initial, groups }: { scope: "me" | "workspace"; initial: DataAccessRow[]; groups?: string[] }) {
  const { t, format } = useI18n();
  const id = useId();
  const [rows, setRows] = useState(initial);
  const [group, setGroup] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(initial.length < 100);
  const appLabel = (g: string) => t(`trust.apps.groups.${g}.label` as MessageKey);

  async function load(more: boolean, g = group) {
    setLoading(true);
    try {
      const q = new URLSearchParams({ scope });
      if (g) q.set("group", g);
      if (more && rows.length) q.set("before", rows[rows.length - 1]!.at);
      const res = await fetch(`/api/trust/data-access?${q.toString()}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { rows?: DataAccessRow[] };
      const got = body.rows ?? [];
      setRows((prev) => (more ? [...prev, ...got] : got));
      setDone(got.length < 100);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {groups ? (
        <div className="max-w-xs">
          <label className={labelCls} htmlFor={`${id}-app`}>
            {t("trust.dataAccess.filterApp")}
            <select
              id={`${id}-app`}
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                void load(false, e.target.value);
              }}
              className={fieldCls}
            >
              <option value="">{t("trust.dataAccess.allApps")}</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {appLabel(g)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div className={tableWrapCls}>
        <table className={tableCls} data-testid={`data-access-${scope}`}>
          <caption className="sr-only">{t("trust.dataAccess.title")}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={thCls}>{t("trust.dataAccess.columns.when")}</th>
              <th scope="col" className={thCls}>{t("trust.dataAccess.columns.agent")}</th>
              <th scope="col" className={thCls}>{t("trust.dataAccess.columns.app")}</th>
              <th scope="col" className={thCls}>{t("trust.dataAccess.columns.what")}</th>
              <th scope="col" className={thCls}>{t("trust.dataAccess.columns.run")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = AGENT_NAMES[r.agent] ?? r.agent.replace(/^agent:/, "").replace(/[_-]+/g, " ");
              return (
                <tr key={r.key} className={rowCls} data-app={r.group}>
                  <td className={`${tdCls} whitespace-nowrap text-muted`}>{format.date(r.at, "dateTime")}</td>
                  <td className={tdCls}>
                    <span className="inline-flex items-center gap-2 font-medium text-ink">
                      <AgentAvatar name={name} size="sm" />
                      {name[0]!.toUpperCase() + name.slice(1)}
                    </span>
                  </td>
                  <td className={`${tdCls} font-medium text-ink`}>{appLabel(r.group)}</td>
                  <td className={`${tdCls} font-mono text-xs text-muted`}>{r.what}</td>
                  <td className={tdCls}>
                    {r.runId ? (
                      <Link href={`/dashboard/runs/${encodeURIComponent(r.runId)}`} className="text-sm font-semibold text-ink underline-offset-2 hover:underline">
                        {t("trust.dataAccess.openRun")}
                      </Link>
                    ) : (
                      <span className="text-sm text-muted">{t("trust.dataAccess.system")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                  {scope === "me" ? t("trust.privacy.reads.empty") : t("trust.dataAccess.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {!done ? (
        <div>
          <button type="button" disabled={loading} onClick={() => void load(true)} className={aosButton({ variant: "secondary", size: "sm" })}>
            {loading ? t("common.loading") : t("trust.memory.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
