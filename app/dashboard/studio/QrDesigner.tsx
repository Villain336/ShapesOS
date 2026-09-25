// Marketr — Creative Studio: QR designer tab (Phase 5 A1, chat-generated QR).
//
// Chat-first surface for brand-styled QR codes: describe the look, get a
// rendered preview that has already passed automated validation + a real
// decoder scan test. The print-locked asset's sha256 is the hash the
// per-buy approval object binds (spec §4 tracking_links qr_png_url).

"use client";

import { useState } from "react";
import {
  BadgeCheck,
  Download,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { api, hashShort } from "./api";

interface DesignResponse {
  ok: boolean;
  regenerated: boolean;
  attempts: string[];
  fatal: string | null;
  spec: {
    moduleGlyph: string;
    glyphLabel: string;
    shapeMask: string;
    foreground: string;
    background: string;
    finderStyle: string;
    frameCta: string | null;
    errorCorrection: string;
    quietZoneModules: number;
    fillFraction: number;
    hasLogo: boolean;
  };
  matrix: { size: number; version: number };
  validation: {
    ok: boolean;
    issues: Array<{ code: string; message: string }>;
    metrics: {
      contrastRatio: number;
      meanGlyphFill: number;
      thinModuleShare: number;
      finderMatchPct: number;
      quietZoneOk: boolean;
      decodeOk: boolean;
      decodedUrl: string | null;
    };
  } | null;
  scanTest: { passed: boolean; decoded: string | null };
  previewPng: string | null;
  svg: string | null;
  lock: {
    hash: string;
    qrPngUrl: string;
    pngPath: string;
    svgPath: string;
    targetUrl: string;
    validatedAt: string;
  } | null;
}

const EXAMPLES = [
  "round QR, modules as little snakes, brand purple on white",
  "dots for modules, navy and gold, logo in the center",
  "classic squares, black on white, frame that says “Scan for 20% off”",
];

export function QrDesignerTab() {
  const [targetUrl, setTargetUrl] = useState("https://example.com/board-47");
  const [stylePrompt, setStylePrompt] = useState(EXAMPLES[0]);
  const [foreground, setForeground] = useState("#7C3AED");
  const [background, setBackground] = useState("#FFFFFF");
  const [shapeMask, setShapeMask] = useState<"square" | "round">("round");
  const [frameCta, setFrameCta] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DesignResponse | null>(null);

  function onLogoFile(file: File | null) {
    if (!file) {
      setLogoDataUrl(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function design() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<DesignResponse>("/api/media/qr/design", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetUrl,
          stylePrompt,
          brand: { foreground, background, logoDataUrl },
          shapeMask,
          frameCta: frameCta || undefined,
        }),
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Design failed.");
    } finally {
      setBusy(false);
    }
  }

  function downloadPng() {
    if (!result?.previewPng) return;
    const a = document.createElement("a");
    a.href = result.previewPng;
    a.download = `qr-${result.lock?.hash.slice(0, 8) ?? "preview"}.png`;
    a.click();
  }

  function downloadSvg() {
    if (!result?.svg) return;
    const blob = new Blob([result.svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `qr-${result.lock?.hash.slice(0, 8) ?? "preview"}.svg`;
    a.click();
  }

  const v = result?.validation;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* Controls */}
      <div className="space-y-4 rounded-xl border border-stone-200 bg-white p-4">
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-stone-700">Target URL</label>
          <input
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400"
          />
          <p className="mt-1 text-[11px] text-stone-400">The code must decode to exactly this URL — verified by a real scan test.</p>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-stone-700">Describe the look</label>
          <textarea
            value={stylePrompt}
            onChange={(e) => setStylePrompt(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setStylePrompt(ex)}
                className="rounded-full border border-stone-200 px-2 py-0.5 text-[11px] text-stone-500 hover:border-violet-300 hover:text-violet-700"
              >
                {ex.slice(0, 34)}…
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-stone-700">Foreground</label>
            <div className="flex items-center gap-2">
              <input type="color" value={foreground} onChange={(e) => setForeground(e.target.value)} className="h-9 w-10 cursor-pointer rounded border border-stone-200" />
              <span className="font-mono text-[11px] text-stone-500">{foreground}</span>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-stone-700">Background</label>
            <div className="flex items-center gap-2">
              <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} className="h-9 w-10 cursor-pointer rounded border border-stone-200" />
              <span className="font-mono text-[11px] text-stone-500">{background}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-stone-700">Shape</label>
            <select
              value={shapeMask}
              onChange={(e) => setShapeMask(e.target.value as "square" | "round")}
              className="w-full rounded-lg border border-stone-200 px-2 py-2 text-[13px]"
            >
              <option value="square">Square</option>
              <option value="round">Round</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-stone-700">Center logo</label>
            <input
              type="file"
              accept="image/png"
              onChange={(e) => onLogoFile(e.target.files?.[0] ?? null)}
              className="w-full text-[12px] text-stone-500"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-stone-700">Frame CTA (optional)</label>
          <input
            value={frameCta}
            onChange={(e) => setFrameCta(e.target.value)}
            placeholder="Scan for 20% off"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400"
          />
        </div>
        <button
          onClick={design}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-[13.5px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <QrCode size={16} />}
          {busy ? "Designing + verifying…" : "Design QR code"}
        </button>
        {error && <p className="text-[12.5px] text-red-600">{error}</p>}
        <p className="text-[11px] leading-relaxed text-stone-400">
          Every design is validated before preview: glyph fill, contrast ≥ 3:1, finder-pattern integrity,
          quiet zone, error correction H — then decoded with a real scanner. Styles that fail come back
          with the reason plus a bolder variant. The AI styles artwork only, never the encoded data.
        </p>
      </div>

      {/* Preview + validation */}
      <div className="space-y-4">
        {!result && (
          <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-stone-300 bg-white text-[13px] text-stone-400">
            Describe the look and hit “Design QR code” — the verified preview appears here.
          </div>
        )}
        {result && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-stone-800">Preview</h3>
                  {result.regenerated && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700">
                      <RefreshCw size={11} /> bolder variant
                    </span>
                  )}
                </div>
                {result.previewPng ? (
                  <img src={result.previewPng} alt="Styled QR preview" className="mx-auto max-h-80 rounded-lg border border-stone-100" />
                ) : (
                  <p className="text-[12.5px] text-red-600">No preview — the design did not verify (see issues).</p>
                )}
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">{result.spec.glyphLabel}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">{result.spec.shapeMask} mask</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 font-mono text-stone-600">{result.spec.foreground} / {result.spec.background}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">EC-{result.spec.errorCorrection}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">v{result.matrix.version} · {result.matrix.size}×{result.matrix.size}</span>
                </div>
              </div>
              <div className="rounded-xl border border-stone-200 bg-white p-4">
                <h3 className="mb-2 text-[13px] font-semibold text-stone-800">Validation</h3>
                {v ? (
                  <div className="space-y-2.5 text-[12.5px]">
                    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${result.scanTest.passed ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
                      {result.scanTest.passed ? <BadgeCheck size={16} className="text-emerald-600" /> : <ShieldAlert size={16} className="text-red-600" />}
                      <span className={result.scanTest.passed ? "text-emerald-800" : "text-red-800"}>
                        {result.scanTest.passed ? `Scan test passed — decodes to the exact target URL` : "Scan test FAILED"}
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      <div><dt className="text-stone-400">Contrast</dt><dd className="font-mono">{v.metrics.contrastRatio.toFixed(2)}:1</dd></div>
                      <div><dt className="text-stone-400">Glyph fill</dt><dd className="font-mono">{(v.metrics.meanGlyphFill * 100).toFixed(0)}%</dd></div>
                      <div><dt className="text-stone-400">Finder integrity</dt><dd className="font-mono">{(v.metrics.finderMatchPct * 100).toFixed(1)}%</dd></div>
                      <div><dt className="text-stone-400">Quiet zone</dt><dd>{v.metrics.quietZoneOk ? "clean" : "damaged"}</dd></div>
                    </dl>
                    {v.issues.length > 0 && (
                      <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-2.5">
                        {v.issues.map((i) => (
                          <li key={i.code} className="flex gap-1.5 text-red-800">
                            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                            <span><span className="font-mono text-[11px]">{i.code}</span> — {i.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.lock && (
                      <div className="rounded-lg border border-violet-200 bg-violet-50 p-2.5">
                        <div className="flex items-center gap-1.5 text-violet-800">
                          <ShieldCheck size={14} /> <span className="font-semibold">Print-locked</span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-violet-700">sha256 {hashShort(result.lock.hash)}</p>
                        <p className="mt-0.5 text-[11px] text-violet-600">Bind this hash in the per-buy approval object — it covers the exact verified PNG.</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-red-600">{result.fatal ?? "Validation did not run."}</p>
                )}
              </div>
            </div>

            {result.attempts.length > 0 && (
              <div className="rounded-xl border border-stone-200 bg-white p-4">
                <h3 className="mb-2 text-[13px] font-semibold text-stone-800">Design log</h3>
                <ul className="space-y-1 text-[12px] text-stone-500">
                  {result.attempts.map((a, i) => (
                    <li key={i} className="flex gap-2"><span className="font-mono text-stone-300">{i + 1}.</span><span>{a}</span></li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={downloadPng}
                disabled={!result.previewPng}
                className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12.5px] font-medium text-stone-700 hover:border-stone-300 disabled:opacity-40"
              >
                <Download size={14} /> Export PNG
              </button>
              <button
                onClick={downloadSvg}
                disabled={!result.svg}
                className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12.5px] font-medium text-stone-700 hover:border-stone-300 disabled:opacity-40"
              >
                <Download size={14} /> Export SVG
              </button>
              {result.lock && (
                <a
                  href={result.lock.qrPngUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[12.5px] font-medium text-violet-700 hover:bg-violet-100"
                >
                  <ShieldCheck size={14} /> Print-locked asset
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
