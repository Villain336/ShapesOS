// Marketr — Phase 16 slice 8: recording storage card for Settings → Usage.
// Per-workspace agent-run recording rollup (total/video/trace bytes, counts,
// pinned + purged counts) with the retention policy stated plainly.

"use client";

import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { cardCls } from "./ui";

interface StoragePayload {
  workspaceId: string;
  totalBytes: number;
  videoBytes: number;
  traceBytes: number;
  count: number;
  pinnedCount: number;
  purgedVideoCount: number;
  missingFileCount: number;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

export default function RecordingStorageCard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<StoragePayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/agent-runs/storage?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (live) setData(j.storage ?? null);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (failed) return null;
  if (!data) {
    return (
      <div className={cardCls}>
        <p className="text-sm text-zinc-500">Loading recording storage…</p>
      </div>
    );
  }

  return (
    <div className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-[var(--brand-600)]" />
        <h3 className="text-sm font-semibold text-zinc-900">Agent run recordings</h3>
        <span className="text-xs text-zinc-500">videos auto-purge after 30 days · traces always kept</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Total" value={fmtBytes(data.totalBytes)} />
        <Stat label="Video" value={fmtBytes(data.videoBytes)} />
        <Stat label="Traces" value={fmtBytes(data.traceBytes)} />
        <Stat label="Recordings" value={String(data.count)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
        <span>
          <span className="font-medium text-zinc-700">{data.pinnedCount}</span> pinned
          (videos survive the sweep)
        </span>
        <span>
          <span className="font-medium text-zinc-700">{data.purgedVideoCount}</span> videos purged
        </span>
        {data.missingFileCount > 0 && (
          <span>
            <span className="font-medium text-zinc-700">{data.missingFileCount}</span> artifacts missing
            from disk
          </span>
        )}
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Retention policy: recordings keep their video for 30 days, then the sweep drops the video
        and keeps the trace. Pin a recording to keep its video past 30 days — the trace is never
        deleted by the sweep.
      </p>
    </div>
  );
}
