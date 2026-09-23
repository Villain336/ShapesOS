"use client";

// Marketr — OAuth consent form (Phase C, W5; G3 workspace picker). Client
// component: workspace picker + Approve/Deny. Approve is two server steps,
// transparent to the user:
//   1. POST { grant, decision: "select", workspaceId } → re-sealed grant with
//      the chosen workspace bound (membership-verified server-side).
//   2. POST { grant: <re-sealed>, decision: "approve" } → server-issued redirect.
// Deny POSTs { grant, decision: "deny" } directly.

import { useState } from "react";

interface WorkspaceOption {
  id: string;
  name: string;
}

export function ConsentForm({
  grant,
  workspaces,
  defaultWorkspaceId,
}: {
  grant: string;
  workspaces: WorkspaceOption[];
  defaultWorkspaceId: string;
}) {
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/mcp/oauth/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Authorization failed");
    return data as { grant?: string; redirect?: string };
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      // Step 1: bind the chosen workspace (server verifies membership).
      const selected = await post({ grant, decision: "select", workspaceId });
      if (!selected.grant) throw new Error("Workspace binding failed");
      // Step 2: approve the workspace-bound grant.
      const approved = await post({ grant: selected.grant, decision: "approve" });
      if (approved.redirect) window.location.href = approved.redirect;
      else throw new Error("No redirect returned");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed");
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    setError(null);
    try {
      const denied = await post({ grant, decision: "deny" });
      if (denied.redirect) window.location.href = denied.redirect;
      else throw new Error("No redirect returned");
    } catch {
      setError("Network error");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <fieldset>
        <legend className="text-sm font-medium">Connect to workspace</legend>
        <p className="mt-1 text-xs text-zinc-500">
          The app will act within this workspace only. The choice is verified on our servers.
        </p>
        <div className="mt-2 max-h-48 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200">
          {workspaces.map((w) => (
            <label key={w.id} className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-zinc-50">
              <input
                type="radio"
                name="mcp-workspace"
                value={w.id}
                checked={workspaceId === w.id}
                onChange={() => setWorkspaceId(w.id)}
                className="h-4 w-4"
              />
              <span className="font-medium">{w.name}</span>
              <code className="ml-auto rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500">
                {w.id.slice(0, 8)}…
              </code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={approve}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Working…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={deny}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 disabled:opacity-50"
        >
          Deny
        </button>
        {error && <p className="self-center text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
