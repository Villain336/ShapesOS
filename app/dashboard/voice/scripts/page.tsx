// Marketr — Phase 13D: call scripts legal-review page.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ScriptsApp } from "./ScriptsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Call Scripts — ShapesOS",
  description: "Legal-review surface for call scripts: draft → review → approve.",
};

export default async function ScriptsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <ScriptsApp />
    </div>
  );
}
