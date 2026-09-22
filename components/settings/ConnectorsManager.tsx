// Marketr — workspace connectors manager (milestone 21, part D1).
// Client component: 12 built-in connector cards (OAuth / API-key connect,
// per-connection status + refresh/disconnect), plus custom MCP servers.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Notice,
  btnCls,
  cardCls,
  dangerBtnCls,
  inputCls,
  labelCls,
  primaryBtnCls,
  type NoticeState,
} from "./ui";

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
}

const STATUS_BADGE: Record<Connection["status"], string> = {
  active: "bg-emerald-50 text-emerald-700",
  needs_reauth: "bg-amber-50 text-amber-700",
  revoked: "bg-red-50 text-red-700",
};

const STATUS_LABEL: Record<Connection["status"], string> = {
  active: "active",
  needs_reauth: "needs re-auth",
  revoked: "revoked",
};

const AUTH_BADGE: Record<Connector["authType"], string> = {
  oauth2: "bg-emerald-50 text-emerald-700",
  apiKey: "bg-zinc-100 text-zinc-600",
  none: "bg-zinc-100 text-zinc-400",
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
}: {
  workspaceId: string;
  connectedKey: string | null;
  errorMsg: string | null;
}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [apiKeyFor, setApiKeyFor] = useState<Connector | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyLabel, setApiKeyLabel] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"streamable-http" | "stdio">(
    "streamable-http",
  );

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
    if (!confirm(`Disconnect "${label}"? The agent will lose access to it.`)) return;
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
    if (!confirm(`Delete the custom MCP server "${connector.displayName}"?`)) return;
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

  function connectorCard(c: Connector) {
    return (
      <div key={c.key} className={cardCls}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-medium">{c.displayName}</h3>
            {c.description && (
              <p className="mt-1 text-sm text-zinc-500">{c.description}</p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${AUTH_BADGE[c.authType]}`}
          >
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
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {connectionLabel(conn)}
                </div>
                <div className="text-xs text-zinc-500">
                  connected {new Date(conn.connectedAt).toLocaleDateString()}
                  {conn.scopes.length > 0 &&
                    ` · ${conn.scopes.length} scope${conn.scopes.length === 1 ? "" : "s"}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[conn.status]}`}
                >
                  {STATUS_LABEL[conn.status]}
                </span>
                {conn.status !== "revoked" && (
                  <button
                    onClick={() => refreshConnection(conn.id)}
                    disabled={busy === `refresh-${conn.id}`}
                    className="rounded-md border border-zinc-200 bg-zinc-100 px-2 py-1 text-xs text-zinc-800 hover:bg-zinc-200 disabled:opacity-50"
                  >
                    {busy === `refresh-${conn.id}` ? "Refreshing…" : "Refresh"}
                  </button>
                )}
                <button
                  onClick={() => disconnect(conn.id, connectionLabel(conn))}
                  disabled={busy === `disc-${conn.id}`}
                  className={dangerBtnCls}
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          {c.connections.length === 0 && (
            <p className="text-xs text-zinc-400">Not connected yet.</p>
          )}
        </div>

        <div className="mt-4">
          {c.authType === "none" ? (
            <p className="text-xs text-zinc-400">
              This connector needs no credentials — enable it per project instead.
            </p>
          ) : (
            <button
              onClick={() => connect(c)}
              disabled={busy === `oauth-${c.key}`}
              className={primaryBtnCls}
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
        <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-800">
          Connected &quot;{connectedKey}&quot; — the OAuth flow finished. It now appears
          below with its status.
        </div>
      )}
      {errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-sm text-red-700">
          The connection flow did not complete: {errorMsg}. You can try
          connecting again.
        </div>
      )}

      <Notice notice={notice} />

      <div className="grid gap-4 md:grid-cols-2">
        {builtIn.map(connectorCard)}
        {builtIn.length === 0 && (
          <p className="text-sm text-zinc-500">No connectors available.</p>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="font-medium">Custom MCP servers</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Attach a generic MCP server (Streamable HTTP; stdio is allowed on
          self-hosted installs only). Marketr handshakes and lists its tools.
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
            className={primaryBtnCls}
          >
            {busy === "add-mcp" ? "Adding…" : "Add MCP server"}
          </button>
        </div>
        {custom.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {custom.map((c) => (
              <div
                key={c.key}
                className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{c.displayName}</div>
                  <div className="truncate font-mono text-xs text-zinc-400">
                    {c.description ?? c.key}
                  </div>
                </div>
                <button
                  onClick={() => deleteMcp(c)}
                  disabled={busy === `mcp-${c.key}`}
                  className={dangerBtnCls}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {apiKeyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5">
            <h3 className="font-medium">
              Connect {apiKeyFor.displayName} with an API key
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
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
              <button onClick={() => setApiKeyFor(null)} className={btnCls}>
                Cancel
              </button>
              <button
                onClick={submitApiKey}
                disabled={busy === `key-${apiKeyFor.key}` || !apiKey.trim()}
                className={primaryBtnCls}
              >
                {busy === `key-${apiKeyFor.key}` ? "Saving…" : "Save & connect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
