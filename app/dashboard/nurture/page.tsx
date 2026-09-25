// Marketr — R3 nurture sequences workspace (Phase 3 acquisition loop).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { NurtureApp } from "./NurtureApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Nurture Sequences — Marketr",
  description: "Approval-gated nurture sequences: builder, enrollments, approval queue, message log, consent.",
};

export default async function NurturePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Nurture Sequences</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Approval-gated drip sequences across SMS, email, voice, and direct mail. Every send requires a human approval —
          nothing auto-sends.
        </p>
      </div>
      <NurtureApp />
    </div>
  );
}
