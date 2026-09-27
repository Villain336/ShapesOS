// Marketr — Phase 11 "Canvas": QR matrix builder.
// Uses the `qrcode` package (davidshimjs, MIT — already a dependency) only for
// the error-correction math; rendering is done by QrNode.tsx as crisp Konva
// rects so canvas/PDF export stays sharp at any pixel ratio.

import { create } from "qrcode";

export const QR_QUIET_ZONE = 4; // modules of quiet zone on each side

export interface QrMatrix {
  /** Square boolean grid, quiet zone INCLUDED (true = dark module). */
  modules: boolean[][];
  /** Grid dimension (QR modules + 2 × quiet zone). */
  size: number;
  /** QR version that was required for the payload. */
  version: number;
}

/**
 * Build the module grid for a payload. Never throws: unencodable payloads
 * (shouldn't happen — the validator caps at 2048 chars) yield an empty grid
 * and the renderer shows a fallback.
 */
export function buildQrMatrix(payload: string): QrMatrix {
  try {
    if (!payload) return { modules: [], size: 0, version: 0 };
    const qr = create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const qz = QR_QUIET_ZONE;
    const size = n + qz * 2;
    const modules: boolean[][] = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => {
        const rr = r - qz;
        const cc = c - qz;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) return false;
        return qr.modules.get(rr, cc) === 1;
      }),
    );
    return { modules, size, version: qr.version };
  } catch {
    return { modules: [], size: 0, version: 0 };
  }
}
