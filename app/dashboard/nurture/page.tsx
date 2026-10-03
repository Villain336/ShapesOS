// Marketr — R3 nurture sequences workspace (Phase 3 acquisition loop).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { NurtureApp } from "./NurtureApp";
import { parseNurtureTab } from "./tabs";


export const dynamic = "force-dynamic";

export const metadata = {
  title: "Nurture Sequences — ShapesOS",
  description: "Approval-gated nurture sequences: builder, enrollments, approval queue, message log, consent.",
};

export default async function NurturePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  const sp = await searchParams;
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Nurture Sequences</h1>
        <p className="mt-1 text-sm text-muted">
          Approval-gated drip sequences across SMS, email, voice, and direct mail. Every send requires a human approval —
          nothing auto-sends. The Broadcasts tab runs newsletter campaigns through the Listmonk email sidecar.
        </p>
      </div>
      <NurtureApp initialTab={parseNurtureTab(tab)} />
    </div>
  );
}
