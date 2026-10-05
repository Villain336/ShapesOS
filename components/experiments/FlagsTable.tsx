// Marketr — Phase 12 "embeds": GrowthBook flags + experiments settings.
// Lists feature definitions (from the GrowthBook sidecar when connected,
// otherwise Marketr's built-in wired flags) and lets an admin toggle each
// flag FOR THIS WORKSPACE. The toggle writes a tenant-scoped override —
// GrowthBook's global default is never mutated, so one tenant's experiment
// never leaks into another's. A "Reset" action clears the override back to
// the GrowthBook / built-in default.

"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw, RotateCcw, TerminalSquare } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface Feature {
  id: string;
  valueType: string;
  defaultValue: unknown;
  effectiveValue: unknown;
  overridden: boolean;
  description: string;
  rulesCount: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      features: Feature[];
      source: "growthbook" | "defaults";
      message: string | null;
    };

function ValueBadge({ value, overridden }: { value: unknown; overridden: boolean }) {
  const str = JSON.stringify(value);
  const on = value === true;
  const off = value === false;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
          on
            ? "bg-ink text-paper"
            : off
              ? "bg-canvas text-muted"
              : "bg-canvas font-mono text-ink"
        }`}
      >
        {str ?? "null"}
      </span>
      {overridden && (
        <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink shadow-control">
          This workspace
        </span>
      )}
    </span>
  );
}

export function FlagsTable() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/experiments/flags");
      const json = (await res.json()) as {
        features?: Feature[];
        source?: "growthbook" | "defaults";
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({
        kind: "ready",
        features: json.features ?? [],
        source: json.source ?? "growthbook",
        message: json.message ?? null,
      });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Request failed." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(feature: Feature) {
    if (feature.valueType !== "boolean") return;
    setToggling(feature.id);
    try {
      const res = await fetch(`/api/experiments/flags/${encodeURIComponent(feature.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultValue: feature.effectiveValue !== true }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      await load();
    } finally {
      setToggling(null);
    }
  }

  async function reset(feature: Feature) {
    const ok = await confirmAction({
      title: `Reset "${feature.id}" to its default?`,
      description: "This workspace's override is deleted.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    setToggling(feature.id);
    try {
      const res = await fetch(`/api/experiments/flags/${encodeURIComponent(feature.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      await load();
    } finally {
      setToggling(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="rounded-lg bg-paper p-8 text-center text-sm text-muted shadow-hairline">
        Loading flags…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg bg-failed-tint p-4 text-[13px] text-failed-text">
        <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
        <span>
        Couldn&apos;t load flags: {state.message}{" "}
        </span>
        <button onClick={() => void load()} className="ml-auto inline-flex h-8 shrink-0 items-center rounded-full bg-paper px-3 font-semibold text-ink shadow-outline aos-press">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {state.source === "defaults" && (
        <div className="rounded-lg bg-paper p-5 shadow-hairline">
          <div className="flex items-center gap-2 text-ink">
            <FlaskConical className="h-5 w-5 text-ink" />
            <h2 className="text-sm font-semibold">GrowthBook is not connected</h2>
          </div>
          <p className="mt-2 text-[13px] text-muted">
            {state.message ?? "No GrowthBook sidecar configured."} Showing the
            flags ShapesOS wires natively, with their built-in defaults. Toggles
            below still work — they write a per-workspace override, no sidecar
            needed.
          </p>
          <div className="mt-3 rounded-md bg-canvas p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <TerminalSquare className="h-4 w-4" /> Quick start
            </p>
            <pre className="aos-night mt-2 overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-relaxed">
{`docker compose -f docker-compose.yml \\
  -f docker/profiles/growthbook.yml \\
  --profile growthbook up -d`}
            </pre>
            <p className="mt-2 text-xs text-muted">
              Then set <code className="font-mono">GROWTHBOOK_API_HOST</code>,{" "}
              <code className="font-mono">GROWTHBOOK_API_KEY</code> and{" "}
              <code className="font-mono">GROWTHBOOK_CLIENT_KEY</code> on the host
              (Settings → Providers shows the status).
            </p>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-canvas text-xs text-muted">
              <th className="px-4 py-2.5 font-semibold">Flag</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">Effective value</th>
              <th className="px-4 py-2.5 font-semibold">Rules</th>
              <th className="px-4 py-2.5 font-semibold">Description</th>
              <th className="px-4 py-2.5 text-right font-semibold">
                <button
                  onClick={() => void load()}
                  className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 font-semibold text-ink hover:bg-hover-paper"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.features.map((f) => (
              <tr key={f.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-4 py-2.5 font-mono text-xs text-ink">{f.id}</td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">
                    {f.valueType}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <ValueBadge value={f.effectiveValue} overridden={f.overridden} />
                </td>
                <td className="px-4 py-2.5 text-muted">{f.rulesCount}</td>
                <td className="max-w-xs truncate px-4 py-2.5 text-muted" title={f.description}>
                  {f.description || "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {f.valueType === "boolean" ? (
                    <span className="inline-flex items-center gap-2">
                      {f.overridden && (
                        <button
                          onClick={() => void reset(f)}
                          disabled={toggling === f.id}
                          title="Clear this workspace's override"
                          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-muted hover:bg-hover-paper hover:text-ink disabled:opacity-40"
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Reset
                        </button>
                      )}
                      <button
                        onClick={() => void toggle(f)}
                        disabled={toggling === f.id}
                        aria-pressed={f.effectiveValue === true}
                        className={`inline-flex h-8 min-w-12 items-center justify-center rounded-full px-3 text-xs font-semibold ${
                          f.effectiveValue === true
                            ? "bg-ink text-paper hover:bg-night-hover"
                            : "bg-paper text-ink shadow-control hover:shadow-outline"
                        } disabled:opacity-40`}
                      >
                        {toggling === f.id ? "…" : f.effectiveValue === true ? "On" : "Off"}
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {state.features.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted">
                  No flags defined yet. Create them in the GrowthBook dashboard first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border border-line bg-canvas p-4 text-[13px] text-muted">
        <p className="font-semibold text-ink">How the toggle works</p>
        <p className="mt-1">
          The switch writes a <strong>per-workspace override</strong> — only
          this workspace evaluates the flag differently. GrowthBook&apos;s
          global default is never touched, so other tenants are unaffected.
          Reset clears the override back to the GrowthBook (or built-in) default.
        </p>
        <p className="mt-2 font-semibold text-ink">Flags ShapesOS wires today</p>
        <ul className="mt-1 list-disc pl-5">
          <li>
            <code className="font-mono text-xs">studio.compact-hero</code> — compact
            hero treatment on the Creative Studio page.
          </li>
          <li>
            <code className="font-mono text-xs">content.brief-v2</code> — v2
            treatment of the brief form in the content engine.
          </li>
        </ul>
      </div>
    </div>
  );
}
