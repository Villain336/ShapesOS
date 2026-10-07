"use client";

// ShapesOS — Phase 18.3 (WS=flow): Time Machine (/dashboard/time-machine).
//   Snapshots (admins): schedule (off / daily / weekly) and how many to keep,
//     take one now, download, restore into a NEW workspace (never over this
//     one) with an honest report of what came back, delete.
//   Version history: notes, docs and files with earlier versions; each opens
//     the one Versions panel (18.2's restore paths).
//   Undo an agent run: lives on the run's page (and the Activity Monitor).
// Snapshot states are neutral text: they are not agent states.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Archive, Download, FileText, History, NotebookPen, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { SnapshotSettings, SnapshotView } from "@/lib/timemachine/snapshots";
import type { RestoreReport } from "@/lib/timemachine/restore";
import type { VersionedItem } from "@/lib/timemachine/versions";
import type { MessageKey } from "@/lib/i18n";
import { VersionsPanel } from "./VersionsPanel";

export interface TimeMachineAppProps {
  workspaceId: string;
  isAdmin: boolean;
  canEdit: boolean;
  initial: { settings: SnapshotSettings; snapshots: SnapshotView[] } | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function TimeMachineApp({ workspaceId, isAdmin, canEdit, initial }: TimeMachineAppProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("flow.timeMachine.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("flow.timeMachine.subtitle")}</p>
      </div>
      {isAdmin && initial ? <Snapshots initial={initial} /> : <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">{t("flow.timeMachine.adminsOnly")}</p>}
      <Versions workspaceId={workspaceId} canEdit={canEdit} />
      <section aria-labelledby="tm-undo" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
        <div className="flex items-center gap-2">
          <Undo2 className="size-4 text-muted" aria-hidden />
          <h2 id="tm-undo" className="aos-subheading">
            {t("flow.timeMachine.undoTitle")}
          </h2>
        </div>
        <p className="text-sm text-muted">{t("flow.timeMachine.undoBody")}</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/runs" className={aosButton({ variant: "secondary", size: "sm" })}>
            {t("flow.timeMachine.openRuns")}
          </Link>
          <Link href="/dashboard/activity" className={aosButton({ variant: "quiet", size: "sm" })}>
            {t("flow.timeMachine.openActivity")}
          </Link>
        </div>
      </section>
    </div>
  );
}

function Snapshots({ initial }: { initial: { settings: SnapshotSettings; snapshots: SnapshotView[] } }) {
  const { t, format } = useI18n();
  const [settings, setSettings] = useState(initial.settings);
  const [keep, setKeep] = useState(String(initial.settings.retention));
  const [snaps, setSnaps] = useState(initial.snapshots);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/timemachine/snapshots", { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      const j = (await res.json()) as { settings: SnapshotSettings; snapshots: SnapshotView[] };
      setSnaps(j.snapshots);
      setSettings(j.settings);
    }
  }, []);

  async function save(next: Partial<{ schedule: string; retention: number }>) {
    setBusy("settings");
    const res = await fetch("/api/timemachine/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    setBusy(null);
    const j = (await res?.json().catch(() => null)) as { settings?: SnapshotSettings; error?: string } | null;
    if (!res?.ok || !j?.settings) {
      toastError(t("flow.timeMachine.saveFailed"), j?.error);
      return;
    }
    setSettings(j.settings);
    setKeep(String(j.settings.retention));
    toast({ title: t("flow.timeMachine.saved"), status: "done" });
    await refresh();
  }

  async function take() {
    setBusy("take");
    const res = await fetch("/api/timemachine/snapshots", { method: "POST" }).catch(() => null);
    setBusy(null);
    const j = (await res?.json().catch(() => null)) as { snapshot?: SnapshotView; error?: string } | null;
    if (!res?.ok) {
      toastError(t("flow.timeMachine.takeFailed"), j?.error);
      await refresh();
      return;
    }
    toast({ title: t("flow.timeMachine.taken"), status: "done" });
    await refresh();
  }

  async function restore(s: SnapshotView) {
    const ok = await confirmAction({
      title: t("flow.timeMachine.restoreTitle"),
      description: t("flow.timeMachine.restoreBody", { when: format.date(s.createdAt, "dateTime") }),
      confirmLabel: t("flow.timeMachine.restore"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy(s.id);
    const res = await fetch(`/api/timemachine/snapshots/${encodeURIComponent(s.id)}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) }).catch(() => null);
    setBusy(null);
    const j = (await res?.json().catch(() => null)) as { report?: RestoreReport; error?: string } | null;
    if (!res?.ok || !j?.report) {
      toastError(t("flow.timeMachine.restoreFailed"), j?.error);
      return;
    }
    setReport(j.report);
    toast({ title: t("flow.timeMachine.restored", { name: j.report.workspaceName }), status: "done" });
    await refresh();
  }

  async function remove(s: SnapshotView) {
    const ok = await confirmAction({ title: t("flow.timeMachine.deleteTitle"), confirmLabel: t("flow.timeMachine.delete"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    setBusy(s.id);
    const res = await fetch(`/api/timemachine/snapshots/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      toastError(t("flow.timeMachine.deleteFailed"));
      return;
    }
    await refresh();
  }

  async function openWorkspace(id: string) {
    const res = await fetch("/api/workspaces/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) }).catch(() => null);
    if (res?.ok) window.location.assign("/dashboard");
    else toastError(t("flow.timeMachine.switchFailed"));
  }

  return (
    <section aria-labelledby="tm-snapshots" className="flex flex-col gap-4 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex flex-wrap items-center gap-2">
        <Archive className="size-4 text-muted" aria-hidden />
        <h2 id="tm-snapshots" className="aos-subheading min-w-0 flex-1">
          {t("flow.timeMachine.snapshotsTitle")}
        </h2>
        <button type="button" onClick={() => void take()} disabled={busy !== null} className={aosButton({ size: "sm" })}>
          <Plus className="size-4" aria-hidden />
          {busy === "take" ? t("flow.timeMachine.taking") : t("flow.timeMachine.take")}
        </button>
      </div>
      <p className="text-sm text-muted">{t("flow.timeMachine.snapshotsBody")}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <span id="tm-schedule" className="text-sm font-semibold text-ink">
            {t("flow.timeMachine.schedule")}
          </span>
          <Segmented<string>
            value={settings.schedule}
            labelledBy="tm-schedule"
            disabled={busy !== null}
            onChange={(v) => void save({ schedule: v })}
            options={[
              { value: "off", label: t("flow.timeMachine.schedules.off") },
              { value: "daily", label: t("flow.timeMachine.schedules.daily") },
              { value: "weekly", label: t("flow.timeMachine.schedules.weekly") },
            ]}
          />
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ retention: Number(keep) });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
            {t("flow.timeMachine.keep")}
            <input
              type="number"
              min={1}
              max={60}
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              className="h-control w-24 rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
            />
          </label>
          <button type="submit" disabled={busy !== null || keep === String(settings.retention)} className={aosButton({ variant: "secondary", size: "md" })}>
            {t("common.save")}
          </button>
        </form>
      </div>
      {report ? <RestoreReportView report={report} onOpen={() => void openWorkspace(report.workspaceId)} onClose={() => setReport(null)} /> : null}
      {snaps.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("flow.timeMachine.none")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("flow.timeMachine.snapshotsTitle")}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-semibold">{t("flow.timeMachine.cols.taken")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("flow.timeMachine.cols.contents")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("flow.timeMachine.cols.state")}</th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">{t("flow.timeMachine.cols.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                  <td className="px-2 py-2.5">
                    <span suppressHydrationWarning className="block font-semibold text-ink">
                      {format.date(s.createdAt, "dateTime")}
                    </span>
                    <span className="block text-xs text-muted">{t(`flow.timeMachine.triggers.${s.trigger}` as MessageKey)}</span>
                  </td>
                  <td className="px-2 py-2.5 text-muted">
                    {s.status === "ready" ? t("flow.timeMachine.contents", { rows: s.rowCount, tables: s.tableCount, size: fmtBytes(s.sizeBytes) }) : s.error ?? "—"}
                    {s.lastRestore ? <span className="block text-xs">{t("flow.timeMachine.lastRestore", { name: s.lastRestore.workspaceName })}</span> : null}
                  </td>
                  <td className="px-2 py-2.5">
                    <NeutralBadge size="sm" label={t(`flow.timeMachine.states.${s.status}` as MessageKey)} />
                  </td>
                  <td className="px-2 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {s.status === "ready" ? (
                        <>
                          <a href={`/api/timemachine/snapshots/${encodeURIComponent(s.id)}/download`} className={aosButton({ variant: "quiet", size: "xs" })}>
                            <Download className="size-3.5" aria-hidden />
                            {t("flow.timeMachine.download")}
                          </a>
                          <button type="button" disabled={busy !== null} onClick={() => void restore(s)} className={aosButton({ variant: "secondary", size: "xs" })}>
                            <RotateCcw className="size-3.5" aria-hidden />
                            {busy === s.id ? t("flow.timeMachine.restoring") : t("flow.timeMachine.restore")}
                          </button>
                        </>
                      ) : null}
                      <button type="button" disabled={busy !== null} onClick={() => void remove(s)} className={aosButton({ variant: "deny", size: "xs" })} aria-label={t("flow.timeMachine.deleteLabel", { when: s.createdAt.slice(0, 16) })}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RestoreReportView({ report, onOpen, onClose }: { report: RestoreReport; onOpen: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const restored = report.tables.reduce((a, x) => a + x.restored, 0);
  const partial = report.tables.filter((x) => x.notRestored > 0);
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="font-semibold text-ink">{t("flow.timeMachine.report.title", { name: report.workspaceName })}</p>
      <ul className="list-disc pl-5 text-sm text-ink">
        <li>{t("flow.timeMachine.report.restored", { rows: restored, tables: report.tables.length })}</li>
        <li>{t("flow.timeMachine.report.files", { copied: report.files.copied, missing: report.files.missing })}</li>
        <li>{t("flow.timeMachine.report.paused", { count: report.automationsPaused })}</li>
        {report.inFlightStopped ? <li>{t("flow.timeMachine.report.inFlight", { count: report.inFlightStopped })}</li> : null}
        {report.skipped.map((s) => (
          <li key={s.table} className="text-muted">
            {t("flow.timeMachine.report.skipped", { table: s.table, rows: s.rows, reason: t(`flow.timeMachine.reasons.${s.reason}` as MessageKey) })}
          </li>
        ))}
        {partial.map((p) => (
          <li key={p.table} className="text-muted">
            {t("flow.timeMachine.report.partial", { table: p.table, count: p.notRestored, reason: p.reason ?? "" })}
          </li>
        ))}
        {report.linksNotRestored ? <li className="text-muted">{t("flow.timeMachine.report.links", { count: report.linksNotRestored })}</li> : null}
        <li className="text-muted">{t("flow.timeMachine.report.never")}</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onOpen} className={aosButton({ size: "sm" })}>
          {t("flow.timeMachine.report.open")}
        </button>
        <button type="button" onClick={onClose} className={aosButton({ variant: "quiet", size: "sm" })}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

function Versions({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const { t, format } = useI18n();
  const [items, setItems] = useState<VersionedItem[] | null>(null);
  const [open, setOpen] = useState<VersionedItem | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/timemachine/versions", { cache: "no-store" }).catch(() => null);
      const j = (await res?.json().catch(() => null)) as { items?: VersionedItem[] } | null;
      setItems(j?.items ?? []);
    })();
  }, []);
  const icon = { note: NotebookPen, doc: FileText, file: FileText } as const;
  return (
    <section aria-labelledby="tm-versions" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted" aria-hidden />
        <h2 id="tm-versions" className="aos-subheading">
          {t("flow.timeMachine.versionsTitle")}
        </h2>
      </div>
      <p className="text-sm text-muted">{t("flow.timeMachine.versionsBody")}</p>
      {items === null ? <p className="text-sm text-muted">{t("common.loading")}</p> : null}
      {items?.length === 0 ? <p className="text-sm text-muted">{t("flow.timeMachine.noVersions")}</p> : null}
      <ul className="flex flex-col divide-y divide-line">
        {items?.map((it) => {
          const Icon = icon[it.kind];
          return (
            <li key={`${it.kind}:${it.id}`} className="flex flex-wrap items-center gap-3 py-2">
              <Icon className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link href={it.href} className="block truncate text-md font-semibold text-ink underline-offset-2 hover:underline">
                  {it.title}
                </Link>
                <span suppressHydrationWarning className="block text-xs text-muted">
                  {t(`flow.timeMachine.kinds.${it.kind}` as MessageKey)} · {t("flow.timeMachine.versionsCount", { count: it.versions })} · {format.relative(it.lastAt)}
                </span>
              </div>
              <button type="button" onClick={() => setOpen(it)} className={aosButton({ variant: "secondary", size: "xs" })}>
                <History className="size-3.5" aria-hidden />
                {t("flow.timeMachine.versions")}
              </button>
            </li>
          );
        })}
      </ul>
      {open ? <VersionsPanel target={open} workspaceId={workspaceId} canEdit={canEdit} open onOpenChange={(o) => (!o ? setOpen(null) : undefined)} /> : null}
    </section>
  );
}

export default TimeMachineApp;
