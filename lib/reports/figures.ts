// Marketr — Phase 16 slice 9: branded report engine — figure grounding.
//
// IRON GUARDRAIL (Tico-locked 2026-09-29): never invent numbers. Every figure
// rendered in a report must carry a source pointer. A figure with no connected
// source is flagged for review and NEVER renders — the render service refuses
// to produce a PDF when any figure is ungrounded.

export interface FigureSource {
  /** Connected provider that produced the figure (e.g. "dataforseo", "gsc"). */
  provider: string;
  /** Pointer back to the source record (job id, query hash, row ref …). */
  ref: string;
  /** When the figure was captured (ISO). Optional but encouraged. */
  capturedAt?: string;
}

export interface ReportFigure {
  /** Template slot key (e.g. "organic_sessions"). */
  key: string;
  /** Human label shown in the report. */
  label: string;
  /** Rendered value (already formatted, e.g. "12,480"). Plain string — the
   *  template escapes it; the render service refuses non-strings. */
  value: string;
  /** Source pointer. Absent/empty = ungrounded = flagged, never rendered. */
  source?: FigureSource | null;
  /** Optional change text, e.g. "+8.2% vs prior period" (also source-bound). */
  delta?: string;
}

export interface GroundingResult {
  figures: ReportFigure[];
  /** Keys of figures that carry no valid source pointer. */
  ungroundedKeys: string[];
  /** True when every figure has a valid source pointer. */
  allGrounded: boolean;
}

function hasSource(source: FigureSource | null | undefined): source is FigureSource {
  return (
    !!source &&
    typeof source.provider === "string" &&
    source.provider.trim().length > 0 &&
    typeof source.ref === "string" &&
    source.ref.trim().length > 0
  );
}

/**
 * Evaluate every figure's source pointer. Pure function — the report-gate
 * service and the render service both call this; the render service treats
 * `allGrounded === false` as a hard failure (no PDF).
 */
export function evaluateFigures(figures: ReportFigure[]): GroundingResult {
  const ungroundedKeys: string[] = [];
  for (const fig of figures) {
    if (!hasSource(fig.source)) ungroundedKeys.push(fig.key);
  }
  return { figures, ungroundedKeys, allGrounded: ungroundedKeys.length === 0 };
}

/** Thrown by the render service when any figure lacks a source pointer. */
export class UngroundedFiguresError extends Error {
  readonly ungroundedKeys: string[];
  constructor(ungroundedKeys: string[]) {
    super(
      `Refusing to render: ${ungroundedKeys.length} figure(s) have no source pointer ` +
        `(${ungroundedKeys.join(", ")}). Source the figures, then re-render.`,
    );
    this.name = "UngroundedFiguresError";
    this.ungroundedKeys = ungroundedKeys;
  }
}

/** Hard gate: throws UngroundedFiguresError unless every figure is grounded. */
export function assertFiguresGrounded(figures: ReportFigure[]): void {
  const result = evaluateFigures(figures);
  if (!result.allGrounded) throw new UngroundedFiguresError(result.ungroundedKeys);
}
