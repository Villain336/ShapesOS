// ShapesOS — Expo push service client (Phase 4b).
//
// Documented API (https://docs.expo.dev/push-notifications/sending-notifications/):
//   POST https://exp.host/--/api/v2/push/send
//     headers: accept: application/json, content-type: application/json,
//              Authorization: Bearer <access token>  (only when the Expo
//              project has "enhanced push security" on)
//     body: an array of up to 100 messages { to, title, body, data, sound,
//           priority, channelId }
//   → 200 { data: [ticket, …] } — one ticket per message, same order:
//       { status: "ok", id } | { status: "error", message, details: { error } }
//     A request-level failure answers { errors: [{ code, message }] }.
//   Ticket error codes: DeviceNotRegistered (stop sending to this token),
//   MessageTooBig, MessageRateExceeded, MismatchSenderId, InvalidCredentials.
//
// Sending is OFF unless PUSH_PROVIDER=expo (self-hosted installs opt in; the
// smoke battery and tests never reach exp.host). EXPO_ACCESS_TOKEN is optional.

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_MAX_PER_REQUEST = 100;
const TIMEOUT_MS = 10_000;

/** ExponentPushToken[xxxx] / ExpoPushToken[xxxx] — the only shape Expo accepts. */
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === "string" && token.length <= 240 && TOKEN_RE.test(token);
}

export function pushProvider(env: NodeJS.ProcessEnv = process.env): "expo" | "off" {
  return (env.PUSH_PROVIDER ?? "").trim().toLowerCase() === "expo" ? "expo" : "off";
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  channelId?: string;
}

export type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string } };

export class ExpoPushRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ExpoPushRequestError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function normalizeTicket(raw: unknown): ExpoTicket {
  const t = (raw ?? {}) as { status?: unknown; id?: unknown; message?: unknown; details?: { error?: unknown } };
  if (t.status === "ok" && typeof t.id === "string") return { status: "ok", id: t.id };
  return {
    status: "error",
    message: typeof t.message === "string" ? t.message.slice(0, 300) : "unknown push error",
    details: { error: typeof t.details?.error === "string" ? t.details.error : undefined },
  };
}

/**
 * Send messages through Expo, chunked by 100. Returns one ticket per message
 * in input order. Throws ExpoPushRequestError when a whole request fails
 * (HTTP error, request-level `errors`, malformed body, timeout).
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  opts: { fetchImpl?: FetchLike; accessToken?: string | null } = {},
): Promise<ExpoTicket[]> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += EXPO_MAX_PER_REQUEST) {
    const chunk = messages.slice(i, i + EXPO_MAX_PER_REQUEST);
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    };
    const token = opts.accessToken?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(EXPO_PUSH_SEND_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new ExpoPushRequestError(`expo push request failed: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    let body: { data?: unknown; errors?: Array<{ code?: string; message?: string }> } | null = null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = null;
    }
    if (!res.ok || !body || !Array.isArray(body.data)) {
      const code = body?.errors?.[0]?.code ?? `HTTP ${res.status}`;
      throw new ExpoPushRequestError(`expo push rejected the request (${code})`, res.status);
    }
    const data = body.data as unknown[];
    for (let j = 0; j < chunk.length; j++) tickets.push(normalizeTicket(data[j]));
  }
  return tickets;
}
