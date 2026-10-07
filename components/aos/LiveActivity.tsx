"use client";

// ShapesOS — live activity (kit: toasts-and-banners.png). A black counts pill
// (shape + number per state) and a black run strip: what is running now,
// its progress ("7 of 12"), a red stop button, and chips for anything else
// that needs attention ("Writer needs you", "Ops bot failed").

import Link from "next/link";
import { Square } from "lucide-react";
import { AOS_COLOR_STATUSES, type AosStatus, type StatusCounts } from "@/lib/aos/status";
import { progressFraction } from "@/lib/aos/run-steps";
import { cn } from "@/lib/utils";
// Phase 18.1 (integration): status words and captions in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";
import { StatusShape } from "./StatusShape";
// Phase 19A (WS=server): kit primary actions are cursor targets (lib/cursor/registry.ts).
import { cursorTarget } from "@/lib/cursor/registry";

export function LiveCounts({ counts, className }: { counts: StatusCounts; className?: string }) {
  const { t } = useI18n();
  const summary = AOS_COLOR_STATUSES.map((s) => `${counts[s]} ${t(`status.${s}`).toLowerCase()}`).join(", ");
  return (
    <div
      role="img"
      aria-label={summary}
      className={cn("aos-night inline-flex h-10 items-center gap-4 rounded-full px-4 text-sm font-semibold tabular-nums", className)}
    >
      {AOS_COLOR_STATUSES.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <StatusShape status={s} size={9} tone="night" live={false} />
          {counts[s]}
        </span>
      ))}
    </div>
  );
}

export interface LiveRun {
  title: string;
  subtitle?: string;
  status?: AosStatus;
  progress?: { done: number; total: number } | null;
  href?: string;
  onStop?: () => void;
  stopLabel?: string;
}

export interface LiveChip {
  key: string;
  status: AosStatus;
  label: string;
  href?: string;
}

export function LiveRunStrip({ run, chips = [], className }: { run: LiveRun; chips?: LiveChip[]; className?: string }) {
  const { t } = useI18n();
  const ofCaption = (done: number, total: number) => t("kit.of", { done: Math.max(0, Math.floor(done)), total: Math.max(0, Math.floor(total)) });
  const status = run.status ?? "running";
  const title = run.href ? (
    <Link href={run.href} className="hover:underline">
      {run.title}
    </Link>
  ) : (
    run.title
  );
  return (
    <div className={cn("aos-night w-full rounded-xl p-5 shadow-toast", className)}>
      <div className="flex items-center gap-3">
        <StatusShape status={status} size={9} tone="night" label={t(`status.${status}`)} className="self-start mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base leading-5 font-semibold text-paper">{title}</div>
          {run.subtitle ? <div className="truncate text-sm text-night-soft">{run.subtitle}</div> : null}
        </div>
        {run.progress ? <span className="shrink-0 text-sm text-night-soft tabular-nums">{ofCaption(run.progress.done, run.progress.total)}</span> : null}
        {run.onStop ? (
          <button
            type="button"
            onClick={run.onStop}
            {...cursorTarget("kit:live-run:stop", run.stopLabel ?? t("kit.stopRun"))}
            aria-label={run.stopLabel ?? t("kit.stopRun")}
            className="aos-press flex size-9 shrink-0 items-center justify-center rounded-full bg-failed text-paper"
          >
            <Square className="size-3 fill-current" aria-hidden />
          </button>
        ) : null}
      </div>
      {run.progress ? (
        <div
          className="mt-3 h-1 overflow-hidden rounded-full bg-night-raised"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={run.progress.total}
          aria-valuenow={run.progress.done}
          aria-label={`${run.title}: ${ofCaption(run.progress.done, run.progress.total)}`}
        >
          <div className="h-full rounded-full bg-running-night" style={{ width: `${progressFraction(run.progress.done, run.progress.total) * 100}%` }} />
        </div>
      ) : null}
      {chips.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => {
            const inner = (
              <>
                <StatusShape status={c.status} size={9} tone="night" live={false} />
                {c.label}
              </>
            );
            const cls =
              "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-paper shadow-[inset_0_0_0_1px_var(--aos-night-border)]";
            return c.href ? (
              <Link key={c.key} href={c.href} className={cn(cls, "hover:bg-night-hover")}>
                {inner}
              </Link>
            ) : (
              <span key={c.key} className={cls}>
                {inner}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Counts pill above the run strip, as in the kit. */
export function LiveActivity({
  counts,
  run,
  chips,
  className,
}: {
  counts: StatusCounts;
  run?: LiveRun | null;
  chips?: LiveChip[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-3", className)}>
      <LiveCounts counts={counts} />
      {run ? <LiveRunStrip run={run} chips={chips} /> : null}
    </div>
  );
}

export default LiveActivity;
