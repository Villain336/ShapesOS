// ShapesOS — Phase 9 (apps): /dashboard/apps — the workspace's internal mini-apps.
//
// A dense list: name + description, published version or draft, what the
// app stores, record count, last change. Viewers see published apps only;
// editors see drafts too and can start a new one (agents draft apps with
// app_create_spec; an admin publishes them from the builder).

import Link from "next/link";
import { AppWindow, ChevronRight, PencilRuler } from "lucide-react";
import { aosButton } from "@/components/aos";
import { listApps } from "@/lib/apps/service";
import { roleMeets } from "@/lib/apps/spec";
import { pageActor } from "./_components/actor";
import { EmptyState, NeutralPill } from "./_components/kit";
import { NewAppButton } from "./_components/NewAppButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Apps — ShapesOS",
  description: "Internal mini-apps built for this workspace: lists, forms and boards over your own data.",
};

function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export default async function AppsIndexPage() {
  const actor = await pageActor();
  const apps = await listApps(actor);
  const editor = roleMeets(actor.role, "editor");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="aos-heading">Apps</h1>
          <p className="mt-1 text-md text-muted">
            Small internal tools for {actor.workspaceName}: lists, forms and boards over your own records. Agents can draft one from a prompt; an admin publishes it.
          </p>
        </div>
        {editor ? <NewAppButton /> : null}
      </div>

      {apps.length === 0 ? (
        <EmptyState icon={<AppWindow size={28} aria-hidden />} title="No apps yet">
          {editor ? (
            <>Start one with New app, or ask the assistant: “Build an app to track equipment check-outs.” It drafts the app; you review and publish it.</>
          ) : (
            <>Apps appear here once an admin publishes one.</>
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="px-5 py-2.5 font-semibold">App</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">State</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Stores</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Records</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Updated</th>
                <th scope="col" className="w-24 px-5 py-2.5"><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="relative border-b border-line transition-[background-color] duration-150 last:border-0 hover:bg-hover-paper">
                  <td className="max-w-[360px] px-5 py-3">
                    <Link
                      href={a.published ? `/dashboard/apps/${a.slug}` : `/dashboard/apps/${a.slug}/build`}
                      className="block truncate text-base leading-5 font-semibold text-ink after:absolute after:inset-0 after:content-['']"
                    >
                      {a.name}
                    </Link>
                    <p className="truncate text-sm text-muted">
                      {a.description || <span className="aos-mono text-xs">{a.slug}</span>}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex flex-wrap gap-1.5">
                      <NeutralPill>{a.published ? `Version ${a.version}` : a.version ? "Unpublished" : "Draft"}</NeutralPill>
                      {editor && a.published && a.hasDraftChanges ? <NeutralPill>Draft changes</NeutralPill> : null}
                    </span>
                  </td>
                  <td className="max-w-[240px] truncate px-3 py-3 text-md text-muted">{a.entities.join(", ")}</td>
                  <td className="px-3 py-3 text-right text-md text-muted tabular-nums">{a.recordCount}</td>
                  <td className="px-3 py-3 text-md text-muted tabular-nums">{fmtDay(a.updatedAt)}</td>
                  <td className="px-5 py-3 text-right">
                    {editor ? (
                      <Link href={`/dashboard/apps/${a.slug}/build`} className={aosButton({ variant: "quiet", size: "xs", className: "relative z-10" })}>
                        <PencilRuler size={14} aria-hidden />
                        Build
                      </Link>
                    ) : (
                      <ChevronRight size={16} className="ml-auto text-subtle" aria-hidden />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
