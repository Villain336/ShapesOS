// Marketr — Phase 12 (Worker 1): GrapesJS page editor (landing pages + email
// templates). Client-only: grapesjs is dynamically imported so it never runs
// during SSR. Complementary to the Konva Canvas editor — Canvas makes PNG/SVG
// assets, this makes responsive HTML documents.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Monitor,
  Save,
  Smartphone,
  Tablet,
  TriangleAlert,
} from "lucide-react";
import "grapesjs/dist/css/grapes.min.css";
import type { Editor } from "grapesjs";
import { api } from "../api";
import { applyBrand, getGrapesTemplate, type BrandPalette } from "@/lib/grapes/templates";

interface PageDraftFull {
  id: string;
  name: string;
  kind: string;
  templateKey: string | null;
  html: string | null;
  css: string | null;
  components: unknown;
}

interface BrandDefaults {
  colors: { primary?: string; secondary?: string; accent?: string; text?: string };
  fonts: { heading?: string; body?: string };
}

const btnPrimary =
  "flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-white aos-press disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[13px] font-medium text-ink shadow-outline hover:bg-hover-paper disabled:opacity-40";
const btnIconActive = "bg-ink text-white";
const btnIconIdle = "text-subtle hover:bg-hover-paper";

function buildDocument(editor: Editor, isEmail: boolean): string {
  if (isEmail) {
    try {
      const inlined = editor.runCommand("gjs-get-inlined-html") as unknown;
      if (typeof inlined === "string" && inlined.trim()) return inlined;
    } catch {
      // fall through to the plain export
    }
  }
  const css = editor.getCss();
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShapesOS page</title>
<style>${css}</style>
</head>
<body>
${editor.getHtml()}
</body>
</html>`;
}

export function GrapesEditor({ pageId }: { pageId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [name, setName] = useState("Untitled page");
  const [kind, setKind] = useState("landing");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [device, setDevice] = useState("Desktop");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let editor: Editor | null = null;

    async function boot() {
      try {
        const [{ page }, { defaults }] = await Promise.all([
          api<{ page: PageDraftFull }>(`/api/studio/pages/${pageId}`),
          api<{ defaults: BrandDefaults | null }>("/api/studio/brandkit/defaults").catch(() => ({
            defaults: null as BrandDefaults | null,
          })),
        ]);
        if (cancelled) return;
        setName(page.name);
        setKind(page.kind);

        const grapesjs = (await import("grapesjs")).default;
        if (cancelled) return;
        const isEmail = page.kind === "email";
        let newsletter: ((editor: Editor, opts?: unknown) => void) | null = null;
        if (isEmail) {
          newsletter = (await import("grapesjs-preset-newsletter")).default as (
            editor: Editor,
            opts?: unknown,
          ) => void;
        }
        if (cancelled || !hostRef.current) return;

        editor = grapesjs.init({
          container: hostRef.current,
          height: "100%",
          width: "auto",
          storageManager: false,
          plugins: newsletter ? [newsletter] : [],
          canvas: { styles: [], scripts: [] },
        });
        editorRef.current = editor;

        // Seed content: saved project data wins; otherwise the seed template
        // with the tenant's brand colors/fonts substituted in.
        if (page.components && typeof page.components === "object") {
          editor.loadProjectData(page.components as never);
        } else if (page.templateKey) {
          const tpl = getGrapesTemplate(page.templateKey);
          if (tpl) {
            const brand: Partial<BrandPalette> = {};
            if (defaults?.colors?.primary) brand.primary = defaults.colors.primary;
            if (defaults?.colors?.secondary) brand.secondary = defaults.colors.secondary;
            if (defaults?.colors?.accent) brand.accent = defaults.colors.accent;
            if (defaults?.colors?.text) brand.text = defaults.colors.text;
            if (defaults?.fonts?.heading) brand.headingFont = defaults.fonts.heading;
            if (defaults?.fonts?.body) brand.bodyFont = defaults.fonts.body;
            const { html, css } = applyBrand(tpl.html, tpl.css, brand);
            editor.setComponents(html);
            editor.setStyle(css);
          }
        }

        // Brand-kit hook: default the canvas body font to the brand body font.
        if (defaults?.fonts?.body) {
          const body = editor.Canvas.getBody();
          if (body) body.style.fontFamily = defaults.fonts.body;
        }

        editor.on("update", () => setDirty(true));
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the editor.");
      }
    }

    void boot();
    return () => {
      cancelled = true;
      if (editor) {
        editor.destroy();
        editorRef.current = null;
      }
    };
  }, [pageId]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ page: { id: string; updatedAt: string } }>(`/api/studio/pages/${pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          html: editor.getHtml(),
          css: editor.getCss(),
          components: editor.getProjectData(),
        }),
      });
      setSavedAt(new Date(r.page.updatedAt).toLocaleTimeString());
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [pageId, saving]);

  const togglePreview = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (previewing) editor.stopCommand("preview");
    else editor.runCommand("preview");
    setPreviewing((p) => !p);
  }, [previewing]);

  const setDeviceMode = useCallback((d: string) => {
    editorRef.current?.setDevice(d);
    setDevice(d);
  }, []);

  const exportHtml = useCallback(
    (mode: "download" | "copy") => {
      const editor = editorRef.current;
      if (!editor) return;
      const doc = buildDocument(editor, kind === "email");
      if (mode === "download") {
        const blob = new Blob([doc], { type: "text/html" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "page"}.html`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        navigator.clipboard
          .writeText(doc)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => setError("Clipboard write failed — your browser blocked it."));
      }
    },
    [kind, name],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar — Marketr house chrome over the GrapesJS surface */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-paper px-3 py-2">
        <Link
          href="/dashboard/studio"
          className="flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink"
        >
          <ArrowLeft size={14} /> Pages
        </Link>
        <span className="text-subtle">/</span>
        <span className="max-w-56 truncate text-[13px] font-semibold text-ink">{name}</span>
        <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[10px] font-medium text-muted">
          {kind === "email" ? "Email" : "Landing page"}
        </span>
        {dirty && !saving && <span className="text-[12px] text-subtle">Unsaved changes</span>}
        {savedAt && !dirty && (
          <span className="flex items-center gap-1 text-[12px] text-muted">
            <Check size={12} /> Saved {savedAt}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="mr-1 flex items-center gap-0.5 rounded-md border border-line bg-canvas p-0.5">
            {[
              { id: "Desktop", icon: Monitor, label: "Desktop" },
              { id: "Tablet", icon: Tablet, label: "Tablet" },
              { id: "Mobile", icon: Smartphone, label: "Mobile" },
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setDeviceMode(id)}
                disabled={!ready}
                title={label}
                aria-label={label}
                className={`rounded p-1.5 ${device === id ? btnIconActive : btnIconIdle} disabled:opacity-40`}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <button onClick={togglePreview} disabled={!ready} className={btnGhost} title="Toggle preview">
            {previewing ? <EyeOff size={14} /> : <Eye size={14} />}
            {previewing ? "Edit" : "Preview"}
          </button>
          <button onClick={() => exportHtml("copy")} disabled={!ready} className={btnGhost} title="Copy HTML to clipboard">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy HTML"}
          </button>
          <button onClick={() => exportHtml("download")} disabled={!ready} className={btnGhost} title="Download as .html">
            <Download size={14} /> Export HTML
          </button>
          <button onClick={save} disabled={!ready || saving} className={btnPrimary}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save draft
          </button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-canvas">
        {!ready && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-canvas text-[13px] text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading page builder…
          </div>
        )}
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
