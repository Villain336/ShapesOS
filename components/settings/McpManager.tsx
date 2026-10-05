"use client";

// Marketr — MCP / API key management UI (Phase C, W5). Admin+ only (server-gated).
//
// Sections: MCP enable toggle (off by default), key list with revoke,
// create-key form (name + per-tool scope picker + optional expiry). The raw
// key is shown ONCE after creation and never again.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { MCP_TOOL_NAMES, SCOPE_LABELS, scopeForTool, type McpToolName } from "@/lib/mcp/scopes";
import { confirmAction } from "@/lib/ui/feedback";
import { SwitchRow } from "@/components/aos/Controls";

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
  // Phase 4a: false when the plan doesn't include API/MCP access.
  const [entitled, setEntitled] = useState(true);
  // Phase 11 (conncore): whether "on/off" is the plan default or the admin's switch.
  const [source, setSource] = useState<"explicit_on" | "explicit_off" | "plan_default">("plan_default");
  const [planDefault, setPlanDefault] = useState(false);
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
      setEntitled(data.entitled !== false);
      if (data.source) setSource(data.source);
      setPlanDefault(data.planDefault === true);
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
    if (data.source) setSource(data.source);
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
    if (!await confirmAction("Revoke this API key? Calls using it will fail immediately.")) return;
    const res = await fetch(`/api/mcp/keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to revoke");
      return;
    }
    await refresh();
  }

  async function revokeClient(clientId: string) {
    if (!await confirmAction("Disconnect this app? All of its tokens stop working immediately.")) return;
    const res = await fetch(`/api/mcp/oauth/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to disconnect");
      return;
    }
    await refresh();
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-8">
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {!entitled && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline">
          <p className="text-sm text-ink">
            API and MCP access isn&apos;t included in your plan. Upgrade to Pro or above in Billing.
          </p>
          <a
            href="/dashboard/billing"
            className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press"
          >
            See plans
          </a>
        </div>
      )}

      <section className={cardCls}>
        <h2 className="text-base font-semibold text-ink">MCP server</h2>
        <p className="mt-1 text-sm text-muted">
          Expose this workspace to MCP clients (Claude Code, Claude, ChatGPT) over streamable HTTP
          at <code className="rounded bg-canvas px-1 font-mono">/mcp</code>. On by default on Pro and Agency
          plans, off otherwise. Callers still need a key or an OAuth sign-in you approve; turning it off closes
          the surface for this workspace.
        </p>
        <div className="mt-4 rounded-lg border border-line">
          <SwitchRow
            title="Enable MCP server for this workspace"
            description={
              !entitled
                ? "Not included in your plan"
                : source === "plan_default"
                  ? `${planDefault ? "On" : "Off"} by default on your plan`
                  : source === "explicit_off"
                    ? "Turned off for this workspace"
                    : "Turned on for this workspace"
            }
            checked={enabled === true}
            disabled={!entitled && enabled !== true}
            onChange={(v) => {
              if (v && !entitled) return;
              void toggleEnabled(v);
            }}
          />
        </div>
      </section>

      {newKey && (
        <section className="rounded-xl border border-line bg-needs-tint p-5">
          <div className="flex items-center gap-2">
            <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Warning" />
            <h2 className="text-base font-semibold text-ink">Key created — copy it now</h2>
          </div>
          <p className="mt-1 text-sm text-ink">
            This is the only time the raw key is shown. Store it somewhere safe.
          </p>
          <code className="mt-3 block break-all rounded-md bg-paper p-3 font-mono text-sm text-ink">{newKey.key}</code>
          <p className="mt-2 text-xs text-muted">
            Use as <code className="font-mono">Authorization: Bearer {newKey.keyPrefix}…</code> against <code className="font-mono">/mcp</code>.
          </p>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className={`${btnGhost} mt-3`}
          >
            I&apos;ve copied it
          </button>
        </section>
      )}

      <section className={cardCls}>
        <h2 className="text-base font-semibold text-ink">API keys</h2>
        <p className="mt-1 text-xs text-muted">
          Credit usage per key for the current billing period. Attribution follows the key even
          after it is revoked.
        </p>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No API keys yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium text-ink">
                    {k.name}{" "}
                    <code className="rounded bg-canvas px-1 font-mono text-xs text-muted">{k.keyPrefix}…</code>
                    {k.revokedAt && (
                      <span className={`${chipCls} ml-2`}>revoked</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
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
                    className={btnDeny}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-base font-semibold text-ink">Create API key</h2>
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Code on my laptop"
              className={inputCls}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-ink">Scopes (per-tool permissions)</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {MCP_TOOL_NAMES.map((tool) => {
                const selected = scopes.includes(scopeForTool(tool));
                return (
                  <button
                    key={tool}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleScope(tool)}
                    className={`flex items-start gap-2 rounded-md border p-3 text-left text-sm transition ${
                      selected
                        ? "border-ink bg-paper shadow-[inset_0_0_0_1px_var(--aos-ink)]"
                        : "border-line bg-paper hover:border-control"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-[1.5px] ${
                        selected ? "border-ink bg-ink text-white" : "border-control"
                      }`}
                      aria-hidden="true"
                    >
                      {selected && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span>
                      <span className="font-medium text-ink">{SCOPE_LABELS[tool].title}</span>
                      <span className="block text-xs text-muted">{SCOPE_LABELS[tool].description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted">
              Expires (defaults to 90 days, at most 1 year). Keys also stop working if their creator
              stops being an admin.
            </span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className={inputCls}
            />
          </label>
          <button
            type="button"
            onClick={createKey}
            disabled={creating || enabled !== true || !entitled}
            className={`${btnPrimary} self-start`}
          >
            {creating ? "Creating…" : "Create key"}
          </button>
          {enabled !== true && (
            <p className="text-xs text-muted">Enable the MCP server above before creating keys.</p>
          )}
        </div>
      </section>
      <section className={cardCls}>
        <h2 className="text-base font-semibold text-ink">Connected OAuth clients</h2>
        <p className="mt-1 text-xs text-muted">
          MCP apps you approved on the OAuth consent screen. Deleting a client revokes all of its tokens immediately.
        </p>
        {clients.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No OAuth clients connected.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {clients.map((c) => (
              <li key={c.clientId} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium text-ink">{c.clientName ?? "Unnamed client"}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    <code className="rounded bg-canvas px-1 font-mono">{c.clientId.slice(0, 12)}…</code>
                    {` · connected ${new Date(c.createdAt).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => revokeClient(c.clientId)}
                  className={btnDeny}
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
