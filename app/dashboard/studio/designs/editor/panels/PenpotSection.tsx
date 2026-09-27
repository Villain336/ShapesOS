// Marketr — Phase 12 "Reconsider trio": Penpot design-token import panel.
// Two honest paths: (1) live read of a Penpot file via the RPC API — needs
// PENPOT_BASE_URL + PENPOT_ACCESS_TOKEN (marked beta: Penpot's RPC API is an
// internal contract, not stable); (2) paste the Tokens-tab export
// (Tokens tab → Tools → Export in Penpot) — works with zero setup.
// Both produce the same kit-ready shape as Brandfetch and apply through the
// same /api/brand-kits endpoints. MPL-2.0 Penpot is never forked or merged
// into the Canvas — this HTTP bridge is the whole integration.

"use client";

import { useEffect, useState } from "react";
import { Check, ClipboardPaste, FileDigit, Loader2, PenTool, Settings, TriangleAlert } from "lucide-react";
import { btnGhost, btnPrimary, inputCls, panelSectionLabel } from "../ui";
import type { PenpotImport } from "@/lib/design/penpot";

interface PanelKit {
  id: string;
  name: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  metadata?: Record<string, unknown> | null;
}

export function PenpotSection({ kits, onKitsChanged }: { kits: PanelKit[]; onKitsChanged: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [betaNote, setBetaNote] = useState<string>("");
  const [mode, setMode] = useState<"file" | "paste">("paste");
  const [fileId, setFileId] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PenpotImport | null>(null);
  const [target, setTarget] = useState<string>("new");
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/studio/penpot/status");
        const json = (await res.json()) as { configured?: boolean; betaNote?: string };
        if (live) {
          setConfigured(res.ok && json.configured === true);
          setBetaNote(typeof json.betaNote === "string" ? json.betaNote : "");
          if (res.ok && json.configured === true) setMode("file");
        }
      } catch {
        if (live) setConfigured(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function runImport() {
    setBusy(true);
    setError(null);
    setResult(null);
    setDone(null);
    try {
      const res = await fetch("/api/studio/penpot/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "file" ? { mode: "api", fileId: fileId.trim() } : { mode: "paste", tokensJson: pasteText },
        ),
      });
      const json = (await res.json()) as PenpotImport & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Penpot import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!result || applying) return;
    setApplying(true);
    setError(null);
    setDone(null);
    try {
      const metadata = {
        source: "penpot",
        penpotSource: result.source,
        fileName: result.fileName ?? result.brand.name,
        fetchedAt: new Date().toISOString(),
      };
      const kitName =
        result.source === "penpot" && result.fileName
          ? result.fileName.slice(0, 120)
          : `Penpot tokens`;
      if (target === "new") {
        const res = await fetch("/api/brand-kits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: kitName,
            colors: result.kitColors,
            fonts: result.kitFonts,
            metadata,
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setDone(`Created a “${kitName}” brand kit from Penpot tokens.`);
      } else {
        const kit = kits.find((k) => k.id === target);
        if (!kit) throw new Error("Choose a brand kit first.");
        const res = await fetch(`/api/brand-kits/${target}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            colors: { ...(kit.colors ?? {}), ...result.kitColors },
            fonts: { ...(kit.fonts ?? {}), ...result.kitFonts },
            metadata: { ...(kit.metadata ?? {}), ...metadata },
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setDone(`Applied Penpot tokens to “${kit.name}”.`);
      }
      onKitsChanged();
      setResult(null);
      setFileId("");
      setPasteText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply to brand kit.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-2.5">
      <div className="flex items-center gap-1.5">
        <PenTool className="h-4 w-4 text-violet-600" />
        <span className="text-[13px] font-semibold text-stone-900">Import from Penpot</span>
      </div>
      <p className="pt-1 text-[11px] leading-snug text-stone-500">
        Pull a client's design tokens (colors, typography) from a Penpot file into a brand kit.
        No Penpot editor is embedded — this is a token bridge, nothing more.
      </p>

      {configured === null ? (
        <p className="flex items-center gap-1.5 pt-2 text-[12px] text-stone-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking Penpot setup…
        </p>
      ) : (
        <>
          {/* Mode toggle */}
          <div className="mt-2 flex gap-1">
            {(
              [
                { id: "paste", label: "Paste tokens JSON", icon: ClipboardPaste, enabled: true },
                { id: "file", label: "Live file read", icon: FileDigit, enabled: configured },
              ] as const
            ).map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => m.enabled && setMode(m.id)}
                  disabled={!m.enabled}
                  title={m.enabled ? undefined : "Needs PENPOT_BASE_URL + PENPOT_ACCESS_TOKEN"}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-medium disabled:opacity-40 ${
                    active
                      ? "border-violet-600 bg-violet-50 text-violet-700"
                      : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>

          {mode === "file" ? (
            <div className="flex gap-1.5 pt-2">
              <input
                value={fileId}
                onChange={(e) => setFileId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runImport();
                }}
                placeholder="Penpot file ID"
                className={`${inputCls} min-w-0 flex-1 font-mono`}
              />
              <button onClick={() => void runImport()} disabled={busy || !fileId.trim()} className={btnPrimary}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDigit className="h-4 w-4" />}
                Read
              </button>
            </div>
          ) : (
            <div className="pt-2">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='Paste the Tokens-tab export here (Tokens tab → Tools → Export in Penpot), e.g. { "sets": { "primitive/color": { … } } }'
                rows={3}
                className={`${inputCls} w-full font-mono text-[11px]`}
              />
              <div className="flex justify-end pt-1.5">
                <button onClick={() => void runImport()} disabled={busy || !pasteText.trim()} className={btnPrimary}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardPaste className="h-4 w-4" />}
                  Parse tokens
                </button>
              </div>
            </div>
          )}

          {!configured && (
            <div className="mt-2 rounded-md border border-stone-200 bg-stone-50 px-2.5 py-2">
              <p className="text-[12px] font-medium text-stone-800">Live file read is off</p>
              <p className="pt-0.5 text-[11px] leading-snug text-stone-500">
                Add PENPOT_BASE_URL + PENPOT_ACCESS_TOKEN in Settings → Providers to read files
                live. The paste path works with no setup.
              </p>
              <a href="/dashboard/settings/providers" className={`${btnGhost} mt-2 inline-flex`}>
                <Settings className="h-4 w-4" />
                Open Providers
              </a>
            </div>
          )}
          {configured && betaNote && (
            <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-stone-500">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {betaNote}
            </p>
          )}

          {error && (
            <p className="mt-2 rounded-md border border-stone-200 bg-stone-50 px-2.5 py-2 text-[12px] text-stone-600">
              {error}
            </p>
          )}

          {result && (
            <div className="mt-2 rounded-md border border-stone-200 p-2.5">
              <p className="truncate text-[13px] font-semibold text-stone-900">{result.brand.name}</p>
              <p className="truncate font-mono text-[11px] text-stone-500">
                {result.source === "penpot" ? `Penpot file · ${result.brand.domain}` : "Pasted tokens export"}
              </p>
              {Object.keys(result.kitColors).length > 0 && (
                <div className="pt-2">
                  <div className={panelSectionLabel}>Palette — from Penpot</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(result.kitColors).map(([key, color]) => (
                      <span
                        key={key}
                        title={`${key}: ${color}`}
                        className="h-8 w-8 rounded-md border border-stone-200"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(result.kitFonts).length > 0 && (
                <div className="pt-2">
                  <div className={panelSectionLabel}>Fonts — from Penpot</div>
                  <ul className="space-y-0.5">
                    {Object.entries(result.kitFonts).map(([key, font]) => (
                      <li key={key} className="text-[12px] text-stone-600">
                        <span className="capitalize text-stone-400">{key}:</span>{" "}
                        <span style={{ fontFamily: font }}>{font}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-1.5 pt-2">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className={`${inputCls} min-w-0 flex-1`}
                >
                  <option value="new">New brand kit</option>
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
                <button onClick={() => void apply()} disabled={applying} className={btnPrimary}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Apply to brand kit
                </button>
              </div>
            </div>
          )}
          {done && <p className="pt-1.5 text-[11px] font-medium text-violet-700">{done}</p>}
        </>
      )}
    </div>
  );
}
