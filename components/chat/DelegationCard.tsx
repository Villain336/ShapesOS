"use client";

// ShapesOS — Phase 16: the chat's "Working with N sub-agents" card.
//
// Hangs under the lead's message that started a delegation plan. Compact by
// default (who is working, "2 of 4 done", the plan's state shape); expands to
// every sub-agent with its state — the same rows the run page shows. It
// polls the plan (GET /api/agent-runs/[runId]/delegation) while the lead is
// working or waiting, and reloads the thread once when the lead has answered
// (or listed sub-agents' actions for the user's OK).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Users } from "lucide-react";
import { DelegationPlan } from "@/components/aos/DelegationPlan";
import { StatusShape } from "@/components/aos/StatusShape";
import { viewProgress, type DelegationView } from "@/lib/aos/delegation";
import { AGENT_ACTIVITY_CHANGED_EVENT } from "@/lib/aos/events";
import { progressLine } from "@/lib/agents/delegation/plan";
import { statusLabel, type AosStatus } from "@/lib/aos/status";
import { cn } from "@/lib/utils";
import { useOptionalChat } from "./ChatContext";

const POLL_MS = 2_000;

function overall(view: DelegationView | null): AosStatus {
  if (!view) return "running";
  if (view.runStatus === "awaiting_confirmation") return "needs";
  if (view.live) return "running";
  if (view.runStatus === "failed") return "failed";
  return "done";
}

export function DelegationCard({ runId, planId, tasks, goal }: { runId: string; planId: string; tasks: number; goal: string }) {
  const chat = useOptionalChat();
  const [view, setView] = useState<DelegationView | null>(null);
  const [open, setOpen] = useState(false);
  const refreshed = useRef(false);
  const wasLive = useRef<boolean | null>(null);
  const lastProgress = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/delegation`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as DelegationView;
        if (stop) return;
        setView(next);
        const settled = !next.live || next.runStatus === "awaiting_confirmation";
        // Tell the sidebar's agent tree when a sub-agent starts, finishes or the plan settles.
        const progress = `${progressLine(viewProgress(next))}|${next.runStatus}|${settled}`;
        if (lastProgress.current !== null && lastProgress.current !== progress) window.dispatchEvent(new Event(AGENT_ACTIVITY_CHANGED_EVENT));
        lastProgress.current = progress;
        // The lead answered (or asks for the user's OK): show its message.
        if (settled && wasLive.current && !refreshed.current && chat?.activeId) {
          refreshed.current = true;
          void chat.openThread(chat.activeId);
        }
        wasLive.current = !settled;
        if (!settled) timer = setTimeout(load, POLL_MS);
      } catch {
        if (!stop) timer = setTimeout(load, POLL_MS * 2);
      }
    };
    void load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll per plan; the chat handle is read when settling
  }, [runId, planId]);

  const plan = view?.plans.find((p) => p.planId === planId) ?? null;
  const n = plan?.tasks.length ?? tasks;
  const status = overall(view);
  const done = plan ? progressLine(plan.progress) : view ? progressLine(viewProgress(view)) : `0 of ${n} sub-agents done`;
  return (
    <div className="mt-2 overflow-hidden rounded-lg bg-paper shadow-hairline">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-[background-color] duration-150 hover:bg-hover-paper"
      >
        <Users className="size-4 shrink-0 text-ink" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-md font-semibold text-ink">
            Working with {n} sub-agent{n === 1 ? "" : "s"}
          </span>
          <span className="block truncate text-sm text-muted">
            {done} · {goal}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink">
          <StatusShape status={status} size={9} />
          {statusLabel(status)}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="border-t border-line px-4 pb-2">
          {plan ? <DelegationPlan plan={plan} variant="list" /> : <p className="py-3 text-sm text-muted">Loading the plan…</p>}
          <div className="flex justify-end py-2">
            <Link href={`/dashboard/runs/${runId}`} className="text-sm font-semibold text-ink underline-offset-4 hover:underline">
              Open the run
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DelegationCard;
