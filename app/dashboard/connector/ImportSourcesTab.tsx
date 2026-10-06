// Marketr — Connector Agent slice 2: import sources UI.
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary pills, status color+shape badges, Lucide icons,
// tokens only. Sentence case.
//
// Flow per source: connect (OS OAuth vault) → record consent → set
// exclusions → run import → batch history with provenance.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  ConnectorExclusionType,
  ConnectorExclusionView,
  ConnectorImportBatchView,
} from "@/lib/connector/types";
import type { ImportSourceStatus } from "@/lib/connector/import-engine";
import { confirmAction } from "@/lib/ui/feedback";

type ShapeKind = "running" | "needs" | "done" | "failed" | "queued";

function StatusShape({ kind, live }: { kind: ShapeKind; live?: boolean }) {
  const paths: Record<Exclude<ShapeKind, "queued">, string> = {
    running: "M0 7a7 7 0 1 0 14 0a7 7 0 1 0-14 0z",
    needs: "M7 0.8 13.6 13.2H0.4z",
    done: "M1 13V1a12 12 0 0 1 12 12z",
    failed: "M1 1h12v12H1z",
  };
  const fills: Record<ShapeKind, string> = {
    running: "var(--aos-running)",
    needs: "var(--aos-needs)",
    done: "var(--aos-done)",
    failed: "var(--aos-failed)",
    queued: "none",
  };
  if (kind === "queued") {
    return (
      <svg viewBox="0 0 14 14" width={10} height={10} aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r="5.6"
          fill="none"
          stroke="var(--aos-ink)"
          strokeWidth="2.4"
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 14 14"
      width={10}
      height={10}
      aria-hidden="true"
      className={live ? "animate-status-pulse" : undefined}
    >
      <path
        d={paths[kind]}
        fill={fills[kind]}
        {...(kind === "needs" ? { stroke: "var(--aos-ink)", strokeWidth: 1 } : {})}
      />
    </svg>
  );
}

function StatusBadge({
  kind,
  label,
  live,
}: {
  kind: ShapeKind;
  label: string;
  live?: boolean;
}) {
  const styles: Record<ShapeKind, string> = {
    running: "bg-running text-white",
    needs: "bg-needs text-black",
    done: "bg-done text-white",
    failed: "bg-failed text-white",
    queued: "bg-paper text-ink shadow-outline",
  };
  return (
    <span
      className={`inline-flex h-badge items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold ${styles[kind]}`}
    >
      <StatusShape kind={kind} live={live} />
      {label}
    </span>
  );
}

function batchBadge(batch: ConnectorImportBatchView) {
  switch (batch.status) {
    case "running":
      return <StatusBadge kind="running" label="Running" live />;
    case "completed":
      return <StatusBadge kind="done" label="Completed" />;
    case "failed":
      return <StatusBadge kind="failed" label="Failed" />;
    default:
      return <StatusBadge kind="needs" label="Consent recorded" />;
  }
}

function connectionBadge(status: ImportSourceStatus["connectionStatus"]) {
  switch (status) {
    case "active":
      return <StatusBadge kind="done" label="Connected" />;
    case "needs_reauth":
      return <StatusBadge kind="needs" label="Reconnect needed" />;
    case "revoked":
      return <StatusBadge kind="failed" label="Revoked" />;
    default:
      return <StatusBadge kind="queued" label="Not connected" />;
  }
}

const EXCLUSION_TYPE_LABELS: Record<ConnectorExclusionType, string> = {
  domain: "Domain",
  email: "Email",
  person_name: "Person",
};

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function ImportSourcesTab() {
  const [loading, setLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sources, setSources] = useState<ImportSourceStatus[]>([]);
  const [exclusions, setExclusions] = useState<ConnectorExclusionView[]>([]);
  const [batches, setBatches] = useState<ConnectorImportBatchView[]>([]);
  const [consentChecked, setConsentChecked] = useState<Record<string, boolean>>({});
  const [consenting, setConsenting] = useState<Record<string, boolean>>({});
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [connecting, setConnecting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [exType, setExType] = useState<ConnectorExclusionType>("domain");
  const [exValue, setExValue] = useState("");
  const [exSaving, setExSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [sRes, eRes, bRes] = await Promise.all([
      fetch("/api/connector/import/sources"),
      fetch("/api/connector/import/exclusions"),
      fetch("/api/connector/import/batches"),
    ]);
    if (sRes.ok) {
      const data = await sRes.json();
      setSources(data.sources ?? []);
      setWorkspaceId(data.workspaceId ?? null);
    }
    if (eRes.ok) setExclusions((await eRes.json()).exclusions ?? []);
    if (bRes.ok) setBatches((await bRes.json()).batches ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (source: ImportSourceStatus) => {
      if (!workspaceId) return;
      setConnecting((m) => ({ ...m, [source.source]: true }));
      setError(null);
      try {
        const res = await fetch(
          `/api/connectors/${encodeURIComponent(source.connectorKey)}/auth-url?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Could not start the connection flow.");
        }
        const { url } = await res.json();
        const popup = window.open(url, "_blank", "width=640,height=760");
        // The provider redirects back to the connectors settings page;
        // re-check status when the user returns to this tab.
        const onFocus = () => {
          if (popup && !popup.closed) return;
          window.removeEventListener("focus", onFocus);
          void refresh();
          setConnecting((m) => ({ ...m, [source.source]: false }));
        };
        window.addEventListener("focus", onFocus);
        // Fallback: also re-check after 60s in case focus never fires.
        setTimeout(() => {
          window.removeEventListener("focus", onFocus);
          setConnecting((m) => ({ ...m, [source.source]: false }));
          void refresh();
        }, 60000);
      } catch (e) {
        setConnecting((m) => ({ ...m, [source.source]: false }));
        setError(e instanceof Error ? e.message : "Connection failed.");
      }
    },
    [workspaceId, refresh],
  );

  const recordConsent = useCallback(
    async (source: ImportSourceStatus) => {
      setConsenting((m) => ({ ...m, [source.source]: true }));
      setError(null);
      try {
        const res = await fetch("/api/connector/import/consent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: source.source,
            scopes:
              source.source === "email"
                ? ["https://www.googleapis.com/auth/gmail.readonly"]
                : ["https://www.googleapis.com/auth/calendar.readonly"],
            note: `Consent recorded from the import sources page for ${source.displayName}.`,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "Could not record consent.");
        }
        setConsentChecked((m) => ({ ...m, [source.source]: false }));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Consent failed.");
      } finally {
        setConsenting((m) => ({ ...m, [source.source]: false }));
      }
    },
    [refresh],
  );

  const revokeConsent = useCallback(
    async (source: ImportSourceStatus) => {
      const ok = await confirmAction({
        title: "Revoke import consent?",
        description: "Imports from this source stop until consent is granted again.",
        confirmLabel: "Revoke",
        destructive: true,
      });
      if (!ok) return;
      setRevoking((m) => ({ ...m, [source.source]: true }));
      setError(null);
      try {
        const res = await fetch(
          `/api/connector/import/consent?source=${encodeURIComponent(source.source)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error("Could not revoke consent.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Revoke failed.");
      } finally {
        setRevoking((m) => ({ ...m, [source.source]: false }));
      }
    },
    [refresh],
  );

  const runImport = useCallback(
    async (source: ImportSourceStatus) => {
      setRunning((m) => ({ ...m, [source.source]: true }));
      setError(null);
      try {
        const res = await fetch("/api/connector/import/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: source.source }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Import failed.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
      } finally {
        setRunning((m) => ({ ...m, [source.source]: false }));
      }
    },
    [refresh],
  );

  const addExclusion = useCallback(async () => {
    if (!exValue.trim()) return;
    setExSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/connector/import/exclusions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: exType, value: exValue }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not add the exclusion.");
      setExValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the exclusion.");
    } finally {
      setExSaving(false);
    }
  }, [exType, exValue, refresh]);

  const removeExclusion = useCallback(
    async (id: string) => {
      const ok = await confirmAction({
        title: "Remove this exclusion?",
        description: "Matching people and companies can be imported again.",
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!ok) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/connector/import/exclusions/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!res.ok) throw new Error("Could not remove the exclusion.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not remove the exclusion.");
      }
    },
    [refresh],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading import sources
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-paper p-4 text-[0.875rem] text-muted shadow-hairline">
        Connect a source, record your consent, set exclusions, then run the
        import. No import runs without recorded consent, and excluded contacts
        never enter your graph. Re-imports only fetch what changed since the
        last run.
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-failed bg-failed-tint p-4 text-[0.875rem] text-failed-text"
        >
          <span className="mt-0.5">
            <StatusShape kind="failed" />
          </span>
          {error}
        </div>
      )}

      {sources.map((source) => {
        const sourceBatches = batches.filter((b) => b.source === source.source);
        const canRun =
          !!source.consent && source.connectionStatus === "active" && !running[source.source];
        const checked = !!consentChecked[source.source];
        return (
          <section
            key={source.source}
            className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline"
            aria-label={`${source.displayName} import source`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="stretch-heading text-lg font-bold text-ink">
                {source.displayName}
              </h2>
              <div className="flex items-center gap-2">
                {connectionBadge(source.connectionStatus)}
                {source.consent ? (
                  <StatusBadge kind="done" label="Consent recorded" />
                ) : (
                  <StatusBadge kind="needs" label="Consent required" />
                )}
              </div>
            </div>

            {/* Step 1 — connect */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[0.8125rem] font-semibold text-ink">
                1. Connect {source.displayName}
              </h3>
              <p className="text-[0.8125rem] text-muted">
                {source.source === "email"
                  ? "Message metadata only — who you email, how often, how recently. Message bodies are never read."
                  : "Event attendees only — who you meet with. Event titles and details are never read."}{" "}
                Credentials stay encrypted in the vault.
              </p>
              {source.connectionStatus !== "active" && (
                <div>
                  <button
                    type="button"
                    onClick={() => void connect(source)}
                    disabled={connecting[source.source]}
                    className="aos-press inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-[0.875rem] font-semibold text-white disabled:opacity-50"
                  >
                    {connecting[source.source] ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <ExternalLink size={15} />
                    )}
                    {source.connectionStatus === "needs_reauth" ||
                    source.connectionStatus === "revoked"
                      ? `Reconnect ${source.displayName}`
                      : `Connect ${source.displayName}`}
                  </button>
                </div>
              )}
            </div>

            {/* Step 2 — consent */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[0.8125rem] font-semibold text-ink">2. Consent</h3>
              {source.consent ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-2 text-[0.875rem] text-ink">
                    <ShieldCheck size={15} className="text-done" />
                    Recorded by {source.consent.consentedBy} on{" "}
                    {formatDate(source.consent.consentedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void revokeConsent(source)}
                    disabled={revoking[source.source]}
                    className="aos-press inline-flex h-9 items-center rounded-full bg-paper px-4 text-[0.8125rem] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-50"
                  >
                    {revoking[source.source] ? "Revoking" : "Revoke consent"}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="flex cursor-pointer items-start gap-2 text-[0.875rem] text-ink">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        setConsentChecked((m) => ({
                          ...m,
                          [source.source]: e.target.checked,
                        }))
                      }
                      className="mt-1 h-4 w-4 accent-black"
                    />
                    <span>
                      I consent to importing my {source.displayName} contacts
                      into my connector network. I can revoke this at any time.
                    </span>
                  </label>
                  <div>
                    <button
                      type="button"
                      onClick={() => void recordConsent(source)}
                      disabled={!checked || consenting[source.source]}
                      className="aos-press inline-flex h-10 items-center gap-2 rounded-full bg-needs px-5 text-[0.875rem] font-semibold text-black disabled:opacity-50"
                    >
                      {consenting[source.source] ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <ShieldCheck size={15} />
                      )}
                      {consenting[source.source] ? "Recording" : "Record consent"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Step 3 — exclusions */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[0.8125rem] font-semibold text-ink">
                3. Exclusions{" "}
                <span className="font-normal text-muted">
                  — these never enter your graph
                </span>
              </h3>
              {exclusions.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {exclusions.map((ex) => (
                    <li
                      key={ex.id}
                      className="flex items-center gap-2 text-[0.875rem]"
                    >
                      <span className="inline-flex h-8 items-center rounded-full bg-canvas px-3 text-[0.8125rem] font-semibold text-ink">
                        {EXCLUSION_TYPE_LABELS[ex.type]}
                      </span>
                      <code className="font-mono text-[0.8125rem] text-ink">
                        {ex.value}
                      </code>
                      <button
                        type="button"
                        onClick={() => void removeExclusion(ex.id)}
                        aria-label={`Remove exclusion ${ex.value}`}
                        className="aos-press inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-hover-paper hover:text-ink"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={exType}
                  onChange={(e) =>
                    setExType(e.target.value as ConnectorExclusionType)
                  }
                  aria-label="Exclusion type"
                  className="h-10 rounded-md border border-control bg-paper px-3 text-[0.875rem] text-ink"
                >
                  <option value="domain">Domain</option>
                  <option value="email">Email</option>
                  <option value="person_name">Person name</option>
                </select>
                <input
                  value={exValue}
                  onChange={(e) => setExValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addExclusion();
                  }}
                  placeholder={
                    exType === "domain"
                      ? "competitor.com"
                      : exType === "email"
                        ? "person@example.com"
                        : "Person name"
                  }
                  aria-label="Exclusion value"
                  className="h-10 min-w-52 flex-1 rounded-md border border-control bg-paper px-3 text-[0.875rem] text-ink placeholder:text-subtle"
                />
                <button
                  type="button"
                  onClick={() => void addExclusion()}
                  disabled={exSaving || !exValue.trim()}
                  className="aos-press inline-flex h-10 items-center gap-1.5 rounded-full bg-paper px-4 text-[0.875rem] font-semibold text-ink shadow-outline disabled:opacity-50"
                >
                  {exSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Add
                </button>
              </div>
            </div>

            {/* Step 4 — run */}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[0.8125rem] font-semibold text-ink">4. Import</h3>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void runImport(source)}
                  disabled={!canRun}
                  className="aos-press inline-flex h-11 items-center gap-2 rounded-full bg-ink px-6 text-[0.9375rem] font-semibold text-white disabled:bg-disabled disabled:text-disabled-fg"
                >
                  {running[source.source] ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  {running[source.source]
                    ? "Importing"
                    : sourceBatches.some((b) => b.status === "completed")
                      ? "Run incremental import"
                      : "Run import"}
                </button>
                {!canRun && !running[source.source] && (
                  <span className="text-[0.8125rem] text-muted">
                    {!source.connectionStatus || source.connectionStatus !== "active"
                      ? `Connect ${source.displayName} first.`
                      : !source.consent
                        ? "Record consent first — imports never run without it."
                        : ""}
                  </span>
                )}
              </div>

              {sourceBatches.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-line text-muted">
                        <th className="py-2 pr-3 font-semibold">Run</th>
                        <th className="py-2 pr-3 font-semibold">Status</th>
                        <th className="py-2 pr-3 font-semibold">Created</th>
                        <th className="py-2 pr-3 font-semibold">Skipped</th>
                        <th className="py-2 pr-3 font-semibold">Cursor</th>
                        <th className="py-2 pr-3 font-semibold">Consent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceBatches.map((b) => {
                        const skipped =
                          (b.stats?.dedupSkipped ?? 0) +
                          (b.stats?.excludedSkipped ?? 0) +
                          (b.stats?.staleSkipped ?? 0);
                        return (
                          <tr
                            key={b.id}
                            className="border-b border-line last:border-0"
                          >
                            <td className="py-2 pr-3 text-muted">
                              {formatDate(b.createdAt)}
                            </td>
                            <td className="py-2 pr-3">{batchBadge(b)}</td>
                            <td className="py-2 pr-3 text-ink">
                              {b.stats ? b.stats.created : "—"}
                            </td>
                            <td className="py-2 pr-3 text-ink">
                              {b.stats ? skipped : "—"}
                            </td>
                            <td className="py-2 pr-3">
                              <code className="font-mono text-[0.75rem] text-muted">
                                {b.cursor ? b.cursor.slice(0, 10) : "—"}
                              </code>
                            </td>
                            <td className="py-2 pr-3 text-muted">
                              {b.consentedBy}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {sourceBatches.some((b) => b.status === "failed" && b.error) && (
                    <p className="mt-2 text-[0.8125rem] text-failed-text">
                      {
                        sourceBatches.find(
                          (b) => b.status === "failed" && b.error,
                        )?.error
                      }
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
