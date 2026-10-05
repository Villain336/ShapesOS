// ShapesOS — Phase 11 (conncore): map a custom MCP server's tools to a tool
// group (which task grants cover it) and an action (its approval tier).
// Loads GET /api/connectors/mcp/[id]/tools (live tool list + current
// mapping), saves PATCH /api/connectors/mcp/[id] { toolPolicies } (gated on
// connectors.connect, audited). Unmapped tools stay in "Connected apps" and
// always ask ("Unknown write"). Tiers are approval settings, not agent
// states: neutral chips, never the status colours.

"use client";

import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { FieldMessage } from "@/components/aos/Controls";

const selectCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

interface ToolRow {
  name: string;
  description: string;
  mutating: boolean;
  group: string;
  action: string;
}

interface Payload {
  tools: ToolRow[];
  groups: Array<{ group: string; label: string }>;
  actions: Array<{ action: string; label: string; tier: number }>;
  needsAuth: boolean;
  signedIn: boolean;
}

export default function McpToolPoliciesEditor({
  workspaceId,
  connectorId,
  connectorName,
  onSaved,
  onCancel,
}: {
  workspaceId: string;
  connectorId: string;
  connectorName: string;
  onSaved: (mapped: number) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [rows, setRows] = useState<ToolRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = `mcp-policy-error-${connectorId}`;
  const base = `/api/connectors/mcp/${encodeURIComponent(connectorId)}`;
  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  useEffect(() => {
    let live = true;
    fetch(`${base}/tools?${q}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) {
          setError(typeof j?.error === "string" ? j.error : "Could not load the server's tools.");
          return;
        }
        setData(j as Payload);
        setRows((j as Payload).tools);
      })
      .catch(() => live && setError("Could not load the server's tools."));
    return () => {
      live = false;
    };
  }, [base, q]);

  const tierOf = (action: string) => data?.actions.find((a) => a.action === action)?.tier ?? 2;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const toolPolicies = Object.fromEntries(rows.map((r) => [r.name, { group: r.group, action: r.action }]));
      const r = await fetch(`${base}?${q}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, toolPolicies }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j?.error === "string" ? j.error : "Could not save. Try again.");
        return;
      }
      onSaved(rows.length);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line bg-paper p-4" data-testid={`mcp-policy-editor-${connectorId}`}>
      <h3 className="text-sm font-semibold text-ink">Tool groups and approvals</h3>
      <p className="mt-1 text-[13px] text-muted">
        Choose which tool group covers each tool on {connectorName} (a task can only use the groups it was
        given) and what kind of action it is (its approval tier). Unmapped tools are connected-app tools that
        always ask first.
      </p>

      {!data && !error && <p className="mt-3 text-xs text-subtle">Loading tools…</p>}
      {data && data.needsAuth && !data.signedIn && (
        <p className="mt-3 text-xs text-subtle">Sign in to this server first to list its tools.</p>
      )}
      {data && data.signedIn && rows.length === 0 && <p className="mt-3 text-xs text-subtle">This server lists no tools.</p>}

      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line" aria-label="Tool groups and approvals">
          {rows.map((r) => (
            <li key={r.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-canvas">
                <SquareTerminal className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="aos-mono block truncate text-sm text-ink">{r.name}</span>
                <span className="block truncate text-xs text-muted">{r.description || "No description"}</span>
              </span>
              <span className={chipCls}>{r.mutating ? "writes" : "read-only"}</span>
              <label className="sr-only" htmlFor={`grp-${connectorId}-${r.name}`}>
                {r.name} tool group
              </label>
              <select
                id={`grp-${connectorId}-${r.name}`}
                value={r.group}
                onChange={(e) => setRows((prev) => prev.map((x) => (x.name === r.name ? { ...x, group: e.target.value } : x)))}
                className={selectCls}
              >
                {data?.groups.map((g) => (
                  <option key={g.group} value={g.group}>
                    {g.label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor={`act-${connectorId}-${r.name}`}>
                {r.name} action
              </label>
              <select
                id={`act-${connectorId}-${r.name}`}
                value={r.action}
                disabled={!r.mutating}
                onChange={(e) => setRows((prev) => prev.map((x) => (x.name === r.name ? { ...x, action: e.target.value } : x)))}
                className={selectCls}
              >
                {data?.actions.map((a) => (
                  <option key={a.action} value={a.action}>
                    {a.label} (tier {a.tier})
                  </option>
                ))}
              </select>
              <span className={chipCls}>{r.mutating ? `Tier ${tierOf(r.action)}` : "Never asks"}</span>
            </li>
          ))}
        </ul>
      )}

      <FieldMessage id={errorId} error={error} className="mt-2" />

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving || rows.length === 0} className={btnPrimary}>
          {saving ? "Saving…" : "Save tool settings"}
        </button>
      </div>
    </div>
  );
}
