// Marketr — Dataset Builder slice 1: dashboard page shell (server).
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { DatasetsApp } from "./DatasetsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Datasets — ShapesOS",
  description:
    "Ingest business knowledge from files, Google Drive, websites, and pasted text — every chunk traced to its source.",
};


type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length <= 64 ? s : null;
}

export default async function DatasetsPage({ searchParams }: { searchParams: SearchParams }) {
  // Deep link (record search, stale-dataset notifications): ?tab=build|activate|…
  const initialTab = one((await searchParams).tab);
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Datasets</h1>
        <p className="mt-0.5 text-sm text-muted">
          Bring your business knowledge in from files, Google Drive, websites,
          or pasted text. Every chunk stays traced to its source — no orphaned
          text, ever.
        </p>
      </div>
      <DatasetsApp initialTab={initialTab} />
    </div>
  );
}
