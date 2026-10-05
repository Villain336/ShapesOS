// Marketr — CAD + Hardware slice 1: dashboard page shell (server).
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { CadApp } from "./views/CadApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "CAD — ShapesOS",
  description:
    "CAD project and model registry: upload and inspect 3D models in the browser, version history with visual diffs, and expiring share links for collaborators.",
};


type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.length <= 64 ? s : null;
}

export default async function CadPage({ searchParams }: { searchParams: SearchParams }) {
  // Deep link (record search): ?project=…&model=…&tab=…
  const sp = await searchParams;
  const deepLink = { project: one(sp.project), model: one(sp.model), tab: one(sp.tab) };
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">CAD</h1>
        <p className="mt-0.5 text-sm text-muted">
          Your CAD project registry: upload STL, OBJ, and STEP models, inspect
          them in the browser, track every revision with visual diffs, and
          share expiring links with collaborators.
        </p>
      </div>
      <CadApp deepLink={deepLink} />
    </div>
  );
}
