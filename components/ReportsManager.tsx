// Marketr — reports dashboard UI (milestone 12).
// Template list → edit (editorcn block editor) → generate on-demand → history.

"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { confirmAction } from "@/lib/ui/feedback";

const TemplateEditor = dynamic(() => import("@/components/TemplateEditor"), { ssr: false });

interface Template {
  id: string;
  name: string;
  type: string;
  content: unknown;
  brandKitId: string | null;
  projectId: string | null;
  schedule: string;
  lastRunAt: string | null;
  brandKit?: { id: string; name: string } | null;
  project?: { id: string; domain: string } | null;
  _count?: { reports: number };
}

interface Report {
  id: string;
  period: string;
  status: string;
  error: string | null;
  createdAt: string;
  template?: { id: string; name: string } | null;
  brandKit?: { id: string; name: string } | null;
}

interface ReportsManagerProps {
  initialTemplates: Template[];
  brandKits: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; domain: string }>;
}

const BLANK_DOC = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Monthly SEO Report" }] },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Performance summary for {{project_domain}} — {{period}}." }],
    },
    { type: "paragraph", content: [{ type: "text", text: "{{rankings_table}}" }] },
  ],
};

export default function ReportsManager({ initialTemplates, brandKits, projects }: ReportsManagerProps) {
  const [templates, setTemplates] = useState<Template[]>(initialTemplates);
  const [selectedId, setSelectedId] = useState<string | null>(initialTemplates[0]?.id ?? null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [meta, setMeta] = useState({ name: "", type: "custom", brandKitId: "", projectId: "", schedule: "manual" });
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<Report[]>([]);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [openingDoc, setOpeningDoc] = useState(false);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  function select(id: string | null) {
    setSelectedId(id);
    setDraft(null);
    setError(null);
    setNotice(null);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setMeta({
        name: t.name,
        type: t.type,
        brandKitId: t.brandKitId ?? "",
        projectId: t.projectId ?? "",
        schedule: t.schedule,
      });
      setEditorKey((k) => k + 1);
      loadHistory(t.id);
    }
  }

  function startNew() {
    setSelectedId("new");
    setDraft(BLANK_DOC);
    setMeta({ name: "", type: "ranking", brandKitId: "", projectId: "", schedule: "manual" });
    setEditorKey((k) => k + 1);
    setHistory([]);
    setHistoryFor(null);
    setError(null);
    setNotice(null);
  }

  async function loadHistory(templateId: string) {
    const res = await fetch(`/api/reports?templateId=${templateId}`);
    if (res.ok) {
      const data = await res.json();
      setHistory(data.reports);
      setHistoryFor(templateId);
    }
  }

  async function saveTemplate() {
    if (selectedId === "new") {
      if (!meta.name.trim()) {
        setError("Template name is required");
        return;
      }
      if (!draft) {
        setError("Editor content not ready yet");
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/report-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: meta.name,
            type: meta.type,
            content: draft,
            brandKitId: meta.brandKitId || null,
            projectId: meta.projectId || null,
            schedule: meta.schedule,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Save failed");
        setTemplates((prev) => [data.template, ...prev]);
        setNotice("Template created");
        select(data.template.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!selected || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/report-templates/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: meta.name,
          type: meta.type,
          content: draft,
          brandKitId: meta.brandKitId || null,
          projectId: meta.projectId || null,
          schedule: meta.schedule,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setTemplates((prev) => prev.map((t) => (t.id === selected.id ? { ...t, ...data.template } : t)));
      setNotice("Template saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function generateNow() {
    const id = selectedId === "new" ? null : selectedId;
    if (!id) {
      setError("Save the template before generating");
      return;
    }
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setNotice(`Report generated (${data.report.period}) — PDF ready below.`);
      await loadHistory(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function openInDocs() {
    const id = selectedId === "new" ? null : selectedId;
    if (!id) {
      setError("Save the template before opening in Docs");
      return;
    }
    setOpeningDoc(true);
    setError(null);
    try {
      const res = await fetch("/api/office/docs/from-report-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Open in Docs failed");
      window.location.href = `/dashboard/office?open=${encodeURIComponent(data.doc.id)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Open in Docs failed");
    } finally {
      setOpeningDoc(false);
    }
  }

  async function deleteTemplate() {
    if (!selected || !await confirmAction(`Delete template "${selected.name}"? Generated reports are kept.`)) return;
    const res = await fetch(`/api/report-templates/${selected.id}`, { method: "DELETE" });
    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== selected.id));
      select(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      {/* Template list */}
      <div className="flex flex-col gap-2">
        <button
          onClick={startNew}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press"
        >
          New template
        </button>
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => select(t.id)}
            className={`rounded-lg bg-paper p-3 text-left ${
              selectedId === t.id ? "shadow-outline" : "shadow-hairline hover:bg-hover-paper"
            }`}
          >
            <p className="text-sm font-medium text-ink">{t.name}</p>
            <p className="mt-1 text-xs text-muted">
              {t.type} · {t.schedule}
              {t.project ? ` · ${t.project.domain}` : ""}
              {t._count ? ` · ${t._count.reports} reports` : ""}
            </p>
          </button>
        ))}
        {templates.length === 0 && <p className="text-sm text-muted">No templates yet.</p>}
      </div>

      {/* Editor / history */}
      <div className="flex min-w-0 flex-col gap-4">
        {error && <p className="rounded-md bg-failed-tint px-4 py-2 text-sm text-failed-text">{error}</p>}
        {notice && (
          <p className="rounded-md bg-paper px-4 py-2 text-sm text-ink shadow-hairline">{notice}</p>
        )}

        {(selected || selectedId === "new") && (
          <>
            <div className="grid gap-3 rounded-lg bg-paper p-4 shadow-hairline md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Template name</span>
                <input
                  value={meta.name}
                  onChange={(e) => setMeta({ ...meta, name: e.target.value })}
                  className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Type</span>
                <select
                  value={meta.type}
                  onChange={(e) => setMeta({ ...meta, type: e.target.value })}
                  className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-ink"
                >
                  <option value="ranking">Ranking report</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Brand kit</span>
                <select
                  value={meta.brandKitId}
                  onChange={(e) => setMeta({ ...meta, brandKitId: e.target.value })}
                  className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-ink"
                >
                  <option value="">Workspace default</option>
                  {brandKits.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Project (data source)</span>
                <select
                  value={meta.projectId}
                  onChange={(e) => setMeta({ ...meta, projectId: e.target.value })}
                  className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-ink"
                >
                  <option value="">None</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.domain}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Schedule</span>
                <select
                  value={meta.schedule}
                  onChange={(e) => setMeta({ ...meta, schedule: e.target.value })}
                  className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-ink"
                >
                  <option value="manual">Manual</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
            </div>

            <TemplateEditor
              key={editorKey}
              initialContent={selectedId === "new" ? BLANK_DOC : (selected?.content ?? BLANK_DOC)}
              onChange={(json) => setDraft(json as Record<string, unknown>)}
            />

            <div className="flex flex-wrap gap-2">
              <button
                onClick={saveTemplate}
                disabled={saving}
                className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg"
              >
                {saving ? "Saving…" : selectedId === "new" ? "Create template" : "Save template"}
              </button>
              {selectedId !== "new" && (
                <button
                  onClick={generateNow}
                  disabled={generating}
                  className="rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none"
                >
                  {generating ? "Generating PDF…" : "Generate PDF now"}
                </button>
              )}
              {selectedId !== "new" && (
                <button
                  onClick={openInDocs}
                  disabled={openingDoc}
                  className="rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none"
                  title="Open this template as an editable Univer document"
                >
                  {openingDoc ? "Opening…" : "Open in Docs"}
                </button>
              )}
              {selectedId !== "new" && (
                <button
                  onClick={deleteTemplate}
                  className="rounded-full bg-paper px-4 py-2 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint aos-press"
                >
                  Delete
                </button>
              )}
            </div>

            {/* History */}
            {historyFor === selectedId && history.length > 0 && (
              <div className="rounded-lg bg-paper p-4 shadow-hairline">
                <h3 className="mb-2 text-sm font-semibold text-ink">Generated reports</h3>
                <ul className="flex flex-col gap-2">
                  {history.map((r) => (
                    <li key={r.id} className="flex items-center justify-between rounded-sm border border-line px-3 py-2 text-sm">
                      <span className="text-muted">
                        {r.period} · {new Date(r.createdAt).toLocaleString()}
                        <span
                          className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                            r.status === "ready"
                              ? "bg-done text-white"
                              : r.status === "failed"
                                ? "bg-failed text-white"
                                : "bg-canvas text-muted"
                          }`}
                        >
                          {(r.status === "ready" || r.status === "failed") && (
                            <span
                              aria-hidden
                              className={`aos-shape ${r.status === "ready" ? "aos-shape--done" : "aos-shape--failed"}`}
                              style={{ color: "inherit" }}
                            />
                          )}
                          {r.status}
                        </span>
                        {r.error && <span className="ml-2 text-xs text-failed-text">{r.error.slice(0, 120)}</span>}
                      </span>
                      {r.status === "ready" && (
                        <a
                          href={`/api/reports/${r.id}/download`}
                          className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline"
                        >
                          Download PDF
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {!selected && selectedId !== "new" && (
          <p className="text-sm text-muted">Select a template to edit, or create a new one.</p>
        )}
      </div>
    </div>
  );
}
