// Marketr — Agent Playbooks home (Phase 9 M5).
// Versioned procedures the Chief Strategy Agent and executors follow:
// learned from Growth Memory + opt-in community sharing.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { PlaybooksApp } from "./PlaybooksApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agent Playbooks — ShapesOS",
  description:
    "Versioned agent procedures: immutable versions, mutable label pointers, outcome evals against real tenant outcomes.",
};

export default async function PlaybooksPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Agent Playbooks</h1>
        <p className="mt-0.5 text-sm text-muted">
          Versioned procedures the Chief Strategy Agent follows — immutable versions, mutable
          production/staging/latest pointers, evaluated against real tenant outcomes.
        </p>
      </div>
      <div className="mt-4">
        <PlaybooksApp />
      </div>
    </div>
  );
}
