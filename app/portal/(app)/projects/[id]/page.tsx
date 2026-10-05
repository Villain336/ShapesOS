// ShapesOS — Phase 10 (portal): /portal/projects/[id] — one linked project:
// milestones and the tasks marked client-visible (never assignees, notes or
// internal tasks).

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { portalPage } from "@/lib/portal/page";
import { getPortalProject, PortalNotFoundError } from "@/lib/portal/data";
import { btnQuietSm, cardCls, chipCls, emptyCls, fmtDate, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project — Client portal" };

export default async function PortalProject({ params }: { params: Promise<{ id: string }> }) {
  const p = await portalPage("projects");
  const project = await getPortalProject(p, (await params).id).catch((e: unknown) => {
    if (e instanceof PortalNotFoundError) notFound();
    throw e;
  });
  return (
    <>
      <div className="flex flex-col gap-3">
        <Link href="/portal/projects" className={`${btnQuietSm} self-start`}>
          <ArrowLeft size={15} aria-hidden /> All projects
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className={pageTitleCls}>{project.name}</h1>
          <span className={chipCls}>{stateLabel(project.status)}</span>
        </div>
      </div>
      <section className={cardCls} aria-labelledby="milestones">
        <h2 id="milestones" className="aos-subheading">Milestones</h2>
        {project.milestones.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No milestones set.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {project.milestones.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-md text-ink">{m.title}</span>
                <span className="flex items-center gap-3 text-sm text-muted">
                  {m.dueAt ? `Due ${fmtDate(m.dueAt)}` : null}
                  <span className={chipCls}>{stateLabel(m.status)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="tasks" className="flex flex-col gap-3">
        <h2 id="tasks" className="aos-subheading">Tasks</h2>
        {project.tasks.length === 0 ? (
          <div className={emptyCls}>No tasks shared on this project.</div>
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Task</th>
                  <th className={thCls}>Stage</th>
                  <th className={thCls}>Due</th>
                  <th className={thCls}>Completed</th>
                </tr>
              </thead>
              <tbody>
                {project.tasks.map((t) => (
                  <tr key={t.id} className={rowCls}>
                    <td className={tdCls}>{t.title}</td>
                    <td className={tdCls}>
                      <span className={chipCls}>{stateLabel(t.stage)}</span>
                    </td>
                    <td className={tdCls}>{fmtDate(t.dueAt)}</td>
                    <td className={tdCls}>{fmtDate(t.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
