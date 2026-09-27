// Marketr — Phase 11 "Canvas": AI panel. Two draft-first tools:
//   1. Generate design — prompt → LLM → validated DesignDocument → appended
//      as a new page draft the human edits. The AI proposes, the human disposes.
//   2. Generate image — prompt → text-to-image → lands in the Uploads shelf,
//      never auto-placed on canvas.
//
// Both fail loudly when keys are missing — never a fake design or image.

"use client";

import { useState } from "react";
import { ImagePlus, Loader2, Sparkles } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { newAssetId, useSessionAssets } from "@/lib/design/assets";
import { AI_DESIGN_SIZES } from "@/lib/design/ai";
import type { DesignDocument } from "@/lib/design/types";
import { btnPrimary, inputCls, panelSectionLabel, panelTitle } from "../ui";

type Status = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string } | { kind: "ok"; message: string };

const IMAGE_SIZES = [
  { key: "square", label: "Square" },
  { key: "landscape", label: "Landscape" },
  { key: "portrait", label: "Portrait" },
] as const;

export function AiPanel() {
  const appendPages = useCanvasStore((s) => s.appendPages);
  const addAssets = useSessionAssets((s) => s.addAssets);

  const [designPrompt, setDesignPrompt] = useState("");
  const [designSize, setDesignSize] = useState<(typeof AI_DESIGN_SIZES)[number]>(AI_DESIGN_SIZES[0]!);
  const [designStatus, setDesignStatus] = useState<Status>({ kind: "idle" });

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageSize, setImageSize] = useState<(typeof IMAGE_SIZES)[number]["key"]>("square");
  const [imageStatus, setImageStatus] = useState<Status>({ kind: "idle" });

  const generateDesign = async () => {
    const prompt = designPrompt.trim();
    if (prompt.length < 3 || designStatus.kind === "busy") return;
    setDesignStatus({ kind: "busy", label: "Drafting your design…" });
    try {
      const res = await fetch("/api/studio/designs/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, width: designSize.width, height: designSize.height }),
      });
      const json = (await res.json()) as { document?: DesignDocument; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (!json.document) throw new Error("The AI returned no design.");
      appendPages(json.document.pages);
      setDesignPrompt("");
      setDesignStatus({ kind: "ok", message: "Draft added as a new page — make it yours." });
    } catch (e) {
      setDesignStatus({ kind: "error", message: e instanceof Error ? e.message : "Generation failed." });
    }
  };

  const generateImage = async () => {
    const prompt = imagePrompt.trim();
    if (prompt.length < 3 || imageStatus.kind === "busy") return;
    setImageStatus({ kind: "busy", label: "Painting your image…" });
    try {
      const res = await fetch("/api/studio/designs/generate-image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, size: imageSize }),
      });
      const json = (await res.json()) as {
        dataUrl?: string;
        width?: number;
        height?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (!json.dataUrl) throw new Error("The image service returned no image.");
      addAssets([
        {
          id: newAssetId("gen"),
          name: prompt.slice(0, 40) || "AI image",
          dataUrl: json.dataUrl,
          width: json.width ?? 1024,
          height: json.height ?? 1024,
          origin: "generated",
        },
      ]);
      setImagePrompt("");
      setImageStatus({ kind: "ok", message: "Image is in your Uploads — place it when ready." });
    } catch (e) {
      setImageStatus({ kind: "error", message: e instanceof Error ? e.message : "Generation failed." });
    }
  };

  const renderStatus = (s: Status) => {
    if (s.kind === "idle") return null;
    if (s.kind === "busy") {
      return (
        <p className="flex items-center gap-1.5 text-[12px] text-violet-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {s.label} This can take ~30 seconds.
        </p>
      );
    }
    return (
      <p
        className={`rounded-md border px-2.5 py-2 text-[12px] leading-snug ${
          s.kind === "error"
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}
      >
        {s.message}
      </p>
    );
  };

  return (
    <div>
      <div className={panelTitle}>AI assist</div>
      <div className="space-y-5 px-3 pb-4">
        {/* ── Generate design ─────────────────────────────────── */}
        <section>
          <div className={panelSectionLabel}>Generate design</div>
          <textarea
            value={designPrompt}
            onChange={(e) => setDesignPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. Instagram post announcing our spring sale — bold headline, warm colors"
            className={`${inputCls} w-full resize-none`}
          />
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {AI_DESIGN_SIZES.map((s) => (
              <button
                key={s.key}
                onClick={() => setDesignSize(s)}
                className={`rounded-md border px-2 py-1.5 text-left text-[11px] font-medium ${
                  designSize.key === s.key
                    ? "border-violet-600 bg-violet-50 text-violet-700"
                    : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void generateDesign()}
            disabled={designPrompt.trim().length < 3 || designStatus.kind === "busy"}
            className={`${btnPrimary} mt-2 w-full justify-center`}
          >
            <Sparkles className="h-4 w-4" />
            {designStatus.kind === "busy" ? "Drafting…" : "Generate design"}
          </button>
          <div className="mt-2">{renderStatus(designStatus)}</div>
          <p className="mt-1.5 text-[11px] leading-snug text-stone-400">
            The AI drafts a starting page — you refine every detail. Nothing is published automatically.
          </p>
        </section>

        {/* ── Generate image ──────────────────────────────────── */}
        <section className="border-t border-stone-100 pt-4">
          <div className={panelSectionLabel}>Generate image</div>
          <textarea
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            rows={2}
            placeholder="e.g. sunlit coffee shop interior, warm tones, no people"
            className={`${inputCls} w-full resize-none`}
          />
          <div className="mt-2 flex gap-1.5">
            {IMAGE_SIZES.map((s) => (
              <button
                key={s.key}
                onClick={() => setImageSize(s.key)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium ${
                  imageSize === s.key
                    ? "border-violet-600 bg-violet-50 text-violet-700"
                    : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void generateImage()}
            disabled={imagePrompt.trim().length < 3 || imageStatus.kind === "busy"}
            className={`${btnPrimary} mt-2 w-full justify-center`}
          >
            <ImagePlus className="h-4 w-4" />
            {imageStatus.kind === "busy" ? "Painting…" : "Generate image"}
          </button>
          <div className="mt-2">{renderStatus(imageStatus)}</div>
          <p className="mt-1.5 text-[11px] leading-snug text-stone-400">
            Uses your OpenAI image key (LLM_IMAGE_MODEL). Images land in Uploads — you place them.
          </p>
        </section>
      </div>
    </div>
  );
}
