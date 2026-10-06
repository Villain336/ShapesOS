// Marketr — Phase 10 M5: difficulty page shell.
// Modeled keyword difficulty: estimate ± uncertainty band + input provenance
// per keyword, plus the eval-bar state that decides whether the model may
// replace the vendor call. House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { DifficultyClient } from "./DifficultyClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Difficulty — ShapesOS",
  description:
    "The owned keyword-difficulty model: estimates with uncertainty bands, input provenance, and the eval bar that gates vendor replacement.",
};

export default async function DifficultyPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Difficulty</h1>
        <p className="mt-0.5 max-w-2xl text-[0.8125rem] text-muted">
          The owned keyword-difficulty model: KD = f(median referring domains of
          the top-10 SERP, authority gap, SERP-feature crowding). Every estimate
          ships with its ± uncertainty band and full input provenance —
          &ldquo;estimated range,&rdquo; never a score.
        </p>
      </div>
      <DifficultyClient />
    </div>
  );
}
