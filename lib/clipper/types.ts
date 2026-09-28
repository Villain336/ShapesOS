// Marketr — Phase 13C clipper pipeline: shared types.
//
// Worker 2. These types are the contract between the pipeline stages
// (transcribe → score → select → reframe → captions) and the ClipSource /
// Clip / ClipJob Prisma models. No side effects here.

/** A single transcribed word with second-precision timing. */
export interface Word {
  /** The word text, e.g. "freedom". */
  w: string;
  /** Start time in seconds (relative to source media). */
  start: number;
  /** End time in seconds. */
  end: number;
}

/** Word-level timed transcript produced by a TranscriptionProvider. */
export interface WordTimedTranscript {
  words: Word[];
  /** Full plain text of the transcript (words joined with spaces). */
  text: string;
  /** True only on the mock/dev provider. Real providers never set this. */
  mock?: boolean;
}

/** A candidate clip window proposed by the scoring stage. */
export interface ClipCandidate {
  /** Start time in seconds (relative to source media). */
  startSec: number;
  /** End time in seconds. */
  endSec: number;
  /** 0–100 virality score, normalized by score.ts. */
  viralityScore: number;
  /** Why it scored what it did — never empty after normalization. */
  scoreReasons: string[];
  /** The opening line/text of the segment (used for hook display + captions). */
  hookText: string;
}

/** Caption rendering style — resolved from the workspace brand kit. */
export interface CaptionStyle {
  /** Font family name (brand kit fonts.heading, fall back to body). */
  font: string;
  /** Base caption color, CSS hex (brand kit colors.text). */
  color: string;
  /** Active-word highlight color, CSS hex (brand kit colors.primary/accent). */
  highlightColor: string;
  /** Screen position of captions. */
  position: "bottom" | "center" | "top";
  /** Whether the currently-spoken word gets the highlight color (karaoke). */
  wordHighlight: boolean;
}

/**
 * Everything needed to render one clip. Built by lib/clipper/reframe.ts,
 * executed by W3's job processor via child_process on the container/VPS
 * lane (never the edge).
 */
export interface RenderSpec {
  /** Absolute path to the source media file. */
  input: string;
  /** Absolute path of the rendered output file (1080x1920). */
  output: string;
  /** Absolute path of the ASS subtitle file burned into the render. */
  assPath: string;
  /** Cut window, in seconds (source-media timeline). */
  startSec: number;
  endSec: number;
  /** Normalized (0..1) face center driving the crop x-offset, if known. */
  faceRegion?: { x: number; y: number };
  /** Full ffmpeg argv (argv[0] is the ffmpeg binary). */
  ffmpegArgs: string[];
}
