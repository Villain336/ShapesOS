"use client";

// ShapesOS — OAuth consent form (Phase C, W5; G3 workspace picker). Client
// component: workspace picker + Approve/Deny. Approve is two server steps,
// transparent to the user:
//   1. POST { grant, decision: "select", workspaceId } → re-sealed grant with
//      the chosen workspace bound (membership-verified server-side).
//   2. POST { grant: <re-sealed>, decision: "approve" } → server-issued redirect.
// Deny POSTs { grant, decision: "deny" } directly.

import { useState } from "react";

const ERROR_COPY: Record<string, string> = {
  insufficient_role: "You need the editor role or higher in this workspace to connect apps.",
  workspace_not_accessible: "You're no longer a member of this workspace. Pick another one.",
  no_permitted_scopes: "Your role in this workspace doesn't allow any of the requested permissions.",
};

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
    if (!res.ok) throw new Error(ERROR_COPY[data.error as string] ?? data.error ?? "Authorization failed");
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
        <legend className="text-sm font-semibold text-ink">Connect to workspace</legend>
        <p className="mt-1 text-[13px] text-muted">
          The app will act within this workspace only. The choice is verified on our servers.
        </p>
        <div className="mt-2 max-h-48 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {workspaces.map((w) => (
            <label key={w.id} className="flex cursor-pointer items-center gap-3 p-3 text-sm text-ink hover:bg-hover-paper">
              <input
                type="radio"
                name="mcp-workspace"
                value={w.id}
                checked={workspaceId === w.id}
                onChange={() => setWorkspaceId(w.id)}
                className="h-4 w-4"
              />
              <span className="font-semibold">{w.name}</span>
              <code className="ml-auto rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-muted">
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
          className="inline-flex h-control items-center rounded-full bg-ink px-[22px] text-[15px] font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40"
        >
          {busy ? "Allowing…" : "Allow access"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={deny}
          className="inline-flex h-control items-center rounded-full bg-paper px-[22px] text-[15px] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40"
        >
          Deny
        </button>
        {error && (
          <p role="alert" className="flex items-center gap-2 self-center text-sm text-failed-text">
            <span className="h-2.5 w-2.5 shrink-0 bg-failed" aria-hidden="true" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
