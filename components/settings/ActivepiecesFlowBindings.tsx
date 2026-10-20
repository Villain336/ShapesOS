// ShapesOS — Activepieces flow bindings (platform operators only, Phase 1 H6).
// The engine is host-wide; a flow is usable only from the workspace it is
// bound to. Binding is an install-operator action, so the server page renders
// this component only for MARKETR_PLATFORM_OPERATORS (and the bindings API
// enforces requirePlatformOperator regardless).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface EngineFlow {
  id: string;
  displayName: string;
  published: boolean;
  triggerableViaWebhook: boolean;
  boundWorkspaceId: string | null;
}

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

async function errorOf(r: Response, fallback: string): Promise<string> {
  const j = await r.json().catch(() => ({}));
  return typeof j?.error === "string" ? j.error : fallback;
}

export default function ActivepiecesFlowBindings({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const [flows, setFlows] = useState<EngineFlow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/integrations/activepieces/flows?scope=engine&limit=100");
    if (!r.ok) {
      setError(await errorOf(r, "Could not list engine flows."));
      setFlows([]);
      return;
    }
    const j = await r.json();
    setFlows(Array.isArray(j.flows) ? j.flows : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function bind(flow: EngineFlow) {
    setBusy(flow.id);
    setError(null);
    try {
      const r = await fetch("/api/integrations/activepieces/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: flow.id, workspaceId }),
      });
      if (!r.ok) {
        setError(await errorOf(r, `Could not bind "${flow.displayName}".`));
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function unbind(flow: EngineFlow) {
    if (!flow.boundWorkspaceId) return;
    setBusy(flow.id);
    setError(null);
    try {
      const qs = new URLSearchParams({ flowId: flow.id, workspaceId: flow.boundWorkspaceId });
      const r = await fetch(`/api/integrations/activepieces/bindings?${qs}`, { method: "DELETE" });
      if (!r.ok) {
        setError(await errorOf(r, `Could not unbind "${flow.displayName}".`));
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4" data-testid="activepieces-flow-bindings">
      <h3 className="text-sm font-semibold text-ink">Flow bindings</h3>
      <p className="mt-1 text-[0.8125rem] text-muted">
        Platform operators only. A flow runs only from the workspace it is bound to; bind it to{" "}
        {workspaceName} to make it available to Missions, Playbooks and the Strategy Agent here.
      </p>

      {error && (
        <p role="alert" className="mt-2 flex items-center gap-2 text-[0.8125rem] text-failed-text">
          <span className="h-2 w-2 shrink-0 bg-failed" aria-hidden="true" />
          {error}
        </p>
      )}

      {flows === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="aos-spin" aria-hidden="true" /> Loading flows
        </p>
      ) : flows.length === 0 ? (
        !error && <p className="mt-3 text-xs text-subtle">The engine has no flows yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {flows.map((f) => {
            const here = f.boundWorkspaceId === workspaceId;
            const elsewhere = f.boundWorkspaceId !== null && !here;
            return (
              <li
                key={f.id}
                className="flex items-center justify-between gap-2 rounded-sm border border-line bg-paper px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{f.displayName}</div>
                  <div className="truncate font-mono text-xs text-subtle">{f.id}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!f.triggerableViaWebhook && <span className={chipCls}>not webhook-triggered</span>}
                  {!f.published && <span className={chipCls}>unpublished</span>}
                  <span className={chipCls}>
                    {here ? "bound here" : elsewhere ? "bound to another workspace" : "unbound"}
                  </span>
                  {f.boundWorkspaceId ? (
                    <button onClick={() => void unbind(f)} disabled={busy === f.id} className={btnGhost}>
                      {busy === f.id ? "Unbinding…" : "Unbind"}
                    </button>
                  ) : (
                    <button onClick={() => void bind(f)} disabled={busy === f.id} className={btnPrimary}>
                      {busy === f.id ? "Binding…" : "Bind here"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
