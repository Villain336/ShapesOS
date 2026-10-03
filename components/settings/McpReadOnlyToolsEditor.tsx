// ShapesOS — read-only tool allow-list editor for a custom MCP server (H5).
// Every tool on a custom MCP server is treated as mutating (the agent asks
// first) unless the server annotates it readOnlyHint or an admin lists it
// here. Saves via PATCH /api/connectors/mcp/[id] { readOnlyTools }, which is
// gated on the connectors.connect permission and audited. Rendered only on
// the admin-gated connectors settings page.

"use client";

import { useState } from "react";
import { X } from "lucide-react";

const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper py-0.5 pl-2.5 pr-1 font-mono text-xs text-ink shadow-control";

/** Split free text (commas, whitespace, newlines) into tool names; same bounds as the API. */
export function parseToolNames(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 200);
}

export default function McpReadOnlyToolsEditor({
  workspaceId,
  connectorId,
  connectorName,
  initial,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  connectorId: string;
  connectorName: string;
  initial: string[];
  onSaved: (tools: string[]) => void;
  onCancel: () => void;
}) {
  const [tools, setTools] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `mcp-ro-error-${connectorId}`;

  function add() {
    const next = parseToolNames(draft);
    if (next.length === 0) return;
    setTools((prev) => [...new Set([...prev, ...next])].slice(0, 200));
    setDraft("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Include a typed-but-not-added name so "Save" never silently drops it.
      const all = [...new Set([...tools, ...parseToolNames(draft)])].slice(0, 200);
      const r = await fetch(
        `/api/connectors/mcp/${encodeURIComponent(connectorId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, readOnlyTools: all }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j?.error === "string" ? j.error : "Could not save the allow-list. Try again.");
        return;
      }
      setDraft("");
      onSaved(Array.isArray(j.readOnlyTools) ? j.readOnlyTools : all);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line bg-paper p-4" data-testid={`mcp-readonly-editor-${connectorId}`}>
      <h3 className="text-sm font-semibold text-ink">Read-only tools</h3>
      <p className="mt-1 text-[13px] text-muted">
        The agent asks before running any tool on {connectorName}. Tools listed here only read
        data, so it may run them without asking. List a tool only if it never changes anything.
      </p>

      <div className="mt-3 flex flex-wrap gap-2" aria-label="Read-only tools">
        {tools.map((t) => (
          <span key={t} className={chipCls}>
            {t}
            <button
              type="button"
              onClick={() => setTools((prev) => prev.filter((x) => x !== t))}
              aria-label={`Remove ${t}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-hover-paper hover:text-ink"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {tools.length === 0 && (
          <p className="text-xs text-subtle">No tools listed. Every tool asks first.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className={`${labelCls} min-w-[240px] flex-1`}>
          Tool names
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="search_docs, get_record"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={`${inputCls} mt-1 w-full font-mono text-xs`}
          />
        </label>
        <button type="button" onClick={add} disabled={!draft.trim()} className={btnGhost}>
          Add
        </button>
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-2 flex items-center gap-2 text-[13px] text-failed-text">
          <span className="h-2 w-2 shrink-0 bg-failed" aria-hidden="true" />
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving} className={btnPrimary}>
          {saving ? "Saving…" : "Save allow-list"}
        </button>
      </div>
    </div>
  );
}
