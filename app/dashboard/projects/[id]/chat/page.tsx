// Marketr — legacy per-project chat route. The assistant is now a single
// global page; preserve deep links (?tab=team included) via redirect.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  redirect(`/dashboard/assistant?project=${id}${sp.tab === "team" ? "&tab=team" : ""}`);
}
