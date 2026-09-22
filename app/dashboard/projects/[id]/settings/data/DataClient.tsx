"use client";

// Marketr — project settings: Data client (milestone 21, part D2).
// Bind a workspace connection to this project:
//   POST /api/projects/[id]/data-sources { connectionId, projectConfig? }
// Unbind:
//   DELETE /api/projects/[id]/data-sources/[bindingId]

import { useState } from "react";
import { LinkSimple, Warning } from "@/components/vault/phosphor";
import { Field } from "@/components/vault/Field";
import { Textarea } from "@/components/vault/shadcn/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { buttonVariants } from "@/components/vault/atoms/button-variants";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/vault/EmptyState";

export interface BindingRow {
  id: string;
  connectorKey: string;
  displayName: string;
  connectionId: string;
  status: string;
  meta: Record<string, unknown> | null;
  projectConfig: Record<string, unknown> | null;
}

export interface ConnectionOption {
  id: string;
  connectorKey: string;
  displayName: string;
  meta: Record<string, unknown> | null;
}

function metaSummary(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  const email = meta.accountEmail ?? meta.email;
  if (typeof email === "string" && email) return email;
  const property = meta.property ?? meta.siteUrl;
  if (typeof property === "string" && property) return property;
  return null;
}

function configSummary(config: Record<string, unknown> | null): string | null {
  if (!config) return null;
  const entries = Object.entries(config);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
}

/** MVP key=value parser: one pair per line, "key=value". */
function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export default function DataClient({
  projectId,
  canEdit,
  initialBindings,
  availableConnections,
}: {
  projectId: string;
  canEdit: boolean;
  initialBindings: BindingRow[];
  availableConnections: ConnectionOption[];
}) {
  const [bindings, setBindings] = useState(initialBindings);
  const [connectionId, setConnectionId] = useState("");
  const [configText, setConfigText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boundConnectionIds = new Set(bindings.map((b) => b.connectionId));
  const bindable = availableConnections.filter((c) => !boundConnectionIds.has(c.id));

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/data-sources`);
    if (!res.ok) return;
    const data = await res.json();
    setBindings((data.bindings ?? []) as BindingRow[]);
  }

  async function bind() {
    if (!connectionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const projectConfig = parseConfig(configText);
      const res = await fetch(`/api/projects/${projectId}/data-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId,
          ...(Object.keys(projectConfig).length > 0 ? { projectConfig } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Bind failed (${res.status})`);
      }
      setConnectionId("");
      setConfigText("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setBusy(false);
    }
  }

  async function unbind(bindingId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/data-sources/${bindingId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Unbind failed (${res.status})`);
      }
      setBindings((prev) => prev.filter((b) => b.id !== bindingId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unbind failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {bindings.length === 0 ? (
        <EmptyState
          icon={<LinkSimple className="size-5" weight="duotone" />}
          title="No data sources bound"
          description="Bind a workspace connection below to give this project — and Marketr — access to it."
        />
      ) : (
        <ul className="flex flex-col">
          {bindings.map((b) => {
            const meta = metaSummary(b.meta);
            const config = configSummary(b.projectConfig);
            return (
              <li
                key={b.id}
                className="flex items-start justify-between gap-4 border-b border-line py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[13.5px] font-medium text-ink">
                      {b.displayName}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        b.status === "active"
                          ? "bg-green/10 text-green"
                          : "bg-amber/10 text-amber",
                      )}
                    >
                      {b.status}
                    </span>
                  </div>
                  {meta && (
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-2">{meta}</p>
                  )}
                  {config && (
                    <p className="mt-0.5 font-mono text-[11.5px] text-ink-3">{config}</p>
                  )}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void unbind(b.id)}
                    className={cn(buttonVariants({ variant: "quiet", size: "sm" }))}
                  >
                    Unbind
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-col gap-3 rounded-control bg-inset p-4">
          <h4 className="text-[13.5px] font-medium text-ink">Bind a data source</h4>
          {bindable.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">
              No active workspace connections available. Connect one from
              workspace settings first.
            </p>
          ) : (
            <>
              <Field label="Connection" htmlFor="bind-connection">
                <Select value={connectionId} onValueChange={(v) => setConnectionId(v ?? "")}>
                  <SelectTrigger id="bind-connection">
                    <SelectValue placeholder="Choose a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {bindable.map((c) => {
                      const meta = metaSummary(c.meta);
                      return (
                        <SelectItem key={c.id} value={c.id}>
                          {c.displayName}
                          {meta ? ` — ${meta}` : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Project config (optional)"
                hint='One key=value per line — e.g. property=https://example.com or folderId=abc123.'
                htmlFor="bind-config"
              >
                <Textarea
                  id="bind-config"
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  rows={3}
                  placeholder={"property=https://example.com"}
                  className="font-mono text-[12.5px]"
                />
              </Field>
              <div>
                <button
                  type="button"
                  disabled={!connectionId || busy}
                  onClick={() => void bind()}
                  className={cn(buttonVariants({ variant: "accent", size: "sm" }))}
                >
                  {busy ? "Binding…" : "Bind to this project"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-red">
          <Warning className="size-3.5" />
          {error}
        </p>
      )}

    </div>
  );
}
