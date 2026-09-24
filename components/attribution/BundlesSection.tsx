// Marketr — Physical attribution kit (P2): measurement-bundle UI.
// Lives inside the attribution dashboard. One-click bundle creation and the
// four artifacts per bundle: tracking number, QR (PNG/SVG download),
// vanity URL (copy), promo code (copy), plus scan/call/redemption/revenue
// counts and disable/regenerate controls.
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  QrCode,
  Plus,
  X,
  Copy,
  Check,
  Download,
  ArrowClockwise,
  Pause,
  Play,
  Phone,
  Link as LinkIcon,
  Ticket,
} from "@phosphor-icons/react";
import { formatMoney } from "../crm/types";

interface BundleStats {
  scans: number;
  calls: number;
  redemptions: number;
  leads: number;
  revenueCents: Record<string, number>;
}

interface Bundle {
  id: string;
  name: string;
  campaignName: string;
  vanitySlug: string;
  vanityUrl: string;
  promoCode: string;
  status: string;
  number: { id: string; e164: string; status: string } | null;
  qrPreview: string;
  stats: BundleStats;
}

const cardCls = "rounded-[10px] border border-stone-200 bg-white p-4";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="crm-btn-ghost !px-2 !py-1 text-stone-500 hover:text-violet-700"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable */ }
      }}
    >
      {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
    </button>
  );
}

function ArtifactRow({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-[8px] bg-stone-50 px-2.5 py-1.5">
      <span className="shrink-0 text-stone-400">{icon}</span>
      <span className="w-[86px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-stone-500">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-[12.5px] text-stone-800 ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function BundlesSection() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ name: "", campaignName: "", destinationUrl: "", vanitySlug: "", areaCode: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/attribution/bundles");
      const j = await r.json();
      if (r.ok) setBundles(j.bundles);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/attribution/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          campaignName: draft.campaignName,
          destinationUrl: draft.destinationUrl,
          ...(draft.vanitySlug ? { vanitySlug: draft.vanitySlug } : {}),
          ...(draft.areaCode ? { areaCode: draft.areaCode } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Creation failed");
      setShowForm(false);
      setDraft({ name: "", campaignName: "", destinationUrl: "", vanitySlug: "", areaCode: "" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation failed");
    } finally {
      setSaving(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/api/attribution/bundles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) await load();
  }

  return (
    <section className={cardCls}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <QrCode size={16} className="text-violet-600" /> Measurement bundles
        </h2>
        <button className="crm-btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={14} /> New bundle
        </button>
      </div>
      <p className="mb-4 text-[12.5px] text-stone-500">
        One click provisions a tracking number, QR code, vanity URL, and promo code per campaign —
        every identified scan, call, and redemption attributes revenue through your chosen model.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-stone-400">Loading bundles…</p>
      ) : bundles.length === 0 ? (
        <p className="rounded-[8px] border border-dashed border-stone-200 px-4 py-8 text-center text-[13px] text-stone-400">
          No measurement bundles yet. Create one for your next mailer, billboard, or event.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {bundles.map((b) => (
            <div key={b.id} className="min-w-0 rounded-[10px] border border-stone-200 p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[14px] font-semibold text-stone-900">{b.name}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        b.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"
                      }`}
                    >
                      {b.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-stone-500">Campaign: {b.campaignName}</p>
                </div>
                <img src={b.qrPreview} alt={`QR code for ${b.name}`} className="h-[72px] w-[72px] shrink-0 rounded-[6px] border border-stone-200" />
              </div>

              <div className="flex flex-col gap-1.5">
                <ArtifactRow
                  icon={<Phone size={14} />}
                  label="Number"
                  value={b.number ? `${b.number.e164}${b.number.status !== "active" ? " (released)" : ""}` : "—"}
                  mono
                />
                <ArtifactRow icon={<LinkIcon size={14} />} label="Vanity URL" value={b.vanityUrl} mono />
                <ArtifactRow icon={<Ticket size={14} />} label="Promo code" value={b.promoCode} mono />
              </div>

              <div className="mt-3 grid grid-cols-5 gap-2 border-t border-stone-100 pt-3 text-center">
                {[
                  { label: "Scans", value: String(b.stats.scans) },
                  { label: "Calls", value: String(b.stats.calls) },
                  { label: "Redemptions", value: String(b.stats.redemptions) },
                  { label: "Leads", value: String(b.stats.leads) },
                  { label: "Revenue", value: formatMoney(b.stats.revenueCents.linear ?? 0) },
                ].map((s) => (
                  <div key={s.label}>
                    <div className="text-[15px] font-semibold tabular-nums text-stone-900">{s.value}</div>
                    <div className="text-[10.5px] font-medium uppercase tracking-wide text-stone-400">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
                <a
                  className="crm-btn-ghost !py-1 text-[12px]"
                  href={`/api/attribution/bundles/${b.id}/qr?format=png`}
                  download
                >
                  <Download size={13} /> PNG
                </a>
                <a
                  className="crm-btn-ghost !py-1 text-[12px]"
                  href={`/api/attribution/bundles/${b.id}/qr?format=svg`}
                  download
                >
                  <Download size={13} /> SVG
                </a>
                <button className="crm-btn-ghost !py-1 text-[12px]" onClick={() => patch(b.id, { regenerateQr: true })}>
                  <ArrowClockwise size={13} /> Restyle QR
                </button>
                <span className="flex-1" />
                {b.status === "active" ? (
                  <button className="crm-btn-ghost !py-1 text-[12px] text-stone-500" onClick={() => patch(b.id, { status: "disabled" })}>
                    <Pause size={13} /> Disable
                  </button>
                ) : (
                  <button className="crm-btn-ghost !py-1 text-[12px] text-emerald-700" onClick={() => patch(b.id, { status: "active" })}>
                    <Play size={13} /> Enable
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-[480px] rounded-[12px] bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-stone-900">New measurement bundle</h3>
              <button className="crm-btn-ghost !p-1.5" onClick={() => setShowForm(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {[
                { key: "name", label: "Bundle name", ph: "Fall mailer — Greensboro", req: true },
                { key: "campaignName", label: "Campaign (attribution key)", ph: "fall-mailer-2026", req: true },
                { key: "destinationUrl", label: "Destination URL", ph: "https://example.com/offer", req: true },
                { key: "vanitySlug", label: "Vanity slug (optional)", ph: "fall-offer", req: false },
                { key: "areaCode", label: "Number area code (optional)", ph: "336", req: false },
              ].map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-stone-600">
                    {f.label}{f.req && <span className="text-red-500"> *</span>}
                  </span>
                  <input
                    className="crm-input w-full"
                    placeholder={f.ph}
                    value={draft[f.key as keyof typeof draft]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </label>
              ))}
              {error && <p className="text-[12.5px] text-red-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <button className="crm-btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
                <button
                  className="crm-btn-primary"
                  disabled={saving || !draft.name.trim() || !draft.campaignName.trim() || !draft.destinationUrl.trim()}
                  onClick={create}
                >
                  {saving ? "Provisioning…" : "Create bundle"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
