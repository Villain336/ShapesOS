"use client";

// ShapesOS — outbound webhooks manager (Phase 4a). Admin+ only (server-gated).
//
// Endpoints: dense table with on/off switch, test, rotate secret, delete.
// Create form: https URL, optional description, event filter (none = all).
// The signing secret is shown ONCE after create/rotate. Delivery log: newest
// first, filter by endpoint/status, expand a row for the payload and the
// endpoint's response, redeliver any row.

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Send, Trash2 } from "lucide-react";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";

const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:opacity-40";
const btnSecondary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secretHint: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  endpointId: string;
  endpointUrl: string | null;
  eventId: string;
  eventType: string;
  status: "pending" | "delivering" | "succeeded" | "dead";
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  durationMs: number | null;
  redeliveryOf: string | null;
  createdAt: string;
  payload: unknown;
}

interface EventType {
  type: string;
  label: string;
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-ink" : "bg-disabled-fg"}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-paper shadow transition-all ${checked ? "left-[21px]" : "left-[3px]"}`}
      />
    </button>
  );
}

/** Delivery state → text label. Status shapes are reserved for agent states
 *  (docs/design/DESIGN.md), and a webhook delivery is a system job, so this
 *  is text only; failures read in failed-text. */
function DeliveryStatus({ d }: { d: Delivery }) {
  const map: Record<Delivery["status"], { cls: string; label: string }> = {
    succeeded: { cls: "text-ink", label: "Delivered" },
    dead: { cls: "text-failed-text", label: "Failed" },
    delivering: { cls: "text-ink", label: "Sending" },
    pending: { cls: "text-muted", label: d.attempts > 0 ? "Retrying" : "Queued" },
  };
  const s = map[d.status];
  return <span className={`whitespace-nowrap text-xs font-semibold ${s.cls}`}>{s.label}</span>;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function WebhooksManager({ entitled }: { entitled: boolean }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Create form
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  // Log filters
  const [filterEndpoint, setFilterEndpoint] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const loadDeliveries = useCallback(async () => {
    const qs = new URLSearchParams();
    if (filterEndpoint) qs.set("endpointId", filterEndpoint);
    if (filterStatus) qs.set("status", filterStatus);
    const r = await fetch(`/api/workspace/webhooks/deliveries?${qs.toString()}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) setDeliveries(j.deliveries ?? []);
  }, [filterEndpoint, filterStatus]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/workspace/webhooks/endpoints");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't load webhooks.");
      setEndpoints(j.endpoints ?? []);
      setEventTypes(j.eventTypes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load webhooks.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      toastError(typeof j.error === "string" ? j.error : `Request failed (HTTP ${r.status}).`);
      return null;
    }
    return j;
  }

  async function create() {
    if (!url.trim()) return;
    setBusy("create");
    const j = await call("/api/workspace/webhooks/endpoints", {
      method: "POST",
      body: JSON.stringify({ url: url.trim(), description: description.trim() || null, events }),
    });
    setBusy(null);
    if (!j) return;
    const ep = j.endpoint as Endpoint;
    setSecret({ url: ep.url, secret: String(j.secret) });
    setUrl("");
    setDescription("");
    setEvents([]);
    toast({ title: "Endpoint added", description: ep.url });
    await load();
  }

  async function setEnabled(ep: Endpoint, enabled: boolean) {
    setBusy(ep.id);
    const j = await call(`/api/workspace/webhooks/endpoints/${ep.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    setBusy(null);
    if (j) {
      toast({ title: enabled ? "Endpoint turned on" : "Endpoint turned off", description: ep.url });
      await load();
    }
  }

  async function rotate(ep: Endpoint) {
    const ok = await confirmAction({
      title: "Rotate the signing secret?",
      description: "The old secret stops working immediately. Update your receiver with the new one.",
      confirmLabel: "Rotate",
    });
    if (!ok) return;
    setBusy(ep.id);
    const j = await call(`/api/workspace/webhooks/endpoints/${ep.id}`, { method: "PATCH", body: JSON.stringify({ rotateSecret: true }) });
    setBusy(null);
    if (j) {
      setSecret({ url: ep.url, secret: String(j.secret) });
      await load();
    }
  }

  async function remove(ep: Endpoint) {
    const ok = await confirmAction({
      title: "Delete this endpoint?",
      description: `${ep.url} stops receiving events, and its delivery log is deleted.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(ep.id);
    const j = await call(`/api/workspace/webhooks/endpoints/${ep.id}`, { method: "DELETE" });
    setBusy(null);
    if (j) {
      toast({ title: "Endpoint deleted", description: ep.url });
      await Promise.all([load(), loadDeliveries()]);
    }
  }

  async function sendTest(ep: Endpoint) {
    setBusy(ep.id);
    const j = await call(`/api/workspace/webhooks/endpoints/${ep.id}/test`, { method: "POST" });
    setBusy(null);
    if (!j) return;
    const outcome = j.outcome as { status?: string; responseStatus?: number | null; error?: string | null } | null;
    if (outcome?.status === "succeeded") {
      toast({ title: "Test event delivered", description: `HTTP ${outcome.responseStatus ?? "2xx"}` });
    } else {
      toast({ title: "Test event not delivered", description: outcome?.error ?? "It will retry.", status: "failed" });
    }
    await Promise.all([load(), loadDeliveries()]);
  }

  async function redeliver(d: Delivery) {
    setBusy(d.id);
    const j = await call(`/api/workspace/webhooks/deliveries/${d.id}/redeliver`, { method: "POST" });
    setBusy(null);
    if (!j) return;
    const outcome = j.outcome as { status?: string; error?: string | null } | null;
    if (outcome?.status === "succeeded") toast({ title: "Redelivered", description: d.eventType });
    else toast({ title: "Redelivery failed", description: outcome?.error ?? "It will retry.", status: "failed" });
    await loadDeliveries();
  }

  function toggleEvent(t: string) {
    setEvents((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {secret && (
        <section className="rounded-lg border border-line bg-needs-tint p-5">
          <div className="flex items-center gap-2">
            <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs you" />
            <h2 className="text-base font-semibold text-ink">Copy the signing secret now</h2>
          </div>
          <p className="mt-1 text-sm text-ink">
            This is the only time it&apos;s shown for <span className="font-mono">{secret.url}</span>. Use it to
            check the <span className="font-mono">ShapesOS-Signature</span> header on every delivery.
          </p>
          <code className="mt-3 block break-all rounded-md bg-paper p-3 font-mono text-sm text-ink">{secret.secret}</code>
          <button type="button" onClick={() => setSecret(null)} className={`${btnSecondary} mt-3`}>
            I&apos;ve copied it
          </button>
        </section>
      )}

      <section className={cardCls} aria-labelledby="wh-endpoints">
        <h2 id="wh-endpoints" className="aos-subheading">Endpoints</h2>
        {endpoints.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No endpoints yet. Add one below to start receiving events.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">On</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">URL</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Events</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Secret</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Health</th>
                  <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((ep) => (
                  <tr key={ep.id} className="border-b border-line align-top last:border-0 hover:bg-hover-paper">
                    <td className="py-2.5 pr-3">
                      <Switch
                        checked={ep.enabled}
                        label={`${ep.enabled ? "Turn off" : "Turn on"} ${ep.url}`}
                        disabled={busy === ep.id || (!ep.enabled && !entitled)}
                        onChange={(v) => void setEnabled(ep, v)}
                      />
                    </td>
                    <td className="max-w-[260px] py-2.5 pr-3">
                      <span className="block truncate font-mono text-xs text-ink" title={ep.url}>{ep.url}</span>
                      {ep.description && <span className="block truncate text-xs text-muted">{ep.description}</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted">
                      {ep.events.length === 0 ? "All events" : ep.events.join(", ")}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-muted">{ep.secretHint}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted">
                      {ep.consecutiveFailures > 0
                        ? `${ep.consecutiveFailures} failed in a row`
                        : ep.lastSuccessAt
                          ? `Last delivered ${when(ep.lastSuccessAt)}`
                          : "No deliveries yet"}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" className={btnSecondary} disabled={busy === ep.id || !ep.enabled || !entitled} onClick={() => void sendTest(ep)}>
                          <Send size={14} aria-hidden /> Send test
                        </button>
                        <button type="button" className={btnSecondary} disabled={busy === ep.id || !entitled} onClick={() => void rotate(ep)}>
                          <RefreshCw size={14} aria-hidden /> Rotate secret
                        </button>
                        <button type="button" className={btnDeny} disabled={busy === ep.id} onClick={() => void remove(ep)}>
                          <Trash2 size={14} aria-hidden /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={cardCls} aria-labelledby="wh-add">
        <h2 id="wh-add" className="aos-subheading">Add an endpoint</h2>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-72 flex-1 flex-col gap-1">
              <span className="text-xs font-semibold text-muted">HTTPS URL</span>
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/webhooks/shapesos"
                className={inputCls}
                disabled={!entitled}
              />
            </label>
            <label className="flex min-w-56 flex-1 flex-col gap-1">
              <span className="text-xs font-semibold text-muted">Description (optional)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Zapier lead sync"
                maxLength={200}
                className={inputCls}
                disabled={!entitled}
              />
            </label>
          </div>
          <fieldset disabled={!entitled}>
            <legend className="text-sm font-semibold text-ink">Events</legend>
            <p className="text-xs text-muted">Pick none to receive every event.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {eventTypes.map((t) => {
                const on = events.includes(t.type);
                return (
                  <button
                    key={t.type}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleEvent(t.type)}
                    title={t.label}
                    className={`inline-flex h-8 items-center rounded-full px-3 font-mono text-xs aos-press ${
                      on ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
                    }`}
                  >
                    {t.type}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <button type="button" onClick={() => void create()} disabled={!entitled || !url.trim() || busy === "create"} className={`${btnPrimary} self-start`}>
            {busy === "create" ? "Adding…" : "Add endpoint"}
          </button>
        </div>
      </section>

      <section className={cardCls} aria-labelledby="wh-log">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="wh-log" className="aos-subheading">Delivery log</h2>
          <div className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="wh-filter-endpoint">Endpoint</label>
            <select id="wh-filter-endpoint" value={filterEndpoint} onChange={(e) => setFilterEndpoint(e.target.value)} className={inputCls}>
              <option value="">All endpoints</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>{ep.url}</option>
              ))}
            </select>
            <label className="sr-only" htmlFor="wh-filter-status">Status</label>
            <select id="wh-filter-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={inputCls}>
              <option value="">Any status</option>
              <option value="succeeded">Delivered</option>
              <option value="pending">Queued or retrying</option>
              <option value="dead">Failed</option>
            </select>
            <button type="button" className={btnSecondary} onClick={() => void loadDeliveries()}>
              <RefreshCw size={14} aria-hidden /> Refresh
            </button>
          </div>
        </div>
        {deliveries.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No deliveries yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th scope="col" className="py-2 pr-2 font-semibold"><span className="sr-only">Details</span></th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Event</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Endpoint</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Attempts</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Response</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Created</th>
                  <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => {
                  const expanded = open === d.id;
                  return (
                    <Fragment key={d.id}>
                      <tr className="border-b border-line hover:bg-hover-paper">
                        <td className="py-2 pr-2">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={expanded ? "Hide details" : "Show details"}
                            onClick={() => setOpen(expanded ? null : d.id)}
                            className="rounded-full p-1 text-muted hover:bg-hover hover:text-ink"
                          >
                            {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                          </button>
                        </td>
                        <td className="py-2 pr-3"><DeliveryStatus d={d} /></td>
                        <td className="py-2 pr-3 font-mono text-xs text-ink">{d.eventType}</td>
                        <td className="max-w-[200px] truncate py-2 pr-3 font-mono text-xs text-muted" title={d.endpointUrl ?? ""}>{d.endpointUrl ?? "—"}</td>
                        <td className="py-2 pr-3 text-xs text-muted">
                          {d.attempts}
                          {d.status === "pending" && d.nextAttemptAt ? ` · next ${when(d.nextAttemptAt)}` : ""}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted">
                          {d.responseStatus ? `HTTP ${d.responseStatus}` : d.lastError ? "No response" : "—"}
                          {d.durationMs !== null ? ` · ${d.durationMs} ms` : ""}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted">{when(d.createdAt)}</td>
                        <td className="py-2 text-right">
                          <button type="button" className={btnSecondary} disabled={busy === d.id || !entitled} onClick={() => void redeliver(d)}>
                            Redeliver
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-line">
                          <td colSpan={8} className="bg-canvas px-3 py-3">
                            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
                              <dt className="font-semibold text-muted">Event id</dt>
                              <dd className="font-mono text-ink">{d.eventId}</dd>
                              <dt className="font-semibold text-muted">Delivery id</dt>
                              <dd className="font-mono text-ink">{d.id}</dd>
                              {d.lastError && (
                                <>
                                  <dt className="font-semibold text-muted">Last error</dt>
                                  <dd className="text-failed-text">{d.lastError}</dd>
                                </>
                              )}
                              {d.redeliveryOf && (
                                <>
                                  <dt className="font-semibold text-muted">Redelivery of</dt>
                                  <dd className="font-mono text-ink">{d.redeliveryOf}</dd>
                                </>
                              )}
                            </dl>
                            <p className="mt-3 text-xs font-semibold text-muted">Payload</p>
                            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-paper p-3 font-mono text-xs text-ink">
                              {JSON.stringify(d.payload, null, 2)}
                            </pre>
                            {d.responseBody && (
                              <>
                                <p className="mt-3 text-xs font-semibold text-muted">Response (first 1 KB)</p>
                                <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-paper p-3 font-mono text-xs text-ink">{d.responseBody}</pre>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
        <h2 className="text-sm font-semibold text-ink">Verifying deliveries</h2>
        <p className="mt-1">
          Each request is a JSON <span className="font-mono">POST</span> with{" "}
          <span className="font-mono">ShapesOS-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</span>. Compute HMAC-SHA256
          of <span className="font-mono">&lt;t&gt;.&lt;raw body&gt;</span> with your secret, compare in constant time,
          and reject timestamps more than 5 minutes old. Dedupe on <span className="font-mono">ShapesOS-Event-Id</span>.
          Answer with any 2xx within 10 seconds; redirects aren&apos;t followed. The full event schema is in the{" "}
          <a href="/dashboard/settings/developers" className="font-semibold text-ink underline">API reference</a>.
        </p>
      </section>
    </div>
  );
}
