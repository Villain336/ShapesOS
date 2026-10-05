// Marketr — Phase 16 slice 7: live watch client component.
//
// "Watch live" surface for a running agent run: opens an EventSource to the
// slice-7 SSE endpoint and paints the transient CDP-screencast JPEG frames
// as they arrive (latest-wins — a slow tab skips to the newest frame).
// Rendered by the run viewer ONLY while the run is running; finished runs
// never mount this component (the WebM below is the permanent record).

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Radio, VideoOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/aos/StatusBadge";

type WatchState = "connecting" | "live" | "unavailable" | "ended";

// The live dot IS a running agent state: blue circle, pulses while live.
function LiveDot() {
  return (
    <span
      className="aos-shape aos-shape--running aos-is-live"
      style={{ color: "inherit" }}
      aria-hidden
    />
  );
}

export function LiveWatch({ runId }: { runId: string }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState("running");
  const [state, setState] = useState<WatchState>("connecting");
  const [endReason, setEndReason] = useState<string | null>(null);
  const stateRef = useRef<WatchState>("connecting");
  stateRef.current = state;

  useEffect(() => {
    const es = new EventSource(`/api/agent-runs/${encodeURIComponent(runId)}/watch`);

    const onFrame = (e: Event) => {
      setFrame(`data:image/jpeg;base64,${(e as MessageEvent).data}`);
      setState("live");
    };
    const onStatus = (e: Event) => {
      try {
        setStatus(JSON.parse((e as MessageEvent).data).status as string);
      } catch {
        // Malformed status payload — keep the last known status.
      }
    };
    const onEnd = (e: Event) => {
      try {
        setEndReason((JSON.parse((e as MessageEvent).data).reason as string) ?? null);
      } catch {
        setEndReason(null);
      }
      setState("ended");
      es.close();
    };
    const onError = () => {
      // A failure before the first frame means no stream exists (404);
      // a failure mid-stream means the connection dropped.
      setState(stateRef.current === "connecting" ? "unavailable" : "ended");
      es.close();
    };

    es.addEventListener("frame", onFrame);
    es.addEventListener("status", onStatus);
    es.addEventListener("end", onEnd);
    es.onerror = onError;
    return () => es.close();
  }, [runId]);

  return (
    <section className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <div>
          <h2 className="aos-subheading">Watch live</h2>
          <p className="mt-0.5 text-sm text-muted">
            Real-time view of the agent's browser — frames are transient
          </p>
        </div>
        <span className="flex items-center gap-2">
          {state === "live" ? (
            <StatusBadge status="running" label="Live" />
          ) : (
            <span className="inline-flex h-badge items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
              <Radio className="size-3.5" aria-hidden />
              {state === "ended" ? "Ended" : status}
            </span>
          )}
        </span>
      </div>
      {state === "unavailable" ? (
        // No stream for this run: one quiet line, not an empty black frame.
        <p className="flex items-center gap-2 px-5 py-4 text-md text-muted">
          <VideoOff className="size-4 shrink-0" aria-hidden />
          Live watch isn&apos;t available for this run. The full recording appears when it finishes.
        </p>
      ) : (
      <div className="flex flex-col gap-3 p-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
          {frame && (state === "live" || state === "ended") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={frame}
              alt="Live view of the agent's browser"
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-subtle">
              {state === "connecting" ? (
                <>
                  <Loader2 className="size-6 aos-spin" />
                  <p className="text-sm">Connecting to the live stream…</p>
                </>
              ) : (
                <>
                  <VideoOff className="size-6" />
                  <p className="max-w-md px-6 text-center text-sm">
                    {endReason === "run-finished"
                      ? "Run finished. The full recording is in Recording."
                      : "The live stream ended. The full recording is in Recording."}
                  </p>
                </>
              )}
            </div>
          )}
          {state === "live" && (
            <span
              className={cn(
                "absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1",
                "bg-black/60 text-xs font-semibold text-white",
              )}
            >
              <LiveDot />
              Live
            </span>
          )}
        </div>
        <p className="text-sm text-muted">
          Frames stream in real time and are never stored. The recorded video is the permanent record of this run.
        </p>
      </div>
      )}
    </section>
  );
}
