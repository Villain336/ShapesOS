// Marketr — Phase 13C clipper: public barrel for lib/clipper.
// The API layer (app/api/clipper/_pipeline.ts) imports the pipeline surface
// from here so W2-internal renames stay contained.

export {
  getTranscriptionProvider,
  TranscriptionNotConfiguredError,
} from "./transcribe";
export type { TranscriptionProvider, TranscribeOptions } from "./transcribe";

export { scoreSegments } from "./score";
export type { Scorer, ScoreOptions } from "./score";

export { selectClips } from "./select";
export type { SelectOptions } from "./select";

export {
  buildRenderCommand,
  buildReframeFilter,
  buildFilterChain,
  escapeSubtitlePath,
  defaultOutputPath,
  DEFAULT_FACE_TRACKER,
} from "./reframe";
export type { RenderCommandOptions, FaceRegion, FaceTracker } from "./reframe";

export {
  buildAss,
  buildSrt,
  resolveCaptionStyle,
  applyStyleRulesToCaptions,
} from "./captions";

export type {
  Word,
  WordTimedTranscript,
  ClipCandidate,
  CaptionStyle,
  RenderSpec,
} from "./types";
