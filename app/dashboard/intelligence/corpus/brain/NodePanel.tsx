// Marketr — Knowledge Brain: source detail panel.
// Moved verbatim out of BrainClient.tsx (3D rebuild refactor); the panel is
// view-agnostic and serves both the 2D canvas and the 3D scene.

import { X, Flag, FlagOff, Loader2 } from "lucide-react";
import type { BrainNode } from "@/lib/intelligence/corpus/graph";
import { Chip, inputCls, btnGhost, PILLAR_COLORS, PILLAR_TONE, PILLAR_LABEL } from "./brain-ui";

export function NodePanel({
  node,
  canManage,
  flagReason,
  setFlagReason,
  flagging,
  onFlag,
  onUnflag,
  onClose,
}: {
  node: BrainNode;
  canManage: boolean;
  flagReason: string;
  setFlagReason: (s: string) => void;
  flagging: boolean;
  onFlag: () => void;
  onUnflag: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex max-h-[560px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-start gap-2 border-b border-stone-100 p-3">
        <span
          className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: PILLAR_COLORS[node.pillar] }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-stone-900">{node.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip tone={PILLAR_TONE[node.pillar]}>{PILLAR_LABEL[node.pillar]}</Chip>
            <Chip tone="violet">Tier {node.tier}</Chip>
            {node.kind === "proposed" && <Chip tone="amber">proposed</Chip>}
            {node.kind === "removal-flagged" && <Chip tone="red">flagged for removal</Chip>}
            {node.status === "pending" && node.kind === "source" && <Chip tone="amber">pending</Chip>}
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <dl className="space-y-2.5 text-[13px]">
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
              What Marketr learned
            </dt>
            <dd className="mt-0.5 leading-snug text-stone-700">{node.teaches}</dd>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Chunks</dt>
              <dd className="mt-0.5 font-semibold text-stone-900">{node.chunks.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Mode</dt>
              <dd className="mt-0.5 text-stone-700">
                {node.mode === "verbatim" ? "Ingested verbatim" : "Marketr synthesis"}
              </dd>
            </div>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Author</dt>
            <dd className="mt-0.5 text-stone-700">{node.author}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">License basis</dt>
            <dd className="mt-0.5 leading-snug text-stone-700">{node.licenseBasis}</dd>
          </div>
          {node.synthesizedFrom.length > 0 && (
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Distilled from
              </dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {node.synthesizedFrom.map((s) => (
                  <Chip key={s} tone="slate">
                    {s}
                  </Chip>
                ))}
              </dd>
            </div>
          )}
          {node.removalReason && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-red-500">
                Removal reason
              </dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-red-800">{node.removalReason}</dd>
            </div>
          )}
        </dl>
      </div>
      {canManage && node.kind === "source" && (
        <div className="border-t border-stone-100 p-3">
          <div className="flex flex-col gap-2">
            <input
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              placeholder="Reason for removal…"
              className={inputCls}
            />
            <button
              onClick={onFlag}
              disabled={flagging}
              className="flex items-center justify-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[13px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
            >
              {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flag className="h-3.5 w-3.5" />}
              Flag for removal
            </button>
            <p className="text-[11px] leading-snug text-stone-400">
              Flagging only marks the source — ingested data is never deleted here. Flags take effect
              on the next rebuild.
            </p>
          </div>
        </div>
      )}
      {canManage && node.kind === "removal-flagged" && (
        <div className="border-t border-stone-100 p-3">
          <button onClick={onUnflag} disabled={flagging} className={btnGhost}>
            {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlagOff className="h-3.5 w-3.5" />}
            Clear removal flag
          </button>
        </div>
      )}
    </div>
  );
}
