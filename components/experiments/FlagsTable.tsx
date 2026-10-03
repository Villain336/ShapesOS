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
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
          on
            ? "bg-emerald-100 text-emerald-700"
            : off
              ? "bg-stone-100 text-stone-500"
              : "bg-violet-50 text-violet-700"
        }`}
      >
        {str ?? "null"}
      </span>
      {overridden && (
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
          this workspace
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
      <div className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
        Loading flags…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
        Couldn&apos;t load flags: {state.message}{" "}
        <button onClick={() => void load()} className="ml-2 font-medium underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {state.source === "defaults" && (
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-5">
          <div className="flex items-center gap-2 text-stone-900">
            <FlaskConical className="h-5 w-5 text-violet-600" />
            <h2 className="text-sm font-semibold">GrowthBook is not connected</h2>
          </div>
          <p className="mt-2 text-[13px] text-stone-500">
            {state.message ?? "No GrowthBook sidecar configured."} Showing the
            flags Marketr wires natively, with their built-in defaults. Toggles
            below still work — they write a per-workspace override, no sidecar
            needed.
          </p>
          <div className="mt-3 rounded-lg border border-stone-200 bg-white p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-stone-700">
              <TerminalSquare className="h-4 w-4" /> Quick start
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-stone-900 p-3 font-mono text-[11px] leading-relaxed text-stone-100">
{`docker compose -f docker-compose.yml \\
  -f docker/profiles/growthbook.yml \\
  --profile growthbook up -d`}
            </pre>
            <p className="mt-2 text-xs text-stone-500">
              Then set <code className="font-mono">GROWTHBOOK_API_HOST</code>,{" "}
              <code className="font-mono">GROWTHBOOK_API_KEY</code> and{" "}
              <code className="font-mono">GROWTHBOOK_CLIENT_KEY</code> on the host
              (Settings → Providers shows the status).
            </p>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50/60 text-xs uppercase tracking-wide text-stone-500">
              <th className="px-4 py-2.5 font-medium">Flag</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Effective value</th>
              <th className="px-4 py-2.5 font-medium">Rules</th>
              <th className="px-4 py-2.5 font-medium">Description</th>
              <th className="px-4 py-2.5 text-right font-medium">
                <button
                  onClick={() => void load()}
                  className="inline-flex items-center gap-1 text-violet-700 hover:text-violet-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.features.map((f) => (
              <tr key={f.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                <td className="px-4 py-2.5 font-mono text-xs text-stone-900">{f.id}</td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                    {f.valueType}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <ValueBadge value={f.effectiveValue} overridden={f.overridden} />
                </td>
                <td className="px-4 py-2.5 text-stone-600">{f.rulesCount}</td>
                <td className="max-w-xs truncate px-4 py-2.5 text-stone-500" title={f.description}>
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
                          className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-violet-700 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Reset
                        </button>
                      )}
                      <button
                        onClick={() => void toggle(f)}
                        disabled={toggling === f.id}
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${
                          f.effectiveValue === true
                            ? "bg-emerald-600 text-white hover:bg-emerald-700"
                            : "bg-stone-200 text-stone-700 hover:bg-stone-300"
                        } disabled:opacity-50`}
                      >
                        {toggling === f.id ? "…" : f.effectiveValue === true ? "On" : "Off"}
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-stone-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {state.features.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-stone-500">
                  No flags defined yet. Create them in the GrowthBook dashboard first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 text-[13px] text-stone-500">
        <p className="font-medium text-stone-700">How the toggle works</p>
        <p className="mt-1">
          The switch writes a <strong>per-workspace override</strong> — only
          this workspace evaluates the flag differently. GrowthBook&apos;s
          global default is never touched, so other tenants are unaffected.
          Reset clears the override back to the GrowthBook (or built-in) default.
        </p>
        <p className="mt-2 font-medium text-stone-700">Flags Marketr wires today</p>
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
