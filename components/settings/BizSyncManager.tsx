// ShapesOS — Phase 11 (bizsync): Settings → Connectors → Business sync.
// Per provider (Shopify, QuickBooks, Xero): the connection, what is mapped,
// the recent sync / export runs with their errors, and the decisions only a
// person makes — Shopify location ↔ stock location, the Xero organisation,
// and the chart-of-accounts mapping (shared QuickBooks/Xero model). Syncs and
// exports themselves run as agent tools that always ask first.
// Phase 14 (connectors): + Gusto — a person confirms which Gusto employee each
// team member is (email matches are only suggestions); pay runs are sent to
// Gusto from the pay run page.
// Run and connection states are provider states, not agent states: neutral
// chips, never the status colors.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Calculator, Check, RefreshCw, ShoppingBag, Wallet, type LucideIcon } from "lucide-react";
import {
  btnGhostSm,
  btnPrimarySm,
  chipCls,
  errorBoxCls,
  infoBoxCls,
  noteBoxCls,
  selectCls,
  tabCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";

type Provider = "shopify" | "quickbooks" | "xero" | "gusto";

interface RunView {
  id: string;
  operation: string;
  status: string;
  summary: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface ProviderStatus {
  provider: Provider;
  connection: { id: string; status: string; label: string | null; connectedAt: string } | null;
  links: Record<string, number>;
  runs: RunView[];
  lastRun: RunView | null;
  lastError: { at: string; operation: string; error: string } | null;
  exports: { exported: number; pending: number; failed: number; lastExportedAt: string | null; recentFailures: Array<{ sourceKey: string; lastError: string | null; updatedAt: string }> } | null;
  tenants: Array<{ tenantId: string; tenantName: string }> | null;
  tenantId: string | null;
  tenantError: string | null;
}

interface RemoteAccount {
  id: string;
  code: string | null;
  name: string;
  type: string;
  cls: string;
  active: boolean;
}

interface MappingRow {
  account: { id: string; code: string; name: string; type: string; active: boolean; systemKey: string | null };
  link: { remoteAccountId: string; remoteName: string; status: string; matchReason: string | null } | null;
}

const META: Record<Provider, { label: string; icon: LucideIcon; tools: string }> = {
  shopify: { label: "Shopify", icon: ShoppingBag, tools: "shopify.sync_from_shopify, shopify.push_inventory, shopify.register_webhooks" },
  quickbooks: { label: "QuickBooks", icon: Calculator, tools: "quickbooks.import_contacts, quickbooks.post_to_quickbooks" },
  xero: { label: "Xero", icon: BookOpen, tools: "xero.import_contacts, xero.post_to_xero" },
  gusto: { label: "Gusto", icon: Wallet, tools: "gusto.sync_employees, gusto.send_payroll" },
};

const OBJECT_LABEL: Record<string, string> = {
  product: "products",
  variant: "variants",
  inventory_item: "stock items",
  inventory_level: "stock levels",
  location: "locations",
  order: "orders",
  customer: "customers",
  vendor: "vendors",
  invoice_customer: "invoice customers",
  item: "sales items",
  employee: "employees",
};

type Loaded<T> = { ok: true; data: T } | { ok: false; error: string | null };

/** GET a JSON route (no state here — callers apply the result). */
async function getJson<T>(url: string): Promise<Loaded<T>> {
  const r = await fetch(url);
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  return r.ok ? { ok: true, data: j } : { ok: false, error: typeof j.error === "string" ? j.error : null };
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

/** One line from a run summary (sync, push, export and webhook shapes). */
export function summarizeRun(s: Record<string, unknown> | null): string {
  if (!s) return "";
  const n = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : Array.isArray(s[k]) ? (s[k] as unknown[]).length : null);
  const parts: string[] = [];
  const add = (k: string, label: string) => {
    const v = n(k);
    if (v) parts.push(`${v} ${label}`);
  };
  if (Array.isArray(s.exported)) {
    add("exported", "posted");
    add("alreadyExported", "already posted");
    add("skipped", "skipped");
    add("failed", "failed");
  } else {
    add("created", "created");
    add("updated", "updated");
    add("linked", "linked");
    add("pushed", "pushed");
    add("localAhead", "kept local");
    add("unchanged", "unchanged");
    add("conflicts", "conflicts");
    add("failed", "failed");
    if (Array.isArray(s.created) && Array.isArray(s.existing)) parts.push(`${(s.created as unknown[]).length} webhooks added`);
  }
  if (s.truncated) parts.push("more to fetch");
  return parts.join(" · ") || "nothing to do";
}

export default function BizSyncManager({ workspaceId, initialProvider }: { workspaceId: string; initialProvider?: Provider }) {
  const [tab, setTab] = useState<Provider>(initialProvider ?? "shopify");
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const apply = useCallback((res: Loaded<{ providers?: ProviderStatus[] }>) => {
    setError(res.ok ? null : res.error ?? "Could not load sync status.");
    if (res.ok) setStatus(res.data.providers ?? []);
  }, []);
  const load = useCallback(async () => apply(await getJson(`/api/bizsync?${q}`)), [apply, q]);

  useEffect(() => {
    let live = true;
    getJson<{ providers?: ProviderStatus[] }>(`/api/bizsync?${q}`).then((res) => {
      if (live) apply(res);
    });
    return () => {
      live = false;
    };
  }, [apply, q]);

  const current = status?.find((s) => s.provider === tab) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4 border-b border-line" role="tablist" aria-label="Business sync providers">
        {(Object.keys(META) as Provider[]).map((p) => {
          const Icon = META[p].icon;
          return (
            <button key={p} role="tab" aria-selected={tab === p} onClick={() => setTab(p)} className={tabCls(tab === p)}>
              <Icon size={15} aria-hidden="true" />
              {META[p].label}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className={errorBoxCls}>
          {error}
        </div>
      )}
      {!status && !error && <p className="text-sm text-muted">Loading sync status…</p>}
      {current && <ProviderPanel key={tab} workspaceId={workspaceId} status={current} onChanged={load} />}
    </div>
  );
}

function ProviderPanel({ workspaceId, status, onChanged }: { workspaceId: string; status: ProviderStatus; onChanged: () => void }) {
  const meta = META[status.provider];
  const conn = status.connection;
  const linkEntries = Object.entries(status.links).filter(([, v]) => v > 0);
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{meta.label}</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {conn ? (
                <>
                  {conn.label ?? "Connected"} · connected {new Date(conn.connectedAt).toLocaleDateString()}
                </>
              ) : (
                <>Not connected. Connect it on the Connections tab first.</>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={chipCls}>{conn ? conn.status.replace("_", " ") : "not connected"}</span>
            <span className={chipCls}>last run {status.lastRun ? when(status.lastRun.startedAt) : "never"}</span>
            <button onClick={onChanged} className={btnGhostSm} aria-label="Refresh status">
              <RefreshCw size={13} aria-hidden="true" /> Refresh
            </button>
          </div>
        </div>
        {linkEntries.length > 0 && (
          <p className="mt-3 text-[13px] text-muted">
            Mapped: {linkEntries.map(([k, v]) => `${v} ${OBJECT_LABEL[k] ?? k}`).join(" · ")}
          </p>
        )}
        {status.exports && (
          <p className="mt-1 text-[13px] text-muted">
            Posted to {meta.label}: {status.exports.exported} document{status.exports.exported === 1 ? "" : "s"}
            {status.exports.pending ? ` · ${status.exports.pending} interrupted (retried with the same key next run)` : ""}
            {status.exports.failed ? ` · ${status.exports.failed} refused` : ""}
            {status.exports.lastExportedAt ? ` · last ${when(status.exports.lastExportedAt)}` : ""}
          </p>
        )}
        {status.lastError && (
          <div role="alert" className={`${errorBoxCls} mt-3`}>
            Last error ({status.lastError.operation}, {when(status.lastError.at)}): {status.lastError.error}
          </div>
        )}
        {status.tenantError && (
          <div role="alert" className={`${errorBoxCls} mt-3`}>
            {status.tenantError}
          </div>
        )}
      </section>

      {conn?.status === "active" && status.provider === "xero" && <XeroTenantPicker workspaceId={workspaceId} status={status} onChanged={onChanged} />}
      {conn?.status === "active" && status.provider === "shopify" && <LocationMapping workspaceId={workspaceId} />}
      {conn?.status === "active" && status.provider === "gusto" && <EmployeeMapping workspaceId={workspaceId} />}
      {conn?.status === "active" && (status.provider === "quickbooks" || status.provider === "xero") && (status.provider !== "xero" || status.tenantId) && (
        <AccountMapping workspaceId={workspaceId} provider={status.provider} />
      )}

      {status.exports && status.exports.recentFailures.length > 0 && (
        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink">Documents waiting</h3>
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Source</th>
                  <th className={thCls}>Why</th>
                  <th className={thCls}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {status.exports.recentFailures.map((f) => (
                  <tr key={f.sourceKey}>
                    <td className={`${tdCls} font-mono text-xs`}>{f.sourceKey}</td>
                    <td className={tdCls}>{f.lastError ?? "interrupted — retried with the same key next run"}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{when(f.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[13px] font-bold text-ink">Recent runs</h3>
        {status.runs.length === 0 ? (
          <p className="text-[13px] text-muted">No runs yet. Ask an agent to run a sync — it asks before it writes anything.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={`${tableCls} min-w-[640px]`}>
              <thead>
                <tr>
                  <th className={thCls}>Operation</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Started</th>
                  <th className={thCls}>Result</th>
                </tr>
              </thead>
              <tbody>
                {status.runs.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdCls} font-mono text-xs`}>{r.operation}</td>
                    <td className={tdCls}>
                      <span className={chipCls}>{r.status}</span>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{when(r.startedAt)}</td>
                    <td className={tdCls}>{r.error ? <span className="text-failed-text">{r.error}</span> : summarizeRun(r.summary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className={infoBoxCls}>
        {status.provider === "gusto"
          ? `Pay runs go to Gusto from the pay run page (or the ${meta.tools} agent tools). Sending payroll is never automated: it always asks, and you submit the payroll in Gusto yourself.`
          : `Syncs and exports run as agent tools (${meta.tools}) and always ask before they write. Posting to accounting software is never automated.`}
      </p>
    </div>
  );
}

function XeroTenantPicker({ workspaceId, status, onChanged }: { workspaceId: string; status: ProviderStatus; onChanged: () => void }) {
  const [tenantId, setTenantId] = useState(status.tenantId ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tenants = status.tenants ?? [];
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/bizsync/xero`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, action: "select_tenant", tenantId }) });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? { ok: true, text: `Using ${j.tenantName}.` } : { ok: false, text: j.error ?? "Could not change the organisation." });
      if (r.ok) onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <h3 className="text-[13px] font-bold text-ink">Xero organisation</h3>
      <p className="mt-0.5 text-[13px] text-muted">Exports and imports use this organisation.</p>
      {tenants.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">No organisations were granted. Reconnect Xero and pick at least one.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="xero-tenant">
            Xero organisation
          </label>
          <select id="xero-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={selectCls}>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName}
              </option>
            ))}
          </select>
          <button onClick={save} disabled={busy || !tenantId || tenantId === status.tenantId} className={btnPrimarySm}>
            {busy ? "Saving…" : "Use this organisation"}
          </button>
        </div>
      )}
      {msg && <p className={`mt-2 ${msg.ok ? noteBoxCls : errorBoxCls}`}>{msg.text}</p>}
    </section>
  );
}

function LocationMapping({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<{ remote: Array<{ id: string; name: string; active: boolean }>; local: Array<{ id: string; path: string; name: string | null }>; links: Array<{ remoteId: string; localId: string }> } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;
  type View = NonNullable<typeof data>;
  const apply = useCallback((res: Loaded<View>) => {
    if (!res.ok) {
      setMsg({ ok: false, text: res.error ?? "Could not load Shopify locations." });
      return;
    }
    setData(res.data);
    setChoice(Object.fromEntries(res.data.links.map((l) => [l.remoteId, l.localId])));
  }, []);
  const load = useCallback(async () => apply(await getJson<View>(`/api/bizsync/shopify?${q}`)), [apply, q]);
  useEffect(() => {
    let live = true;
    getJson<View>(`/api/bizsync/shopify?${q}`).then((res) => {
      if (live) apply(res);
    });
    return () => {
      live = false;
    };
  }, [apply, q]);
  async function save(remoteLocationId: string) {
    setBusy(remoteLocationId);
    setMsg(null);
    try {
      const r = await fetch(`/api/bizsync/shopify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, action: "map_location", remoteLocationId, opsLocationId: choice[remoteLocationId] }) });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? { ok: true, text: "Location mapped. The next stock sync compares against it." } : { ok: false, text: j.error ?? "Could not map the location." });
      if (r.ok) load();
    } finally {
      setBusy(null);
    }
  }
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-bold text-ink">Shopify locations</h3>
      <p className="mb-2 text-[13px] text-muted">Each Shopify location keeps its stock in one stock location. A first sync creates a warehouse for any location you haven&apos;t mapped.</p>
      {msg && <p className={`mb-2 ${msg.ok ? noteBoxCls : errorBoxCls}`}>{msg.text}</p>}
      {data && (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Shopify location</th>
                <th className={thCls}>Stock location</th>
                <th className={thCls}>
                  <span className="sr-only">Save</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.remote.map((l) => {
                const linked = data.links.find((x) => x.remoteId === l.id)?.localId ?? "";
                return (
                  <tr key={l.id}>
                    <td className={tdCls}>
                      {l.name}
                      {!l.active && <span className={`${chipCls} ml-2`}>inactive</span>}
                    </td>
                    <td className={tdCls}>
                      <label className="sr-only" htmlFor={`loc-${l.id}`}>
                        Stock location for {l.name}
                      </label>
                      <select id={`loc-${l.id}`} value={choice[l.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [l.id]: e.target.value }))} className={`${selectCls} w-full max-w-[360px]`}>
                        <option value="">Not mapped (a sync creates one)</option>
                        {data.local.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.path}
                            {o.name ? ` — ${o.name}` : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <button onClick={() => save(l.id)} disabled={busy === l.id || !choice[l.id] || choice[l.id] === linked} className={btnPrimarySm}>
                        {busy === l.id ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface EmployeeView {
  remote: Array<{ id: string; name: string; email: string | null; terminated: boolean }>;
  local: Array<{ id: string; name: string; email: string | null; status: string }>;
  links: Array<{ remoteId: string; localId: string; confirmed: boolean; matchedBy: string | null }>;
  suggestions: Array<{ remoteId: string; localId: string; email: string }>;
  truncated: boolean;
}

/** Phase 14: Gusto employee ↔ team member — a person confirms every match. */
function EmployeeMapping({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<EmployeeView | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;
  const apply = useCallback((res: Loaded<EmployeeView>) => {
    if (!res.ok) {
      setMsg({ ok: false, text: res.error ?? "Could not load Gusto employees." });
      return;
    }
    setData(res.data);
    const next: Record<string, string> = {};
    for (const s of res.data.suggestions) next[s.remoteId] = s.localId;
    for (const l of res.data.links) next[l.remoteId] = l.localId;
    setChoice(next);
  }, []);
  const load = useCallback(async () => apply(await getJson<EmployeeView>(`/api/bizsync/gusto?${q}`)), [apply, q]);
  useEffect(() => {
    let live = true;
    getJson<EmployeeView>(`/api/bizsync/gusto?${q}`).then((res) => {
      if (live) apply(res);
    });
    return () => {
      live = false;
    };
  }, [apply, q]);
  async function save(remoteEmployeeId: string, memberId: string | null) {
    setBusy(remoteEmployeeId);
    setMsg(null);
    try {
      const r = await fetch(`/api/bizsync/gusto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, action: "map_employee", remoteEmployeeId, memberId }) });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? { ok: true, text: memberId ? "Match confirmed. Pay runs send this person's hours to Gusto." : "Match cleared." } : { ok: false, text: j.error ?? "Could not save the match." });
      if (r.ok) load();
    } finally {
      setBusy(null);
    }
  }
  const unconfirmed = data ? data.remote.filter((e) => !data.links.some((l) => l.remoteId === e.id && l.confirmed)).length : 0;
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-bold text-ink">Gusto employees</h3>
      <p className="mb-2 text-[13px] text-muted">
        Confirm which team member each Gusto employee is. Email matches are suggestions; only confirmed matches are used when a pay run is sent to Gusto.{" "}
        {data ? `${unconfirmed} not confirmed.` : ""}
      </p>
      {msg && <p className={`mb-2 ${msg.ok ? noteBoxCls : errorBoxCls}`}>{msg.text}</p>}
      {data?.truncated && <p className={`mb-2 ${noteBoxCls}`}>Only the first 2,000 Gusto employees are shown.</p>}
      {data && (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[720px]`}>
            <thead>
              <tr>
                <th className={thCls}>Gusto employee</th>
                <th className={thCls}>Team member</th>
                <th className={thCls}>State</th>
                <th className={thCls}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.remote.map((e) => {
                const link = data.links.find((l) => l.remoteId === e.id) ?? null;
                const suggestion = data.suggestions.find((x) => x.remoteId === e.id) ?? null;
                const picked = choice[e.id] ?? "";
                return (
                  <tr key={e.id}>
                    <td className={tdCls}>
                      {e.name}
                      {e.email && <span className="block text-xs text-muted">{e.email}</span>}
                      {e.terminated && <span className={`${chipCls} mt-1`}>terminated</span>}
                    </td>
                    <td className={tdCls}>
                      <label className="sr-only" htmlFor={`emp-${e.id}`}>
                        Team member for {e.name}
                      </label>
                      <select id={`emp-${e.id}`} value={picked} onChange={(ev) => setChoice((c) => ({ ...c, [e.id]: ev.target.value }))} className={`${selectCls} w-full max-w-[300px]`}>
                        <option value="">Not matched</option>
                        {data.local.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.email ? ` — ${m.email}` : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={tdCls}>
                      <span className={chipCls}>{link?.confirmed ? "confirmed" : link ? "suggested" : suggestion ? "suggested · email match" : "not matched"}</span>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap text-right`}>
                      <div className="flex justify-end gap-2">
                        {link && (
                          <button onClick={() => save(e.id, null)} disabled={busy === e.id} className={btnGhostSm}>
                            Clear
                          </button>
                        )}
                        <button onClick={() => save(e.id, picked)} disabled={busy === e.id || !picked || (link?.confirmed === true && link.localId === picked)} className={btnPrimarySm}>
                          <Check size={13} aria-hidden="true" />
                          {busy === e.id ? "Saving…" : "Confirm"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const MATCH_LABEL: Record<string, string> = { code: "code match", system: "role match", name: "name match", type: "type match" };

function AccountMapping({ workspaceId, provider }: { workspaceId: string; provider: "quickbooks" | "xero" }) {
  const label = META[provider].label;
  const [rows, setRows] = useState<MappingRow[] | null>(null);
  const [remote, setRemote] = useState<RemoteAccount[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const apply = useCallback((next: MappingRow[]) => {
    setRows(next);
    setChoice(Object.fromEntries(next.map((r) => [r.account.id, r.link?.remoteAccountId ?? ""])));
  }, []);

  useEffect(() => {
    let live = true;
    getJson<{ remote?: RemoteAccount[]; rows?: MappingRow[] }>(`/api/bizsync/${provider}?${q}`).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setMsg({ ok: false, text: res.error ?? `Could not load the ${label} chart of accounts.` });
        return;
      }
      setRemote(res.data.remote ?? []);
      apply(res.data.rows ?? []);
    });
    return () => {
      live = false;
    };
  }, [apply, label, provider, q]);

  const byClass = useMemo(() => {
    const m = new Map<string, RemoteAccount[]>();
    for (const a of remote.filter((x) => x.active)) m.set(a.cls, [...(m.get(a.cls) ?? []), a]);
    return m;
  }, [remote]);

  async function post(action: "suggest_accounts" | "confirm_accounts") {
    setBusy(action);
    setMsg(null);
    try {
      const entries =
        action === "confirm_accounts"
          ? (rows ?? []).flatMap((r): Array<{ accountId: string; remoteAccountId: string | null }> => {
              const v = choice[r.account.id] ?? "";
              if (v) return [{ accountId: r.account.id, remoteAccountId: v }];
              return r.link ? [{ accountId: r.account.id, remoteAccountId: null }] : [];
            })
          : undefined;
      if (action === "confirm_accounts" && entries!.length === 0) {
        setMsg({ ok: false, text: "Pick at least one account to map." });
        return;
      }
      const r = await fetch(`/api/bizsync/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, action, entries }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: j.error ?? "Could not save the mapping." });
        return;
      }
      apply(j.rows ?? []);
      setMsg({ ok: true, text: action === "suggest_accounts" ? `Suggested ${j.suggested} match${j.suggested === 1 ? "" : "es"}. Review them, then confirm.` : `Confirmed ${j.confirmed} mapping${j.confirmed === 1 ? "" : "s"}${j.cleared ? `, cleared ${j.cleared}` : ""}.` });
    } finally {
      setBusy(null);
    }
  }

  const unconfirmed = (rows ?? []).filter((r) => r.account.active && r.link?.status !== "confirmed").length;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold text-ink">Chart of accounts mapping</h3>
          <p className="text-[13px] text-muted">
            Posting only uses confirmed rows; a document whose accounts aren&apos;t confirmed waits. {rows ? `${unconfirmed} account${unconfirmed === 1 ? "" : "s"} not confirmed.` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => post("suggest_accounts")} disabled={busy !== null || !rows} className={btnGhostSm}>
            {busy === "suggest_accounts" ? "Suggesting…" : "Suggest matches"}
          </button>
          <button onClick={() => post("confirm_accounts")} disabled={busy !== null || !rows} className={btnPrimarySm}>
            <Check size={13} aria-hidden="true" />
            {busy === "confirm_accounts" ? "Confirming…" : "Confirm mapping"}
          </button>
        </div>
      </div>
      {msg && <p className={`mb-2 ${msg.ok ? noteBoxCls : errorBoxCls}`}>{msg.text}</p>}
      {rows && (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[720px]`}>
            <thead>
              <tr>
                <th className={thCls}>Account</th>
                <th className={thCls}>Type</th>
                <th className={thCls}>{label} account</th>
                <th className={thCls}>State</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.account.active)
                .map((r) => {
                  const options = byClass.get(r.account.type) ?? [];
                  return (
                    <tr key={r.account.id}>
                      <td className={tdCls}>
                        <span className="font-mono text-xs text-muted">{r.account.code}</span> {r.account.name}
                      </td>
                      <td className={`${tdCls} text-muted`}>{r.account.type}</td>
                      <td className={tdCls}>
                        <label className="sr-only" htmlFor={`map-${r.account.id}`}>
                          {label} account for {r.account.name}
                        </label>
                        <select id={`map-${r.account.id}`} value={choice[r.account.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [r.account.id]: e.target.value }))} className={`${selectCls} w-full max-w-[340px]`}>
                          <option value="">Not mapped</option>
                          {options.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.code ? `${o.code} ` : ""}
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={tdCls}>
                        <span className={chipCls}>
                          {r.link?.status === "confirmed" ? "confirmed" : r.link ? `suggested · ${MATCH_LABEL[r.link.matchReason ?? ""] ?? "match"}` : "not mapped"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
