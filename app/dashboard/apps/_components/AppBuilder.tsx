"use client";

// ShapesOS — Phase 9 (apps): the mini-app builder (form-based spec editor).
//
// Edits the DRAFT spec: entities and their fields, views, actions (with
// tier and minimum role) and the tool groups call_tool actions may use.
// Every change is checked live with the same parser the server uses
// (lib/apps/spec.ts parseSpec); the server re-checks on save and adds the
// checks that need it (tools, workflows) on publish. JSON mode edits the
// whole spec (filters live there). Admins publish: that is the approval
// step for an app an agent drafted.

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { FilterPill, Switch, aosButton } from "@/components/aos";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import {
  ACTION_TYPES,
  APP_ROLES,
  FIELD_TYPES,
  TIER_LABELS,
  VIEW_TYPES,
  parseSpec,
  type ActionSpec,
  type EntitySpec,
  type FieldSpec,
  type MiniAppSpec,
  type ToolGroup,
  type ViewSpec,
} from "@/lib/apps/spec";
import { ErrorLine, NeutralPill, Panel, denseInputCls, inputCls, textareaCls } from "./kit";

const FIELD_TYPE_LABELS: Record<FieldSpec["type"], string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  bool: "Yes / no",
  select: "Choice",
  relation: "Link to record",
  file: "File",
};
const VIEW_TYPE_LABELS: Record<ViewSpec["type"], string> = { table: "Table", form: "Form", kanban: "Board", detail: "Detail" };
const ACTION_TYPE_LABELS: Record<ActionSpec["type"], string> = {
  create_record: "Create record",
  update_record: "Update record",
  delete_record: "Delete record",
  run_workflow: "Run workflow",
  call_tool: "Call agent tool",
};
const ROLE_LABELS: Record<string, string> = { viewer: "Viewers", editor: "Editors", admin: "Admins", owner: "Owners" };

export interface BuilderProps {
  slug: string;
  draft: MiniAppSpec;
  published: boolean;
  version: number;
  hasDraftChanges: boolean;
  canPublish: boolean;
  workflows: Array<{ id: string; name: string }>;
  tools: Array<{ name: string; group: string }>;
  toolGroups: Array<{ value: ToolGroup; label: string }>;
}

function uniqueKey(base: string, taken: string[]): string {
  let k = base;
  for (let i = 2; taken.includes(k); i++) k = `${base}_${i}`.slice(0, 40);
  return k;
}

/** "status=Done; urgent=true" ⇄ { status: "Done", urgent: true } (typed by the entity's fields). */
function setToText(set: ActionSpec["set"]): string {
  return Object.entries(set ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("; ");
}
function textToSet(text: string, entity: EntitySpec | undefined): ActionSpec["set"] | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const part of text.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    const f = entity?.fields.find((x) => x.key === k);
    out[k] = f?.type === "bool" ? raw === "true" : f?.type === "number" || f?.type === "money" ? Number(raw) : raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
    </label>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={aosButton({ variant: "quiet", size: "xs", className: "mt-5 px-2 text-failed-text hover:bg-failed-tint" })}>
      <Trash2 size={15} aria-hidden />
    </button>
  );
}

export function AppBuilder(props: BuilderProps) {
  const router = useRouter();
  const [spec, setSpec] = useState<MiniAppSpec>(props.draft);
  const [saved, setSaved] = useState(JSON.stringify(props.draft));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const parsed = useMemo(() => parseSpec(spec), [spec]);
  const dirty = JSON.stringify(spec) !== saved;
  const entityKeys = spec.entities.map((e) => e.key);

  const update = (fn: (s: MiniAppSpec) => MiniAppSpec) => {
    setServerErrors([]);
    setSpec((s) => fn(structuredClone(s)));
  };
  const setEntity = (i: number, fn: (e: EntitySpec) => void) => update((s) => (fn(s.entities[i]!), s));
  const setField = (ei: number, fi: number, fn: (f: FieldSpec) => void) => update((s) => (fn(s.entities[ei]!.fields[fi]!), s));
  const setView = (i: number, fn: (v: ViewSpec) => void) => update((s) => (fn(s.views[i]!), s));
  const setAction = (i: number, fn: (a: ActionSpec) => void) => update((s) => (fn(s.actions[i]!), s));

  async function save(): Promise<boolean> {
    if (!parsed.ok) return false;
    setBusy("save");
    try {
      const res = await fetch(`/api/apps/${props.slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: string[] };
      if (!res.ok) {
        setServerErrors(body.errors ?? [body.error ?? "The draft wasn't saved."]);
        return false;
      }
      setSaved(JSON.stringify(spec));
      return true;
    } catch {
      toastError("The draft wasn't saved", "Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    const ok = await confirmAction({
      title: props.published ? `Publish version ${props.version + 1}?` : "Publish this app?",
      description: "Everyone in the workspace with access to its views can use it. Records already stored stay readable.",
      confirmLabel: "Publish",
    });
    if (!ok) return;
    setBusy("publish");
    try {
      const res = await fetch(`/api/apps/${props.slug}/publish`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { version?: number; error?: string; errors?: string[] };
      if (!res.ok) {
        setServerErrors(body.errors ?? [body.error ?? "The app wasn't published."]);
        return;
      }
      toast({ status: "done", title: `Published version ${body.version}` });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function unpublish() {
    if (!(await confirmAction({ title: "Unpublish this app?", description: "It disappears for everyone; records are kept and come back when you publish again.", confirmLabel: "Unpublish" }))) return;
    setBusy("unpublish");
    try {
      const res = await fetch(`/api/apps/${props.slug}/publish`, { method: "DELETE" });
      if (!res.ok) toastError("The app is still published", ((await res.json().catch(() => ({}))) as { error?: string }).error);
      else {
        toast({ status: "done", title: "Unpublished" });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirmAction({ title: `Delete ${spec.name}?`, description: "The app and every record in it are deleted. This can't be undone.", confirmLabel: "Delete", destructive: true }))) return;
    setBusy("delete");
    const res = await fetch(`/api/apps/${props.slug}`, { method: "DELETE" });
    if (!res.ok) {
      toastError("The app wasn't deleted", ((await res.json().catch(() => ({}))) as { error?: string }).error);
      setBusy(null);
      return;
    }
    toast({ status: "done", title: "Deleted" });
    router.push("/dashboard/apps");
  }

  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(JSON.stringify(spec, null, 2));
      setJsonError(null);
      setMode("json");
      return;
    }
    try {
      const v = JSON.parse(jsonText) as MiniAppSpec;
      if (!v || typeof v !== "object" || !Array.isArray(v.entities) || !Array.isArray(v.views)) throw new Error("needs entities and views");
      setSpec({ ...v, actions: Array.isArray(v.actions) ? v.actions : [], slug: props.slug });
      setMode("form");
    } catch (e) {
      setJsonError(`Fix the JSON first: ${e instanceof Error ? e.message : "it doesn't parse"}`);
    }
  }

  const errors = [...(parsed.ok ? [] : parsed.errors), ...serverErrors];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill selected={mode === "form"} onClick={() => switchMode("form")}>
          Form
        </FilterPill>
        <FilterPill selected={mode === "json"} onClick={() => switchMode("json")}>
          JSON
        </FilterPill>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <NeutralPill>{props.published ? `Live: version ${props.version}` : props.version ? "Unpublished" : "Never published"}</NeutralPill>
          {dirty ? <NeutralPill>Unsaved changes</NeutralPill> : props.hasDraftChanges && props.published ? <NeutralPill>Draft differs from live</NeutralPill> : null}
        </span>
      </div>

      {errors.length ? (
        <Panel className="flex flex-col gap-1.5 p-4">
          <p className="text-md font-semibold text-ink">Fix these before saving</p>
          {errors.slice(0, 8).map((e) => (
            <ErrorLine key={e}>
              <span className="aos-mono text-xs">{e}</span>
            </ErrorLine>
          ))}
        </Panel>
      ) : null}

      {mode === "json" ? (
        <Panel className="flex flex-col gap-3 p-5">
          <p className="text-md text-muted">The whole spec, including view filters. Switch back to Form to check and keep your edits.</p>
          <textarea aria-label="Spec JSON" className={`${textareaCls} aos-mono min-h-[520px] text-sm`} spellCheck={false} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
          {jsonError ? <ErrorLine>{jsonError}</ErrorLine> : null}
        </Panel>
      ) : (
        <>
          {/* App */}
          <Panel className="grid gap-4 p-5 md:grid-cols-2">
            <Cell label="Name">
              <input className={inputCls} value={spec.name} maxLength={80} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} />
            </Cell>
            <Cell label="Address">
              <input className={`${inputCls} aos-mono text-md`} value={`/dashboard/apps/${spec.slug}`} disabled />
            </Cell>
            <Cell label="Description" className="md:col-span-2">
              <input className={inputCls} value={spec.description ?? ""} maxLength={500} onChange={(e) => update((s) => ({ ...s, description: e.target.value || undefined }))} />
            </Cell>
          </Panel>

          {/* Entities */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="aos-subheading">What it stores</h2>
              <button
                type="button"
                className={aosButton({ variant: "secondary", size: "sm" })}
                onClick={() =>
                  update((s) => {
                    const key = uniqueKey("records", entityKeys);
                    s.entities.push({ key, label: "Record", fields: [{ key: "name", label: "Name", type: "text", required: true }] });
                    return s;
                  })
                }
              >
                <Plus size={15} aria-hidden />
                Add a list
              </button>
            </div>
            {spec.entities.map((e, ei) => (
              <Panel key={ei} className="flex flex-col gap-4 p-5">
                <div className="grid items-start gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  <Cell label="Name (one)">
                    <input className={denseInputCls} value={e.label} onChange={(ev) => setEntity(ei, (x) => void (x.label = ev.target.value))} />
                  </Cell>
                  <Cell label="Name (many)">
                    <input className={denseInputCls} value={e.labelPlural ?? ""} placeholder={`${e.label}s`} onChange={(ev) => setEntity(ei, (x) => void (x.labelPlural = ev.target.value || undefined))} />
                  </Cell>
                  <Cell label="Key">
                    <input className={`${denseInputCls} aos-mono`} value={e.key} onChange={(ev) => setEntity(ei, (x) => void (x.key = ev.target.value))} />
                  </Cell>
                  <Cell label="Title field">
                    <select className={denseInputCls} value={e.titleField ?? ""} onChange={(ev) => setEntity(ei, (x) => void (x.titleField = ev.target.value || undefined))}>
                      <option value="">First text field</option>
                      {e.fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </Cell>
                  <RemoveButton label={`Remove ${e.label}`} onClick={() => update((s) => (s.entities.splice(ei, 1), s))} />
                </div>
                <div className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {e.fields.map((f, fi) => (
                    <div key={fi} className="grid items-start gap-3 px-3 py-2.5 md:grid-cols-[1.2fr_1fr_1fr_auto_1.6fr_auto]">
                      <Cell label="Field">
                        <input className={denseInputCls} value={f.label} onChange={(ev) => setField(ei, fi, (x) => void (x.label = ev.target.value))} />
                      </Cell>
                      <Cell label="Key">
                        <input className={`${denseInputCls} aos-mono`} value={f.key} onChange={(ev) => setField(ei, fi, (x) => void (x.key = ev.target.value))} />
                      </Cell>
                      <Cell label="Type">
                        <select
                          className={denseInputCls}
                          value={f.type}
                          onChange={(ev) =>
                            setField(ei, fi, (x) => {
                              const t = ev.target.value as FieldSpec["type"];
                              for (const k of ["options", "target", "format", "min", "max", "minLength", "maxLength", "currency"] as const) delete x[k];
                              x.type = t;
                              if (t === "select") x.options = ["Option 1"];
                              if (t === "relation") x.target = e.key === spec.entities[0]?.key && spec.entities.length > 1 ? spec.entities[1]!.key : spec.entities[0]!.key;
                            })
                          }
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {FIELD_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      </Cell>
                      <div className="flex flex-col gap-1">
                        <span id={`req-${ei}-${fi}`} className="text-xs font-semibold text-muted">Required</span>
                        <div className="flex h-control-sm items-center">
                          <Switch checked={!!f.required} labelledBy={`req-${ei}-${fi}`} onChange={(on) => setField(ei, fi, (x) => void (on ? (x.required = true) : delete x.required))} />
                        </div>
                      </div>
                      <FieldExtras field={f} entities={spec.entities} onChange={(fn) => setField(ei, fi, fn)} />
                      <RemoveButton label={`Remove ${f.label}`} onClick={() => setEntity(ei, (x) => void x.fields.splice(fi, 1))} />
                    </div>
                  ))}
                </div>
                <div>
                  <button
                    type="button"
                    className={aosButton({ variant: "quiet", size: "sm" })}
                    onClick={() => setEntity(ei, (x) => void x.fields.push({ key: uniqueKey("field", x.fields.map((f) => f.key)), label: "New field", type: "text" }))}
                  >
                    <Plus size={15} aria-hidden />
                    Add field
                  </button>
                </div>
              </Panel>
            ))}
          </section>

          {/* Views */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="aos-subheading">How people see it</h2>
              <button
                type="button"
                className={aosButton({ variant: "secondary", size: "sm" })}
                onClick={() => update((s) => (s.views.push({ key: uniqueKey("view", s.views.map((v) => v.key)), label: "New view", type: "table", entity: s.entities[0]!.key }), s))}
              >
                <Plus size={15} aria-hidden />
                Add view
              </button>
            </div>
            <Panel className="flex flex-col divide-y divide-line">
              {spec.views.map((v, vi) => {
                const ent = spec.entities.find((e) => e.key === v.entity);
                return (
                  <div key={vi} className="grid items-start gap-3 px-5 py-3 md:grid-cols-[1.2fr_1fr_0.9fr_1fr_1.6fr_1fr_1fr_auto]">
                    <Cell label="View">
                      <input className={denseInputCls} value={v.label} onChange={(ev) => setView(vi, (x) => void (x.label = ev.target.value))} />
                    </Cell>
                    <Cell label="Key">
                      <input className={`${denseInputCls} aos-mono`} value={v.key} onChange={(ev) => setView(vi, (x) => void (x.key = ev.target.value))} />
                    </Cell>
                    <Cell label="Type">
                      <select
                        className={denseInputCls}
                        value={v.type}
                        onChange={(ev) =>
                          setView(vi, (x) => {
                            x.type = ev.target.value as ViewSpec["type"];
                            if (x.type === "kanban") x.groupBy = ent?.fields.find((f) => f.type === "select")?.key;
                            else delete x.groupBy;
                          })
                        }
                      >
                        {VIEW_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {VIEW_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="Shows">
                      <select className={denseInputCls} value={v.entity} onChange={(ev) => setView(vi, (x) => void ((x.entity = ev.target.value), delete x.fields, delete x.groupBy, delete x.sort, delete x.filters))}>
                        {spec.entities.map((e) => (
                          <option key={e.key} value={e.key}>
                            {e.labelPlural ?? e.label}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="Fields (keys, in order)">
                      <input
                        className={`${denseInputCls} aos-mono`}
                        placeholder="All fields"
                        defaultValue={(v.fields ?? []).join(", ")}
                        key={`${v.entity}-${(v.fields ?? []).join(",")}`}
                        onBlur={(ev) => {
                          const list = ev.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                          setView(vi, (x) => void (list.length ? (x.fields = list) : delete x.fields));
                        }}
                      />
                    </Cell>
                    {v.type === "kanban" ? (
                      <Cell label="Columns from">
                        <select className={denseInputCls} value={v.groupBy ?? ""} onChange={(ev) => setView(vi, (x) => void (x.groupBy = ev.target.value || undefined))}>
                          <option value="">Choose a choice field</option>
                          {ent?.fields.filter((f) => f.type === "select").map((f) => (
                            <option key={f.key} value={f.key}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </Cell>
                    ) : (
                      <Cell label="Sort">
                        <select
                          className={denseInputCls}
                          value={v.sort ? `${v.sort.field}:${v.sort.dir}` : ""}
                          onChange={(ev) =>
                            setView(vi, (x) => {
                              const [field, dir] = ev.target.value.split(":");
                              if (field && (dir === "asc" || dir === "desc")) x.sort = { field, dir };
                              else delete x.sort;
                            })
                          }
                        >
                          <option value="">Newest first</option>
                          {[...(ent?.fields ?? []).map((f) => ({ key: f.key, label: f.label })), { key: "updatedAt", label: "Last changed" }].flatMap((f) => [
                            <option key={`${f.key}:asc`} value={`${f.key}:asc`}>
                              {f.label} ↑
                            </option>,
                            <option key={`${f.key}:desc`} value={`${f.key}:desc`}>
                              {f.label} ↓
                            </option>,
                          ])}
                        </select>
                      </Cell>
                    )}
                    <Cell label="Who sees it">
                      <select className={denseInputCls} value={v.minRole ?? "viewer"} onChange={(ev) => setView(vi, (x) => void (ev.target.value === "viewer" ? delete x.minRole : (x.minRole = ev.target.value as ViewSpec["minRole"])))}>
                        {APP_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]} and up
                          </option>
                        ))}
                      </select>
                      {v.filters?.length ? <span className="text-xs text-muted">{v.filters.length} filter{v.filters.length === 1 ? "" : "s"} (JSON)</span> : null}
                    </Cell>
                    <RemoveButton label={`Remove ${v.label}`} onClick={() => update((s) => (s.views.splice(vi, 1), s))} />
                  </div>
                );
              })}
            </Panel>
          </section>

          {/* Actions */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="aos-subheading">What people can do</h2>
                <p className="mt-0.5 text-sm text-muted">Every change to a record goes through one of these. The tier decides the ceremony; deletes always ask first, and money or deletion wording always needs approval.</p>
              </div>
              <button
                type="button"
                className={aosButton({ variant: "secondary", size: "sm" })}
                onClick={() => update((s) => (s.actions.push({ key: uniqueKey("action", s.actions.map((a) => a.key)), label: "New action", type: "update_record", entity: s.entities[0]!.key, tier: 0 }), s))}
              >
                <Plus size={15} aria-hidden />
                Add action
              </button>
            </div>
            <Panel className="flex flex-col divide-y divide-line">
              {spec.actions.length === 0 ? <p className="px-5 py-4 text-md text-muted">No actions: the app is read-only.</p> : null}
              {spec.actions.map((a, ai) => {
                const ent = spec.entities.find((e) => e.key === a.entity);
                return (
                  <div key={ai} className="grid items-start gap-3 px-5 py-3 md:grid-cols-[1.2fr_1fr_1.1fr_1fr_1.1fr_1fr_1.6fr_auto]">
                    <Cell label="Button">
                      <input className={denseInputCls} value={a.label} onChange={(ev) => setAction(ai, (x) => void (x.label = ev.target.value))} />
                    </Cell>
                    <Cell label="Key">
                      <input className={`${denseInputCls} aos-mono`} value={a.key} onChange={(ev) => setAction(ai, (x) => void (x.key = ev.target.value))} />
                    </Cell>
                    <Cell label="Does">
                      <select
                        className={denseInputCls}
                        value={a.type}
                        onChange={(ev) =>
                          setAction(ai, (x) => {
                            x.type = ev.target.value as ActionSpec["type"];
                            for (const k of ["set", "workflowId", "tool", "args", "projectId"] as const) delete x[k];
                            if (x.type === "delete_record" && (x.tier ?? 0) < 1) x.tier = 1;
                            if (x.type === "run_workflow") x.workflowId = props.workflows[0]?.id ?? "";
                          })
                        }
                      >
                        {ACTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {ACTION_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="On">
                      <select className={denseInputCls} value={a.entity ?? ""} onChange={(ev) => setAction(ai, (x) => void (ev.target.value ? (x.entity = ev.target.value) : delete x.entity))}>
                        {a.type === "run_workflow" || a.type === "call_tool" ? <option value="">The whole app</option> : null}
                        {spec.entities.map((e) => (
                          <option key={e.key} value={e.key}>
                            {e.labelPlural ?? e.label}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="Tier">
                      <select className={denseInputCls} value={a.tier ?? 0} onChange={(ev) => setAction(ai, (x) => void (x.tier = Number(ev.target.value) as ActionSpec["tier"]))}>
                        {([0, 1, 2] as const).map((t) => (
                          <option key={t} value={t}>
                            {TIER_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </Cell>
                    <Cell label="Who can">
                      <select className={denseInputCls} value={a.minRole ?? "editor"} onChange={(ev) => setAction(ai, (x) => void (ev.target.value === "editor" ? delete x.minRole : (x.minRole = ev.target.value as ActionSpec["minRole"])))}>
                        {APP_ROLES.filter((r) => r !== "viewer").map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]} and up
                          </option>
                        ))}
                      </select>
                    </Cell>
                    {a.type === "update_record" ? (
                      <Cell label="Sets (blank = edit form)">
                        <input
                          className={`${denseInputCls} aos-mono`}
                          placeholder="status=Done"
                          defaultValue={setToText(a.set)}
                          key={setToText(a.set)}
                          onBlur={(ev) => setAction(ai, (x) => void ((x.set = textToSet(ev.target.value, ent)), x.set === undefined && delete x.set))}
                        />
                      </Cell>
                    ) : a.type === "run_workflow" ? (
                      <Cell label="Workflow">
                        <select className={denseInputCls} value={a.workflowId ?? ""} onChange={(ev) => setAction(ai, (x) => void (x.workflowId = ev.target.value))}>
                          <option value="">Choose a workflow</option>
                          {props.workflows.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </Cell>
                    ) : a.type === "call_tool" ? (
                      <Cell label="Tool">
                        <input className={`${denseInputCls} aos-mono`} list="app-tools" value={a.tool ?? ""} placeholder="get_keywords" onChange={(ev) => setAction(ai, (x) => void (x.tool = ev.target.value))} />
                      </Cell>
                    ) : (
                      <span />
                    )}
                    <RemoveButton label={`Remove ${a.label}`} onClick={() => update((s) => (s.actions.splice(ai, 1), s))} />
                  </div>
                );
              })}
            </Panel>
            <datalist id="app-tools">
              {props.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.group}
                </option>
              ))}
            </datalist>
          </section>

          {/* Tool groups */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="aos-subheading">Agent tools it may call</h2>
              <p className="mt-0.5 text-sm text-muted">Call-tool actions can only use tools in these groups (workspace reads are always allowed). Publishing grants them.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {props.toolGroups.map((g) => {
                const on = spec.toolGroups?.includes(g.value) ?? false;
                return (
                  <FilterPill
                    key={g.value}
                    selected={on}
                    onClick={() =>
                      update((s) => {
                        const set = new Set(s.toolGroups ?? []);
                        if (on) set.delete(g.value);
                        else set.add(g.value);
                        if (set.size) s.toolGroups = [...set];
                        else delete s.toolGroups;
                        return s;
                      })
                    }
                  >
                    {g.label}
                  </FilterPill>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Save / publish bar */}
      <div className="sticky bottom-3 z-30 rounded-lg bg-paper px-4 py-3 shadow-raised">
        <div className="flex flex-wrap items-center gap-2">
          {props.published ? (
            <Link href={`/dashboard/apps/${props.slug}`} className={aosButton({ variant: "quiet", size: "sm" })}>
              <ExternalLink size={15} aria-hidden />
              Open app
            </Link>
          ) : null}
          {props.canPublish ? (
            <button type="button" className={aosButton({ variant: "deny", size: "sm" })} onClick={remove} disabled={busy !== null}>
              Delete app
            </button>
          ) : null}
          <span className="ml-auto" />
          {props.canPublish && props.published ? (
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={unpublish} disabled={busy !== null}>
              {busy === "unpublish" ? "Unpublishing" : "Unpublish"}
            </button>
          ) : null}
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => void save().then((ok) => ok && toast({ status: "done", title: "Draft saved" }))} disabled={busy !== null || !dirty || !parsed.ok || mode === "json"}>
            {busy === "save" ? "Saving" : "Save draft"}
          </button>
          {props.canPublish ? (
            <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={publish} disabled={busy !== null || !parsed.ok || mode === "json" || (!dirty && !props.hasDraftChanges && props.published)}>
              {busy === "publish" ? "Publishing" : props.published ? "Publish changes" : "Publish"}
            </button>
          ) : (
            <span className="text-sm text-muted">An admin publishes this app.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldExtras({ field: f, entities, onChange }: { field: FieldSpec; entities: EntitySpec[]; onChange: (fn: (f: FieldSpec) => void) => void }) {
  switch (f.type) {
    case "select":
      return (
        <Cell label="Choices (comma-separated)">
          <input
            className={denseInputCls}
            defaultValue={(f.options ?? []).join(", ")}
            key={(f.options ?? []).join(",")}
            onBlur={(ev) => onChange((x) => void (x.options = ev.target.value.split(",").map((s) => s.trim()).filter(Boolean)))}
          />
        </Cell>
      );
    case "relation":
      return (
        <Cell label="Links to">
          <select className={denseInputCls} value={f.target ?? ""} onChange={(ev) => onChange((x) => void (x.target = ev.target.value))}>
            {entities.map((e) => (
              <option key={e.key} value={e.key}>
                {e.labelPlural ?? e.label}
              </option>
            ))}
          </select>
        </Cell>
      );
    case "text":
      return (
        <Cell label="Format">
          <select className={denseInputCls} value={f.format ?? ""} onChange={(ev) => onChange((x) => void (ev.target.value ? (x.format = ev.target.value as FieldSpec["format"]) : delete x.format))}>
            <option value="">One line</option>
            <option value="multiline">Several lines</option>
            <option value="email">Email</option>
            <option value="url">Link</option>
          </select>
        </Cell>
      );
    case "number":
    case "money": {
      const money = f.type === "money";
      const toIn = (n: number | undefined) => (n === undefined ? "" : money ? String(n / 100) : String(n));
      const fromIn = (s: string) => (s.trim() === "" ? undefined : money ? Math.round(Number(s) * 100) : Number(s));
      return (
        <div className="grid grid-cols-2 gap-2">
          <Cell label={money ? "Min ($)" : "Min"}>
            <input className={denseInputCls} inputMode="decimal" defaultValue={toIn(f.min)} key={`min-${f.min}`} onBlur={(ev) => onChange((x) => void ((x.min = fromIn(ev.target.value)), x.min === undefined && delete x.min))} />
          </Cell>
          <Cell label={money ? "Max ($)" : "Max"}>
            <input className={denseInputCls} inputMode="decimal" defaultValue={toIn(f.max)} key={`max-${f.max}`} onBlur={(ev) => onChange((x) => void ((x.max = fromIn(ev.target.value)), x.max === undefined && delete x.max))} />
          </Cell>
        </div>
      );
    }
    default:
      return <span />;
  }
}
