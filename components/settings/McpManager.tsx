"use client";

// Marketr — MCP / API key management UI (Phase C, W5). Admin+ only (server-gated).
//
// Sections: MCP enable toggle (off by default), key list with revoke,
// create-key form (name + per-tool scope picker + optional expiry). The raw
// key is shown ONCE after creation and never again.

import { useEffect, useState } from "react";
import { MCP_TOOL_NAMES, SCOPE_LABELS, scopeForTool, type McpToolName } from "@/lib/mcp/scopes";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  // G3: credits charged to this key in the current billing period (0 when
  // the key has no usage, or when usage reporting is unavailable).
  usageCredits?: number;
}

interface OAuthClient {
  clientId: string;
  clientName: string | null;
  workspaceId: string | null;
  createdAt: string;
}

export default function McpManager() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string; keyPrefix: string } | null>(null);
  // Create form state
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([scopeForTool("list_projects")]);
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/keys");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setEnabled(data.enabled);
      setKeys(data.keys);
      const cres = await fetch("/api/mcp/oauth/clients");
      const cdata = await cres.json().catch(() => ({ clients: [] }));
      if (cres.ok) setClients(cdata.clients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggleEnabled(next: boolean) {
    setError(null);
    const res = await fetch("/api/mcp/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Failed to update");
      return;
    }
    setEnabled(data.enabled);
  }

  function toggleScope(tool: McpToolName) {
    const s = scopeForTool(tool);
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function createKey() {
    if (!name.trim() || scopes.length === 0) {
      setError("Name and at least one scope are required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          // datetime-local has no offset; the API requires RFC 3339 with
          // offset — convert to ISO in the browser's local zone.
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to create key");
      setNewKey({ name: data.name, key: data.key, keyPrefix: data.keyPrefix });
      setName("");
      setExpiresAt("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    }
    setCreating(false);
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this API key? Calls using it will fail immediately.")) return;
    const res = await fetch(`/api/mcp/keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to revoke");
      return;
    }
    await refresh();
  }

  async function revokeClient(clientId: string) {
    if (!confirm("Disconnect this app? All of its tokens stop working immediately.")) return;
    const res = await fetch(`/api/mcp/oauth/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to disconnect");
      return;
    }
    await refresh();
  }

  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-8">
      {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold">MCP server</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Expose this workspace to MCP clients (Claude Code, Claude, ChatGPT) over streamable HTTP
          at <code className="rounded bg-zinc-100 px-1">/mcp</code>. Disabled by default — enabling
          opens a new authenticated API surface for this workspace.
        </p>
        <label className="mt-4 flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={enabled === true}
            onChange={(e) => toggleEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="font-medium">Enable MCP server for this workspace</span>
        </label>
      </section>

      {newKey && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5">
          <h2 className="text-base font-semibold">Key created — copy it now</h2>
          <p className="mt-1 text-sm text-zinc-600">
            This is the only time the raw key is shown. Store it somewhere safe.
          </p>
          <code className="mt-3 block break-all rounded bg-white p-3 text-sm">{newKey.key}</code>
          <p className="mt-2 text-xs text-zinc-500">
            Use as <code>Authorization: Bearer {newKey.keyPrefix}…</code> against <code>/mcp</code>.
          </p>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
          >
            I&apos;ve copied it
          </button>
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold">API keys</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Credit usage per key for the current billing period. Attribution follows the key even
          after it is revoked.
        </p>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No API keys yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium">
                    {k.name}{" "}
                    <code className="rounded bg-zinc-100 px-1 text-xs text-zinc-500">{k.keyPrefix}…</code>
                    {k.revokedAt && (
                      <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-xs">revoked</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {k.scopes.length} scope{k.scopes.length === 1 ? "" : "s"}
                    {` · ${k.usageCredits ?? 0} credit${(k.usageCredits ?? 0) === 1 ? "" : "s"} used`}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}` : " · never used"}
                    {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                {!k.revokedAt && (
                  <button
                    type="button"
                    onClick={() => revoke(k.id)}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-red-700"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold">Create API key</h2>
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Code on my laptop"
              className="rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">Scopes (per-tool permissions)</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {MCP_TOOL_NAMES.map((tool) => (
                <label key={tool} className="flex items-start gap-2 rounded-md border border-zinc-200 p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scopeForTool(tool))}
                    onChange={() => toggleScope(tool)}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="font-medium">{SCOPE_LABELS[tool].title}</span>
                    <span className="block text-xs text-zinc-500">{SCOPE_LABELS[tool].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Expires (optional)</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
          <button
            type="button"
            onClick={createKey}
            disabled={creating || enabled !== true}
            className="self-start rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create key"}
          </button>
          {enabled !== true && (
            <p className="text-xs text-zinc-500">Enable the MCP server above before creating keys.</p>
          )}
        </div>
      </section>
      <section className="rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="text-base font-semibold">Connected OAuth clients</h2>
        <p className="mt-1 text-xs text-zinc-500">
          MCP apps you approved on the OAuth consent screen. Deleting a client revokes all of its tokens immediately.
        </p>
        {clients.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No OAuth clients connected.</p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {clients.map((c) => (
              <li key={c.clientId} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium">{c.clientName ?? "Unnamed client"}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    <code className="rounded bg-zinc-100 px-1">{c.clientId.slice(0, 12)}…</code>
                    {` · connected ${new Date(c.createdAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => revokeClient(c.clientId)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-red-700"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}
