import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { AgentsApp } from "./AgentsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Voice Agents — Marketr",
  description: "LiveKit lead follow-up agents: consent-gated, disclosure-first, kill-switched.",
};

export default async function VoicePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <AgentsApp />
    </div>
  );
}
