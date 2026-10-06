// ShapesOS Desktop: the ShapesOS API client (p19a-contract.md).
//
// Auth: the person signs in inside the main window (partition
// persist:shapesos). Requests go through that partition's fetch
// (session.fromPartition('persist:shapesos').fetch), so its cookies ride
// along; the short-lived cursor token from POST /api/cursor/session is sent
// too as `Authorization: Bearer`. No provider key ever touches this app.

import type {
  AgentActivityResponse,
  AgentRequest,
  AgentResponse,
  ApprovalCounts,
  ApproveRequest,
  ApproveResponse,
  CursorSession,
  NotificationsResponse,
  TranscribeToken,
  TurnEvent,
  TurnRequest,
  VoicesResponse,
} from "../shared/contract";
import { expiryMs } from "../shared/contract";
import { parseTurnEvent, readSse, type SseMessage } from "../shared/sse";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
    if (typeof body.error === "string") message = body.error;
    else if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    /* not JSON */
  }
  if (res.status === 401) message = "Sign in to ShapesOS in the main window first.";
  return new ApiError(res.status, code, message);
}

/** A session with no expiry (no signing secret on the server) is re-checked after this long. */
const COOKIE_ONLY_SESSION_TTL_MS = 5 * 60_000;

export class ShapesApi {
  private session: CursorSession | null = null;
  private sessionAt = 0;

  constructor(
    private baseUrl: () => string,
    private fetchImpl: FetchLike,
  ) {}

  get current(): CursorSession | null {
    return this.session;
  }

  forget(): void {
    this.session = null;
  }

  /** ms until the cached session should be refreshed (≤ 0 = now). */
  private sessionLeftMs(): number {
    if (!this.session) return 0;
    const exp = expiryMs(this.session.expiresAt);
    if (Number.isFinite(exp)) return exp - Date.now();
    return this.sessionAt + COOKIE_ONLY_SESSION_TTL_MS - Date.now();
  }

  private url(path: string): string {
    return `${this.baseUrl()}${path}`;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: json ? "application/json" : "*/*", "X-Shapes-Client": "desktop" };
    // The bearer token rides along while it is valid; with no token (server
    // without a signing secret) the partition's cookie alone authenticates.
    if (this.session?.token && expiryMs(this.session.expiresAt) > Date.now() + 15_000) {
      h.Authorization = `Bearer ${this.session.token}`;
    }
    return h;
  }

  private async json<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: { ...this.headers(true), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as T;
  }

  /** POST /api/cursor/session; refreshed when under a minute is left. */
  async ensureSession(force = false): Promise<CursorSession> {
    if (!force && this.session && this.sessionLeftMs() > 60_000) return this.session;
    this.session = null;
    const s = await this.json<CursorSession>("POST", "/api/cursor/session", {});
    this.session = s;
    this.sessionAt = Date.now();
    return s;
  }

  transcribeToken(): Promise<TranscribeToken> {
    return this.json<TranscribeToken>("POST", "/api/cursor/transcribe-token", {});
  }

  /** POST /api/cursor/turn → validated events. Malformed events are skipped. */
  async *turn(body: TurnRequest, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    const res = await this.fetchImpl(this.url("/api/cursor/turn"), {
      method: "POST",
      headers: { ...this.headers(false), Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) throw new ApiError(502, "no_body", "The server sent no answer.");
    for await (const msg of readSse(res.body, signal)) {
      if (msg.event === "reconnect") {
        yield { type: "error", code: "reconnect", message: "The server restarted mid-answer. Ask again." };
        return;
      }
      const ev = parseTurnEvent(msg);
      if (ev) yield ev;
    }
  }

  approve(req: ApproveRequest): Promise<ApproveResponse> {
    return this.json("POST", "/api/cursor/approve", req);
  }

  /** POST /api/cursor/tts → the streamed audio/mpeg response (caller reads the body). */
  async tts(text: string, signal: AbortSignal, voice?: string): Promise<Response> {
    const res = await this.fetchImpl(this.url("/api/cursor/tts"), {
      method: "POST",
      headers: { ...this.headers(false), Accept: "audio/mpeg", "Content-Type": "application/json" },
      body: JSON.stringify(voice ? { text, voice } : { text }),
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  agent(req: AgentRequest): Promise<AgentResponse> {
    return this.json("POST", "/api/cursor/agent", req);
  }

  /** GET /api/cursor/voices (Settings shows what the server offers). */
  voices(): Promise<VoicesResponse> {
    return this.json("GET", "/api/cursor/voices");
  }

  /** PUT /api/cursor/voices { voiceId } → { selected } (only an id the provider lists). */
  setVoice(voiceId: string): Promise<{ selected: { id: string; label: string } | null }> {
    return this.json("PUT", "/api/cursor/voices", { voiceId });
  }

  /**
   * An SSE stream at an absolute URL the server handed us (the labelled mock
   * STT, GET /api/cursor/mock-stt). Only ever on the configured ShapesOS
   * origin, so the cookie and bearer token never go anywhere else.
   */
  async *sseAt(absoluteUrl: string, signal: AbortSignal): AsyncGenerator<SseMessage> {
    let target: URL;
    try {
      target = new URL(absoluteUrl);
    } catch {
      throw new ApiError(400, "bad_url", "The server sent a bad speech URL.");
    }
    if (target.origin !== new URL(this.baseUrl()).origin) {
      throw new ApiError(400, "foreign_origin", "The server sent a speech URL on another site; refused.");
    }
    const res = await this.fetchImpl(target.toString(), {
      method: "GET",
      headers: { ...this.headers(false), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) return;
    yield* readSse(res.body, signal);
  }

  approvalCounts(): Promise<ApprovalCounts> {
    return this.json("GET", "/api/approvals/count");
  }

  activity(): Promise<AgentActivityResponse> {
    return this.json("GET", "/api/agents/activity");
  }

  notifications(): Promise<NotificationsResponse> {
    return this.json("GET", "/api/notifications?limit=8&unread=1");
  }

  /** GET /api/agent-runs/:id/watch?view=delegation (SSE): raw messages. */
  async *watchRun(runId: string, signal: AbortSignal): AsyncGenerator<SseMessage> {
    const res = await this.fetchImpl(this.url(`/api/agent-runs/${encodeURIComponent(runId)}/watch?view=delegation`), {
      method: "GET",
      headers: { ...this.headers(false), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) return;
    yield* readSse(res.body, signal);
  }
}
