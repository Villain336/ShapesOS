// Marketr — programmatic SEO studio UI (milestone 17).
// Client island: templates (editor with variable insertion), datasets
// (CSV upload, column mapping, row preview), pages (preview-before-generate,
// quality flags, approve/publish/discard, export, sitemap).

"use client";

import { useEffect, useMemo, useState } from "react";

export interface TemplateRow {
  id: string;
  name: string;
  urlPattern: string;
  titleTemplate: string;
  descriptionTemplate: string;
  contentBlocks: unknown;
  minWordCount: number;
  duplicateRateCap: number;
  noindexUntilApproved: boolean;
  defaultPublishTarget: string;
  defaultTargetSiteId: string | null;
  defaultWebflowCollectionId: string | null;
  variables?: { name: string; fallback?: string }[];
  pageCounts?: { total: number; draft: number; ready: number; published: number };
  createdAt: string;
  updatedAt: string;
}

export interface SiteOption {
  id: string;
  name: string;
  sourceType: string;
  isMock: boolean;
}

export const TARGET_LABELS: Record<string, string> = {
  none: "None (template default)",
  csv: "CSV export (internal)",
  wordpress: "WordPress",
  webflow: "Webflow",
  "marketr-site": "Marketr site",
};

export interface PageRow {
  id: string;
  url: string;
  slug: string;
  status: "draft" | "ready" | "published" | "discarded";
  title: string;
  description: string;
  wordCount: number;
  missingVariables: string[];
  qualityFlags: string[];
  noindex: boolean;
  canonical: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  publishTarget: string;
  targetSiteId: string | null;
  webflowCollectionId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  html: string;
  template: {
    id: string;
    name: string;
    minWordCount: number;
    duplicateRateCap: number;
    defaultPublishTarget?: string;
    defaultTargetSiteId?: string | null;
    defaultWebflowCollectionId?: string | null;
  };
  dataset: { id: string; name: string } | null;
  rowIndex: number;
}

export interface DatasetRow {
  id: string;
  name: string;
  columns: string[];
  rowCount: number;
  columnMapping: Record<string, string> | null;
  pageCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface SimpleBlock {
  type: "paragraph" | "h1" | "h2" | "h3" | "bullet";
  text: string;
}

const BLOCK_TYPES: { value: SimpleBlock["type"]; label: string }[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
  { value: "bullet", label: "Bullet" },
];

const FLAG_LABELS: Record<string, string> = {
  missing_variable: "missing variable",
  thin_content: "thin content",
  duplicate_content: "duplicate content",
  slug_collision: "slug collision",
};

function extractVars(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\|[^}]*)?\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) out.add(m[1]);
  }
  return [...out];
}

function tiptapToSimple(doc: unknown): SimpleBlock[] {
  const blocks: SimpleBlock[] = [];
  const root = doc as { content?: unknown[] } | null;
  if (!root || !Array.isArray(root.content)) return blocks;
  const textOf = (n: unknown): string => {
    const node = n as { text?: string; content?: unknown[]; type?: string };
    if (typeof node.text === "string") return node.text;
    return (node.content ?? []).map(textOf).join("");
  };
  for (const n of root.content) {
    const node = n as { type?: string; attrs?: { level?: number }; content?: unknown[] };
    if (node.type === "bulletList") {
      for (const li of node.content ?? []) {
        const item = li as { content?: unknown[] };
        const p = item.content?.find((c) => (c as { type?: string }).type === "paragraph");
        blocks.push({ type: "bullet", text: textOf(p ?? li) });
      }
    } else if (node.type === "heading") {
      const level = node.attrs?.level;
      blocks.push({ type: level === 2 ? "h2" : level === 3 ? "h3" : "h1", text: textOf(node) });
    } else if (node.type === "paragraph") {
      blocks.push({ type: "paragraph", text: textOf(node) });
    }
  }
  return blocks;
}

const inputCls =
  "w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-500 focus:border-orange-500 focus:outline-none";
const btnPrimary =
  "rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2";
const btnSecondary =
  "rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 hover:border-zinc-400 disabled:opacity-50";
const btnDanger =
  "rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:border-red-300 disabled:opacity-50";

function FlagBadge({ flag }: { flag: string }) {
  return (
    <span className="inline-block rounded-full bg-amber-100/40 px-2 py-0.5 text-xs text-amber-700">
      {FLAG_LABELS[flag] ?? flag}
    </span>
  );
}

function StatusBadge({ status }: { status: PageRow["status"] }) {
  const colors: Record<string, string> = {
    draft: "bg-zinc-100 text-zinc-500",
    ready: "bg-blue-100/40 text-blue-700",
    published: "bg-emerald-900/40 text-emerald-700",
    discarded: "bg-white text-zinc-500",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${colors[status]}`}>{status}</span>
  );
}

// ---------------------------------------------------------------------------
// Template editor
// ---------------------------------------------------------------------------

function TemplateEditor({
  projectId,
  initial,
  datasetColumns,
  sites,
  onSaved,
  onCancel,
}: {
  projectId: string;
  initial: TemplateRow | null;
  datasetColumns: string[];
  sites: SiteOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [urlPattern, setUrlPattern] = useState(initial?.urlPattern ?? "/services/{{city}}/{{service}}");
  const [titleTemplate, setTitleTemplate] = useState(initial?.titleTemplate ?? "{{service}} in {{city}} | {{company}}");
  const [descriptionTemplate, setDescriptionTemplate] = useState(initial?.descriptionTemplate ?? "");
  const [blocks, setBlocks] = useState<SimpleBlock[]>(
    initial ? tiptapToSimple(initial.contentBlocks) : [{ type: "h1", text: "{{service}} in {{city}}" }, { type: "paragraph", text: "Looking for {{service}} in {{city}}? ..." }],
  );
  const [minWordCount, setMinWordCount] = useState(initial?.minWordCount ?? 300);
  const [duplicateRateCap, setDuplicateRateCap] = useState(initial?.duplicateRateCap ?? 0.05);
  const [noindexUntilApproved, setNoindexUntilApproved] = useState(initial?.noindexUntilApproved ?? true);
  const [defaultPublishTarget, setDefaultPublishTarget] = useState(initial?.defaultPublishTarget ?? "none");
  const [defaultTargetSiteId, setDefaultTargetSiteId] = useState(initial?.defaultTargetSiteId ?? "");
  const [defaultWebflowCollectionId, setDefaultWebflowCollectionId] = useState(initial?.defaultWebflowCollectionId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<"title" | "description" | "url" | number>("title");

  const detectedVars = useMemo(
    () => extractVars(urlPattern, titleTemplate, descriptionTemplate, ...blocks.map((b) => b.text)),
    [urlPattern, titleTemplate, descriptionTemplate, blocks],
  );

  function insertVariable(v: string) {
    const tag = `{{${v}}}`;
    if (activeField === "title") setTitleTemplate((t) => t + tag);
    else if (activeField === "description") setDescriptionTemplate((t) => t + tag);
    else if (activeField === "url") setUrlPattern((t) => t + tag);
    else {
      setBlocks((bs) => bs.map((b, i) => (i === activeField ? { ...b, text: b.text + tag } : b)));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const payload = {
      projectId,
      name,
      urlPattern,
      titleTemplate,
      descriptionTemplate,
      contentBlocks: blocks,
      minWordCount,
      duplicateRateCap,
      noindexUntilApproved,
      defaultPublishTarget,
      defaultTargetSiteId: ["wordpress", "webflow", "marketr-site"].includes(defaultPublishTarget) && defaultTargetSiteId ? defaultTargetSiteId : null,
      defaultWebflowCollectionId: defaultPublishTarget === "webflow" && defaultWebflowCollectionId.trim() ? defaultWebflowCollectionId.trim() : null,
    };
    const url = initial ? `/api/programmatic/templates/${initial.id}` : "/api/programmatic/templates";
    const res = await fetch(url, {
      method: initial ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Save failed");
      return;
    }
    onSaved();
  }

  const insertSources = [...new Set([...detectedVars, ...datasetColumns])];

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-5">
      <h3 className="mb-4 text-base font-semibold">{initial ? "Edit template" : "New template"}</h3>
      {error && <p className="mb-3 rounded-md bg-red-100/30 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Name</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="City × service pages" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">URL pattern</span>
          <input
            className={inputCls + " font-mono"}
            value={urlPattern}
            onFocus={() => setActiveField("url")}
            onChange={(e) => setUrlPattern(e.target.value)}
            placeholder="/services/{{city}}/{{service}}"
          />
        </label>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Title template</span>
          <input className={inputCls} value={titleTemplate} onFocus={() => setActiveField("title")} onChange={(e) => setTitleTemplate(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Meta description template</span>
          <input className={inputCls} value={descriptionTemplate} onFocus={() => setActiveField("description")} onChange={(e) => setDescriptionTemplate(e.target.value)} />
        </label>
      </div>

      <div className="mt-4">
        <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Insert variable</span>
        <div className="flex flex-wrap gap-1.5">
          {insertSources.length === 0 && <span className="text-xs text-zinc-500">Type {"{{var}}"} in a field to detect variables, or upload a dataset.</span>}
          {insertSources.map((v) => (
            <button key={v} type="button" onClick={() => insertVariable(v)} className="rounded border border-zinc-200 px-2 py-0.5 font-mono text-xs text-zinc-500 hover:border-zinc-400">
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">Fallbacks: {"{{city|your area}}"} renders “your area” when city is empty.</p>
      </div>

      <div className="mt-4">
        <span className="mb-2 block text-xs uppercase tracking-widest text-zinc-500">Content blocks</span>
        <div className="flex flex-col gap-2">
          {blocks.map((b, i) => (
            <div key={i} className="flex gap-2">
              <select
                className="w-28 rounded-md border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-800"
                value={b.type}
                onChange={(e) => setBlocks((bs) => bs.map((x, j) => (j === i ? { ...x, type: e.target.value as SimpleBlock["type"] } : x)))}
              >
                {BLOCK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <input
                className={inputCls}
                value={b.text}
                onFocus={() => setActiveField(i)}
                onChange={(e) => setBlocks((bs) => bs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                placeholder="Block text with {{variables}}"
              />
              <button type="button" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))} className={btnDanger}>✕</button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setBlocks((bs) => [...bs, { type: "paragraph", text: "" }])}
          className="mt-2 rounded-md border border-dashed border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:border-zinc-400"
        >
          + Add block
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Min words (gate)</span>
          <input type="number" className={inputCls} value={minWordCount} min={50} max={10000} onChange={(e) => setMinWordCount(Number(e.target.value))} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-zinc-500">Duplicate-rate cap (0–1)</span>
          <input type="number" className={inputCls} value={duplicateRateCap} min={0} max={1} step={0.01} onChange={(e) => setDuplicateRateCap(Number(e.target.value))} />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm text-zinc-500">
          <input type="checkbox" checked={noindexUntilApproved} onChange={(e) => setNoindexUntilApproved(e.target.checked)} />
          noindex until published
        </label>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 p-4">
        <span className="mb-2 block text-xs uppercase tracking-widest text-zinc-500">Default publish target</span>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Target</span>
            <select
              className={inputCls}
              value={defaultPublishTarget}
              onChange={(e) => { setDefaultPublishTarget(e.target.value); setDefaultTargetSiteId(""); }}
            >
              {Object.entries(TARGET_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          {["wordpress", "webflow", "marketr-site"].includes(defaultPublishTarget) && (
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Site</span>
              <select className={inputCls} value={defaultTargetSiteId} onChange={(e) => setDefaultTargetSiteId(e.target.value)}>
                <option value="">— pick a site —</option>
                {sites
                  .filter((s) =>
                    defaultPublishTarget === "wordpress" ? s.sourceType === "wordpress"
                    : defaultPublishTarget === "webflow" ? s.sourceType === "webflow"
                    : true)
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.sourceType}{s.isMock ? ", mock" : ""})</option>
                  ))}
              </select>
            </label>
          )}
          {defaultPublishTarget === "webflow" && (
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Webflow collection id</span>
              <input className={inputCls + " font-mono"} value={defaultWebflowCollectionId} onChange={(e) => setDefaultWebflowCollectionId(e.target.value)} placeholder="col-…" />
            </label>
          )}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Pages of this template publish here by default; individual pages can override it in the Pages tab. Quality gates still run before every push.
        </p>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Saving…" : initial ? "Save changes" : "Create template"}</button>
        <button onClick={onCancel} className={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Templates tab
// ---------------------------------------------------------------------------

function TemplatesTab({
  projectId,
  canEdit,
  templates,
  datasets,
  sites,
  refresh,
}: {
  projectId: string;
  canEdit: boolean;
  templates: TemplateRow[];
  datasets: DatasetRow[];
  sites: SiteOption[];
  refresh: () => void;
}) {
  const [editing, setEditing] = useState<TemplateRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const datasetColumns = useMemo(() => [...new Set(datasets.flatMap((d) => d.columns))], [datasets]);

  async function remove(id: string) {
    if (!confirm("Delete this template and all its non-published pages?")) return;
    setDeleting(id);
    setError(null);
    const res = await fetch(`/api/programmatic/templates/${id}?projectId=${projectId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setDeleting(null);
    if (!res.ok) {
      setError(data.error ?? "Delete failed");
      return;
    }
    refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="rounded-md bg-red-100/30 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">Templates</h2>
        {canEdit && (
          <button onClick={() => setEditing("new")} className={btnSecondary}>+ New template</button>
        )}
      </div>
      {editing && (
        <TemplateEditor
          projectId={projectId}
          initial={editing === "new" ? null : editing}
          datasetColumns={datasetColumns}
          sites={sites}
          onSaved={() => { setEditing(null); refresh(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      {templates.length === 0 && !editing && (
        <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
          No templates yet. Create one to start generating pages.
        </p>
      )}
      <div className="grid gap-3">
        {templates.map((t) => (
          <div key={t.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold">{t.name}</h3>
                <p className="mt-0.5 font-mono text-xs text-zinc-500">{t.urlPattern}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(t.variables ?? []).map((v) => (
                    <span key={v.name} className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-500">
                      {`{{${v.name}${v.fallback !== undefined ? `|${v.fallback}` : ""}}}`}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Gates: ≥{t.minWordCount} words · duplicate cap {(t.duplicateRateCap * 100).toFixed(0)}%
                  {t.noindexUntilApproved ? " · noindex until published" : ""}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Default publish: {TARGET_LABELS[t.defaultPublishTarget] ?? t.defaultPublishTarget}
                  {t.defaultTargetSiteId ? ` → ${sites.find((s) => s.id === t.defaultTargetSiteId)?.name ?? t.defaultTargetSiteId}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right text-xs text-zinc-500">
                  <div>{t.pageCounts?.published ?? 0} published</div>
                  <div>{t.pageCounts?.ready ?? 0} ready · {t.pageCounts?.draft ?? 0} draft</div>
                </div>
                {canEdit && (
                  <>
                    <button onClick={() => setEditing(t)} className={btnSecondary}>Edit</button>
                    <button onClick={() => remove(t.id)} disabled={deleting === t.id} className={btnDanger}>
                      {deleting === t.id ? "…" : "Delete"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datasets tab
// ---------------------------------------------------------------------------

function DatasetsTab({
  projectId,
  canEdit,
  datasets,
  templates,
  refresh,
}: {
  projectId: string;
  canEdit: boolean;
  datasets: DatasetRow[];
  templates: TemplateRow[];
  refresh: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, { columns: string[]; rows: Record<string, string>[] }>>({});
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [mappingFor, setMappingFor] = useState<string | null>(null);
  const [mappingDraft, setMappingDraft] = useState<Record<string, string>>({});

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("projectId", projectId);
    form.append("file", file);
    form.append("name", file.name.replace(/\.csv$/i, ""));
    const res = await fetch("/api/programmatic/datasets", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    setUploading(false);
    e.target.value = "";
    if (!res.ok) {
      setError(data.error ?? "Upload failed");
      return;
    }
    refresh();
  }

  async function loadPreview(id: string) {
    if (previews[id]) {
      setPreviews((p) => { const n = { ...p }; delete n[id]; return n; });
      return;
    }
    setLoadingPreview(id);
    const res = await fetch(`/api/programmatic/datasets/${id}?projectId=${projectId}&rows=10`);
    const data = await res.json().catch(() => ({}));
    setLoadingPreview(null);
    if (res.ok) {
      setPreviews((p) => ({ ...p, [id]: { columns: data.dataset.columns, rows: data.dataset.rowPreview } }));
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this dataset? Generated pages must be deleted first.")) return;
    const res = await fetch(`/api/programmatic/datasets/${id}?projectId=${projectId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Delete failed");
      return;
    }
    refresh();
  }

  function openMapping(d: DatasetRow) {
    setMappingFor(d.id);
    setMappingDraft(d.columnMapping ?? {});
  }

  async function saveMapping(d: DatasetRow) {
    const res = await fetch(`/api/programmatic/datasets/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, columnMapping: mappingDraft }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Mapping save failed");
      return;
    }
    setMappingFor(null);
    refresh();
  }

  const templateVars = useMemo(
    () => [...new Set(templates.flatMap((t) => (t.variables ?? []).map((v) => v.name)))],
    [templates],
  );

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="rounded-md bg-red-100/30 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">Datasets</h2>
        {canEdit && (
          <label className={btnSecondary + " cursor-pointer"}>
            {uploading ? "Uploading…" : "+ Upload CSV"}
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={upload} disabled={uploading} />
          </label>
        )}
      </div>
      <p className="text-xs text-zinc-500">CSV upload, parsed server-side. 10,000-row cap. Columns auto-map to template variables by name; override below when names differ.</p>
      {datasets.length === 0 && (
        <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
          No datasets yet. Upload a CSV to feed your templates.
        </p>
      )}
      <div className="grid gap-3">
        {datasets.map((d) => (
          <div key={d.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold">{d.name}</h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {d.rowCount.toLocaleString()} rows · {d.columns.length} columns · {d.pageCount ?? 0} pages generated
                </p>
                <p className="mt-1 font-mono text-xs text-zinc-500">{d.columns.join(", ")}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button onClick={() => loadPreview(d.id)} className={btnSecondary}>
                  {loadingPreview === d.id ? "…" : previews[d.id] ? "Hide rows" : "Preview rows"}
                </button>
                {canEdit && templateVars.length > 0 && (
                  <button onClick={() => openMapping(d)} className={btnSecondary}>Column mapping</button>
                )}
                {canEdit && (
                  <button onClick={() => remove(d.id)} className={btnDanger}>Delete</button>
                )}
              </div>
            </div>
            {previews[d.id] && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-zinc-500">
                      {previews[d.id].columns.map((c) => (
                        <th key={c} className="border-b border-zinc-200 px-2 py-1 font-medium">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previews[d.id].rows.map((r, i) => (
                      <tr key={i} className="text-zinc-500">
                        {previews[d.id].columns.map((c) => (
                          <td key={c} className="border-b border-zinc-300 px-2 py-1">{String(r[c] ?? "")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {mappingFor === d.id && (
              <div className="mt-3 rounded-lg border border-zinc-200 p-3">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">Variable → column mapping</h4>
                <div className="grid gap-2 md:grid-cols-2">
                  {templateVars.map((v) => (
                    <label key={v} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 font-mono text-xs text-zinc-500">{`{{${v}}}`}</span>
                      <select
                        className="flex-1 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-800"
                        value={mappingDraft[v] ?? ""}
                        onChange={(e) => setMappingDraft((m) => { const n = { ...m }; if (e.target.value) n[v] = e.target.value; else delete n[v]; return n; })}
                      >
                        <option value="">auto ({d.columns.find((c) => c.toLowerCase() === v.toLowerCase()) ?? "—"})</option>
                        {d.columns.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => saveMapping(d)} className={btnPrimary}>Save mapping</button>
                  <button onClick={() => setMappingFor(null)} className={btnSecondary}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pages tab
// ---------------------------------------------------------------------------

interface PreviewPage {
  rowIndex: number;
  url: string;
  slug: string;
  title: string;
  description: string;
  wordCount: number;
  flags: string[];
  missingVariables: string[];
  html: string;
}

function PagesTab({
  projectId,
  canEdit,
  templates,
  datasets,
  counts,
  sites,
  refreshAll,
}: {
  projectId: string;
  canEdit: boolean;
  templates: TemplateRow[];
  datasets: DatasetRow[];
  counts: Record<string, number>;
  sites: SiteOption[];
  refreshAll: () => void;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewPage[] | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [actionResult, setActionResult] = useState<{
    changed: string[];
    blocked: { id: string; url: string; reasons: string[] }[];
    pushes?: { id: string; url: string; target: string; siteName: string | null; externalId: string | null; externalUrl: string | null; updated: boolean; mock: boolean }[];
  } | null>(null);
  const [drawer, setDrawer] = useState<PageRow | PreviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushModal, setPushModal] = useState(false);
  const [pushTarget, setPushTarget] = useState("");
  const [pushSiteId, setPushSiteId] = useState("");
  const [pushCollectionId, setPushCollectionId] = useState("");
  const [pushWebflowPublish, setPushWebflowPublish] = useState(false);

  async function loadPages() {
    setLoading(true);
    const params = new URLSearchParams({ projectId });
    if (statusFilter) params.set("status", statusFilter);
    if (templateId) params.set("templateId", templateId);
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`/api/programmatic/pages?${params}`);
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (res.ok) {
      setPages(data.pages ?? []);
      setSelected(new Set());
    }
  }

  async function runPreview() {
    if (!templateId || !datasetId) return;
    setPreviewing(true);
    setError(null);
    const res = await fetch("/api/programmatic/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, templateId, datasetId, action: "preview", limit: 5 }),
    });
    const data = await res.json().catch(() => ({}));
    setPreviewing(false);
    if (!res.ok) {
      setError(data.error ?? "Preview failed");
      return;
    }
    setPreview(data.pages ?? []);
    setPreviewTotal(data.totalRows ?? 0);
  }

  async function runGenerate() {
    if (!templateId || !datasetId) return;
    if (!confirm("Generate pages for all dataset rows? Preview first if you haven't.")) return;
    setGenerating(true);
    setError(null);
    setGenResult(null);
    const res = await fetch("/api/programmatic/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, templateId, datasetId, action: "generate" }),
    });
    const data = await res.json().catch(() => ({}));
    setGenerating(false);
    if (!res.ok) {
      setError(data.error ?? "Generation failed");
      return;
    }
    setGenResult(data);
    loadPages();
    refreshAll();
  }

  async function bulkAction(action: "approve" | "publish" | "discard") {
    if (selected.size === 0) return;
    if (action === "publish") {
      // Destination summary modal — no silent pushes.
      setPushTarget("");
      setPushSiteId("");
      setPushCollectionId("");
      setPushWebflowPublish(false);
      setPushModal(true);
      return;
    }
    const verb = action === "approve" ? "approve" : "discard";
    if (!confirm(`${verb} ${selected.size} page(s)? Quality gates run server-side.`)) return;
    setActing(true);
    setActionResult(null);
    const res = await fetch("/api/programmatic/pages", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, pageIds: [...selected], action }),
    });
    const data = await res.json().catch(() => ({}));
    setActing(false);
    if (!res.ok) {
      setError(data.error ?? "Action failed");
      return;
    }
    setActionResult(data);
    loadPages();
    refreshAll();
  }

  /** Effective destination for one page: explicit modal override > page override > template default. */
  function effectiveDest(p: PageRow): { kind: string; siteId: string | null; collectionId: string | null } {
    const explicit = pushModal ? { target: pushTarget || undefined, siteId: pushSiteId || undefined, collectionId: pushCollectionId || undefined } : {};
    const kind =
      explicit.target !== undefined ? explicit.target
      : p.publishTarget !== "none" ? p.publishTarget
      : p.template.defaultPublishTarget ?? "none";
    const siteId =
      explicit.siteId !== undefined ? explicit.siteId
      : (p.targetSiteId ?? p.template.defaultTargetSiteId ?? null);
    const collectionId =
      explicit.collectionId !== undefined ? explicit.collectionId
      : (p.webflowCollectionId ?? p.template.defaultWebflowCollectionId ?? null);
    return { kind, siteId, collectionId };
  }

  function siteName(id: string | null): string | null {
    if (!id) return null;
    return sites.find((s) => s.id === id)?.name ?? id;
  }

  async function confirmPush() {
    if (selected.size === 0) return;
    setActing(true);
    setActionResult(null);
    const body: Record<string, unknown> = { projectId, pageIds: [...selected], action: "push" };
    if (pushTarget) body.target = pushTarget;
    if (pushSiteId) body.siteId = pushSiteId;
    if (pushCollectionId.trim()) body.collectionId = pushCollectionId.trim();
    if (pushWebflowPublish) body.webflowPublish = true;
    const res = await fetch("/api/programmatic/pages", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setActing(false);
    setPushModal(false);
    if (!res.ok) {
      setError(data.error ?? "Push failed");
      return;
    }
    setActionResult(data);
    loadPages();
    refreshAll();
  }

  async function setPageTarget(pageId: string, target: string) {
    setError(null);
    const res = await fetch("/api/programmatic/pages", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, pageIds: [pageId], action: "setTarget", target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Could not set target");
      return;
    }
    loadPages();
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const drawerIsPage = drawer !== null && "status" in drawer;
  const drawerFlags: string[] = drawer === null ? [] : drawerIsPage ? (drawer as PageRow).qualityFlags : (drawer as PreviewPage).flags;
  const drawerMissing: string[] = drawer?.missingVariables ?? [];

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="rounded-md bg-red-100/30 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* Generation controls */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">Generate</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Template</span>
            <select className={inputCls} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">Dataset</span>
            <select className={inputCls} value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.rowCount.toLocaleString()} rows)</option>
              ))}
            </select>
          </label>
        </div>
        {canEdit && (
          <div className="mt-3 flex gap-2">
            <button onClick={runPreview} disabled={previewing || !templateId || !datasetId} className={btnSecondary}>
              {previewing ? "Rendering…" : "Preview first 5"}
            </button>
            <button onClick={runGenerate} disabled={generating || !templateId || !datasetId} className={btnPrimary}>
              {generating ? "Generating…" : "Generate all rows"}
            </button>
          </div>
        )}
        {genResult && (
          <div className="mt-3 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-500">
            <p>
              Generated: <strong className="text-zinc-900">{String(genResult.created)} created</strong>,{" "}
              {String(genResult.updated)} updated, {String(genResult.flagged)} flagged,{" "}
              {String(genResult.skippedPublished)} published skipped,{" "}
              {(genResult.skippedCollisions as unknown[])?.length ?? 0} slug collisions skipped.
            </p>
          </div>
        )}
      </div>

      {/* Preview results */}
      {preview && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Preview — first {preview.length} of {previewTotal.toLocaleString()} rows</h3>
            <button onClick={() => setPreview(null)} className="text-xs text-zinc-500 hover:text-zinc-600">close</button>
          </div>
          <div className="flex flex-col gap-2">
            {preview.map((p) => (
              <button
                key={p.rowIndex}
                onClick={() => setDrawer(p)}
                className="rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-300"
              >
                <p className="font-mono text-xs text-zinc-500">{p.url}</p>
                <p className="mt-0.5 text-sm font-medium text-zinc-900">{p.title}</p>
                <div className="mt-1 flex gap-1.5">
                  {p.flags.map((f) => (
                    <FlagBadge key={f} flag={f} />
                  ))}
                  {p.flags.length === 0 && <span className="text-xs text-emerald-600">✓ clean</span>}
                  <span className="text-xs text-zinc-500">{p.wordCount} words</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Page list */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-medium uppercase tracking-widest text-zinc-500">Pages</h2>
          {(["", "draft", "ready", "published", "discarded"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs ${statusFilter === s ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-500"}`}
            >
              {s === "" ? `all (${Object.values(counts).reduce((a, b) => a + b, 0)})` : `${s} (${counts[s] ?? 0})`}
            </button>
          ))}
          <input
            className={inputCls + " ml-auto w-48"}
            placeholder="Search URL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadPages()}
          />
          <button onClick={loadPages} disabled={loading} className={btnSecondary}>{loading ? "…" : "Load"}</button>
        </div>

        {canEdit && selected.size > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-zinc-200 p-2">
            <span className="text-xs text-zinc-500">{selected.size} selected</span>
            <button onClick={() => bulkAction("approve")} disabled={acting} className={btnSecondary}>Approve → ready</button>
            <button onClick={() => bulkAction("publish")} disabled={acting} className={btnPrimary}>Publish</button>
            <button onClick={() => bulkAction("discard")} disabled={acting} className={btnDanger}>Discard</button>
          </div>
        )}
        {actionResult && (
          <div className="mb-3 rounded-lg border border-zinc-200 p-3 text-sm">
            <p className="text-emerald-600">{actionResult.changed.length} page(s) updated.</p>
            {actionResult.pushes && actionResult.pushes.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-zinc-500">
                {actionResult.pushes.slice(0, 10).map((pu) => (
                  <li key={pu.id}>
                    <span className="font-mono">{pu.url}</span> → {TARGET_LABELS[pu.target] ?? pu.target}
                    {pu.siteName ? ` · ${pu.siteName}` : ""}
                    {pu.updated ? " (updated in place)" : ""}
                    {pu.mock ? " (mock)" : ""}
                    {pu.externalUrl ? (
                      <> · <a href={pu.externalUrl} target="_blank" rel="noreferrer" className="underline hover:text-zinc-800">{pu.externalUrl}</a></>
                    ) : null}
                  </li>
                ))}
                {actionResult.pushes.length > 10 && <li>…and {actionResult.pushes.length - 10} more</li>}
              </ul>
            )}
            {actionResult.blocked.length > 0 && (
              <div className="mt-2">
                <p className="text-amber-700">{actionResult.blocked.length} blocked by quality gates:</p>
                <ul className="mt-1 list-disc pl-5 text-xs text-zinc-500">
                  {actionResult.blocked.slice(0, 10).map((b) => (
                    <li key={b.id}><span className="font-mono">{b.url}</span> — {b.reasons.join("; ")}</li>
                  ))}
                  {actionResult.blocked.length > 10 && <li>…and {actionResult.blocked.length - 10} more</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                {canEdit && <th className="w-8 px-2 py-1"><input type="checkbox" checked={pages.length > 0 && selected.size === pages.length} onChange={() => setSelected(selected.size === pages.length ? new Set() : new Set(pages.map((p) => p.id)))} /></th>}
                <th className="px-2 py-1">URL</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1">Target</th>
                <th className="px-2 py-1">Flags</th>
                <th className="px-2 py-1">Words</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => {
                const effKind = p.publishTarget !== "none" ? p.publishTarget : (p.template.defaultPublishTarget ?? "none");
                return (
                <tr key={p.id} className="border-t border-zinc-300 text-zinc-500">
                  {canEdit && <td className="px-2 py-2"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} /></td>}
                  <td className="px-2 py-2">
                    <button onClick={() => setDrawer(p)} className="font-mono text-xs text-zinc-800 hover:text-zinc-900">{p.url}</button>
                    <p className="max-w-md truncate text-xs text-zinc-500">{p.title}</p>
                    {p.externalUrl && <p className="max-w-md truncate text-xs text-emerald-600">→ {p.externalUrl}</p>}
                  </td>
                  <td className="px-2 py-2"><StatusBadge status={p.status} /></td>
                  <td className="px-2 py-2">
                    {canEdit ? (
                      <select
                        className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-xs text-zinc-500"
                        value={p.publishTarget}
                        onChange={(e) => setPageTarget(p.id, e.target.value)}
                        title="Per-page publish target override (blank = template default)"
                      >
                        <option value="none">{p.template.defaultPublishTarget && p.template.defaultPublishTarget !== "none" ? `Default: ${TARGET_LABELS[p.template.defaultPublishTarget] ?? p.template.defaultPublishTarget}` : "No target"}</option>
                        <option value="csv">CSV export (internal)</option>
                        <option value="wordpress">WordPress</option>
                        <option value="webflow">Webflow</option>
                        <option value="marketr-site">Marketr site</option>
                      </select>
                    ) : (
                      <span className="text-xs text-zinc-500">{TARGET_LABELS[effKind] ?? effKind}</span>
                    )}
                  </td>
                  <td className="px-2 py-2"><div className="flex flex-wrap gap-1">{p.qualityFlags.map((f) => <FlagBadge key={f} flag={f} />)}</div></td>
                  <td className="px-2 py-2 text-xs text-zinc-500">{p.wordCount}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {pages.length === 0 && !loading && (
            <p className="p-6 text-center text-sm text-zinc-500">No pages loaded. Pick a template + dataset and generate, or adjust filters.</p>
          )}
        </div>

        <div className="mt-3 flex gap-3 text-xs">
          <a href={`/api/programmatic/export?projectId=${projectId}${templateId ? `&templateId=${templateId}` : ""}`} className="text-zinc-500 underline hover:text-zinc-800">Export CSV</a>
          <a href={`/api/programmatic/sitemap?projectId=${projectId}`} target="_blank" rel="noreferrer" className="text-zinc-500 underline hover:text-zinc-800">View sitemap.xml</a>
        </div>
      </div>

      {/* Publish destination summary modal */}
      {pushModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPushModal(false)}>
          <div className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-zinc-50 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Publish {selected.size} page(s)</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Destination per page (explicit override below wins, else the page override, else the template default).
              Quality gates run server-side — gated pages are blocked, never pushed. Re-pushing to the same
              target updates in place instead of duplicating.
            </p>

            <div className="mt-4 max-h-56 overflow-y-auto rounded-lg border border-zinc-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="px-3 py-2">URL</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Destination</th>
                  </tr>
                </thead>
                <tbody>
                  {pages.filter((p) => selected.has(p.id)).map((p) => {
                    const d = effectiveDest(p);
                    const label =
                      d.kind === "none" ? "— no target —"
                      : d.kind === "csv" ? "CSV export (internal)"
                      : `${TARGET_LABELS[d.kind] ?? d.kind}${d.siteId ? ` → ${siteName(d.siteId) ?? d.siteId}` : " (no site!)"}`;
                    return (
                      <tr key={p.id} className="border-t border-zinc-300 text-zinc-500">
                        <td className="px-3 py-1.5 font-mono">{p.url}</td>
                        <td className="px-3 py-1.5"><StatusBadge status={p.status} /></td>
                        <td className={`px-3 py-1.5 ${d.kind === "none" || ((d.kind === "wordpress" || d.kind === "webflow" || d.kind === "marketr-site") && !d.siteId) ? "text-amber-700" : ""}`}>{label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Override target (all)</span>
                <select className={inputCls} value={pushTarget} onChange={(e) => { setPushTarget(e.target.value); setPushSiteId(""); }}>
                  <option value="">Use per-page/template targets</option>
                  {Object.entries(TARGET_LABELS).filter(([v]) => v !== "none").map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
              {["wordpress", "webflow", "marketr-site"].includes(pushTarget) && (
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">Site</span>
                  <select className={inputCls} value={pushSiteId} onChange={(e) => setPushSiteId(e.target.value)}>
                    <option value="">— pick a site —</option>
                    {sites
                      .filter((s) =>
                        pushTarget === "wordpress" ? s.sourceType === "wordpress"
                        : pushTarget === "webflow" ? s.sourceType === "webflow"
                        : true)
                      .map((s) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.sourceType}{s.isMock ? ", mock" : ""})</option>
                      ))}
                  </select>
                </label>
              )}
              {pushTarget === "webflow" && (
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">Webflow collection id</span>
                  <input className={inputCls + " font-mono"} value={pushCollectionId} onChange={(e) => setPushCollectionId(e.target.value)} placeholder="col-…" />
                </label>
              )}
            </div>
            {pushTarget === "webflow" && (
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                <input type="checkbox" checked={pushWebflowPublish} onChange={(e) => setPushWebflowPublish(e.target.checked)} />
                Publish the Webflow site after the CMS items are saved
              </label>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPushModal(false)} disabled={acting} className={btnSecondary}>Cancel</button>
              <button onClick={confirmPush} disabled={acting} className={btnPrimary}>
                {acting ? "Pushing…" : `Push ${selected.size} page(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setDrawer(null)}>
          <div className="h-full w-full max-w-2xl overflow-y-auto bg-zinc-50 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="font-mono text-sm text-zinc-500">{drawer.url}</p>
                <h2 className="mt-1 text-xl font-bold">{drawer.title}</h2>
                <p className="mt-1 text-sm text-zinc-500">{drawer.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {drawerIsPage && <StatusBadge status={(drawer as PageRow).status} />}
                  {drawerFlags.map((f: string) => (
                    <FlagBadge key={f} flag={f} />
                  ))}
                  {drawerFlags.length === 0 && <span className="text-xs text-emerald-600">✓ clean</span>}
                  <span className="text-xs text-zinc-500">{drawer.wordCount} words</span>
                  {drawerMissing.length > 0 && (
                    <span className="text-xs text-amber-700">missing: {drawerMissing.join(", ")}</span>
                  )}
                </div>
                {drawerIsPage && (
                  <p className="mt-1 text-xs text-zinc-500">
                    canonical: {(drawer as PageRow).canonical ?? "—"} · noindex: {(drawer as PageRow).noindex ? "yes" : "no"}
                  </p>
                )}
                {drawerIsPage && (drawer as PageRow).status === "published" && (
                  <p className="mt-1 text-xs text-emerald-600">
                    Published via {TARGET_LABELS[(drawer as PageRow).publishTarget] ?? (drawer as PageRow).publishTarget}
                    {(drawer as PageRow).publishedAt ? ` · ${new Date((drawer as PageRow).publishedAt!).toLocaleString()}` : ""}
                    {(drawer as PageRow).externalUrl ? (
                      <> · <a href={(drawer as PageRow).externalUrl!} target="_blank" rel="noreferrer" className="underline hover:text-emerald-800">{(drawer as PageRow).externalUrl}</a></>
                    ) : null}
                  </p>
                )}
              </div>
              <button onClick={() => setDrawer(null)} className={btnSecondary}>Close</button>
            </div>
            <div
              className="prose prose-invert max-w-none rounded-xl border border-zinc-200 bg-white/50 p-5 text-sm text-zinc-800 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-bold [&_h3]:font-bold [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
              dangerouslySetInnerHTML={{ __html: drawer.html }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main studio
// ---------------------------------------------------------------------------

export default function ProgrammaticStudio({
  projectId,
  canEdit,
  initialTemplates,
  initialDatasets,
  initialCounts,
}: {
  projectId: string;
  canEdit: boolean;
  initialTemplates: TemplateRow[];
  initialDatasets: DatasetRow[];
  initialCounts: Record<string, number>;
}) {
  const [tab, setTab] = useState<"templates" | "datasets" | "pages">("templates");
  const [templates, setTemplates] = useState(initialTemplates);
  const [datasets, setDatasets] = useState(initialDatasets);
  const [counts, setCounts] = useState(initialCounts);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);

  async function loadSites() {
    try {
      const res = await fetch(`/api/websites?projectId=${projectId}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSites((data.sites ?? []) as SiteOption[]);
    } catch {
      // sites list is a nice-to-have for target pickers; never block the studio
    } finally {
      setSitesLoaded(true);
    }
  }

  // Load the project's sites once (for publish-target pickers).
  useEffect(() => {
    void loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAll() {
    const [tRes, dRes, pRes] = await Promise.all([
      fetch(`/api/programmatic/templates?projectId=${projectId}`),
      fetch(`/api/programmatic/datasets?projectId=${projectId}`),
      fetch(`/api/programmatic/pages?projectId=${projectId}`),
    ]);
    const [t, d, p] = await Promise.all([tRes.json(), dRes.json(), pRes.json()]);
    if (tRes.ok) setTemplates(t.templates ?? []);
    if (dRes.ok) setDatasets(d.datasets ?? []);
    if (pRes.ok) setCounts(p.counts ?? {});
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
        {(["templates", "datasets", "pages"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium capitalize ${tab === t ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-600"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "templates" && (
        <TemplatesTab projectId={projectId} canEdit={canEdit} templates={templates} datasets={datasets} sites={sites} refresh={refreshAll} />
      )}
      {tab === "datasets" && (
        <DatasetsTab projectId={projectId} canEdit={canEdit} datasets={datasets} templates={templates} refresh={refreshAll} />
      )}
      {tab === "pages" && (
        <PagesTab projectId={projectId} canEdit={canEdit} templates={templates} datasets={datasets} counts={counts} sites={sites} refreshAll={refreshAll} />
      )}
    </div>
  );
}
