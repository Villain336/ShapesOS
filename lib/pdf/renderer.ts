// Marketr — PDF renderer adapter (milestone 12).
//
// Canonical renderer: Takumi (`takumi-pdf`), installed via the pdfcn shadcn
// registry (@pdfcn, pinned to github.com/shadcn-labs/pdfcn — the cpiprint
// fork is stale). Takumi renders a React element tree (pdfcn components +
// primitives) directly to PDF bytes: no headless browser, WASM-based so it
// runs anywhere Node runs.
//
// To swap the renderer later (e.g. Forme), replace this module's internals.
// All callers go through renderPdf() — nothing imports takumi-pdf directly.

import type { ReactElement } from "react";
import { render } from "takumi-pdf";

/** Render a pdfcn React element tree to PDF bytes. */
export async function renderPdf(element: ReactElement): Promise<Buffer> {
  const bytes = await render(element);
  return Buffer.from(bytes);
}

/** Which renderer backs renderPdf(). Surfaced for diagnostics / future swap. */
export const PDF_RENDERER_NAME = "takumi" as const;
