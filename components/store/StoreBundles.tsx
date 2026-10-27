"use client";

// ShapesOS Phase 24 - Store bundles: one place to install a related group of
// Store items. A bundle is a shortcut, not a bypass: each member still goes
// through its own install check on the server, connectors and accounts are
// only linked (never installed or connected here), and nothing is installed
// that the person didn't leave ticked and then confirm.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Package } from "lucide-react";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { BundlePlan, MemberPlan } from "@/lib/store/bundles";
const memberId = (m: { kind: string; key: string }) => `${m.kind}:${m.key}`;

const KIND_LABEL: Record<string, string> = { skill: "Skill", mission_template: "Mission template", connector: "Connector", mini_app: "Mini-app", composio_toolkit: "Toolkit", mcp_server: "MCP server" };

function stateText(m: MemberPlan): string {
  switch (m.action) {
    case "installable": return "Ready to install";
    case "already_installed": return "Already installed";
    case "connect_separately": return "Connect separately";
    case "blocked": return m.reason ?? "Not allowed for your role";
    default: return m.reason ?? "Unavailable";
  }
}

function needsLine(m: MemberPlan): string {
  const tier = m.maxTier === null ? "no tools listed" : `highest approval tier ${m.maxTier}`;
  return m.needs.length ? `${tier}; needs ${m.needs.join(", ")}` : tier;
}

export function StoreBundles({ canInstall, onInstalled }: { canInstall: boolean; onInstalled: () => void | Promise<void> }) {
  const [bundles, setBundles] = useState<BundlePlan[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/store/bundles", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { bundles: BundlePlan[] };
      setBundles(data.bundles);
      setPicked((prev) => {
        const next: Record<string, boolean> = {};
        for (const b of data.bundles) for (const m of b.members) {
          const id = `${b.key}|${memberId(m)}`;
          next[id] = id in prev ? prev[id] : m.action === "installable";
        }
        return next;
      });
    } catch {
      // keep what is shown
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!bundles || bundles.length === 0) return null;

  async function install(b: BundlePlan) {
    const chosen = b.members.filter((m) => m.action === "installable" && picked[`${b.key}|${memberId(m)}`]);
    if (chosen.length === 0) return;
    const connectors = b.members.filter((m) => m.action === "connect_separately");
    const ok = await confirmAction({
      title: `Install ${chosen.length} item${chosen.length === 1 ? "" : "s"} from "${b.name}"?`,
      description:
        chosen.map((m) => `${m.name} (${KIND_LABEL[m.kind] ?? m.kind}): ${needsLine(m)}`).join("\n") +
        (connectors.length
          ? `\n\nNot installed by this bundle: ${connectors.map((m) => m.name).join(", ")}. They need your own account or key, which you connect in Settings.`
          : "") +
        "\n\nEach item is installed with its own permission check, and anything that acts for you still asks for approval when it runs.",
      confirmLabel: "Install selected",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setBusy(b.key);
    try {
      const res = await fetch(`/api/store/bundles/${encodeURIComponent(b.key)}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, members: chosen.map(memberId) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; results?: Array<{ id: string; outcome: string; reason?: string }> };
      if (!res.ok) {
        toastError("Couldn't install the bundle", body.error);
        return;
      }
      const results = body.results ?? [];
      const done = results.filter((r) => r.outcome === "installed").length;
      const failed = results.filter((r) => r.outcome === "failed");
      if (failed.length) toastError(`${done} installed, ${failed.length} not installed`, failed.map((f) => `${f.id}: ${f.reason ?? "failed"}`).join("\n"));
      else toast({ title: `Installed ${done} item${done === 1 ? "" : "s"}`, status: "done" });
      await load();
      await onInstalled();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="store-bundles" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div>
        <h2 id="store-bundles" className="text-sm font-semibold text-ink">Bundles</h2>
        <p className="mt-0.5 text-xs text-muted">Related items you can install together. Each item keeps its own permission check, and connectors are connected separately.</p>
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {bundles.map((b) => {
          const selectedCount = b.members.filter((m) => m.action === "installable" && picked[`${b.key}|${memberId(m)}`]).length;
          return (
            <li key={b.key} className="flex flex-col gap-2 rounded-md bg-canvas p-3" data-bundle={b.key}>
              <div className="flex items-start gap-2">
                <Package className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{b.name}</p>
                  <p className="text-xs text-muted">{b.description}</p>
                </div>
              </div>
              <ul className="flex flex-col gap-1">
                {b.members.map((m) => {
                  const id = `${b.key}|${memberId(m)}`;
                  return (
                    <li key={id} className="flex items-center gap-2 text-xs text-ink">
                      {m.action === "installable" ? (
                        <input
                          type="checkbox"
                          checked={!!picked[id]}
                          onChange={(e) => setPicked((p) => ({ ...p, [id]: e.target.checked }))}
                          aria-label={`Install ${m.name}`}
                          disabled={!canInstall}
                        />
                      ) : (
                        <span className="inline-block w-[13px]" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-muted">({KIND_LABEL[m.kind] ?? m.kind})</span></span>
                      {m.action === "connect_separately" && m.href ? (
                        <Link href={m.href} className="shrink-0 text-muted underline">Connect separately</Link>
                      ) : (
                        <span className="shrink-0 text-muted">{stateText(m)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                disabled={!canInstall || busy === b.key || selectedCount === 0}
                onClick={() => void install(b)}
                className="inline-flex h-control-sm w-fit items-center rounded-full bg-ink px-3 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40"
              >
                {busy === b.key ? "Installing..." : `Install selected (${selectedCount})`}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
