// Marketr — Phase 11 "Canvas": editor route. Full-bleed page (the editor takes
// the whole content area, so the dashboard's default padding is cancelled with
// negative margins), with a slim "Back to Studio" header row.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { CanvasEditor } from "../editor/CanvasEditor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Canvas editor — Marketr",
  description: "Design editor for Marketr Studio designs.",
};

export default async function DesignEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-105px)] flex-col bg-[#FAFAF7] sm:-mx-6 sm:-my-8 md:h-[calc(100dvh-48px)] lg:-mx-10">
      <div className="flex shrink-0 items-center border-b border-stone-200 bg-[#FAFAF7] px-4 py-2">
        <Link
          href="/dashboard/studio"
          className="flex items-center gap-1.5 text-[13px] font-medium text-stone-600 hover:text-violet-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Studio
        </Link>
      </div>
      <div className="min-h-0 flex-1">
        <CanvasEditor designId={id} />
      </div>
    </div>
  );
}
