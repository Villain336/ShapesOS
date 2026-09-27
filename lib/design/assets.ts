// Marketr — Phase 11 "Canvas": session asset library.
// Uploads and AI-generated images live here (browser session only) so both
// the Uploads panel and the AI panel read/write the same shelf. Generated
// images land here and are NEVER auto-placed — the user puts them on canvas.

import { create } from "zustand";

export interface SessionAsset {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  origin: "upload" | "generated";
}

interface AssetsState {
  assets: SessionAsset[];
  addAssets: (assets: SessionAsset[]) => void;
  removeAsset: (id: string) => void;
  clear: () => void;
}

export const useSessionAssets = create<AssetsState>()((set) => ({
  assets: [],
  addAssets: (assets) => set((s) => ({ assets: [...assets, ...s.assets] })),
  removeAsset: (id) => set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  clear: () => set({ assets: [] }),
}));

let assetCounter = 0;
export function newAssetId(prefix: string): string {
  assetCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${assetCounter.toString(36)}`;
}

/** Decode natural dimensions of a data-URL image. Rejects on bad data. */
export function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = dataUrl;
  });
}
