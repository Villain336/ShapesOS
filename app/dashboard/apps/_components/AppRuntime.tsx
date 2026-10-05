"use client";

// ShapesOS — Phase 9 (apps): the runtime body of /dashboard/apps/[slug].
//
// Renders the selected view from the spec (dense table, kanban board or a
// form), the record detail panel and the actions the person may run. Every
// write goes to POST /api/apps/[slug]/actions; the action's tier decides
// the ceremony (the server enforces it, this mirrors it):
//   0  runs at once
//   1  asks first (shared confirm dialog), then runs with confirmed
//   2  sends an approval to Approvals; once approved, pressing the action
//      again runs it with that approval (remembered in this browser)

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, Search, X } from "lucide-react";
import { StatusShape, aosButton } from "@/components/aos";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import {
  TIER_LABELS,
  titleFieldOf,
  viewFields,
  type ActionSpec,
  type ActionTier,
  type EntitySpec,
  type FieldSpec,
  type MiniAppSpec,
  type ViewSpec,
} from "@/lib/apps/spec";
import { formatValue, orphanKeys } from "@/lib/apps/records";
import { NeutralPill, Panel, inputCls } from "./kit";
import { RecordForm, type RelationOptions } from "./RecordForm";

export interface RuntimeRow {
  id: string;
  data: Record<string, unknown>;
  specVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeAction {
  key: string;
  label: string;
  type: ActionSpec["type"];
  entity?: string;
  tier: ActionTier;
  hasSet: boolean;
  description?: string;
}

export interface RuntimeDetail {
  row: RuntimeRow;
  entityKey: string;
  /** The entity as the current spec declares it (null: dropped in a later version). */
  entity: EntitySpec | null;
  /** The entity as the record's own version declared it. */
  writtenEntity: EntitySpec | null;
}

export interface AppRuntimeProps {
  slug: string;
  appVersion: number;
  workspaceId: string;
  spec: MiniAppSpec;
  view: ViewSpec;
  rows: RuntimeRow[];
  matched: number;
  truncated: boolean;
  q: string;
  detail: RuntimeDetail | null;
  /** The detail view's field list for the record's entity, if the app has one the person can see. */
  detailFields: string[] | null;
  relationOptions: RelationOptions;
  fileNames: Record<string, string>;
  actions: RuntimeAction[];
}

type RunResult =
  | { ok: true; outcome: "done" | "approval_required"; record?: { id: string } }
  | { ok: false; fields?: Record<string, string> };

function approvalKey(slug: string, action: string, recordId?: string | null) {
  return `apps:${slug}:approval:${action}:${recordId ?? "-"}`;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, v: string | null) {
  try {
    if (v) window.localStorage.setItem(key, v);
    else window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: the approval id is still in Approvals */
  }
}

export function AppRuntime(props: AppRuntimeProps) {
  const { slug, spec, view, workspaceId } = props;
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const entity = spec.entities.find((e) => e.key === view.entity)!;
  const createAction = props.actions.find((a) => a.type === "create_record" && a.entity === entity.key);
  const appActions = props.actions.filter((a) => !a.entity && (a.type === "run_workflow" || a.type === "call_tool"));

  const hrefFor = (params: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    sp.set("view", view.key);
    if (props.q) sp.set("q", props.q);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    return `/dashboard/apps/${slug}?${sp.toString()}`;
  };

  async function upload(file: File): Promise<{ id: string; filename: string }> {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("workspaceId", workspaceId);
    fd.set("path", `/files/apps/${slug}`);
    const res = await fetch("/api/files", { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { file?: { id: string; filename: string }; error?: string };
    if (!res.ok || !body.file) throw new Error(body.error ?? "Upload failed");
    return body.file;
  }

  async function run(action: RuntimeAction, opts: { recordId?: string | null; data?: Record<string, unknown>; title?: string } = {}): Promise<RunResult> {
    const key = approvalKey(slug, action.key, opts.recordId);
    const approvalId = action.tier === 2 ? readStored(key) : null;
    if (action.tier === 1) {
      const ok = await confirmAction({
        title: `${action.label}${opts.title ? ` ${opts.title}` : ""}?`,
        description: action.description ?? (action.type === "delete_record" ? "This can't be undone." : undefined),
        confirmLabel: action.label,
        destructive: action.type === "delete_record",
      });
      if (!ok) return { ok: false };
    }
    setBusyAction(action.key);
    try {
      const res = await fetch(`/api/apps/${slug}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: action.key, recordId: opts.recordId ?? null, data: opts.data ?? null, confirmed: action.tier >= 1, approvalId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        outcome?: string;
        summary?: string;
        error?: string;
        code?: string;
        fields?: Record<string, string>;
        record?: { id: string };
        approval?: { id: string };
      };
      if (res.status === 202 && body.approval) {
        writeStored(key, body.approval.id);
        toast({ status: "needs", title: `${action.label}: sent for approval`, description: "Once it's approved in Approvals, press it again to run it." });
        return { ok: true, outcome: "approval_required" };
      }
      if (res.ok && body.outcome === "done") {
        writeStored(key, null);
        toast({ status: "done", title: body.summary ?? `${action.label}: done` });
        router.refresh();
        return { ok: true, outcome: "done", record: body.record };
      }
      if (res.status === 422 && body.code === "approval_not_approved") {
        toast({ status: "needs", title: `${action.label} is still waiting for approval`, description: "Approve it in Approvals, then press it again." });
        return { ok: false };
      }
      if (res.status === 422) writeStored(key, null); // expired, replayed or no longer matching: start over
      if (body.fields) return { ok: false, fields: body.fields };
      toastError(`${action.label} didn't run`, body.error ?? `The server answered ${res.status}.`);
      return { ok: false };
    } catch {
      toastError(`${action.label} didn't run`, "The request failed. Check your connection and try again.");
      return { ok: false };
    } finally {
      setBusyAction(null);
    }
  }

  const cell = (f: FieldSpec | undefined, v: unknown) => <Value field={f} value={v} relationOptions={props.relationOptions} fileNames={props.fileNames} workspaceId={workspaceId} />;

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: search + the view's create action + app-level actions */}
      <div className="flex flex-wrap items-center gap-2">
        {view.type !== "form" ? (
          <form action={`/dashboard/apps/${slug}`} className="relative min-w-[220px] flex-1 sm:max-w-[360px]" role="search">
            <input type="hidden" name="view" value={view.key} />
            <Search size={16} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
            <input name="q" defaultValue={props.q} aria-label={`Search ${entity.labelPlural ?? entity.label}`} placeholder={`Search ${(entity.labelPlural ?? entity.label).toLowerCase()}`} className={`${inputCls} h-control-sm pl-10 text-md`} />
          </form>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {appActions.map((a) => (
            <button key={a.key} type="button" className={aosButton({ variant: "secondary", size: "sm" })} disabled={busyAction !== null} onClick={() => run(a)} title={TIER_LABELS[a.tier]}>
              {a.label}
              <TierMark tier={a.tier} />
            </button>
          ))}
          {createAction && view.type !== "form" ? (
            <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
              <Plus size={16} aria-hidden />
              {createAction.label}
            </button>
          ) : null}
        </div>
      </div>

      {creating && createAction ? (
        <Panel className="p-5">
          <h2 className="aos-subheading mb-4">{createAction.label}</h2>
          <RecordForm
            fields={formFieldsFor(spec, entity)}
            submitLabel={createAction.label}
            busyLabel="Saving"
            relationOptions={props.relationOptions}
            fileNames={props.fileNames}
            upload={upload}
            onCancel={() => setCreating(false)}
            onSubmit={async (data) => {
              const r = await run(createAction, { data });
              if (r.ok) setCreating(false);
              return r.ok ? undefined : r.fields;
            }}
          />
        </Panel>
      ) : null}

      <div className={props.detail ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]" : ""}>
        <div className="min-w-0">
          {view.type === "table" ? (
            <TableView {...props} entity={entity} hrefFor={hrefFor} cell={cell} />
          ) : view.type === "kanban" ? (
            <KanbanView {...props} entity={entity} hrefFor={hrefFor} cell={cell} run={run} busy={busyAction !== null} />
          ) : view.type === "form" ? (
            <Panel className="max-w-[640px] p-5">
              {createAction ? (
                <RecordForm
                  key={props.rows.length}
                  fields={viewFields(spec, view)}
                  submitLabel={createAction.label}
                  busyLabel="Saving"
                  relationOptions={props.relationOptions}
                  fileNames={props.fileNames}
                  upload={upload}
                  onSubmit={async (data) => {
                    const r = await run(createAction, { data });
                    return r.ok ? undefined : r.fields;
                  }}
                />
              ) : (
                <p className="text-md text-muted">You can't add {(entity.labelPlural ?? entity.label).toLowerCase()} in this app.</p>
              )}
            </Panel>
          ) : null}
        </div>

        {props.detail ? (
          <DetailPanel
            {...props}
            detail={props.detail}
            editing={editing}
            setEditing={setEditing}
            closeHref={hrefFor({ record: null })}
            cell={cell}
            run={run}
            busy={busyAction !== null}
            upload={upload}
            onDeleted={() => router.push(hrefFor({ record: null }))}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Create forms use the entity's form view fields when it has one, else every field. */
function formFieldsFor(spec: MiniAppSpec, entity: EntitySpec): FieldSpec[] {
  const form = spec.views.find((v) => v.type === "form" && v.entity === entity.key);
  return form ? viewFields(spec, form) : entity.fields;
}

function TierMark({ tier }: { tier: ActionTier }) {
  if (tier < 2) return null;
  // Tier 2 waits on a person's approval: the "needs you" mark, with its label.
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted">
      <StatusShape status="needs" size={9} />
      <span className="sr-only">Needs approval</span>
    </span>
  );
}

function Value({
  field,
  value,
  relationOptions,
  fileNames,
  workspaceId,
}: {
  field: FieldSpec | undefined;
  value: unknown;
  relationOptions: RelationOptions;
  fileNames: Record<string, string>;
  workspaceId: string;
}) {
  if (value === undefined || value === null || value === "") return <span className="text-subtle">—</span>;
  if (field?.type === "relation" && typeof value === "string") {
    const hit = relationOptions[field.target ?? ""]?.find((o) => o.id === value);
    return <span>{hit?.title ?? <span className="aos-mono text-xs">{value}</span>}</span>;
  }
  if (field?.type === "file" && typeof value === "string") {
    return (
      <a
        href={`/api/files/${encodeURIComponent(value)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`}
        className="relative z-10 inline-flex items-center gap-1.5 font-semibold text-ink underline-offset-4 hover:underline"
      >
        <Download size={13} aria-hidden />
        {fileNames[value] ?? "File"}
      </a>
    );
  }
  if (field?.type === "text" && field.format === "url" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener" className="relative z-10 font-semibold text-ink underline-offset-4 hover:underline">
        {value.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  return <span className={field?.type === "money" || field?.type === "number" ? "tabular-nums" : undefined}>{formatValue(field, value)}</span>;
}

type CellFn = (f: FieldSpec | undefined, v: unknown) => React.ReactNode;

function TableView({
  spec,
  view,
  rows,
  matched,
  truncated,
  q,
  entity,
  appVersion,
  detail,
  hrefFor,
  cell,
}: AppRuntimeProps & { entity: EntitySpec; hrefFor: (p: Record<string, string | null>) => string; cell: CellFn }) {
  const cols = viewFields(spec, view);
  const tf = titleFieldOf(entity);
  const titleCol = cols.find((c) => c.key === tf.key) ?? cols[0]!;
  const rest = cols.filter((c) => c !== titleCol);
  if (rows.length === 0) {
    return (
      <Panel className="px-6 py-12 text-center">
        <h2 className="aos-subheading">{q ? `No matches for “${q}”` : `No ${(entity.labelPlural ?? entity.label).toLowerCase()} yet`}</h2>
        <p className="mt-1 text-md text-muted">{q ? "Try another search, or clear it." : view.filters?.length ? "Nothing matches this view's filters." : "Add the first one to get started."}</p>
      </Panel>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            {[titleCol, ...rest].map((c) => (
              <th key={c.key} scope="col" className={`px-4 py-2.5 font-semibold first:pl-5 ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = detail?.row.id === r.id;
            return (
              <tr key={r.id} aria-selected={selected} className={`relative border-b border-line transition-[background-color] duration-150 last:border-0 hover:bg-hover-paper ${selected ? "bg-hover-paper" : ""}`}>
                <td className="max-w-[320px] py-2.5 pr-4 pl-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Link href={hrefFor({ record: r.id })} className="truncate text-md font-semibold text-ink after:absolute after:inset-0 after:content-['']">
                      {formatValue(titleCol, r.data[titleCol.key]) || "Untitled"}
                    </Link>
                    {r.specVersion !== appVersion ? <NeutralPill className="h-5 px-2">v{r.specVersion}</NeutralPill> : null}
                  </span>
                </td>
                {rest.map((c) => (
                  <td key={c.key} className={`max-w-[260px] truncate px-4 py-2.5 text-md text-ink ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}>
                    {cell(c, r.data[c.key])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {matched > rows.length || truncated ? (
        <p className="border-t border-line px-5 py-2.5 text-sm text-muted">
          Showing {rows.length} of {matched}
          {truncated ? " (only the newest records were searched)" : ""}. Search to narrow the list.
        </p>
      ) : null}
    </div>
  );
}

function KanbanView({
  spec,
  view,
  rows,
  entity,
  actions,
  hrefFor,
  cell,
  run,
  busy,
}: AppRuntimeProps & {
  entity: EntitySpec;
  hrefFor: (p: Record<string, string | null>) => string;
  cell: CellFn;
  run: (a: RuntimeAction, o: { recordId?: string | null; data?: Record<string, unknown>; title?: string }) => Promise<RunResult>;
  busy: boolean;
}) {
  const group = entity.fields.find((f) => f.key === view.groupBy)!;
  const tf = titleFieldOf(entity);
  const lines = viewFields(spec, view).filter((f) => f.key !== tf.key && f.key !== group.key).slice(0, 3);
  const move = actions.find((a) => a.type === "update_record" && a.entity === entity.key && !a.hasSet);
  const columns = useMemo(() => {
    const opts = group.options ?? [];
    const cols = opts.map((o) => ({ key: o, label: o, rows: rows.filter((r) => r.data[group.key] === o) }));
    const other = rows.filter((r) => !opts.includes(String(r.data[group.key] ?? "")));
    if (other.length) cols.push({ key: "", label: `No ${group.label.toLowerCase()}`, rows: other });
    return cols;
  }, [group, rows]);

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {columns.map((col) => (
        <section key={col.key || "_none"} aria-label={col.label} className="flex w-[280px] shrink-0 flex-col gap-2 rounded-lg bg-hover p-2.5">
          <h2 className="flex items-center justify-between px-1.5 pt-0.5 text-md font-semibold text-ink">
            {col.label}
            <span className="text-sm text-muted tabular-nums">{col.rows.length}</span>
          </h2>
          {col.rows.map((r) => {
            const title = formatValue(tf, r.data[tf.key]) || "Untitled";
            return (
              <article key={r.id} className="relative flex flex-col gap-1.5 rounded-md bg-paper p-3 shadow-hairline">
                <Link href={hrefFor({ record: r.id })} className="text-md leading-5 font-semibold text-ink after:absolute after:inset-0 after:content-['']">
                  {title}
                </Link>
                {lines.map((f) =>
                  r.data[f.key] !== undefined && r.data[f.key] !== "" ? (
                    <p key={f.key} className="truncate text-sm text-muted">
                      <span className="sr-only">{f.label}: </span>
                      {cell(f, r.data[f.key])}
                    </p>
                  ) : null,
                )}
                {move ? (
                  <select
                    aria-label={`Move ${title} to`}
                    className="relative z-10 mt-1 h-8 w-full rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink outline-none focus:border-focus"
                    value={String(r.data[group.key] ?? "")}
                    disabled={busy}
                    onChange={(e) => run(move, { recordId: r.id, data: { [group.key]: e.target.value || null }, title: `“${title}”` })}
                  >
                    {!group.required ? <option value="">No {group.label.toLowerCase()}</option> : null}
                    {(group.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : null}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function DetailPanel({
  detail,
  detailFields,
  actions,
  appVersion,
  editing,
  setEditing,
  closeHref,
  cell,
  run,
  busy,
  upload,
  onDeleted,
  relationOptions,
  fileNames,
}: AppRuntimeProps & {
  detail: RuntimeDetail;
  editing: boolean;
  setEditing: (v: boolean) => void;
  closeHref: string;
  cell: CellFn;
  run: (a: RuntimeAction, o: { recordId?: string | null; data?: Record<string, unknown>; title?: string }) => Promise<RunResult>;
  busy: boolean;
  upload: (f: File) => Promise<{ id: string; filename: string }>;
  onDeleted: () => void;
}) {
  const { row, entity, writtenEntity } = detail;
  const shownEntity = entity ?? writtenEntity;
  const tf = shownEntity ? titleFieldOf(shownEntity) : undefined;
  const title = (tf && formatValue(tf, row.data[tf.key])) || "Untitled";
  const fields = shownEntity
    ? detailFields?.length
      ? detailFields.map((k) => shownEntity.fields.find((f) => f.key === k)).filter((f): f is FieldSpec => !!f)
      : shownEntity.fields
    : [];
  const orphans = entity ? orphanKeys(entity, row.data) : [];
  const recordActions = entity ? actions.filter((a) => a.entity === entity.key && a.type !== "create_record") : [];
  const edit = recordActions.find((a) => a.type === "update_record" && !a.hasSet);
  const others = recordActions.filter((a) => a !== edit);

  return (
    <Panel as="aside" className="flex h-fit flex-col gap-4 p-5 xl:sticky xl:top-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="aos-subheading break-words">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">
            {shownEntity?.label ?? detail.entityKey} · added {new Date(row.createdAt).toLocaleDateString()}
            {row.specVersion !== appVersion ? ` · written with version ${row.specVersion}` : ""}
          </p>
        </div>
        <Link href={closeHref} aria-label="Close" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })}>
          <X size={16} aria-hidden />
        </Link>
      </div>

      {editing && edit && entity ? (
        <RecordForm
          fields={entity.fields}
          initial={row.data}
          submitLabel="Save changes"
          busyLabel="Saving"
          relationOptions={relationOptions}
          fileNames={fileNames}
          upload={upload}
          onCancel={() => setEditing(false)}
          onSubmit={async (data) => {
            const r = await run(edit, { recordId: row.id, data, title: `“${title}”` });
            if (r.ok) setEditing(false);
            return r.ok ? undefined : r.fields;
          }}
        />
      ) : (
        <dl className="flex flex-col divide-y divide-line">
          {fields.map((f) => (
            <div key={f.key} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 py-2.5">
              <dt className="text-sm font-semibold text-muted">{f.label}</dt>
              <dd className={`text-md break-words text-ink ${f.format === "multiline" ? "whitespace-pre-wrap" : ""}`}>{cell(f, row.data[f.key])}</dd>
            </div>
          ))}
          {orphans.length ? (
            <div className="py-2.5">
              <p className="mb-1.5 text-xs font-semibold text-muted">From version {row.specVersion} (no longer in this app)</p>
              {orphans.map((k) => {
                const wf = writtenEntity?.fields.find((f) => f.key === k);
                return (
                  <div key={k} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 py-1.5">
                    <dt className="text-sm font-semibold text-muted">{wf?.label ?? k}</dt>
                    <dd className="text-md break-words text-ink">{cell(wf, row.data[k])}</dd>
                  </div>
                );
              })}
            </div>
          ) : null}
        </dl>
      )}

      {!editing && (edit || others.length) ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {edit ? (
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setEditing(true)} disabled={busy}>
              {edit.label}
              <TierMark tier={edit.tier} />
            </button>
          ) : null}
          {others.map((a) => (
            <button
              key={a.key}
              type="button"
              title={TIER_LABELS[a.tier]}
              className={aosButton({ variant: a.type === "delete_record" ? "deny" : "secondary", size: "sm" })}
              disabled={busy}
              onClick={async () => {
                const r = await run(a, { recordId: row.id, title: `“${title}”` });
                if (r.ok && r.outcome === "done" && a.type === "delete_record") onDeleted();
              }}
            >
              {a.label}
              <TierMark tier={a.tier} />
            </button>
          ))}
        </div>
      ) : null}
      {!entity ? <p className="text-sm text-muted">This kind of record was removed from the app; it's kept read-only.</p> : null}
    </Panel>
  );
}
