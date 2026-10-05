// Marketr — Phase 13D: call sessions list.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { SessionsApp } from "./SessionsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Call Sessions — ShapesOS",
  description: "Live, rehearsal, and blocked call sessions with transcripts and audit trails.",
};

export default async function SessionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <SessionsApp />
    </div>
  );
}
