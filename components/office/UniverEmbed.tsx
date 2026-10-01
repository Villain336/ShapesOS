// Marketr — Phase 14 slice 6: Univer editor embed (client-only).
//
// Manual plugin composition (no preset worker — the preset's worker.js ships
// bare imports that don't survive the Next.js build; formulas run on the
// main thread instead). Sheet + doc surfaces; slide defers to slice 9.
//
// Theming: the Univer theme's primary ramp is rebuilt at mount from the
// dashboard's computed --brand-* CSS vars, so the editor re-tints with the
// workspace brand kit. Never hardcodes a primary color.

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
import type { Theme } from "@univerjs/themes";
// Facade augmentations (createWorkbook/createDocument on FUniver) — same
// side-effect imports the presets use. Evaluated only in the browser: this
// module is loaded via next/dynamic { ssr: false }.
import "@univerjs/sheets/facade";
import "@univerjs/docs-ui/facade";

export interface UniverEmbedProps {
  kind: "sheet" | "doc" | "slide";
  /** Initial snapshot (IWorkbookData / IDocumentData / ISlideData). */
  snapshot: unknown;
  /** Called with the unit snapshot when the user clicks Save. */
  onSave?: (snapshot: unknown) => void | Promise<void>;
  height?: number;
}

type Phase = "loading" | "ready" | "error";

function brandTheme(defaultTheme: Theme): Theme {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const v = css.getPropertyValue(name).trim();
    return v || fallback;
  };
  // Defaults mirror app/globals.css (violet) so SSR/first paint matches.
  const b50 = read("--brand-50", "#f5f3ff");
  const b600 = read("--brand-600", "#7c3aed");
  const b700 = read("--brand-700", "#6d28d9");
  return {
    ...defaultTheme,
    primary: { ...defaultTheme.primary, 50: b50, 500: b600, 600: b600, 700: b700 },
  };
}

export default function UniverEmbed({ kind, snapshot, onSave, height = 560 }: UniverEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{
    dispose: () => void;
    save: () => unknown;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [saving, setSaving] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");

    (async () => {
      try {
        const core = await import("@univerjs/core");
        const themes = await import("@univerjs/themes");
        const sheetsLocale = await import("@univerjs/preset-sheets-core/locales/en-US");
        const docsLocale = await import("@univerjs/preset-docs-core/locales/en-US");
        const { Univer, LocaleType, UniverInstanceType } = core;
        const { UniverRenderEnginePlugin } = await import("@univerjs/engine-render");
        const { UniverUIPlugin } = await import("@univerjs/ui");
        const { UniverDocsPlugin } = await import("@univerjs/docs");
        const { UniverDocsUIPlugin } = await import("@univerjs/docs-ui");
        const { FUniver } = await import("@univerjs/core/facade");
        // Slides locale (raw OSS package ships its own; no preset exists).
        const slidesLocaleMod =
          kind === "slide" ? await import("@univerjs/slides-ui/locale/en-US") : null;
        const slidesLocale = (
          slidesLocaleMod ? (slidesLocaleMod.default ?? slidesLocaleMod) : {}
        ) as object;

        if (cancelled || !containerRef.current) return;

        const univer = new Univer({
          theme: brandTheme(themes.defaultTheme as Theme),
          locale: LocaleType.EN_US,
          locales: {
            enUS: {
              ...(sheetsLocale.default as object),
              ...(docsLocale.default as object),
              ...slidesLocale,
            },
          },
        });

        univer.registerPlugin(UniverRenderEnginePlugin);
        univer.registerPlugin(UniverUIPlugin, { container: containerRef.current });

        // Docs surface is registered in both modes (sheet cell notes need it).
        univer.registerPlugin(UniverDocsPlugin);
        univer.registerPlugin(UniverDocsUIPlugin);

        if (kind === "sheet") {
          const sheets = await import("@univerjs/sheets");
          const sheetsUI = await import("@univerjs/sheets-ui");
          const formulaEngine = await import("@univerjs/engine-formula");
          const sheetsFormula = await import("@univerjs/sheets-formula");
          const sheetsFormulaUI = await import("@univerjs/sheets-formula-ui");
          const sheetsNumfmt = await import("@univerjs/sheets-numfmt");
          const sheetsNumfmtUI = await import("@univerjs/sheets-numfmt-ui");
          univer.registerPlugin(sheets.UniverSheetsPlugin);
          univer.registerPlugin(sheetsUI.UniverSheetsUIPlugin);
          univer.registerPlugin(formulaEngine.UniverFormulaEnginePlugin);
          univer.registerPlugin(sheetsFormula.UniverSheetsFormulaPlugin);
          univer.registerPlugin(sheetsFormulaUI.UniverSheetsFormulaUIPlugin);
          univer.registerPlugin(sheetsNumfmt.UniverSheetsNumfmtPlugin);
          univer.registerPlugin(sheetsNumfmtUI.UniverSheetsNumfmtUIPlugin);
        }

        if (kind === "slide") {
          const slides = await import("@univerjs/slides");
          const slidesUI = await import("@univerjs/slides-ui");
          univer.registerPlugin(slides.UniverSlidesPlugin);
          univer.registerPlugin(slidesUI.UniverSlidesUIPlugin);
        }

        if (cancelled) {
          univer.dispose();
          return;
        }

        const univerAPI = FUniver.newAPI(univer);
        const data = snapshotRef.current as Record<string, unknown>;
        // Slides have no FUniver facade at 1.0.2 — create the unit directly
        // (makeCurrent defaults true) and snapshot it via the unit model.
        const slideUnit =
          kind === "slide"
            ? univer.createUnit(UniverInstanceType.UNIVER_SLIDE, data)
            : null;
        const unit =
          kind === "sheet"
            ? univerAPI.createWorkbook(data as never)
            : kind === "doc"
              ? univerAPI.createDocument(data as never)
              : null;

        apiRef.current = {
          dispose: () => univer.dispose(),
          save: () =>
            slideUnit
              ? (slideUnit as unknown as { getSnapshot: () => unknown }).getSnapshot()
              : (unit as { save: () => unknown }).save(),
        };
        setPhase("ready");
      } catch (err) {
        console.error("[univer] mount failed", err);
        if (!cancelled) setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      apiRef.current?.dispose();
      apiRef.current = null;
    };
    // Re-mount when the doc identity changes (parent keys by doc id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const handleSave = async () => {
    if (!apiRef.current || !onSave) return;
    setSaving(true);
    try {
      const snap = apiRef.current.save();
      await onSave(snap);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center justify-between border-b border-line bg-canvas px-3 py-2">
        <span className="text-sm font-medium text-muted">
          {kind === "sheet" ? "Spreadsheet" : kind === "doc" ? "Document" : "Slides"} — edits stay local until you save
        </span>
        {onSave && (
          <button
            type="button"
            onClick={handleSave}
            disabled={phase !== "ready" || saving}
            className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save to Marketr"}
          </button>
        )}
      </div>
      <div className="relative" style={{ height }}>
        <div ref={containerRef} className="h-full w-full" />
        {phase === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper/80">
            <Loader2 className="h-6 w-6 animate-spin text-subtle" />
          </div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-paper">
            <p className="text-sm text-muted">
              The editor failed to load. Check your connection and reload.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
