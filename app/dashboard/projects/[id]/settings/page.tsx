// Marketr — /settings index: land on the General tab.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectSettingsIndex({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/projects/${id}/settings/general`);
}
