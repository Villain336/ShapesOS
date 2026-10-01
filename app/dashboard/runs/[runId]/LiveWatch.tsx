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
    <section className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="aos-subheading">Watch live</h2>
          <p className="mt-0.5 text-sm text-muted">
            Real-time view of the agent's browser — frames are transient
          </p>
        </div>
        <span className="flex items-center gap-2">
          {state === "live" ? (
            <span className="inline-flex h-badge items-center gap-1.5 rounded-full bg-running px-3 text-sm font-semibold text-white">
              <LiveDot />
              Live
            </span>
          ) : (
            <span className="inline-flex h-badge items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
              <Radio className="size-3.5" aria-hidden />
              {state === "ended" ? "Ended" : status}
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
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
                    {state === "unavailable"
                      ? "Live watch isn't available for this run — the full recording appears below when it finishes."
                      : endReason === "run-finished"
                        ? "Run finished — the full recording is below."
                        : "The live stream ended — the full recording is below."}
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
        <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-muted">
          Frames stream in real time and are never stored — the recorded video below is the
          permanent record of this run.
        </p>
      </div>
    </section>
  );
}
