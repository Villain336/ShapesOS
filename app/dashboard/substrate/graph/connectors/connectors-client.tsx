// Marketr — Phase 8 G1: connector management (client component).
// Connect (OAuth/key handoff start), sync-now, revoke. Credential blobs are
// never displayed — only vault-reference presence. Fake/test mode is the
// default and is labeled honestly.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/vault/shadcn/badge";
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

function statusVariant(s: string): "secondary" | "outline" | "destructive" {
  if (s === "connected") return "secondary";
  if (s === "pending") return "outline";
  return "destructive";
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
          <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
          <p className="text-sm text-muted-foreground">
            Webhook-first where real, scheduled pulls with per-platform rate budgets
            elsewhere. Credentials live in the vault — never in the graph. Fake mode
            is the default until credentials are connected.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Badge variant="secondary">
            {connectors.filter((c) => c.status === "connected").length} connected
          </Badge>
          <Badge variant="outline">{connectors.length} registered</Badge>
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

      <div className="grid gap-4 md:grid-cols-2">
        {catalog.map((entry) => {
          const c = byPlatform.get(entry.platform);
          return (
            <div key={entry.platform} className="rounded-xl border bg-card p-5 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">{entry.displayName}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{entry.honestyNote}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Badge variant="outline">{entry.tier}</Badge>
                  {c && <Badge variant={statusVariant(c.status)}>{c.status}</Badge>}
                </div>
              </div>

              {c && (
                <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                  <div>
                    Vault auth: {c.hasAuth ? "present" : "missing"} · webhook secret:{" "}
                    {c.hasWebhookSecret ? "present" : "missing"}
                  </div>
                  {c.syncJobs.map((j) => (
                    <div key={j.id} className="flex items-center justify-between rounded-md bg-muted px-2 py-1">
                      <span>
                        {j.tier} · {j.status}
                        {j.errorCount > 0 && ` · ${j.errorCount} error(s)`}
                      </span>
                      <span>
                        {j.lastSuccessAt
                          ? `last success ${new Date(j.lastSuccessAt).toLocaleString()}`
                          : "never synced"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                {!c && (
                  <Button
                    size="sm"
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
                  <Button size="sm" disabled={busy === `connect:${entry.platform}`} onClick={() => connect(entry.platform)}>
                    <Plug className="mr-1 h-3.5 w-3.5" /> Re-connect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
