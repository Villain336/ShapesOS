// ShapesOS — read-only tool allow-list editor for a custom MCP server (H5).
// Every tool on a custom MCP server is treated as mutating (the agent asks
// first) unless the server annotates it readOnlyHint or an admin lists it
// here. Phase 4d: each listed tool is a kit permission row (Ask first /
// Auto-run). The allow-list has no "Off", so only those two show; switching a
// tool to Ask first takes it off the list on save, and anything not listed
// keeps asking first (the default never widens). Saves via PATCH /api/connectors/mcp/[id] { readOnlyTools }, which is
// gated on the connectors.connect permission and audited. Rendered only on
// the admin-gated connectors settings page.

"use client";

import { useState } from "react";
import { SquareTerminal } from "lucide-react";
import { FieldMessage, PermissionSegmented, type Permission } from "@/components/aos/Controls";

const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const ALLOW_LIST_OPTIONS: readonly Permission[] = ["ask", "auto"];

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
  // Listed tools auto-run; a tool switched to "ask" leaves the list on save.
  const [rows, setRows] = useState<Array<{ name: string; perm: Permission }>>(() =>
    initial.map((name) => ({ name, perm: "auto" as Permission })),
  );
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `mcp-ro-error-${connectorId}`;

  function add() {
    const next = parseToolNames(draft);
    if (next.length === 0) return;
    setRows((prev) => {
      const out = prev.map((r) => (next.includes(r.name) ? { ...r, perm: "auto" as Permission } : r));
      for (const name of next) if (!out.some((r) => r.name === name)) out.push({ name, perm: "auto" });
      return out.slice(0, 200);
    });
    setDraft("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Include a typed-but-not-added name so "Save" never silently drops it.
      const listed = rows.filter((r) => r.perm === "auto").map((r) => r.name);
      const all = [...new Set([...listed, ...parseToolNames(draft)])].slice(0, 200);
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

      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-subtle">No tools listed. Every tool asks first.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line" aria-label="Tool permissions">
          {rows.map((r) => (
            <li key={r.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-canvas">
                <SquareTerminal className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="aos-mono block truncate text-sm text-ink">{r.name}</span>
                <span className="block text-xs text-muted">
                  {r.perm === "auto" ? "Runs without asking (read-only)" : "Asks first. Leaves the list when you save"}
                </span>
              </span>
              <PermissionSegmented
                label={`${r.name} permission`}
                value={r.perm}
                options={ALLOW_LIST_OPTIONS}
                onChange={(perm) => setRows((prev) => prev.map((x) => (x.name === r.name ? { ...x, perm } : x)))}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className={`${labelCls} min-w-[240px] flex-1`}>
          Add read-only tools
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

      <FieldMessage id={errorId} error={error} className="mt-2" />

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
