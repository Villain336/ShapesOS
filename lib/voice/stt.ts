// ShapesOS — Phase 19A (WS=server): streaming speech-to-text tokens for the
// agentic cursor (ShapesOS Desktop). fetch only; the platform key never
// leaves the server — the desktop gets a SHORT-LIVED token and opens the
// provider's WebSocket itself.
//
// Providers (CURSOR_STT_PROVIDER picks one; unset = the first with a key,
// AssemblyAI first, which is what HeyClicky / farzaa/clicky use):
//
//   AssemblyAI Universal-Streaming v3 (verified 2026-10-06):
//     GET https://streaming.assemblyai.com/v3/token
//         ?expires_in_seconds=1..600&max_session_duration_seconds=60..10800
//     header  Authorization: <ASSEMBLYAI_API_KEY>
//     → { token, expires_in_seconds }
//     WebSocket wss://streaming.assemblyai.com/v3/ws?sample_rate=16000
//         &encoding=pcm_s16le&token=<token>   (browsers can't set headers,
//     so the token rides in the query string)
//     https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
//     https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
//
//   Deepgram (verified 2026-10-06):
//     POST https://api.deepgram.com/v1/auth/grant   body { ttl_seconds } (≤ 3600)
//     header  Authorization: Token <DEEPGRAM_API_KEY>
//     → { access_token, expires_in }
//     WebSocket wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000
//     with header Authorization: Bearer <access_token> (the desktop's main
//     process opens it; the token only has to be valid when connecting)
//     https://developers.deepgram.com/reference/auth/tokens/grant
//     https://developers.deepgram.com/guides/fundamentals/token-based-authentication
//
// No key → "none" (the desktop shows "not configured"); a labelled mock only
// with ALLOW_FAKE_PROVIDERS=1 — never a fake transcript in production.

export type SttProviderName = "assemblyai" | "deepgram" | "mock" | "none";

type Env = Record<string, string | undefined>;

export const STT_SAMPLE_RATE = 16_000;
export const STT_ENCODING = "pcm_s16le" as const;
/** How long a minted token may be used to OPEN a session. */
export const STT_TOKEN_TTL_SECONDS = 60;
/**
 * AssemblyAI: the longest one hold-to-talk session may last. Each started
 * minute is metered (cursor_talk_minute); the first minute is charged when
 * the token is minted.
 */
export const STT_MAX_SESSION_SECONDS = 600;

export const ASSEMBLYAI_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
export const ASSEMBLYAI_WS_URL = "wss://streaming.assemblyai.com/v3/ws";
export const DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
export const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

/** True only with the explicit demo / e2e opt-in (contract: dev/e2e ALLOW_FAKE_PROVIDERS=1). */
export function cursorMocksAllowed(env: Env = process.env): boolean {
  return (env.ALLOW_FAKE_PROVIDERS ?? "").trim() === "1";
}

export function sttProviderName(env: Env = process.env): SttProviderName {
  const want = (env.CURSOR_STT_PROVIDER ?? "").trim().toLowerCase();
  const aai = !!env.ASSEMBLYAI_API_KEY?.trim();
  const dg = !!env.DEEPGRAM_API_KEY?.trim();
  if (want === "assemblyai" && aai) return "assemblyai";
  if (want === "deepgram" && dg) return "deepgram";
  if (!want || (want !== "assemblyai" && want !== "deepgram")) {
    if (aai) return "assemblyai";
    if (dg) return "deepgram";
  }
  return cursorMocksAllowed(env) ? "mock" : "none";
}

export interface SttToken {
  provider: Exclude<SttProviderName, "none">;
  wsUrl: string;
  token: string;
  /** Epoch ms after which the token can no longer open a session. */
  expiresAt: number;
  sampleRate: typeof STT_SAMPLE_RATE;
  encoding: typeof STT_ENCODING;
  /** Where the desktop puts the token: AssemblyAI query string, Deepgram bearer header, mock query string. */
  authVia: "query_token" | "bearer_header";
  /** Set on the labelled mock. */
  mock?: true;
}

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "stt_not_configured" | "stt_provider_error",
  ) {
    super(message);
    this.name = "SttError";
  }
}

export interface MintOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Absolute URL of the mock transcript route (labelled mock only). */
  mockUrl?: string;
}

/** Mint a short-lived streaming token from the platform key. */
export async function mintSttToken(opts: MintOptions = {}): Promise<SttToken> {
  const env = opts.env ?? process.env;
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now();
  const name = sttProviderName(env);
  if (name === "none") {
    throw new SttError("Speech input is not configured on this server (set ASSEMBLYAI_API_KEY or DEEPGRAM_API_KEY).", 503, "stt_not_configured");
  }
  if (name === "mock") {
    const { randomBytes } = await import("node:crypto");
    return {
      provider: "mock",
      wsUrl: opts.mockUrl ?? "/api/cursor/mock-stt",
      token: `mock_${randomBytes(12).toString("base64url")}`,
      expiresAt: now + STT_TOKEN_TTL_SECONDS * 1000,
      sampleRate: STT_SAMPLE_RATE,
      encoding: STT_ENCODING,
      authVia: "query_token",
      mock: true,
    };
  }
  if (name === "assemblyai") {
    const url = `${ASSEMBLYAI_TOKEN_URL}?expires_in_seconds=${STT_TOKEN_TTL_SECONDS}&max_session_duration_seconds=${STT_MAX_SESSION_SECONDS}`;
    const res = await f(url, { method: "GET", headers: { Authorization: env.ASSEMBLYAI_API_KEY!.trim() } }).catch((e: unknown) => {
      throw new SttError(`AssemblyAI is unreachable: ${e instanceof Error ? e.message : String(e)}`, 502, "stt_provider_error");
    });
    if (!res.ok) throw new SttError(`AssemblyAI refused the token request (${res.status}).`, 502, "stt_provider_error");
    const body = (await res.json().catch(() => ({}))) as { token?: unknown; expires_in_seconds?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new SttError("AssemblyAI returned no token.", 502, "stt_provider_error");
    const ttl = typeof body.expires_in_seconds === "number" ? body.expires_in_seconds : STT_TOKEN_TTL_SECONDS;
    return {
      provider: "assemblyai",
      wsUrl: `${ASSEMBLYAI_WS_URL}?sample_rate=${STT_SAMPLE_RATE}&encoding=${STT_ENCODING}&format_turns=true`,
      token: body.token,
      expiresAt: now + ttl * 1000,
      sampleRate: STT_SAMPLE_RATE,
      encoding: STT_ENCODING,
      authVia: "query_token",
    };
  }
  const res = await f(DEEPGRAM_GRANT_URL, {
    method: "POST",
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: STT_TOKEN_TTL_SECONDS }),
  }).catch((e: unknown) => {
    throw new SttError(`Deepgram is unreachable: ${e instanceof Error ? e.message : String(e)}`, 502, "stt_provider_error");
  });
  if (!res.ok) throw new SttError(`Deepgram refused the token request (${res.status}).`, 502, "stt_provider_error");
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) throw new SttError("Deepgram returned no token.", 502, "stt_provider_error");
  const ttl = typeof body.expires_in === "number" ? body.expires_in : STT_TOKEN_TTL_SECONDS;
  return {
    provider: "deepgram",
    // pcm_s16le is Deepgram's "linear16".
    wsUrl: `${DEEPGRAM_WS_URL}?encoding=linear16&sample_rate=${STT_SAMPLE_RATE}&interim_results=true&smart_format=true`,
    token: body.access_token,
    expiresAt: now + ttl * 1000,
    sampleRate: STT_SAMPLE_RATE,
    encoding: STT_ENCODING,
    authVia: "bearer_header",
  };
}

/**
 * The labelled mock transcript (ALLOW_FAKE_PROVIDERS=1 only): what the mock
 * STT route streams, in AssemblyAI v3 "Turn" message shape, so the desktop's
 * caption path can be exercised without a provider.
 */
export const MOCK_STT_TRANSCRIPT = "Mock transcript: where do I approve this?";

export function mockSttMessages(text: string = MOCK_STT_TRANSCRIPT): Array<Record<string, unknown>> {
  const words = text.split(" ");
  const out: Array<Record<string, unknown>> = [{ type: "Begin", mock: true }];
  for (let i = 1; i <= words.length; i++) {
    out.push({ type: "Turn", transcript: words.slice(0, i).join(" "), end_of_turn: i === words.length, turn_is_formatted: i === words.length, mock: true });
  }
  out.push({ type: "Termination", mock: true });
  return out;
}
