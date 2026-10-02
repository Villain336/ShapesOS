"use client";

// Marketr — CAD + Hardware slice 2: manufacturability analysis.
// Deterministic checks over the version's REAL mesh geometry (STL/OBJ):
// wall thickness (raycast estimate), overhangs, tolerance risks. Every flag
// cites the measurement it came from — nothing is invented. STEP versions
// record an "unavailable" run instead of a guessed analysis. Flags are
// dismissible with a reason (audit trail).

import { useCallback, useEffect, useState } from "react";
import { Loader2, FlaskConical, ExternalLink, X } from "lucide-react";

interface VersionLite {
  id: string;
  versionNumber: number;
  fileName: string;
  format: "stl" | "obj" | "step";
}

interface MfgCheck {
  check: string;
  status: "computed" | "unavailable";
  detail: string;
}

interface MfgReference {
  rule: string;
  source: string;
  accessed: string;
}

interface MfgRun {
  id: string;
  status: "complete" | "unavailable";
  unavailableReason: string | null;
  unitAssumption: string;
  checks: MfgCheck[];
  references: MfgReference[];
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
  _count: { flags: number };
}

interface MfgFlag {
  id: string;
  runId: string;
  checkType: string;
  severity: "info" | "warning" | "risk";
  measurement: Record<string, number | string | null>;
  message: string;
  dismissed: boolean;
  dismissedBy: string | null;
  dismissedAt: string | null;
  dismissalReason: string | null;
  createdAt: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function ManufacturingTab({
  modelId,
  versions,
  currentVersionId,
}: {
  modelId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
}) {
  const [versionId, setVersionId] = useState(
    currentVersionId ?? versions[0]?.id ?? "",
  );
  const [runs, setRuns] = useState<MfgRun[]>([]);
  const [flags, setFlags] = useState<MfgFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");

  const version = versions.find((v) => v.id === versionId);

  const load = useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ runs: MfgRun[]; flags: MfgFlag[] }>(
        `/api/cad/models/${modelId}/versions/${versionId}/manufacturability`,
      );
      setRuns(res.runs);
      setFlags(res.flags);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the analysis.");
    } finally {
      setLoading(false);
    }
  }, [modelId, versionId]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAnalysis() {
    if (!versionId) return;
    setRunning(true);
    setError(null);
    try {
      await api(`/api/cad/models/${modelId}/versions/${versionId}/manufacturability`, {
        method: "POST",
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The analysis failed to run.");
    } finally {
      setRunning(false);
    }
  }

  async function dismiss(flagId: string) {
    if (!dismissReason.trim()) {
      setError("Dismissing a flag requires a reason.");
      return;
    }
    try {
      await api(`/api/cad/flags/${flagId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: dismissReason.trim() }),
      });
      setDismissId(null);
      setDismissReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not dismiss the flag.");
    }
  }

  const activeFlags = flags.filter((f) => !f.dismissed);
  const dismissedFlags = flags.filter((f) => f.dismissed);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper p-4 shadow-hairline">
        <label htmlFor="mfg-version" className="text-sm font-semibold text-ink">
          Analyze version
        </label>
        <select
          id="mfg-version"
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          className="h-10 rounded-full border border-line bg-paper px-3 text-sm text-ink"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.versionNumber} — {v.fileName}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={runAnalysis}
          disabled={running || !versionId}
          className="flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <FlaskConical className="h-4 w-4" aria-hidden />
          )}
          {running ? "Analyzing…" : "Run analysis"}
        </button>
        <p className="w-full text-xs text-muted">
          Wall thickness (raycast estimate over the real mesh), overhangs vs the
          45° guideline, tolerance risks. STEP versions record “analysis
          unavailable” — never a guessed analysis.
        </p>
      </div>

      {error && <p className="mb-3 text-sm text-failed-text">{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Findings ({activeFlags.length} open)
            </h3>
            {flags.length === 0 ? (
              <p className="rounded-lg border border-line bg-paper p-4 text-sm text-muted shadow-hairline">
                {runs.length === 0
                  ? "No analysis has run on this version yet."
                  : "No manufacturability issues found in the latest run."}
              </p>
            ) : (
              <ul className="space-y-2">
                {activeFlags.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-ink">
                        {f.checkType.replace(/_/g, " ")}
                      </span>
                      <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]">
                        {f.severity}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-ink">{f.message}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted">
                        The measurement behind this flag
                      </summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-canvas p-2 font-mono text-xs text-ink">
                        {JSON.stringify(f.measurement, null, 2)}
                      </pre>
                    </details>
                    {dismissId === f.id ? (
                      <div className="mt-2">
                        <input
                          value={dismissReason}
                          onChange={(e) => setDismissReason(e.target.value)}
                          maxLength={500}
                          placeholder="Why is this flag not a problem? (required)"
                          className="h-10 w-full rounded-full border border-line bg-canvas px-3 text-sm text-ink"
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => dismiss(f.id)}
                            className="flex h-9 items-center rounded-full bg-ink px-4 text-sm font-semibold text-paper"
                          >
                            Dismiss with reason
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDismissId(null);
                              setDismissReason("");
                            }}
                            className="flex h-9 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDismissId(f.id)}
                        className="mt-2 flex h-8 items-center gap-1 rounded-full bg-paper px-3 text-xs font-semibold text-muted shadow-[inset_0_0_0_1.5px_var(--aos-ink)] hover:text-ink"
                      >
                        <X className="h-3 w-3" aria-hidden />
                        Dismiss
                      </button>
                    )}
                  </li>
                ))}
                {dismissedFlags.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-line bg-canvas p-4 opacity-70"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-muted">
                        {f.checkType.replace(/_/g, " ")}
                      </span>
                      <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-muted">
                        dismissed
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-muted">{f.message}</p>
                    <p className="mt-1 text-xs text-muted">
                      Dismissed by {f.dismissedBy} ·{" "}
                      {f.dismissedAt ? new Date(f.dismissedAt).toLocaleString() : ""} —{" "}
                      {f.dismissalReason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">
              Analysis runs ({runs.length})
            </h3>
            {runs.length === 0 ? (
              <p className="rounded-lg border border-line bg-paper p-4 text-sm text-muted shadow-hairline">
                No runs yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-line bg-paper p-4 shadow-hairline"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          r.status === "complete"
                            ? "bg-ink text-paper"
                            : "bg-canvas text-muted shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
                        }`}
                      >
                        {r.status}
                      </span>
                      <span className="text-xs text-muted">
                        {new Date(r.startedAt).toLocaleString()} · {r._count.flags} flags
                      </span>
                    </div>
                    {r.status === "unavailable" && r.unavailableReason && (
                      <p className="mt-2 text-sm text-muted">{r.unavailableReason}</p>
                    )}
                    <ul className="mt-2 space-y-1">
                      {r.checks.map((c) => (
                        <li key={c.check} className="text-xs text-muted">
                          <span className="font-mono text-ink">{c.check.replace(/_/g, " ")}</span>
                          {" — "}
                          {c.detail}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-muted">
                      Units: {r.unitAssumption}
                    </p>
                    {r.references.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted">
                          Process-limit sources ({r.references.length})
                        </summary>
                        <ul className="mt-1 space-y-1">
                          {r.references.map((ref, i) => (
                            <li key={i} className="text-xs text-muted">
                              {ref.rule}{" "}
                              <a
                                href={ref.source}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 text-ink underline"
                              >
                                source
                                <ExternalLink className="h-3 w-3" aria-hidden />
                              </a>{" "}
                              (accessed {ref.accessed})
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
