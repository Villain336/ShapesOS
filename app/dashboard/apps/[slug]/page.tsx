// ShapesOS — Phase 9 (apps): /dashboard/apps/[slug] — a published mini-app.
//
// Rendered from the app's live spec: the view tabs the member's role can
// see (?view=), the selected view's records (server-filtered and sorted),
// and the record detail (?record=). Reads go through lib/apps/service.ts
// (RLS scope + view roles); writes go through the actions API.

import Link from "next/link";
import { notFound } from "next/navigation";
import { AppWindow, PencilRuler } from "lucide-react";
import { FilterPill, aosButton } from "@/components/aos";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getTool } from "@/lib/chat/tools";
import {
  AppError,
  getRecord,
  listRecords,
  loadApp,
  recordTitles,
  type RecordDetail,
  type RecordOut,
} from "@/lib/apps/service";
import {
  actionMinRole,
  effectiveActionTier,
  findEntity,
  roleMeets,
  viewMinRole,
  type EntitySpec,
} from "@/lib/apps/spec";
import { pageActor } from "../_components/actor";
import { EmptyState, NeutralPill } from "../_components/kit";
import { AppRuntime, type RuntimeAction, type RuntimeRow } from "../_components/AppRuntime";

export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function toRow(r: RecordOut): RuntimeRow {
  return { id: r.id, data: r.data, specVersion: r.specVersion, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `${slug} — Apps — ShapesOS` };
}

export default async function MiniAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await pageActor();
  const { slug } = await params;
  const sp = await searchParams;

  let app;
  try {
    app = await loadApp(actor, slug);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const canBuild = roleMeets(actor.role, "editor");

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-muted">
          <Link href="/dashboard/apps" className="font-semibold text-ink underline-offset-4 hover:underline">
            Apps
          </Link>
        </p>
        <h1 className="aos-heading mt-1 flex flex-wrap items-center gap-2.5">
          {app.name}
          {app.published ? <NeutralPill>Version {app.version}</NeutralPill> : <NeutralPill>Not published</NeutralPill>}
        </h1>
        {app.description ? <p className="mt-1 text-md text-muted">{app.description}</p> : null}
      </div>
      {canBuild ? (
        <Link href={`/dashboard/apps/${slug}/build`} className={aosButton({ variant: "secondary", size: "sm" })}>
          <PencilRuler size={15} aria-hidden />
          Build
        </Link>
      ) : null}
    </div>
  );

  if (!app.published || !app.spec) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={<AppWindow size={28} aria-hidden />} title="This app isn't published yet">
          Review the draft in the builder; an admin publishes it to make it live.
        </EmptyState>
      </div>
    );
  }

  const spec = app.spec;
  const tabs = spec.views.filter((v) => v.type !== "detail" && roleMeets(actor.role, viewMinRole(v)));
  if (tabs.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState icon={<AppWindow size={28} aria-hidden />} title="Nothing to show for your role">
          Ask an admin for access to this app&apos;s views.
        </EmptyState>
      </div>
    );
  }
  const view = tabs.find((v) => v.key === one(sp.view)) ?? tabs[0]!;
  const q = (one(sp.q) ?? "").slice(0, 200);
  const recordId = one(sp.record);

  const list = view.type === "form" ? null : await listRecords(actor, slug, { view: view.key, q, limit: 300 });

  let detail: RecordDetail | null = null;
  if (recordId) {
    try {
      detail = await getRecord(actor, slug, recordId);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }

  // Relation pickers / cells: titles of every target entity in play.
  const entitiesInPlay = new Set<EntitySpec>();
  const viewEntity = findEntity(spec, view.entity);
  if (viewEntity) entitiesInPlay.add(viewEntity);
  if (detail?.entity) entitiesInPlay.add(detail.entity);
  const targets = new Set<string>();
  for (const e of entitiesInPlay) for (const f of e.fields) if (f.type === "relation" && f.target) targets.add(f.target);
  const relationOptions: Record<string, Array<{ id: string; title: string }>> = {};
  for (const t of targets) relationOptions[t] = await recordTitles(actor, slug, t, 300);

  // File names for file values on screen.
  const fileIds = new Set<string>();
  const collectFiles = (e: EntitySpec | null | undefined, data: Record<string, unknown>) => {
    for (const f of e?.fields ?? []) if (f.type === "file" && typeof data[f.key] === "string") fileIds.add(data[f.key] as string);
  };
  for (const r of list?.rows ?? []) collectFiles(viewEntity, r.data);
  if (detail) collectFiles(detail.entity ?? findEntity(detail.writtenWith ?? spec, detail.record.entity), detail.record.data);
  const files = fileIds.size
    ? await withWorkspaceScope(actor.workspaceId, (tx) =>
        tx.workspaceFile.findMany({ where: { workspaceId: actor.workspaceId, id: { in: [...fileIds] } }, select: { id: true, filename: true } }),
      )
    : [];

  // The actions this member may run, with the tier the server will apply.
  const actions: RuntimeAction[] = spec.actions
    .filter((a) => roleMeets(actor.role, actionMinRole(a)))
    .map((a) => ({
      key: a.key,
      label: a.label,
      type: a.type,
      ...(a.entity ? { entity: a.entity } : {}),
      ...(a.description ? { description: a.description } : {}),
      tier: effectiveActionTier(a, { toolKind: a.tool ? (getTool(a.tool)?.kind ?? "publish") : null }),
      hasSet: !!a.set,
    }));

  const detailView = detail ? spec.views.find((v) => v.type === "detail" && v.entity === detail.record.entity && roleMeets(actor.role, viewMinRole(v))) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {header}
      {tabs.length > 1 ? (
        <nav aria-label="Views" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {tabs.map((t) => (
            <FilterPill key={t.key} href={`/dashboard/apps/${slug}?view=${t.key}`} selected={t.key === view.key}>
              {t.label}
            </FilterPill>
          ))}
        </nav>
      ) : null}
      <AppRuntime
        slug={slug}
        appVersion={app.version}
        workspaceId={actor.workspaceId}
        spec={spec}
        view={view}
        rows={(list?.rows ?? []).map(toRow)}
        matched={list?.matched ?? 0}
        truncated={list?.truncated ?? false}
        q={q}
        detail={
          detail
            ? {
                row: toRow(detail.record),
                entityKey: detail.record.entity,
                entity: detail.entity,
                writtenEntity: detail.writtenWith ? (findEntity(detail.writtenWith, detail.record.entity) ?? null) : null,
              }
            : null
        }
        detailFields={detailView?.fields ?? null}
        relationOptions={relationOptions}
        fileNames={Object.fromEntries(files.map((f) => [f.id, f.filename]))}
        actions={actions}
      />
    </div>
  );
}
