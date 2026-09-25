// Marketr — Direct Mail workspace (Phase 4 R3-integration).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MailApp } from "./MailApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Direct Mail — Marketr",
  description: "Direct mail campaigns and nurture mail pieces: builder, approvals, verification, tracking.",
};

export default async function MailPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Direct Mail</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Postcard and letter campaigns — a first-class nurture channel. Test mode by default; every
          piece needs a human approval binding creative, count, and max spend.
        </p>
      </div>
      <MailApp />
    </div>
  );
}
