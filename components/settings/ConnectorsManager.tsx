// Marketr — workspace connectors manager (milestone 21, part D1).
// Client component: 12 built-in connector cards (OAuth / API-key connect,
// per-connection status + refresh/disconnect), plus custom MCP servers.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Check, Plug } from "lucide-react";
import ConnectorHealthTab from "./ConnectorHealthTab";
import McpReadOnlyToolsEditor from "./McpReadOnlyToolsEditor";
import { confirmAction } from "@/lib/ui/feedback";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

interface Connection {
  id: string;
  userId: string | null;
  status: "active" | "needs_reauth" | "revoked";
  scopes: string[];
  meta: Record<string, string> | null;
  connectedAt: string;
}

interface Connector {
  key: string;
  id?: string; // DB id, present for custom MCP connectors; used by DELETE.
  displayName: string;
  kind: "native" | "mcp";
  authType: "oauth2" | "apiKey" | "none";
  description: string | null;
  custom: boolean;
  connections: Connection[];
  /** Custom MCP only: tools the agent may run without asking (admin allow-list). */
  readOnlyTools?: string[];
}

// Connection/auth states are provider states, not agent states — neutral chips.
const STATUS_LABEL: Record<Connection["status"], string> = {
  active: "active",
  needs_reauth: "needs re-auth",
  revoked: "revoked",
};

function connectionLabel(c: Connection): string {
  if (c.meta?.label) return c.meta.label;
  if (c.meta?.email) return c.meta.email;
  if (c.meta?.account) return c.meta.account;
  return c.userId ?? "connection";
}

export default function ConnectorsManager({
  workspaceId,
  connectedKey,
  errorMsg,
  initialTab,
}: {
  workspaceId: string;
  connectedKey: string | null;
  errorMsg: string | null;
  initialTab?: "connections" | "health";
}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"connections" | "health">(initialTab ?? "connections");
  const [apiKeyFor, setApiKeyFor] = useState<Connector | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"streamable-http" | "stdio">(
    "streamable-http",
  );
  const [editingReadOnly, setEditingReadOnly] = useState<string | null>(null);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/connectors?${q}`);
    if (r.ok) {
      const j = await r.json();
      setConnectors(j.connectors ?? []);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  function err(j: unknown, fallback: string): NoticeState {
    const msg =
      j && typeof j === "object" && "error" in j && typeof j.error === "string"
        ? j.error
        : fallback;
    return { kind: "error", message: msg };
  }

  async function connect(c: Connector) {
    setNotice(null);
    if (c.authType === "oauth2") {
      setBusy(`oauth-${c.key}`);
      try {
        const r = await fetch(
          `/api/connectors/${encodeURIComponent(c.key)}/auth-url?${q}`,
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) {
          setNotice(err(j, "Could not start the OAuth flow."));
          return;
        }
        window.location.href = j.url;
      } finally {
        setBusy(null);
      }
    } else if (c.authType === "apiKey") {
      setApiKey("");
      setApiKeyLabel("");
      setApiKeyFor(c);
    }
  }

  async function submitApiKey() {
    if (!apiKeyFor || !apiKey.trim()) return;
    const key = apiKeyFor.key;
    setBusy(`key-${key}`);
    setNotice(null);
    try {
      const r = await fetch(
        `/api/connectors/${encodeURIComponent(key)}/api-key`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            apiKey: apiKey.trim(),
            label: apiKeyLabel.trim() || undefined,
          }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Could not save the API key."));
        return;
      }
      setApiKeyFor(null);
      setNotice({ kind: "ok", message: `Connected "${apiKeyFor.displayName}".` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function refreshConnection(id: string) {
    setBusy(`refresh-${id}`);
    setNotice(null);
    try {
      const r = await fetch(`/api/connections/${encodeURIComponent(id)}/refresh?${q}`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Refresh failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Connection status: ${j.status ?? "refreshed"}.` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string, label: string) {
    if (!await confirmAction(`Disconnect "${label}"? The agent will lose access to it.`)) return;
    setBusy(`disc-${id}`);
    setNotice(null);
    try {
      const r = await fetch(`/api/connections/${encodeURIComponent(id)}?${q}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Disconnect failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Disconnected "${label}".` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function addMcp() {
    if (!mcpName.trim() || !mcpEndpoint.trim()) {
      setNotice({ kind: "error", message: "Name and endpoint are required." });
      return;
    }
    setBusy("add-mcp");
    setNotice(null);
    try {
      const r = await fetch("/api/connectors/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name: mcpName.trim(),
          endpoint: mcpEndpoint.trim(),
          transport: mcpTransport,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Could not add the MCP server."));
        return;
      }
      setMcpName("");
      setMcpEndpoint("");
      setNotice({ kind: "ok", message: `Added MCP server "${j.connector?.displayName ?? mcpName}".` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function deleteMcp(connector: Connector) {
    const key = connector.id ?? connector.key;
    if (!await confirmAction(`Delete the custom MCP server "${connector.displayName}"?`)) return;
    setBusy(`mcp-${connector.key}`);
    setNotice(null);
    try {
      // Delete by the Connector DB id (the route resolves DB rows by id).
      const r = await fetch(`/api/connectors/mcp/${encodeURIComponent(key)}?${q}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Delete failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Deleted "${connector.displayName}".` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const builtIn = connectors.filter((c) => !c.custom);
  const custom = connectors.filter((c) => c.custom);

  /** Reconnect from the Health tab: deep-links the existing connect flow. */
  function reconnectFromHealth(key: string, authType: "oauth2" | "api_key" | "none") {
    if (authType === "none") return;
    connect({
      key,
      displayName: key,
      kind: "native",
      authType: authType === "oauth2" ? "oauth2" : "apiKey",
      description: null,
      custom: false,
      connections: [],
    });
  }

  function connectorCard(c: Connector) {
    return (
      <div key={c.key} data-testid={`connector-card-${c.key}`} className={cardCls}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-medium text-ink">{c.displayName}</h3>
            {c.description && (
              <p className="mt-1 text-sm text-muted">{c.description}</p>
            )}
          </div>
          <span className={chipCls}>
            {c.authType === "oauth2"
              ? "OAuth"
              : c.authType === "apiKey"
                ? "API key"
                : "no auth"}
          </span>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {c.connections.map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">
                  {connectionLabel(conn)}
                </div>
                <div className="text-xs text-muted">
                  connected {new Date(conn.connectedAt).toLocaleDateString()}
                  {conn.scopes.length > 0 &&
                    ` · ${conn.scopes.length} scope${conn.scopes.length === 1 ? "" : "s"}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={chipCls}>{STATUS_LABEL[conn.status]}</span>
                {conn.status !== "revoked" && (
                  <button
                    onClick={() => refreshConnection(conn.id)}
                    disabled={busy === `refresh-${conn.id}`}
                    className={btnGhost}
                  >
                    {busy === `refresh-${conn.id}` ? "Refreshing…" : "Refresh"}
                  </button>
                )}
                <button
                  onClick={() => disconnect(conn.id, connectionLabel(conn))}
                  disabled={busy === `disc-${conn.id}`}
                  className={btnDeny}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          {c.connections.length === 0 && (
            <p className="text-xs text-subtle">Not connected yet.</p>
          )}
        </div>

        <div className="mt-4">
          {c.authType === "none" ? (
            <p className="text-xs text-subtle">
              This connector needs no credentials — enable it per project instead.
            </p>
          ) : (
            <button
              onClick={() => connect(c)}
              disabled={busy === `oauth-${c.key}`}
              className={btnPrimary}
            >
              {busy === `oauth-${c.key}` ? "Starting…" : "Connect"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {connectedKey && (
        <div className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
          Connected &quot;{connectedKey}&quot; — the OAuth flow finished. It now appears
          below with its status.
        </div>
      )}
      {errorMsg && (
        <div
          role="alert"
          className="rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
        >
          The connection flow did not complete: {errorMsg}. You can try
          connecting again.
        </div>
      )}

      <Notice notice={notice} />

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist" aria-label="Connectors">
        {(
          [
            { id: "connections", label: "Connections", icon: Plug },
            { id: "health", label: "Health", icon: Activity },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                tab === t.id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "health" ? (
        <ConnectorHealthTab workspaceId={workspaceId} onReconnect={reconnectFromHealth} />
      ) : (
      <>
      <div className="grid gap-4 md:grid-cols-2">
        {builtIn.map(connectorCard)}
        {builtIn.length === 0 && (
          <p className="text-sm text-muted">No connectors available.</p>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-medium text-ink">Custom MCP servers</h2>
        <p className="mt-1 text-sm text-muted">
          Attach a generic MCP server (Streamable HTTP; stdio is allowed on
          self-hosted installs only). ShapesOS handshakes and lists its tools.
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <label className={labelCls}>
            Name
            <input
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
              placeholder="My tools server"
              className={`${inputCls} mt-1 w-full`}
            />
          </label>
          <label className={`${labelCls} md:col-span-2`}>
            Endpoint
            <input
              value={mcpEndpoint}
              onChange={(e) => setMcpEndpoint(e.target.value)}
              placeholder="https://tools.example.com/mcp"
              className={`${inputCls} mt-1 w-full font-mono text-xs`}
            />
          </label>
          <label className={labelCls}>
            Transport
            <select
              value={mcpTransport}
              onChange={(e) =>
                setMcpTransport(e.target.value as "streamable-http" | "stdio")
              }
              className={`${inputCls} mt-1 w-full`}
            >
              <option value="streamable-http">streamable-http</option>
              <option value="stdio">stdio (self-hosted)</option>
            </select>
          </label>
        </div>
        <div className="mt-3">
          <button
            onClick={addMcp}
            disabled={busy === "add-mcp" || !mcpName.trim() || !mcpEndpoint.trim()}
            className={btnPrimary}
          >
            {busy === "add-mcp" ? "Adding…" : "Add MCP server"}
          </button>
        </div>
        {custom.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {custom.map((c) => {
              const ro = c.readOnlyTools ?? [];
              return (
                <div key={c.key}>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">{c.displayName}</div>
                      <div className="truncate font-mono text-xs text-subtle">
                        {c.description ?? c.key}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={chipCls}>
                        {ro.length === 0
                          ? "all tools ask first"
                          : `${ro.length} read-only tool${ro.length === 1 ? "" : "s"}`}
                      </span>
                      {c.id && (
                        <button
                          onClick={() => setEditingReadOnly(editingReadOnly === c.id ? null : c.id!)}
                          aria-expanded={editingReadOnly === c.id}
                          className={btnGhost}
                        >
                          Read-only tools
                        </button>
                      )}
                      <button
                        onClick={() => deleteMcp(c)}
                        disabled={busy === `mcp-${c.key}`}
                        className={btnDeny}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {c.id && editingReadOnly === c.id && (
                    <McpReadOnlyToolsEditor
                      workspaceId={workspaceId}
                      connectorId={c.id}
                      connectorName={c.displayName}
                      initial={ro}
                      onCancel={() => setEditingReadOnly(null)}
                      onSaved={(tools) => {
                        setEditingReadOnly(null);
                        setConnectors((prev) =>
                          prev.map((x) => (x.id === c.id ? { ...x, readOnlyTools: tools } : x)),
                        );
                        setNotice({
                          kind: "ok",
                          message: `Saved the read-only allow-list for "${c.displayName}".`,
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {apiKeyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
          <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-overlay">
            <h3 className="font-medium text-ink">
              Connect {apiKeyFor.displayName} with an API key
            </h3>
            <p className="mt-1 text-sm text-muted">
              The key is encrypted before storage and never shown again.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <label className={labelCls}>
                Label (optional)
                <input
                  value={apiKeyLabel}
                  onChange={(e) => setApiKeyLabel(e.target.value)}
                  placeholder="Production"
                  className={`${inputCls} mt-1 w-full`}
                />
              </label>
              <label className={labelCls}>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  className={`${inputCls} mt-1 w-full font-mono text-xs`}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setApiKeyFor(null)} className={btnGhost}>
                Cancel
              </button>
              <button
                onClick={submitApiKey}
                disabled={busy === `key-${apiKeyFor.key}` || !apiKey.trim()}
                className={btnPrimary}
              >
                {busy === `key-${apiKeyFor.key}` ? "Saving…" : "Save & connect"}
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
