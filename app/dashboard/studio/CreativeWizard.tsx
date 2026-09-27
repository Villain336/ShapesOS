// Marketr — Creative Studio "New creative" wizard (Phase 4, T2).
// Steps: 1) channel template (print only in v1; email/social disabled as
// "coming soon") 2) format track + size 3) source (upload PDF) 4) validation
// report 5) save as draft -> mark ready.
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Mail,
  Printer,
  Share2,
  X,
} from "lucide-react";
import {
  api,
  hashShort,
  type ChannelTemplate,
  type Creative,
} from "./api";

const STEPS = ["Channel", "Format", "Source", "Validation", "Review"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-stone-600">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

export function CreativeWizard({ onClose, onDone }: { onClose: () => void; onDone: (c: Creative) => void }) {
  const [step, setStep] = useState(1);
  const [channels, setChannels] = useState<ChannelTemplate[]>([]);
  const [channelTemplate, setChannelTemplate] = useState("print");
  const [formatTrack, setFormatTrack] = useState("addressed");
  const [size, setSize] = useState("4x6_postcard");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creative, setCreative] = useState<Creative | null>(null);
  const [attested, setAttested] = useState(false);

  useEffect(() => {
    api<{ channelTemplates: Record<string, ChannelTemplate> }>("/api/studio/creatives/formats")
      .then((r) => setChannels(Object.values(r.channelTemplates)))
      .catch((e) => setError(e.message));
  }, []);

  const track = useMemo(
    () =>
      channels
        .find((c) => c.id === channelTemplate)
        ?.tracks.find((t) => t.id === formatTrack) ?? null,
    [channels, channelTemplate, formatTrack],
  );
  const sizeSpec = useMemo(() => track?.sizes.find((s) => s.id === size) ?? null, [track, size]);

  const canNext =
    step === 1
      ? channelTemplate === "print"
      : step === 2
        ? !!track && !!sizeSpec && name.trim().length > 0
        : step === 3
          ? !!file
          : true;

  async function runStep4() {
    setBusy(true);
    setError(null);
    try {
      const { creative: created } = await api<{ creative: Creative }>("/api/studio/creatives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channelTemplate,
          formatTrack,
          size,
          source: "upload",
        }),
      });
      let c = created;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ creative: Creative }>(`/api/studio/creatives/${created.id}/upload`, {
          method: "POST",
          body: form,
        });
        c = r.creative;
      }
      setCreative(c);
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something failed.");
    } finally {
      setBusy(false);
    }
  }

  async function markReady() {
    if (!creative) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ creative: Creative }>(`/api/studio/creatives/${creative.id}/mark-ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attested }),
      });
      setCreative(r.creative);
      onDone(r.creative);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mark-ready failed.");
    } finally {
      setBusy(false);
    }
  }

  const report = creative?.validation ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-stone-900">New creative</h2>
            <div className="mt-1.5 flex items-center gap-1.5">
              {STEPS.map((s, i) => (
                <div key={s} className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      step === i + 1
                        ? "bg-violet-600 text-white"
                        : step > i + 1
                          ? "bg-violet-100 text-violet-700"
                          : "bg-stone-100 text-stone-500"
                    }`}
                  >
                    {i + 1}. {s}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 && (
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: "print", icon: Printer, desc: "Postcards, letters, EDDM flats" },
                { id: "email", icon: Mail, desc: "Email templates" },
                { id: "social", icon: Share2, desc: "Social templates" },
              ].map(({ id, icon: Icon, desc }) => {
                const ch = channels.find((c) => c.id === id);
                const enabled = ch?.status === "live";
                const selected = channelTemplate === id;
                return (
                  <button
                    key={id}
                    disabled={!enabled}
                    onClick={() => setChannelTemplate(id)}
                    className={`rounded-lg border p-4 text-left transition ${
                      selected
                        ? "border-violet-500 bg-violet-50/60 ring-1 ring-violet-500"
                        : enabled
                          ? "border-stone-200 hover:border-stone-300"
                          : "cursor-not-allowed border-stone-100 bg-stone-50 opacity-70"
                    }`}
                  >
                    <Icon size={18} className={selected ? "text-violet-600" : "text-stone-500"} />
                    <div className="mt-2 text-[13px] font-semibold text-stone-900">{ch?.label ?? id}</div>
                    <div className="mt-0.5 text-[12px] text-stone-500">{desc}</div>
                    {!enabled && (
                      <div className="mt-2 inline-block rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-600">
                        coming soon
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <Field label="Creative name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fall mailer — front" className={inputCls} />
              </Field>
              <Field label="Format track">
                <select value={formatTrack} onChange={(e) => { setFormatTrack(e.target.value); setSize(""); }} className={inputCls}>
                  {channels
                    .find((c) => c.id === channelTemplate)
                    ?.tracks.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                </select>
              </Field>
              {track?.notes && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{track.notes}</span>
                </div>
              )}
              <Field label="Size">
                <select value={size} onChange={(e) => setSize(e.target.value)} className={inputCls}>
                  <option value="">Select a size…</option>
                  {track?.sizes.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </Field>
              {sizeSpec?.notes && <p className="text-[12px] text-stone-500">{sizeSpec.notes}</p>}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <Field label="PDF file (max 25 MB)">
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-[13px] text-stone-600 file:mr-3 file:rounded-md file:border file:border-stone-200 file:bg-stone-50 file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-stone-700 hover:file:bg-stone-100"
                />
              </Field>
            </div>
          )}

          {step === 4 && (
            <div className="py-8 text-center">
              {busy ? (
                <>
                  <Loader2 size={28} className="mx-auto animate-spin text-violet-600" />
                  <p className="mt-3 text-[13px] text-stone-600">Uploading and validating your PDF…</p>
                </>
              ) : (
                <p className="text-[13px] text-stone-500">Ready when you are — run validation to create the creative and pull its PDF.</p>
              )}
            </div>
          )}

          {step === 5 && creative && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[14px] font-semibold text-stone-900">{creative.name}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-stone-500">hash {hashShort(creative.creativeHash)}</div>
                </div>
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                  v{creative.version} · draft
                </span>
              </div>
              {report ? (
                <ValidationView report={report} />
              ) : (
                <p className="text-[13px] text-stone-500">No PDF attached yet.</p>
              )}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(e) => setAttested(e.target.checked)}
                  className="mt-0.5 accent-violet-600"
                />
                <span className="text-[12.5px] leading-snug text-stone-700">
                  I confirm this creative contains <strong>no USPS/government impersonation markings</strong> (spec §7).
                </span>
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-stone-100 px-5 py-3">
          <button
            onClick={() => (step === 5 ? setStep(4) : setStep((s) => Math.max(1, s - 1)))}
            disabled={step === 1 || busy}
            className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px] text-stone-500 hover:bg-stone-100 disabled:opacity-40"
          >
            <ChevronLeft size={14} /> Back
          </button>
          {step < 3 && (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext}
              className="flex items-center gap-1 rounded-md bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40"
            >
              Continue <ChevronRight size={14} />
            </button>
          )}
          {step === 3 && (
            <button
              onClick={runStep4}
              disabled={!canNext || busy}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {busy && <Loader2 size={14} className="animate-spin" />} Create & validate
            </button>
          )}
          {step === 4 && (
            <button
              onClick={() => setStep(5)}
              disabled={busy || !creative}
              className="flex items-center gap-1 rounded-md bg-violet-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40"
            >
              Review <ChevronRight size={14} />
            </button>
          )}
          {step === 5 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => creative && onDone(creative)}
                className="rounded-md border border-stone-200 px-3.5 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50"
              >
                Save as draft
              </button>
              <button
                onClick={markReady}
                disabled={busy || !attested || !report?.ok}
                title={!report?.ok ? "Validation must pass before marking ready" : undefined}
                className="flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                <CheckCircle2 size={14} /> Mark ready
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ValidationView({ report }: { report: NonNullable<Creative["validation"]> }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {report.ok ? (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700">
            <CheckCircle2 size={13} /> Validation passed
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-700">
            <AlertTriangle size={13} /> Validation failed
          </span>
        )}
        {report.widthIn != null && report.heightIn != null && (
          <span className="text-[12px] text-stone-500">
            {report.widthIn.toFixed(2)}″ × {report.heightIn.toFixed(2)}″
            {report.pages != null && ` · ${report.pages} page${report.pages === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
      {report.issues.length > 0 && (
        <ul className="space-y-1.5">
          {report.issues.map((issue, i) => (
            <li
              key={i}
              className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px] ${
                issue.severity === "error"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : issue.severity === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-stone-200 bg-stone-50 text-stone-600"
              }`}
            >
              {issue.severity === "error" ? (
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              ) : issue.severity === "warning" ? (
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              ) : (
                <Info size={13} className="mt-0.5 shrink-0" />
              )}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
      {report.printNotes.length > 0 && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[12px] text-stone-600">
          <span className="font-medium">Print notes: </span>
          {report.printNotes.join(" ")}
        </div>
      )}
      {report.attestation && (
        <div className="flex items-center gap-1.5 text-[12px] text-emerald-700">
          <CheckCircle2 size={13} /> No-USPS-impersonation attested
          {report.attestation.attestedAt && ` · ${new Date(report.attestation.attestedAt).toLocaleDateString()}`}
        </div>
      )}
    </div>
  );
}
