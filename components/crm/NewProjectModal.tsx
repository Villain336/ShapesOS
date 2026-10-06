// Marketr CRM — new project modal (Phase 17 slice 4).
// Creates a free draft project (planning) with an optional customer
// (CRM lead) and initial milestones. Sending money never enters here —
// no gate is involved in project creation.

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { backdropCls, btnPrimary, errorBoxCls, inputCls, modalWrapCls } from "./ui";

interface LeadHit {
  id: string;
  name: string;
  company: string | null;
}

export function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerHits, setCustomerHits] = useState<LeadHit[]>([]);
  const [customer, setCustomer] = useState<LeadHit | null>(null);
  const [showHits, setShowHits] = useState(false);
  const [searching, setSearching] = useState(false);
  const [milestones, setMilestones] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (customer) return;
    const needle = customerQuery.trim();
    if (needle.length < 2) {
      setCustomerHits([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(needle)}&limit=8`);
        const d = await r.json();
        if (r.ok) {
          setCustomerHits(
            ((d.leads ?? []) as Array<{ id: string; name: string; company?: string | null }>).map((l) => ({
              id: l.id,
              name: l.name,
              company: l.company ?? null,
            })),
          );
          setShowHits(true);
        }
      } catch {
        /* best-effort */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [customerQuery, customer]);

  async function submit() {
    setError(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Give the project a name.");
      return;
    }
    const cleanMilestones = milestones.map((m) => m.trim()).filter(Boolean);
    setSaving(true);
    try {
      const r = await fetch("/api/ops/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          status: "planning",
          ...(customer ? { customerId: customer.id, leadId: customer.id } : {}),
          milestones: cleanMilestones.map((title) => ({ title, status: "open" })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to create project.");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={modalWrapCls}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-ink">New project</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && (
            <div className={errorBoxCls}>
              {error}
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-ink">Project name</span>
            <input
              className={inputCls}
              placeholder="e.g. Q4 website redesign"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="relative flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-ink">Customer (CRM lead, optional)</span>
            {customer ? (
              <div className="flex items-center justify-between rounded-md border border-line bg-canvas px-3 py-2">
                <span className="text-[0.8125rem] text-ink">
                  {customer.name}
                  {customer.company ? ` · ${customer.company}` : ""}
                </span>
                <button
                  onClick={() => {
                    setCustomer(null);
                    setCustomerQuery("");
                  }}
                  className="text-[0.75rem] font-semibold text-muted hover:text-ink"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  className={inputCls}
                  placeholder="Search leads by name or company…"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  onFocus={() => customerHits.length > 0 && setShowHits(true)}
                />
                {showHits && customerHits.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-line bg-paper shadow-overlay">
                    {customerHits.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => {
                          setCustomer(l);
                          setShowHits(false);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-[0.8125rem] hover:bg-canvas"
                      >
                        <span className="text-ink">{l.name}</span>
                        <span className="text-subtle">{l.company ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
                {searching && <span className="text-[0.75rem] text-subtle">Searching…</span>}
              </>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-ink">Initial milestones (optional)</span>
            {milestones.map((m, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  placeholder={`Milestone ${i + 1}…`}
                  value={m}
                  onChange={(e) =>
                    setMilestones((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                  }
                />
                {milestones.length > 1 && (
                  <button
                    onClick={() => setMilestones((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded-md p-2 text-subtle hover:bg-hover-paper hover:text-ink"
                    aria-label="Remove milestone"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => setMilestones((prev) => [...prev, ""])}
              className="inline-flex w-fit items-center gap-1.5 text-[0.8125rem] font-semibold text-ink hover:underline"
            >
              <Plus size={14} /> Add milestone
            </button>
          </div>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              onClick={onClose}
              className="rounded-md border border-line bg-paper px-3 py-[7px] text-[0.8125rem] font-semibold text-ink hover:bg-canvas"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={saving || !name.trim()}
              className={btnPrimary}
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              Create project
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
