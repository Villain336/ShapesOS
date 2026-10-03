// Marketr — Knowledge Brain: source dossier (Agentic OS).
//
// A STRICT dossier: identical section order for every source, so the brain
// doubles as an audit surface. Sections:
//   1. Source (title + pillar/tier/status badges)
//   2. What Marketr learned
//   3. Chunks
//   4. Ingest mode
//   5. Author
//   6. License basis
//   7. Provenance (manifest version, retrieved date, eval participation, agent retrieval hits)
//   8. Distilled from (Tier 1S only)
//   9. Removal-flag controls (managers only)

import { X, Flag, FlagOff, Loader2 } from "lucide-react";
import type { BrainNode } from "@/lib/intelligence/corpus/graph";
import { Chip, inputCls, btnGhost, PILLAR_COLORS, PILLAR_LABEL } from "./brain-ui";

const STATUS_SHORT: Record<string, string> = {
  ingested: "ingested",
  "rights-review-pending": "rights review",
  "acquisition-pending": "acquisition",
  segregated: "segregated",
};

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm leading-snug text-ink">{children}</dd>
    </div>
  );
}

export function NodePanel({
  node,
  canManage,
  flagReason,
  setFlagReason,
  flagging,
  onFlag,
  onUnflag,
  onClose,
  evalQuestions,
}: {
  node: BrainNode;
  canManage: boolean;
  flagReason: string;
  setFlagReason: (s: string) => void;
  flagging: boolean;
  onFlag: () => void;
  onUnflag: () => void;
  onClose: () => void;
  /** Total eval questions this run (null when the eval never ran). */
  evalQuestions: number | null;
}) {
  return (
    <div className="flex max-h-[560px] flex-col overflow-hidden rounded-lg bg-paper shadow-hairline">
      {/* 1 · Source */}
      <div className="flex items-start gap-2 border-b border-line p-3">
        <span
          className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: PILLAR_COLORS[node.pillar] }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{node.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip tone="neutral">{PILLAR_LABEL[node.pillar]}</Chip>
            <Chip tone="neutral">Tier {node.tier}</Chip>
            {node.kind === "proposed" && <Chip tone="needs">Proposed</Chip>}
            {node.kind === "catalog" && (
              <Chip tone="neutral">
                Cataloged{node.catalogStatus ? ` · ${STATUS_SHORT[node.catalogStatus] ?? node.catalogStatus}` : ""}
              </Chip>
            )}
            {node.kind === "removal-flagged" && <Chip tone="deny">Flagged for removal</Chip>}
            {node.status === "pending" && node.kind === "source" && <Chip tone="needs">Pending</Chip>}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close dossier"
          className="rounded-full p-1.5 text-muted hover:bg-hover-paper"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <dl className="space-y-2.5">
          {/* 2 · What Marketr learned */}
          <Section label="What ShapesOS learned">{node.teaches}</Section>

          <div className="grid grid-cols-2 gap-2">
            {/* 3 · Chunks */}
            <Section label="Chunks">
              <span className="font-semibold text-ink">{node.chunks.toLocaleString()}</span>
            </Section>
            {/* 4 · Ingest mode */}
            <Section label="Ingest mode">
              {node.kind === "catalog"
                ? "Not ingested — cataloged only"
                : node.mode === "verbatim"
                  ? "Ingested verbatim"
                  : "ShapesOS synthesis"}
            </Section>
          </div>

          {/* 5 · Author */}
          <Section label="Author">{node.author}</Section>

          {/* 6 · License basis */}
          <Section label="License basis">{node.licenseBasis}</Section>

          {/* 7 · Provenance */}
          <div>
            <dt className="text-xs font-semibold text-muted">Provenance</dt>
            <dd className="mt-1 space-y-1 text-sm text-ink">
              <div className="flex justify-between gap-2">
                <span className="text-subtle">Ingested under</span>
                <span className="font-medium">
                  {node.manifestVersion != null ? `Corpus v${node.manifestVersion}` : "—"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-subtle">Retrieved</span>
                <span className="font-medium">{node.retrievedDate ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-subtle">Eval top-hits</span>
                <span className="font-medium">
                  {evalQuestions != null
                    ? `${node.evalHits} of ${evalQuestions} questions`
                    : "eval not run"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-subtle">Agent retrievals</span>
                <span className="font-medium">
                  {node.retrievalHits.toLocaleString()} hits
                </span>
              </div>
            </dd>
          </div>

          {/* 8 · Distilled from (Tier 1S only) */}
          {node.synthesizedFrom.length > 0 && (
            <div>
              <dt className="text-xs font-semibold text-muted">Distilled from</dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {node.synthesizedFrom.map((s) => (
                  <Chip key={s} tone="neutral">
                    {s}
                  </Chip>
                ))}
              </dd>
            </div>
          )}

          {node.removalReason && (
            <div className="rounded-md border-[1.5px] border-failed bg-failed-tint p-2">
              <dt className="text-xs font-semibold text-failed-text">Removal reason</dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-failed-text">{node.removalReason}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* 9 · Removal-flag controls */}
      {canManage && node.kind === "source" && (
        <div className="border-t border-line p-3">
          <div className="flex flex-col gap-2">
            <input
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              placeholder="Reason for removal…"
              className={`${inputCls} h-control-sm w-full`}
            />
            <button
              onClick={onFlag}
              disabled={flagging}
              className="aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint disabled:bg-disabled disabled:text-disabled-fg"
            >
              {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flag className="h-3.5 w-3.5" />}
              Flag for removal
            </button>
            <p className="text-[11px] leading-snug text-subtle">
              Flagging only marks the source — ingested data is never deleted here. Flags take effect
              on the next rebuild.
            </p>
          </div>
        </div>
      )}
      {canManage && node.kind === "removal-flagged" && (
        <div className="border-t border-line p-3">
          <button onClick={onUnflag} disabled={flagging} className={btnGhost}>
            {flagging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlagOff className="h-3.5 w-3.5" />}
            Clear removal flag
          </button>
        </div>
      )}
    </div>
  );
}
