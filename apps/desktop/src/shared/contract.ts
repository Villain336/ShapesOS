// ShapesOS Desktop: the client side of the Phase 19A API contract
// (p19a-contract.md, binding). Every request and event shape the desktop
// sends or understands lives here, so the server workstream and this app
// can be diffed against one file.

export type SttProvider = "assemblyai" | "deepgram" | "mock" | "none";
export type TtsProvider = "elevenlabs" | "voicestudio" | "openai" | "mock" | "none";
/** "openai" was added by the WS=server amendment (single-key OpenAI deployments). */
export type VisionProvider = "anthropic" | "openai" | "mock" | "none";

/** POST /api/cursor/session → 200 */
export interface CursorSession {
  /** null when the server has no AUTH_SECRET/NEXTAUTH_SECRET: cookie auth still works. */
  token: string | null;
  /** The server sends epoch ms; ISO strings are accepted too (see expiryMs). */
  expiresAt: number | string | null;
  workspaceId: string;
  user: { id: string; name: string | null };
  voice: { id: string | null; label: string };
  /** talkMinutesIncluded null = unlimited (self-hosted). */
  limits: { talkMinutesIncluded: number | null; talkMinutesUsed: number; byok: boolean };
  providers: { stt: SttProvider; tts: TtsProvider; vision: VisionProvider };
}

/** An expiry as epoch ms, from epoch ms or an ISO string; NaN when absent or unreadable. */
export function expiryMs(v: number | string | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v) return /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return NaN;
}

/** POST /api/cursor/transcribe-token → 200 */
export interface TranscribeToken {
  provider: SttProvider;
  wsUrl: string;
  token: string;
  expiresAt: number | string;
  sampleRate: 16000;
  encoding: "pcm_s16le";
  /** Amendment: AssemblyAI → query_token (`&token=`), Deepgram → bearer_header (from main). */
  authVia?: "query_token" | "bearer_header";
  sessionId?: string;
}

/**
 * One screenshot in a turn.
 *
 * Interpretation (documented in the report): `width`/`height` are the JPEG's
 * pixel size and `scaleFactor` is JPEG pixels per screen point on that
 * display, so the server maps a model coordinate on the image to screen
 * points with `x / scaleFactor`. When the image is not downscaled this equals
 * the OS scale factor (2 on Retina, 1.25/1.5 on scaled Windows displays).
 */
export interface TurnScreenshot {
  screen: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
  jpegBase64: string;
}

export interface UiMapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiMapEntry {
  id: string;
  label: string;
  role: string;
  rect: UiMapRect;
}

export interface TurnApp {
  name: string;
  title?: string;
  url?: string;
  isShapesOS: boolean;
}

/** POST /api/cursor/turn body. */
export interface TurnRequest {
  conversationId?: string;
  transcript: string;
  screenshots: TurnScreenshot[];
  uiMap?: UiMapEntry[];
  app?: TurnApp;
  mode?: "answer" | "agent";
  /** Amendment: how long the key was held (minutes 2…N are metered from it). */
  talkSeconds?: number;
}

export const TURN_LIMITS = {
  maxScreenshots: 4,
  /** 6 MB total; the client budgets against the base64 length it sends. */
  maxTotalBytes: 6 * 1024 * 1024,
} as const;

export const TTS_MAX_CHARS = 2000;

export interface Point2 {
  x: number;
  y: number;
}

export type TurnEvent =
  | { type: "turn_started"; runId: string; conversationId: string; mock?: boolean }
  | { type: "text_delta"; text: string }
  | { type: "point"; screen: number; x: number; y: number; label: string }
  | { type: "point"; elementId: string; label: string }
  | {
      type: "draw";
      kind: "circle" | "arrow" | "step";
      screen: number;
      points: Point2[];
      step?: number;
      label?: string;
    }
  | {
      type: "proposal";
      approvalId: string;
      tool: string;
      summary: string;
      tier: 0 | 1 | 2 | 3;
      destructive: boolean;
      voiceApprovable: boolean;
      elementId?: string;
    }
  | { type: "dictation"; text: string }
  | { type: "agent_started"; runId: string; maxUsd: number }
  | { type: "error"; code: string; message: string }
  | { type: "done"; usage: { credits: number; inputTokens: number; outputTokens: number } };

export type TurnEventType = TurnEvent["type"];
export type ScreenPointEvent = Extract<TurnEvent, { type: "point"; screen: number }>;
export type ElementPointEvent = Extract<TurnEvent, { type: "point"; elementId: string }>;
export type DrawEvent = Extract<TurnEvent, { type: "draw" }>;
export type ProposalEvent = Extract<TurnEvent, { type: "proposal" }>;

/** POST /api/cursor/approve body. */
export interface ApproveRequest {
  approvalId: string;
  decision: "approve" | "reject";
  via: "voice" | "click";
}

/** POST /api/cursor/approve → 200 (amendment). 404/409/410/403 are errors. */
export interface ApproveResponse {
  approvalId: string;
  status: "executed" | "failed" | "rejected";
  resultSummary: string | null;
}

/** POST /api/cursor/agent → 200 { runId, maxUsd } (maxUsd added by the amendment). */
export interface AgentResponse {
  runId: string;
  maxUsd?: number;
}

/** GET /api/cursor/voices (amendment). */
export interface VoicesResponse {
  provider: string;
  voices: { id: string; label: string }[];
  /** The person's saved choice for this provider (the server sends { provider, id, label }). */
  selected: { id: string; label: string } | null;
  error: string | null;
}

/** POST /api/cursor/agent body → { runId, maxUsd } */
export interface AgentRequest {
  goal: string;
  maxUsd: number;
  conversationId?: string;
}

/** `{ error: { code, message } }` */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** GET /api/approvals/count */
export interface ApprovalCounts {
  total: number;
  actionable: number;
}

/** GET /api/agents/activity (the subset the tray reads). */
export interface ActivityNode {
  key: string;
  name: string;
  status: "running" | "needs" | "done" | "failed" | "queued" | "paused";
  line: string;
  href: string | null;
  children?: ActivityNode[];
}

export interface AgentActivityResponse {
  tree: { lead: ActivityNode; branches: ActivityNode[] } | null;
}

/** GET /api/notifications */
export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  unread: number;
}
