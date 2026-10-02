// Marketr — Connector Agent slice 1: the connector's Network home (client).
// Three tabs: People (master-detail with warmth breakdown, boundaries, and
// provenance), Companies, Import batches (provenance view).
// Agentic OS design system: canvas page, white surfaces, black primary
// pills, Lucide only, tokens only. Warmth renders in monochrome ink — the
// status colors are reserved for agent states, and warmth is data.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftRight,
  Building2,
  Loader2,
  Package,
  PhoneIncoming,
  PhoneOutgoing,
  Plug,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";
import { ImportSourcesTab } from "./ImportSourcesTab";
import type {
  ConnectorCompanyView,
  ConnectorGraphView,
  ConnectorImportBatchView,
  ConnectorPersonView,
} from "@/lib/connector/types";

type Tab = "people" | "companies" | "batches" | "imports";

function WarmthMeter({ score, compact }: { score: number; compact?: boolean }) {
  // Monochrome: warmth is data, not an agent state — never the status colors.
  return (
    <span className="flex items-center gap-2" title={`Warmth ${score}/100`}>
      <span className={`overflow-hidden rounded-full bg-canvas ${compact ? "h-1.5 w-16" : "h-2 w-24"}`}>
        <span className="block h-full rounded-full bg-ink" style={{ width: `${score}%` }} />
      </span>
      <span className={`font-semibold text-ink ${compact ? "text-[13px]" : "text-[15px]"}`}>
        {score}
      </span>
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-8 items-center rounded-full bg-canvas px-3 text-[13px] font-semibold text-ink">
      {children}
    </span>
  );
}

function BreakdownBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-[13px] text-muted">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-canvas">
        <span className="block h-full rounded-full bg-ink" style={{ width: `${(value / max) * 100}%` }} />
      </span>
      <span className="w-12 shrink-0 text-right text-[13px] font-semibold text-ink">
        {value}/{max}
      </span>
    </div>
  );
}

function PersonDetail({
  person,
  onTouch,
  touching,
}: {
  person: ConnectorPersonView;
  onTouch: (direction: "inbound" | "outbound") => void;
  touching: boolean;
}) {
  const rel = person.relationship;
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
      <div>
        <h2 className="aos-subheading">{person.name}</h2>
        {person.roles.length > 0 && (
          <p className="mt-1 text-sm text-muted">{person.roles.join(" · ")}</p>
        )}
        {person.handles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {person.handles.map((h) => (
              <Chip key={h}>{h}</Chip>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-[12px] font-semibold text-muted">Relationship warmth</p>
        {rel ? (
          <div className="flex flex-col gap-2">
            <WarmthMeter score={rel.warmthScore} />
            <BreakdownBar label="Recency" value={rel.warmthBreakdown.recency} max={50} />
            <BreakdownBar label="Frequency" value={rel.warmthBreakdown.frequency} max={30} />
            <BreakdownBar label="Reciprocity" value={rel.warmthBreakdown.reciprocity} max={20} />
            <p className="mt-1 text-[13px] text-muted">
              {rel.touchCount} {rel.touchCount === 1 ? "touch" : "touches"}
              {rel.lastTouchAt
                ? ` · last ${new Date(rel.lastTouchAt).toLocaleDateString()}`
                : " · never touched"}
              {rel.lastReciprocalTouchAt
                ? ` · they last reached out ${new Date(rel.lastReciprocalTouchAt).toLocaleDateString()}`
                : ""}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={touching}
                onClick={() => onTouch("inbound")}
                className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[14px] font-semibold text-white disabled:opacity-50"
              >
                <PhoneIncoming size={15} /> They reached out
              </button>
              <button
                type="button"
                disabled={touching}
                onClick={() => onTouch("outbound")}
                className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-4 text-[14px] font-semibold text-ink shadow-outline disabled:opacity-50"
              >
                <PhoneOutgoing size={15} /> I reached out
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">No relationship yet — record a touch to start one.</p>
        )}
      </div>

      {rel?.boundaries && (
        <div className="rounded-md border border-line bg-canvas p-3">
          <p className="text-[12px] font-semibold text-muted">Boundaries</p>
          <p className="mt-0.5 text-[14px] text-ink">{rel.boundaries}</p>
        </div>
      )}
      {rel?.notes && (
        <div>
          <p className="text-[12px] font-semibold text-muted">Context</p>
          <p className="mt-0.5 text-[14px] text-ink">{rel.notes}</p>
        </div>
      )}

      {person.employments.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-muted">Employment</p>
          <div className="flex flex-col gap-1.5">
            {person.employments.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[14px]">
                <Building2 size={14} className="text-muted" />
                <span className="font-semibold text-ink">{e.companyName}</span>
                {e.title && <span className="text-muted">· {e.title}</span>}
                {e.startYear && (
                  <span className="text-muted">
                    · {e.startYear}–{e.endYear ?? "now"}
                    {!e.isCurrent && " (past)"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-line pt-3">
        <p className="mb-1.5 text-[12px] font-semibold text-muted">Provenance</p>
        {person.importBatch ? (
          <p className="text-[13px] text-ink">
            Imported via <span className="font-semibold">{person.importBatch.source}</span>
            {" "}on {new Date(person.importBatch.createdAt).toLocaleDateString()}
            {" "}· consent by <span className="font-semibold">{person.consentedBy}</span>
            {" "}on {new Date(person.consentedAt).toLocaleDateString()}
          </p>
        ) : (
          <p className="text-[13px] text-ink">
            Added manually · consent by <span className="font-semibold">{person.consentedBy}</span>
            {" "}on {new Date(person.consentedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}

function AddPersonForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState("");
  const [handles, setHandles] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/connector/persons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          roles: roles.split(",").map((s) => s.trim()).filter(Boolean),
          handles: handles.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not add person.");
      setName("");
      setRoles("");
      setHandles("");
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add person.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[15px] font-semibold text-white"
      >
        <Plus size={16} /> Add person
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            className="h-control rounded-md border border-control bg-paper px-3 text-[15px] text-ink"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-muted">Roles (comma-separated)</span>
          <input
            value={roles}
            onChange={(e) => setRoles(e.target.value)}
            placeholder="Partner, Angel investor"
            className="h-control rounded-md border border-control bg-paper px-3 text-[15px] text-ink"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold text-muted">Contact handles (comma-separated)</span>
          <input
            value={handles}
            onChange={(e) => setHandles(e.target.value)}
            placeholder="ada@example.com"
            className="h-control rounded-md border border-control bg-paper px-3 text-[15px] text-ink"
          />
        </label>
      </div>
      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving || !name.trim()}
          onClick={submit}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[15px] font-semibold text-white disabled:opacity-50"
        >
          {saving && <Loader2 size={15} className="animate-spin" />}
          {saving ? "Adding" : "Add person"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="aos-press flex h-11 items-center rounded-full bg-paper px-5 text-[15px] font-semibold text-ink shadow-outline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ConnectorApp() {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("people");
  const [graph, setGraph] = useState<ConnectorGraphView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [touching, setTouching] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/connector/graph");
    if (res.ok) setGraph(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recordTouch = useCallback(
    async (personId: string, direction: "inbound" | "outbound") => {
      setTouching(true);
      try {
        await fetch("/api/connector/touch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ personId, direction }),
        });
        await refresh();
      } finally {
        setTouching(false);
      }
    },
    [refresh],
  );

  const recompute = useCallback(async () => {
    setRecomputing(true);
    try {
      await fetch("/api/connector/recompute", { method: "POST" });
      await refresh();
    } finally {
      setRecomputing(false);
    }
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading your network
      </div>
    );
  }

  const tabs = [
    { id: "people" as const, label: "People", icon: Users },
    { id: "companies" as const, label: "Companies", icon: Building2 },
    { id: "batches" as const, label: "Import batches", icon: Package },
    { id: "imports" as const, label: "Import sources", icon: Plug },
  ];

  const selected = graph?.persons.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2" role="tablist" aria-label="Network views">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`aos-press flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold ${
                  active ? "bg-black text-white" : "bg-paper text-muted shadow-hairline"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={recompute}
            disabled={recomputing}
            className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-4 text-[14px] font-semibold text-ink shadow-hairline disabled:opacity-50"
            title="Recompute every warmth score from interaction signals"
          >
            {recomputing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {recomputing ? "Recomputing" : "Recompute warmth"}
          </button>
          <AddPersonForm onAdded={refresh} />
        </div>
      </div>

      {tab === "people" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            {!graph || graph.persons.length === 0 ? (
              <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
                No people in your network yet. Add your first person above — every
                contact records where it came from and whose consent brought it in.
              </div>
            ) : (
              graph.persons.map((p: ConnectorPersonView) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                  aria-pressed={p.id === selectedId}
                  className={`aos-press flex items-center justify-between gap-3 rounded-sm bg-paper px-4 py-3 text-left shadow-hairline ${
                    p.id === selectedId ? "shadow-outline" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold text-ink">
                      {p.name}
                    </span>
                    <span className="block truncate text-[13px] text-muted">
                      {[p.roles[0], p.employments[0]?.companyName].filter(Boolean).join(" · ") ||
                        "No role yet"}
                    </span>
                  </span>
                  <WarmthMeter score={p.relationship?.warmthScore ?? 0} compact />
                </button>
              ))
            )}
          </div>
          <div>
            {selected ? (
              <PersonDetail
                person={selected}
                touching={touching}
                onTouch={(d) => recordTouch(selected.id, d)}
              />
            ) : (
              <div className="flex h-full min-h-40 items-center justify-center rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
                Select a person to see warmth, boundaries, and provenance.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "companies" && (
        <div className="flex flex-col gap-2">
          {!graph || graph.companies.length === 0 ? (
            <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
              No companies yet. Link people to their employers to grow this list.
            </div>
          ) : (
            graph.companies.map((c: ConnectorCompanyView) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm bg-paper px-4 py-3 shadow-hairline"
              >
                <span className="text-[15px] font-semibold text-ink">{c.name}</span>
                {c.industry && <span className="text-[13px] text-muted">{c.industry}</span>}
                {c.sizeBand && <Chip>{c.sizeBand}</Chip>}
                {c.relationship && <Chip>{c.relationship}</Chip>}
                <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted">
                  <ArrowLeftRight size={13} />
                  {c.employeeCount} {c.employeeCount === 1 ? "contact" : "contacts"}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "imports" && <ImportSourcesTab />}

      {tab === "batches" && (
        <div className="flex flex-col gap-2">
          {!graph || graph.batches.length === 0 ? (
            <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
              No imports yet. Every import batch records its source and the consent
              behind it — nothing enters the graph without that record.
            </div>
          ) : (
            graph.batches.map((b: ConnectorImportBatchView) => (
              <div
                key={b.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm bg-paper px-4 py-3 shadow-hairline"
              >
                <span className="text-[15px] font-semibold capitalize text-ink">{b.source}</span>
                {b.note && <span className="text-[13px] text-muted">{b.note}</span>}
                <span className="ml-auto text-[13px] text-muted">
                  {b.personCount} {b.personCount === 1 ? "person" : "people"} · consent by{" "}
                  <span className="font-semibold text-ink">{b.consentedBy}</span> ·{" "}
                  {new Date(b.consentedAt).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
