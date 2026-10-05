// Marketr — Phase 11 "Canvas": Konva renderer for QR elements.
// The matrix comes from lib/design/qr.ts; every dark module is drawn as a
// Konva Rect (runs merged per row to keep node count low), so canvas/PDF
// export stays razor sharp — never a scaled bitmap.

"use client";

import { useMemo } from "react";
import { Group, Rect, Text as KText } from "react-konva";
import type { QrElement } from "@/lib/design/types";
import { buildQrMatrix } from "@/lib/design/qr";

interface NodeProps {
  el: QrElement;
  /** Same spread pattern as the other ElementNode renderers (drag, select…). */
  common: Record<string, unknown>;
}

export function QrNode({ el, common }: NodeProps) {
  const matrix = useMemo(() => buildQrMatrix(el.payload), [el.payload]);
  const size = Math.max(48, el.size);

  if (matrix.size === 0) {
    // Konva paints to a <canvas> (and into exported PNG/PDF), which can't
    // resolve CSS variables — literal values mirror --aos-line / --aos-text-subtle.
    return (
      <Group {...(common as object)}>
        <Rect width={size} height={size} fill={el.background} stroke="#E2E2DF" />
        <KText
          x={8}
          y={size / 2 - 8}
          width={size - 16}
          align="center"
          text="QR unavailable"
          fontSize={12}
          fontFamily="Inter"
          fill="#76766F"
        />
      </Group>
    );
  }

  const mod = size / matrix.size;
  const runs: React.ReactNode[] = [];
  matrix.modules.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let c2 = c;
      while (c2 + 1 < row.length && row[c2 + 1]) c2 += 1;
      // +0.6px overlap hides hairline seams between adjacent modules.
      runs.push(
        <Rect
          key={`${r}-${c}`}
          x={c * mod}
          y={r * mod}
          width={(c2 - c + 1) * mod + 0.6}
          height={mod + 0.6}
          fill={el.foreground}
        />,
      );
      c = c2 + 1;
    }
  });

  return (
    <Group {...(common as object)}>
      <Rect width={size} height={size} fill={el.background} cornerRadius={6} />
      <Group>{runs}</Group>
    </Group>
  );
}
