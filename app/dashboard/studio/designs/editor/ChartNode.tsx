// Marketr — Phase 11 "Canvas": Konva renderer for chart elements.
// Hand-rolled shapes (no chart lib) so the bundle stays light and
// stage.toDataURL() export stays pixel-perfect vector at any pixel ratio.

"use client";

import {
  Circle,
  Group,
  Line as KLine,
  Rect,
  Text as KText,
  Wedge,
} from "react-konva";
import type { ChartElement } from "@/lib/design/types";
import {
  barModel,
  chartSize,
  formatChartValue,
  lineModel,
  pieLayout,
  pieSlices,
  truncateLabel,
  withAlpha,
  type BarModel,
  type LineModel,
} from "@/lib/design/chart-math";

const FONT = "Inter";
// Legit literal hex: this draws the user's design document on a Konva canvas
// that is exported to PNG/PDF (canvas can't resolve CSS vars), not UI chrome.
const GRID = "#eceae6";
const BASELINE = "#d8d4cf";
const TICK_FILL = "#a8a29e";
const LABEL_FILL = "#78716c";
const VALUE_FILL = "#44403c";

interface NodeProps {
  el: ChartElement;
  /** Same spread pattern as the other ElementNode renderers (drag, select…). */
  common: Record<string, unknown>;
}

export function ChartNode({ el, common }: NodeProps) {
  const { w, h } = chartSize(el);
  return (
    <Group {...(common as object)}>
      <Rect
        width={w}
        height={h}
        fill="#ffffff"
        stroke="#e7e5e4"
        strokeWidth={1}
        cornerRadius={12}
        shadowColor="rgba(28,25,23,0.08)"
        shadowBlur={14}
        shadowOffsetY={3}
      />
      {el.chartType === "bar" && <BarChart el={el} w={w} h={h} />}
      {el.chartType === "line" && <LineChart el={el} w={w} h={h} />}
      {el.chartType === "pie" && <PieChart el={el} w={w} h={h} />}
    </Group>
  );
}

function Gridlines({ model }: { model: BarModel | LineModel }) {
  return (
    <Group>
      {model.ticks.map((t, i) => (
        <Group key={i}>
          <KLine
            points={[model.plot.x, t.y, model.plot.x + model.plot.w, t.y]}
            stroke={t.value === 0 ? BASELINE : GRID}
            strokeWidth={1}
          />
          <KText
            x={model.plot.x - 44}
            y={t.y - 7}
            width={38}
            align="right"
            text={formatChartValue(t.value)}
            fontSize={11}
            fontFamily={FONT}
            fill={TICK_FILL}
          />
        </Group>
      ))}
    </Group>
  );
}

function BarChart({ el, w, h }: { el: ChartElement; w: number; h: number }) {
  const m = barModel(el.labels, el.values, el.colors, w, h);
  return (
    <Group>
      <Gridlines model={m} />
      {m.bars.map((b, i) => (
        <Group key={i}>
          <Rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={b.color}
            cornerRadius={b.value >= 0 ? [6, 6, 0, 0] : [0, 0, 6, 6]}
          />
          {el.showValues && (
            <KText
              x={b.cx - 40}
              y={b.labelY}
              width={80}
              align="center"
              text={formatChartValue(b.value)}
              fontSize={12}
              fontStyle="600"
              fontFamily={FONT}
              fill={VALUE_FILL}
            />
          )}
          {i % m.labelStep === 0 && (
            <KText
              x={b.cx - 40}
              y={m.plot.y + m.plot.h + 8}
              width={80}
              align="center"
              text={truncateLabel(b.label, 12)}
              fontSize={11}
              fontFamily={FONT}
              fill={LABEL_FILL}
            />
          )}
        </Group>
      ))}
    </Group>
  );
}

function LineChart({ el, w, h }: { el: ChartElement; w: number; h: number }) {
  const m = lineModel(el.labels, el.values, el.colors, w, h);
  return (
    <Group>
      <Gridlines model={m} />
      {m.areaPoints.length > 3 && (
        <KLine
          points={m.areaPoints}
          closed
          fill={withAlpha(m.color, 0.12)}
          strokeWidth={0}
        />
      )}
      {m.points.length > 1 && (
        <KLine
          points={m.points}
          stroke={m.color}
          strokeWidth={3}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
        />
      )}
      {m.dots.map((d, i) => (
        <Group key={i}>
          <Circle x={d.x} y={d.y} radius={5.5} fill="#ffffff" stroke={d.color} strokeWidth={3} />
          {el.showValues && (
            <KText
              x={d.x - 40}
              y={d.y - 26}
              width={80}
              align="center"
              text={formatChartValue(d.value)}
              fontSize={12}
              fontStyle="600"
              fontFamily={FONT}
              fill={VALUE_FILL}
            />
          )}
        </Group>
      ))}
      {m.categories.map(
        (c, i) =>
          i % (m.categories.length > 12 ? 2 : 1) === 0 && (
            <KText
              key={i}
              x={c.x - 40}
              y={m.plot.y + m.plot.h + 8}
              width={80}
              align="center"
              text={truncateLabel(c.label, 12)}
              fontSize={11}
              fontFamily={FONT}
              fill={LABEL_FILL}
            />
          ),
      )}
    </Group>
  );
}

function PieChart({ el, w, h }: { el: ChartElement; w: number; h: number }) {
  const slices = pieSlices(el.labels, el.values, el.colors);
  const L = pieLayout(w, h, slices.length);
  return (
    <Group>
      {slices.map(
        (s, i) =>
          s.sweepDeg > 0 && (
            <Wedge
              key={i}
              x={L.cx}
              y={L.cy}
              radius={L.r}
              angle={s.sweepDeg}
              rotation={s.startDeg}
              fill={s.color}
              stroke="#ffffff"
              strokeWidth={2}
            />
          ),
      )}
      {slices.map((s, i) => {
        if (s.fraction < 0.06) return null;
        const mid = ((s.startDeg + s.sweepDeg / 2) * Math.PI) / 180;
        const px = L.cx + Math.cos(mid) * L.r * 0.62;
        const py = L.cy + Math.sin(mid) * L.r * 0.62;
        return (
          <KText
            key={`pct-${i}`}
            x={px - 30}
            y={py - 8}
            width={60}
            align="center"
            text={`${Math.round(s.fraction * 100)}%`}
            fontSize={11}
            fontStyle="600"
            fontFamily={FONT}
            fill="#ffffff"
            shadowColor="rgba(0,0,0,0.3)"
            shadowBlur={3}
          />
        );
      })}
      {slices.map((s, i) => {
        const y = 44 + i * L.rowH;
        return (
          <Group key={`leg-${i}`}>
            <Circle x={L.legendX + 6} y={y + 7} radius={5} fill={s.color} />
            <KText
              x={L.legendX + 18}
              y={y}
              width={Math.max(40, L.legendW - 84)}
              text={truncateLabel(s.label, 16)}
              fontSize={12}
              fontFamily={FONT}
              fill={VALUE_FILL}
              ellipsis
            />
            <KText
              x={L.legendX + L.legendW - 60}
              y={y}
              width={56}
              align="right"
              text={formatChartValue(s.value)}
              fontSize={12}
              fontFamily={FONT}
              fill={LABEL_FILL}
            />
          </Group>
        );
      })}
    </Group>
  );
}
