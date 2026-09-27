// Marketr — Phase 11 "Canvas" FEATURE 5: batch generation modal.
//
// The strategic "100 ad variants from one brief" flow: text elements with
// {{variable}} placeholders on the active page become N variant pages.
// Value sources: manual table, CSV paste, or AI "Fill from brief" (same LLM
// provider + honest no-key state as the AI panel).
//
// Draft-first: Generate appends pages via store.appendPages for human review.
// Never auto-exports or publishes anything.

"use client";

import { useMemo, useState } from "react";
import {
  FileText,
  Loader2,
  Plus,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import type { DesignPage } from "@/lib/design/types";
import {
  MAX_BATCH_VARIANTS,
  buildBatchPages,
  csvToValueRows,
  extractVariables,
} from "@/lib/design/variables";
import { btnGhost, btnPrimary, inputCls, panelSectionLabel } from "./ui";

type ValueTab = "table" | "csv" | "ai";

const emptyRow = (variables: string[]): Record<string, string> =>
  Object.fromEntries(variables.map((v) => [v, ""]));

function rowHasValues(row: Record<string, string>, variables: string[]): boolean {
  return variables.some((v) => (row[v] ?? "").trim() !== "");
}

function BatchModalBody({
  page,
  onClose,
  onGenerated,
}: {
  page: DesignPage;
  onClose: () => void;
  onGenerated: (count: number) => void;
}) {
  const appendPages = useCanvasStore((s) => s.appendPages);

  const variables = useMemo(() => extractVariables(page), [page]);
  const [tab, setTab] = useState<ValueTab>("table");
  const [rows, setRows] = useState<Record<string, string>[]>(() =>
    Array.from({ length: 3 }, () => emptyRow(variables)),
  );
  const [csvText, setCsvText] = useState("");
  const [csvNote, setCsvNote] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const usableRows = rows.filter((r) => rowHasValues(r, variables));

  const setCell = (rowIdx: number, variable: string, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, [variable]: value } : r)),
    );
  };

  const addRow = () => {
    setRows((prev) =>
      prev.length >= MAX_BATCH_VARIANTS ? prev : [...prev, emptyRow(variables)],
    );
  };

  const removeRow = (rowIdx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  const parseCsvInput = () => {
    const res = csvToValueRows(csvText, variables);
    const notes: string[] = [];
    if (res.unmatchedHeaders.length > 0) {
      notes.push(`Ignored columns with no matching variable: ${res.unmatchedHeaders.join(", ")}.`);
    }
    if (res.missingVariables.length > 0) {
      notes.push(
        `No column for: ${res.missingVariables.join(", ")} — those stay blank (placeholders left as-is).`,
      );
    }
    setCsvNote(
      res.rows.length === 0
        ? "No usable rows — the first row must be headers matching your variable names."
        : notes.length > 0
          ? notes.join(" ")
          : `${res.rows.length} row${res.rows.length === 1 ? "" : "s"} loaded.`,
    );
    if (res.rows.length > 0) {
      setRows(res.rows.slice(0, MAX_BATCH_VARIANTS));
      setTab("table");
    }
  };

  const fillFromBrief = async () => {
    const b = brief.trim();
    if (b.length < 3 || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await fetch("/api/studio/designs/batch-fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: b,
          variables,
          count: Math.min(Math.max(1, aiCount), MAX_BATCH_VARIANTS),
        }),
      });
      const json = (await res.json()) as { rows?: Record<string, string>[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (!json.rows || json.rows.length === 0) throw new Error("The AI returned no values.");
      setRows(json.rows.slice(0, MAX_BATCH_VARIANTS));
      setTab("table");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI fill failed.");
    } finally {
      setAiBusy(false);
    }
  };

  const generate = () => {
    setGenError(null);
    if (variables.length === 0) {
      setGenError("No {{variables}} found on this page.");
      return;
    }
    if (usableRows.length === 0) {
      setGenError("Add at least one row with values — empty rows are skipped.");
      return;
    }
    const pages = buildBatchPages(page, usableRows);
    appendPages(pages);
    onGenerated(pages.length);
  };

  const tabs: { key: ValueTab; label: string; icon: React.ReactNode }[] = [
    { key: "table", label: "Table", icon: <Table2 className="h-3.5 w-3.5" /> },
    { key: "csv", label: "CSV paste", icon: <FileText className="h-3.5 w-3.5" /> },
    { key: "ai", label: "AI fill", icon: <Sparkles className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-stone-900">Batch generate variants</h2>
          <p className="text-[13px] text-stone-500">
            From “{page.name}” — one variant page per value row, for your review.
          </p>
        </div>
        <button onClick={onClose} className={btnGhost} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto bg-[#FAFAF7] px-4 py-4">
        {/* Step 1 — detected variables */}
        <section>
          <div className={panelSectionLabel}>1 · Variables on this page</div>
          {variables.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-snug text-amber-800">
              No {"{{variables}}"} found on this page. Add a {"{{name}}"} placeholder to any text
              element first, then come back.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <span
                  key={v}
                  className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 font-mono text-[12px] text-violet-700"
                >
                  {`{{${v}}}`}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Step 2 — values */}
        {variables.length > 0 && (
          <section>
            <div className={panelSectionLabel}>2 · Values for each variant</div>
            <div className="mb-2 flex gap-1.5">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium ${
                    tab === t.key
                      ? "border-violet-600 text-violet-700"
                      : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "table" && (
              <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50">
                      <th className="w-10 px-2 py-1.5 text-left font-mono text-[11px] text-stone-400">#</th>
                      {variables.map((v) => (
                        <th
                          key={v}
                          className="px-2 py-1.5 text-left font-mono text-[11px] font-semibold text-violet-700"
                        >
                          {`{{${v}}}`}
                        </th>
                      ))}
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-stone-100 hover:bg-violet-50/40">
                        <td className="px-2 py-1 font-mono text-[11px] text-stone-400">{ri + 1}</td>
                        {variables.map((v) => (
                          <td key={v} className="px-1 py-1">
                            <input
                              value={row[v] ?? ""}
                              onChange={(e) => setCell(ri, v, e.target.value)}
                              placeholder={v}
                              className={`${inputCls} w-full py-1 text-[12px]`}
                            />
                          </td>
                        ))}
                        <td className="px-1 py-1">
                          <button
                            onClick={() => removeRow(ri)}
                            className="flex h-6 w-6 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-red-600"
                            title="Remove row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  onClick={addRow}
                  disabled={rows.length >= MAX_BATCH_VARIANTS}
                  className={`${btnGhost} m-2 disabled:opacity-40`}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add row
                </button>
              </div>
            )}

            {tab === "csv" && (
              <div>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={6}
                  placeholder={`product,date\nWidget,Friday\nGadget,Monday\n\nFirst row = headers matching ${variables.map((v) => `{{${v}}}`).join(", ")}`}
                  className={`${inputCls} w-full resize-y font-mono text-[12px]`}
                />
                <button onClick={parseCsvInput} className={`${btnPrimary} mt-2`}>
                  <FileText className="h-4 w-4" />
                  Parse CSV into table
                </button>
                {csvNote && (
                  <p className="mt-1.5 text-[12px] leading-snug text-stone-500">{csvNote}</p>
                )}
              </div>
            )}

            {tab === "ai" && (
              <div>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={4}
                  placeholder="e.g. 8 headline angles for our spring sale — playful, urgent, premium…"
                  className={`${inputCls} w-full resize-none`}
                />
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[12px] text-stone-600">Rows</label>
                  <input
                    type="number"
                    min={1}
                    max={MAX_BATCH_VARIANTS}
                    value={aiCount}
                    onChange={(e) =>
                      setAiCount(
                        Math.min(
                          MAX_BATCH_VARIANTS,
                          Math.max(1, parseInt(e.target.value, 10) || 1),
                        ),
                      )
                    }
                    className={`${inputCls} w-20 py-1 text-[12px]`}
                  />
                  <button
                    onClick={() => void fillFromBrief()}
                    disabled={brief.trim().length < 3 || aiBusy}
                    className={btnPrimary}
                  >
                    {aiBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {aiBusy ? "Filling…" : "Fill from brief"}
                  </button>
                </div>
                {aiError && (
                  <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-snug text-red-700">
                    {aiError}
                  </p>
                )}
                <p className="mt-1.5 text-[11px] leading-snug text-stone-400">
                  Uses your LLM key (same as Generate design). Rows land in the table — you edit
                  before generating.
                </p>
              </div>
            )}
          </section>
        )}

        {/* Step 3 — review + generate */}
        {variables.length > 0 && (
          <section>
            <div className={panelSectionLabel}>3 · Review & generate</div>
            <p className="text-[13px] leading-snug text-stone-600">
              <span className="font-semibold text-stone-900">{usableRows.length}</span> variant
              {usableRows.length === 1 ? "" : "s"} will be appended as new pages (
              {usableRows.length > 0
                ? `Variant 1${usableRows.length > 1 ? ` … Variant ${usableRows.length}` : ""}`
                : "—"}
              ). Empty rows are skipped; up to {MAX_BATCH_VARIANTS} variants per run. Pages are
              drafts for your review — nothing is exported or published.
            </p>
            {genError && (
              <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-snug text-red-700">
                {genError}
              </p>
            )}
            <button
              onClick={generate}
              disabled={usableRows.length === 0}
              className={`${btnPrimary} mt-2 disabled:opacity-40`}
            >
              <Sparkles className="h-4 w-4" />
              Generate {usableRows.length} variant{usableRows.length === 1 ? "" : "s"}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

export function BatchModal({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  onGenerated: (count: number) => void;
}) {
  const doc = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  if (!open) return null;
  const page = doc?.pages.find((p) => p.id === activePageId) ?? doc?.pages[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Batch generate variants"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl">
        {page ? (
          <BatchModalBody
            key={page.id}
            page={page}
            onClose={onClose}
            onGenerated={onGenerated}
          />
        ) : (
          <div className="rounded-xl border border-stone-200 bg-white p-6 text-[13px] text-stone-600">
            No page to batch from.
          </div>
        )}
      </div>
    </div>
  );
}
