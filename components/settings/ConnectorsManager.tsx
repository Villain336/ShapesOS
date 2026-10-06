// Marketr — workspace connectors manager (milestone 21, part D1).
// Client component: the built-in connector cards (OAuth / typed-in
// credential connect, per-connection status + refresh/disconnect), plus
// custom MCP servers.
// Phase 14 (connectors): the credential form is rendered from each
// connector's declared fields (GET /api/connectors → credentialModes):
// WordPress site URL + username + application password, DataForSEO login +
// password, Shopify single store (Dev Dashboard client ID/secret or an older
// custom app's token). Registry auth type "api_key" now opens it too (it
// used to be compared against "apiKey" only, so native API-key connectors
// had no working Connect button).

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Check, Plug } from "lucide-react";
import ConnectorHealthTab from "./ConnectorHealthTab";
import McpReadOnlyToolsEditor from "./McpReadOnlyToolsEditor";
import McpToolPoliciesEditor from "./McpToolPoliciesEditor";
import ZernioCard from "./ZernioCard";
import { confirmAction } from "@/lib/ui/feedback";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
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

interface CredentialField {
  name: string;
  label: string;
  kind: "text" | "secret" | "url" | "shop_domain";
  required: boolean;
  placeholder?: string;
  help?: string;
}

interface CredentialMode {
  id: string;
  label: string;
  help?: string;
  fields: CredentialField[];
}

interface Connector {
  key: string;
  id?: string; // DB id, present for custom MCP connectors; used by DELETE.
  displayName: string;
  kind: "native" | "mcp";
  authType: "oauth2" | "apiKey" | "api_key" | "none";
  /** Phase 14: typed-in credential forms (built-ins only). */
  credentialModes?: CredentialMode[];
  description: string | null;
  custom: boolean;
  connections: Connection[];
  /** Custom MCP only: tools the agent may run without asking (admin allow-list). */
  readOnlyTools?: string[];
  /** Phase 11 (conncore): OAuth-protected MCP server; tools mapped to a group/tier. */
  needsAuth?: boolean;
  mappedTools?: number;
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
  zernioNotice = null,
  zernioError = null,
}: {
  workspaceId: string;
  connectedKey: string | null;
  errorMsg: string | null;
  initialTab?: "connections" | "health";
  /** Phase 15.4 (zernio): the result the Zernio connect callback came back with. */
  zernioNotice?: string | null;
  zernioError?: string | null;
}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"connections" | "health">(initialTab ?? "connections");
  // Phase 14: the typed-in credential form (fields from the registry schema).
  const [credFor, setCredFor] = useState<Connector | null>(null);
  const [credMode, setCredMode] = useState("");
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [credLabel, setCredLabel] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"streamable-http" | "stdio">(
    "streamable-http",
  );
  const [editingReadOnly, setEditingReadOnly] = useState<string | null>(null);
  const [editingPolicies, setEditingPolicies] = useState<string | null>(null);
  // Phase 11 (bizsync): Shopify installs per store — ask for the store domain first.
  const [shopFor, setShopFor] = useState<Connector | null>(null);
  const [shopDomain, setShopDomain] = useState("");

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

  function openCredentials(c: Connector) {
    setCredValues({});
    setCredLabel("");
    setCredMode(c.credentialModes?.[0]?.id ?? "api_key");
    setCredFor(c);
  }

  async function connect(c: Connector, shop?: string) {
    setNotice(null);
    if (c.key === "shopify" && !shop) {
      // Phase 14: your own store first (single-store connection); the hosted
      // ShapesOS app's OAuth stays one click away inside that form.
      if (c.credentialModes?.length) {
        openCredentials(c);
        return;
      }
      // Phase 11 (bizsync): the OAuth host is the store itself.
      setShopDomain("");
      setShopFor(c);
      return;
    }
    if (c.authType === "oauth2") {
      setBusy(`oauth-${c.key}`);
      try {
        const r = await fetch(
          `/api/connectors/${encodeURIComponent(c.key)}/auth-url?${q}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`,
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
    } else if (c.authType === "apiKey" || c.authType === "api_key") {
      openCredentials(c);
    }
  }

  const activeMode: CredentialMode | null =
    credFor?.credentialModes?.find((m) => m.id === credMode) ?? credFor?.credentialModes?.[0] ?? null;
  const credMissing = !activeMode || activeMode.fields.some((f) => f.required && !(credValues[f.name] ?? "").trim());

  async function submitCredentials() {
    if (!credFor || !activeMode || credMissing) return;
    const key = credFor.key;
    setBusy(`key-${key}`);
    setNotice(null);
    try {
      const fields: Record<string, string> = {};
      for (const f of activeMode.fields) {
        const v = credValues[f.name] ?? "";
        if (v.trim()) fields[f.name] = f.kind === "secret" ? v : v.trim();
      }
      const r = await fetch(
        `/api/connectors/${encodeURIComponent(key)}/api-key`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            mode: activeMode.id,
            fields,
            label: credLabel.trim() || undefined,
          }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Could not save the credentials."));
        return;
      }
      const name = credFor.displayName;
      setCredFor(null);
      setCredValues({});
      const warnings = Array.isArray(j.warnings) ? (j.warnings as string[]) : [];
      setNotice({
        kind: warnings.length ? "info" : "ok",
        message: `Connected "${name}".${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
      });
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
      setNotice({
        kind: "ok",
        message: j.needsAuth
          ? `Added MCP server "${j.connector?.displayName ?? mcpName}". It needs sign-in: use Sign in next to it.`
          : `Added MCP server "${j.connector?.displayName ?? mcpName}".`,
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  // Phase 11 (conncore): sign in to an OAuth-protected MCP server.
  async function signInMcp(connector: Connector) {
    if (!connector.id) return;
    setBusy(`mcp-auth-${connector.key}`);
    setNotice(null);
    try {
      const r = await fetch(`/api/connectors/mcp/${encodeURIComponent(connector.id)}/oauth?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.url !== "string") {
        setNotice(err(j, "Could not start sign-in."));
        return;
      }
      window.location.assign(j.url);
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
    // Phase 14: the loaded card carries the credential form schema.
    const known = connectors.find((x) => x.key === key && !x.custom);
    if (known) {
      connect(known);
      return;
    }
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
    // Phase 15.4 (zernio): a platform key with per-platform account connects.
    if (c.key === "zernio") {
      return <ZernioCard key={c.key} workspaceId={workspaceId} notice={zernioNotice} errorNotice={zernioError} />;
    }
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
            {c.key === "shopify" && c.credentialModes?.length
              ? "Your store"
              : c.authType === "oauth2"
                ? "OAuth"
                : c.authType === "apiKey" || c.authType === "api_key"
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

        <div className="mt-4 flex flex-wrap gap-2">
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
          {/* Phase 11 (bizsync): sync status, mappings and run log. */}
          {(c.key === "shopify" || c.key === "quickbooks" || c.key === "xero" || c.key === "gusto") && (
            <Link href={`/dashboard/settings/connectors/sync?provider=${c.key}`} className={btnGhost}>
              Sync settings
            </Link>
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
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
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
          self-hosted installs only). ShapesOS handshakes and lists its tools;
          a server that needs sign-in is added first, then you sign in with OAuth.
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
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {c.needsAuth && (
                        <span className={chipCls}>
                          {c.connections.some((x) => x.status === "active") ? "signed in" : "needs sign-in"}
                        </span>
                      )}
                      <span className={chipCls}>
                        {ro.length === 0
                          ? "all tools ask first"
                          : `${ro.length} read-only tool${ro.length === 1 ? "" : "s"}`}
                      </span>
                      {c.needsAuth && c.id && (
                        <button
                          onClick={() => signInMcp(c)}
                          disabled={busy === `mcp-auth-${c.key}`}
                          className={btnGhost}
                        >
                          {c.connections.some((x) => x.status === "active") ? "Sign in again" : "Sign in"}
                        </button>
                      )}
                      {c.id && (
                        <button
                          onClick={() => setEditingPolicies(editingPolicies === c.id ? null : c.id!)}
                          aria-expanded={editingPolicies === c.id}
                          className={btnGhost}
                        >
                          Tool groups
                        </button>
                      )}
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
                  {c.id && editingPolicies === c.id && (
                    <McpToolPoliciesEditor
                      workspaceId={workspaceId}
                      connectorId={c.id}
                      connectorName={c.displayName}
                      onCancel={() => setEditingPolicies(null)}
                      onSaved={(mapped) => {
                        setEditingPolicies(null);
                        setConnectors((prev) => prev.map((x) => (x.id === c.id ? { ...x, mappedTools: mapped } : x)));
                        setNotice({ kind: "ok", message: `Saved tool groups for "${c.displayName}".` });
                      }}
                    />
                  )}
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

      {shopFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4">
          <div className="w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-overlay">
            <h3 className="font-medium text-ink">Connect your Shopify store</h3>
            <p className="mt-1 text-sm text-muted">
              Enter the store&apos;s Shopify domain. You approve the app on Shopify next.
            </p>
            <label className={`${labelCls} mt-3`}>
              Store domain
              <input
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                placeholder="your-store.myshopify.com"
                autoComplete="off"
                className={`${inputCls} mt-1 w-full font-mono text-xs`}
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShopFor(null)} className={btnGhost}>
                Cancel
              </button>
              <button
                onClick={() => {
                  const c = shopFor;
                  setShopFor(null);
                  connect(c, shopDomain.trim());
                }}
                disabled={!shopDomain.trim()}
                className={btnPrimary}
              >
                Continue to Shopify
              </button>
            </div>
          </div>
        </div>
      )}

      {credFor && activeMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cred-title"
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-line bg-paper p-5 shadow-overlay"
          >
            <h3 id="cred-title" className="font-medium text-ink">
              Connect {credFor.displayName}
            </h3>
            <p className="mt-1 text-sm text-muted">
              Secrets are encrypted before storage and never shown again.
            </p>
            {(credFor.credentialModes?.length ?? 0) > 1 && (
              <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="How to connect">
                {credFor.credentialModes!.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={m.id === activeMode.id}
                    onClick={() => setCredMode(m.id)}
                    className={m.id === activeMode.id ? btnPrimary : btnGhost}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {activeMode.help && <p className="mt-3 text-sm text-muted">{activeMode.help}</p>}
            <div className="mt-3 flex flex-col gap-2">
              <label className={labelCls}>
                Label (optional)
                <input
                  value={credLabel}
                  onChange={(e) => setCredLabel(e.target.value)}
                  placeholder="Production"
                  className={`${inputCls} mt-1 w-full`}
                />
              </label>
              {activeMode.fields.map((f) => (
                <label key={`${activeMode.id}-${f.name}`} className={labelCls}>
                  {f.label}
                  {f.required ? "" : " (optional)"}
                  <input
                    type={f.kind === "secret" ? "password" : f.kind === "url" ? "url" : "text"}
                    value={credValues[f.name] ?? ""}
                    onChange={(e) => setCredValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    placeholder={f.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    required={f.required}
                    className={`${inputCls} mt-1 w-full ${f.kind === "text" ? "" : "font-mono text-xs"}`}
                  />
                  {f.help && <span className="mt-1 block text-xs font-normal text-subtle">{f.help}</span>}
                </label>
              ))}
            </div>
            {credFor.key === "shopify" && (
              <p className="mt-3 text-xs text-subtle">
                Using a hosted ShapesOS Shopify app instead?{" "}
                <button
                  type="button"
                  className="font-semibold text-ink underline"
                  onClick={() => {
                    const c = credFor;
                    setCredFor(null);
                    setShopDomain(credValues.shop ?? "");
                    setShopFor(c);
                  }}
                >
                  Install it with OAuth
                </button>
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setCredFor(null)} className={btnGhost}>
                Cancel
              </button>
              <button
                onClick={submitCredentials}
                disabled={busy === `key-${credFor.key}` || credMissing}
                className={btnPrimary}
              >
                {busy === `key-${credFor.key}` ? "Checking…" : "Save & connect"}
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
