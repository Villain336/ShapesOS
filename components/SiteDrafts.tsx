// ShapesOS — Phase 9 (sites): agent drafts of this project's sites.
//
// An agent's site_publish_draft lands here as a draft revision; nothing is
// live until a person applies it (the current files are kept as a backup
// first — restoring that backup is the revert). Deploying / publishing stays
// on the Hosting section and the IDE, behind their own gates.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, RotateCcw, X } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface SiteRow {
  id: string;
  name: string;
}

interface RevisionRow {
  id: string;
  number: number;
  status: "draft" | "applied" | "discarded" | "backup";
  source: string;
  runId: string | null;
  summary: string | null;
  fileCount: number;
  createdAt: string;
  appliedAt: string | null;
}

const STATUS_LABEL: Record<RevisionRow["status"], string> = {
  draft: "Draft",
  applied: "Applied",
  discarded: "Discarded",
  backup: "Backup",
};

const PILL =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-[0.8125rem] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40";
const PILL_PRIMARY =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-3 text-[0.8125rem] font-semibold text-paper aos-press hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40";

export default function SiteDrafts({ projectId }: { projectId: string }) {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [revs, setRevs] = useState<Record<string, RevisionRow[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sRes = await fetch(`/api/websites?projectId=${projectId}`);
    if (!sRes.ok) return;
    const sData = (await sRes.json()) as { sites: SiteRow[] };
    const list = sData.sites.map((s) => ({ id: s.id, name: s.name }));
    setSites(list);
    const entries = await Promise.all(
      list.map(async (s) => {
        const r = await fetch(`/api/websites/${s.id}/revisions?projectId=${projectId}`);
        const d = r.ok ? ((await r.json()) as { revisions: RevisionRow[] }) : { revisions: [] };
        return [s.id, d.revisions] as const;
      }),
    );
    setRevs(Object.fromEntries(entries));
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(siteId: string, rev: RevisionRow, action: "apply" | "discard", force = false) {
    if (action === "apply" && !force) {
      const what = rev.status === "backup" ? `Restore backup #${rev.number}` : `Apply draft #${rev.number}`;
      if (!(await confirmAction(`${what} to the site's files? The current files are kept as a backup. Nothing is deployed.`))) return;
    }
    if (action === "discard" && !(await confirmAction(`Discard draft #${rev.number}?`))) return;
    setBusy(rev.id);
    setMsg(null);
    try {
      const res = await fetch(`/api/websites/${siteId}/revisions/${rev.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action, force }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "site_changed") {
        if (await confirmAction(`${data.error} Apply anyway?`)) {
          setBusy(null);
          await act(siteId, rev, "apply", true);
        }
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setMsg(
        action === "apply"
          ? `Applied #${data.number}: ${data.written} files written, ${data.removed.length} removed. Backup #${data.backupNumber} keeps the previous files.`
          : `Discarded #${rev.number}.`,
      );
      await refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const rows = sites.flatMap((s) => (revs[s.id] ?? []).map((r) => ({ site: s, rev: r })));
  if (!rows.length) return null;

  return (
    <section className="rounded-lg bg-paper p-4 shadow-hairline" aria-labelledby="site-drafts">
      <h2 id="site-drafts" className="text-sm font-semibold text-ink">Agent drafts</h2>
      <p className="mt-1 text-sm text-muted">
        Changes agents made in their sandbox. Nothing here is live until you apply it; deploy afterwards as usual.
      </p>
      {msg && <p role="status" className="mt-2 text-sm text-muted">{msg}</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Site</th>
              <th className="px-3 py-2 font-medium">Revision</th>
              <th className="px-3 py-2 font-medium">Summary</th>
              <th className="px-3 py-2 font-medium">Files</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ site, rev }) => (
              <tr key={rev.id} className="border-b border-line hover:bg-hover-paper">
                <td className="px-3 py-2.5 text-ink">{site.name}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted">#{rev.number}</td>
                <td className="max-w-[320px] truncate px-3 py-2.5 text-ink" title={rev.summary ?? ""}>
                  {rev.summary ?? "—"}
                  {rev.runId && (
                    <Link href={`/dashboard/runs/${rev.runId}`} className="ml-2 text-xs text-muted underline hover:text-ink">
                      View run
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2.5 text-muted">{rev.fileCount}</td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
                    {STATUS_LABEL[rev.status] ?? rev.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{new Date(rev.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-2">
                    {rev.status === "draft" && (
                      <>
                        <button onClick={() => void act(site.id, rev, "apply")} disabled={busy !== null} className={PILL_PRIMARY}>
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          {busy === rev.id ? "Applying…" : "Apply"}
                        </button>
                        <button onClick={() => void act(site.id, rev, "discard")} disabled={busy !== null} className={PILL}>
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          Discard
                        </button>
                      </>
                    )}
                    {rev.status === "backup" && (
                      <button onClick={() => void act(site.id, rev, "apply")} disabled={busy !== null} className={PILL}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        {busy === rev.id ? "Restoring…" : "Restore"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
