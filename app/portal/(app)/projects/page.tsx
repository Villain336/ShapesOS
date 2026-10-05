// ShapesOS — Phase 10 (portal): /portal/projects — projects linked to this
// client: status, milestone progress, and how many tasks are shared.

import Link from "next/link";
import { portalPage } from "@/lib/portal/page";
import { listPortalProjects } from "@/lib/portal/data";
import { chipCls, emptyCls, fmtDate, linkCls, pageHintCls, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects — Client portal" };

export default async function PortalProjects() {
  const p = await portalPage("projects");
  const projects = await listPortalProjects(p);
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Projects</h1>
        <p className={pageHintCls}>Where your projects stand: status, milestones and the tasks your team shares with you.</p>
      </div>
      {projects.length === 0 ? (
        <div className={emptyCls}>No projects shared with you yet.</div>
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Project</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Milestones</th>
                <th className={thCls}>Shared tasks</th>
                <th className={thCls}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((r) => (
                <tr key={r.id} className={rowCls}>
                  <td className={tdCls}>
                    <Link className={linkCls} href={`/portal/projects/${encodeURIComponent(r.id)}`}>
                      {r.name}
                    </Link>
                  </td>
                  <td className={tdCls}>
                    <span className={chipCls}>{stateLabel(r.status)}</span>
                  </td>
                  <td className={`${tdCls} tabular-nums`}>{r.milestones ? `${r.milestonesDone} of ${r.milestones} done` : "—"}</td>
                  <td className={`${tdCls} tabular-nums`}>{r.tasks}</td>
                  <td className={tdCls}>{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
