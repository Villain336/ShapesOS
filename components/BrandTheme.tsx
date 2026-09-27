// Marketr — tenant-scoped brand theme root (Phase 13 Wave A).
//
// Wraps the dashboard shell. Applies the workspace's saved brand primary to
// --brand-600/700/50 on THIS element only, so a brand color can never leak
// across workspaces (a fresh server render per workspace supplies `primary`).
// Also listens for live-preview broadcasts from the brand-kits editor
// (lib/brand-theme.ts → previewBrandTheme), which temporarily override the
// saved brand while the user picks a color.

// "use client" is required: this component listens to window events.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { applyBrandTheme, BRAND_PREVIEW_EVENT } from "@/lib/brand-theme";

export function BrandTheme({ primary, children }: { primary: string | null; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Saved brand (per workspace) + live preview override, if any.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    applyBrandTheme(el, preview ?? primary);
  }, [preview, primary]);

  useEffect(() => {
    const onPreview = (e: Event) => setPreview((e as CustomEvent<string | null>).detail);
    window.addEventListener(BRAND_PREVIEW_EVENT, onPreview);
    return () => window.removeEventListener(BRAND_PREVIEW_EVENT, onPreview);
  }, []);

  return (
    <div ref={rootRef} className="min-h-screen bg-page font-sans text-ink">
      {children}
    </div>
  );
}
