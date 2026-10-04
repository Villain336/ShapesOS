// TEMPORARY dev-only harness (Phase 13 twinui): renders the twin shell from
// lib/twin/fixtures.ts to eyeball the scene before the data side lands.
// notFound() in production; deleted before the workstream's final commit.
import { notFound } from "next/navigation";
import { TwinClient } from "@/components/twin/TwinClient";
import { TWIN_FIXTURES, fixtureSiteList } from "@/lib/twin/fixtures";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ kind: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  await requireOpsViewer();
  const { kind } = await params;
  const id = Object.values(TWIN_FIXTURES).find((s) => s.site.id === kind)?.site.kind ?? kind;
  const snap = TWIN_FIXTURES[id as keyof typeof TWIN_FIXTURES];
  if (!snap) notFound();
  return <TwinClient initial={snap} sites={fixtureSiteList()} canEdit live={false} hrefBase="/dashboard/ops/twin/dev/" />;
}
