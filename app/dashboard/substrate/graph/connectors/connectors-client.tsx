// Marketr — Phase 8 G1: connector management (client component).
// Connect (OAuth/key handoff start), sync-now, revoke. Credential blobs are
// never displayed — only vault-reference presence. Fake/test mode is the
// default and is labeled honestly.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Plug, RefreshCw, Unplug, AlertTriangle } from "lucide-react";

interface SyncJob {
  id: string;
  tier: string;
  status: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  errorCount: number;
  backoffUntil: string | null;
}

interface Connector {
  id: string;
  platform: string;
  tier: string;
  status: string;
  hasAuth: boolean;
  hasWebhookSecret: boolean;
  syncJobs: SyncJob[];
}

interface CatalogEntry {
  platform: string;
  displayName: string;
  tier: string;
  honestyNote: string;
}

function statusPill(s: string): string {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  if (s === "connected") return `${base} bg-emerald-50 text-emerald-700`;
  if (s === "pending") return `${base} bg-amber-50 text-amber-700`;
  return `${base} bg-red-50 text-red-700`;
}

export default function ConnectorsClient({ workspaceId }: { workspaceId: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/substrate/graph/connectors?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to load connectors");
      setCatalog(data.catalog);
      setConnectors(data.connectors);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function connect(platform: string) {
    setBusy(`connect:${platform}`);
    setNotice(null);
    try {
      const res = await fetch("/api/substrate/graph/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, platform }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "connect failed");
      setNotice(`${platform}: ${data.nextStep}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function syncNow(id: string, platform: string) {
    setBusy(`sync:${id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/substrate/graph/connectors/${id}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? data.detail ?? "sync failed");
      setNotice(`${platform}: ${data.detail}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string, platform: string) {
    if (!confirm(`Revoke the ${platform} connector? Sync stops; graph history is kept.`)) return;
    setBusy(`revoke:${id}`);
    try {
      const res = await fetch(
        `/api/substrate/graph/connectors/${id}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "revoke failed");
      setNotice(`${platform} revoked — sync stopped, history kept.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const byPlatform = new Map(connectors.map((c) => [c.platform, c]));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Connectors</h1>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Webhook-first where real, scheduled pulls with per-platform rate budgets
            elsewhere. Credentials live in the vault — never in the graph. Fake mode
            is the default until credentials are connected.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
            {connectors.filter((c) => c.status === "connected").length} connected
          </span>
          <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
            {connectors.length} registered
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive bg-card p-4 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border bg-card p-4 text-sm">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {notice}
        </div>
      )}
      {loading && <div className="text-sm text-muted-foreground">Loading connectors…</div>}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-stone-200 text-left text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Connector</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Sync</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((entry) => {
              const c = byPlatform.get(entry.platform);
              return (
                <tr
                  key={entry.platform}
                  className="border-b border-stone-100 transition hover:bg-violet-50/40"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{entry.displayName}</div>
                    <div className="text-xs text-stone-500">{entry.honestyNote}</div>
                    {c && (
                      <div className="text-xs text-stone-500">
                        Vault auth: {c.hasAuth ? "present" : "missing"} · webhook secret:{" "}
                        {c.hasWebhookSecret ? "present" : "missing"}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                      {entry.tier}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {c ? (
                      <span className={statusPill(c.status)}>{c.status}</span>
                    ) : (
                      <span className="text-xs text-stone-400">not connected</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-stone-500">
                    {c && c.syncJobs.length > 0 ? (
                      <div className="space-y-0.5">
                        {c.syncJobs.map((j) => (
                          <div key={j.id}>
                            {j.tier} · {j.status}
                            {j.errorCount > 0 && ` · ${j.errorCount} error(s)`} ·{" "}
                            {j.lastSuccessAt
                              ? `last success ${new Date(j.lastSuccessAt).toLocaleString()}`
                              : "never synced"}
                          </div>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      {!c && (
                        <Button
                          size="sm"
                          className="bg-violet-600 text-white hover:bg-violet-700"
                          disabled={busy === `connect:${entry.platform}`}
                          onClick={() => connect(entry.platform)}
                        >
                          <Plug className="mr-1 h-3.5 w-3.5" /> Connect
                        </Button>
                      )}
                      {c && c.status !== "revoked" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `sync:${c.id}`}
                            onClick={() => syncNow(c.id, entry.displayName)}
                          >
                            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Sync now
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `revoke:${c.id}`}
                            onClick={() => revoke(c.id, entry.displayName)}
                          >
                            <Unplug className="mr-1 h-3.5 w-3.5" /> Revoke
                          </Button>
                        </>
                      )}
                      {c && c.status === "revoked" && (
                        <Button
                          size="sm"
                          className="bg-violet-600 text-white hover:bg-violet-700"
                          disabled={busy === `connect:${entry.platform}`}
                          onClick={() => connect(entry.platform)}
                        >
                          <Plug className="mr-1 h-3.5 w-3.5" /> Re-connect
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
