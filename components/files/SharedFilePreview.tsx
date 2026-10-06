"use client";

// ShapesOS — Phase 18.2 (WS=content): the preview on a public share page
// (no annotations, no Office server preview — just what the bytes show).

import { FilePreview } from "./FilePreview";

export function SharedFilePreview({ src, mimeType, filename }: { src: string; mimeType: string; filename: string }) {
  return <FilePreview src={src} mimeType={mimeType} filename={filename} />;
}

export default SharedFilePreview;
