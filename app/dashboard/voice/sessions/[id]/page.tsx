// Marketr — Phase 13D: session detail page.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { SessionDetailApp } from "./SessionDetailApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Session detail — Marketr",
  description: "Transcript, consent proof, and audit trail for one call session.",
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <SessionDetailApp sessionId={id} />
    </div>
  );
}
