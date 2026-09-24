// Marketr CRM — visual primitives: StageBadge, ScoreBar, Sparkline, Avatar.
"use client";

import { UsersThree, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import { initials } from "./types";

export function StageBadge({ label, color }: { label: string; color: string }) {
  return <span className={`crm-chip crm-chip-${color}`}>{label}</span>;
}

/** Segmented 5-bar score indicator (reference: multi-segment win-probability bar). */
export function ScoreBar({ score, showNumber = true }: { score: number; showNumber?: boolean }) {
  const filled = Math.round(score / 20);
  const band = score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
  const fillColor =
    band === "hot" ? "#16a34a" : band === "warm" ? "#d97706" : "#7c3aed";
  return (
    <span className="inline-flex items-center gap-2">
      {showNumber && (
        <span className="text-[13px] font-semibold text-stone-800 tabular-nums w-7">{score}</span>
      )}
      <span className="inline-flex gap-[3px]" title={`Score ${score} (${band})`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="h-[6px] w-[14px] rounded-full"
            style={{ background: i < filled ? fillColor : "#e7e5e4" }}
          />
        ))}
      </span>
    </span>
  );
}

/** Mini activity sparkline (8 weekly buckets). */
export function Sparkline({ data, width = 72, height = 24 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...data);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 4) - 2}`)
    .join(" ");
  const last = data[data.length - 1] ?? 0;
  const first = data[0] ?? 0;
  const up = last >= first;
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "#16a34a" : "#b45309"}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.map((v, i) =>
        v > 0 ? (
          <circle
            key={i}
            cx={(i / (data.length - 1)) * width}
            cy={height - (v / max) * (height - 4) - 2}
            r="1.6"
            fill={up ? "#16a34a" : "#b45309"}
          />
        ) : null,
      )}
    </svg>
  );
}

/** Mini bar chart (slide-over activity trend). */
export function MiniBars({ data, width = 220, height = 56 }: { data: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...data);
  const bw = width / data.length;
  return (
    <svg width={width} height={height} aria-hidden>
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 8));
        return (
          <rect
            key={i}
            x={i * bw + 2}
            y={height - h}
            width={bw - 4}
            height={h}
            rx={2}
            fill={i === data.length - 1 ? "#7c3aed" : "#ddd6fe"}
          />
        );
      })}
    </svg>
  );
}

const AVATAR_COLORS = ["#7c3aed", "#0e7c66", "#1d4ed8", "#b45309", "#be123c", "#0f766e"];

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.38 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  icon: Icon = UsersThree,
}: {
  title: string;
  hint: string;
  icon?: PhosphorIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
        <Icon size={22} weight="duotone" />
      </div>
      <p className="text-sm font-semibold text-stone-800">{title}</p>
      <p className="mt-1 max-w-xs text-[13px] text-stone-500">{hint}</p>
    </div>
  );
}
