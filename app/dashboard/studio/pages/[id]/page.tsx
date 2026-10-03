// Marketr — Phase 12 (Worker 1): GrapesJS page editor route. Full-bleed page
// (the editor takes the whole content area, so the dashboard's default
// padding is cancelled with negative margins), mirroring the Canvas editor
// route at app/dashboard/studio/designs/[id]/page.tsx.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { GrapesEditor } from "../GrapesEditor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Page builder — ShapesOS",
  description: "GrapesJS page builder for responsive landing pages and email templates.",
};

export default async function PageEditorPage({
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
      <div className="min-h-0 flex-1">
        <GrapesEditor pageId={id} />
      </div>
    </div>
  );
}
