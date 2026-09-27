// Marketr — Phase 11 "Canvas": client-side background removal.
//
// Uses @imgly/background-removal (WASM/ONNX, runs 100% in the browser):
//   - $0, no API key, no account
//   - no image data ever leaves the device (private by construction)
//   - lazy-loaded so the editor bundle stays lean; the model (~tens of MB)
//     downloads once from the imgly CDN on first use and is then cached
//
// Non-destructive by contract: callers must stash the original src in
// element.custom.originalSrc before swapping in the cutout.

"use client";

export type BgRemovalProgress = (label: string, done: number, total: number) => void;

type BgLib = typeof import("@imgly/background-removal");

let loadPromise: Promise<BgLib> | null = null;
let loadSettled = false;

function loadLib(): Promise<BgLib> {
  if (!loadPromise) {
    // Dynamic import: keeps onnxruntime out of the editor's initial bundle.
    loadPromise = import("@imgly/background-removal").then(
      (lib) => {
        loadSettled = true;
        return lib;
      },
      (err) => {
        loadSettled = true;
        throw err;
      },
    );
  }
  return loadPromise;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not encode the cutout image."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Remove the background from an image (data URL or same-origin/ CORS-open URL).
 * Resolves to a PNG data URL with transparency. Throws with a human-readable
 * message on failure — callers surface it, never a fake result.
 */
export async function removeImageBackground(
  src: string,
  onProgress?: BgRemovalProgress,
): Promise<string> {
  let lib: BgLib;
  try {
    lib = await loadLib();
  } catch {
    throw new Error(
      "Could not load the background-removal engine. Check your connection and try again.",
    );
  }

  let input: Blob;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    input = await res.blob();
  } catch {
    throw new Error("Could not read that image for background removal.");
  }

  let cutout: Blob;
  try {
    cutout = await lib.removeBackground(input, {
      // Quantized model: much smaller first download, still clean cutouts.
      model: "isnet_quint8",
      output: { format: "image/png", quality: 1 },
      progress: (label: string, done: number, total: number) =>
        onProgress?.(label, done, total),
    });
  } catch {
    throw new Error(
      "Background removal failed on this image. Very small or unusual images sometimes don't work — try another.",
    );
  }

  return blobToDataUrl(cutout);
}

/** True once a load has been attempted and finished (success or failure). */
export function isBgEngineReady(): boolean {
  return loadSettled;
}
