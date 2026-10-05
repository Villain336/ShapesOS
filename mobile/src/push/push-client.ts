// ShapesOS mobile — push device API client (pure: no Expo imports).
//
// Server contract (app/api/mobile/push-devices/route.ts), session cookie auth:
//   GET    /api/mobile/push-devices                         → { devices, pushEnabled, kinds }
//   POST   /api/mobile/push-devices { token, platform, deviceName? } → 201 { device, pushEnabled }
//   PATCH  /api/mobile/push-devices { token, enabled?, mutedKinds? } → { device }
//   DELETE /api/mobile/push-devices { token }               → { removed }
// The server only ever touches the signed-in user's own devices.

export type PushKind = "approval_needed" | "approval_decided" | "run_failed";

export const PUSH_KIND_LABELS: Record<PushKind, string> = {
  approval_needed: "Approvals that need you",
  approval_decided: "Your requests approved or denied",
  run_failed: "Failed agent runs",
};

export interface PushDevice {
  id: string;
  platform: string;
  deviceName: string | null;
  enabled: boolean;
  mutedKinds: string[];
  tokenHint: string;
  lastSeenAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface PushClientOptions {
  baseUrl: string;
  authHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class PushApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PushApiError";
  }
}

async function call<T>(opts: PushClientOptions, method: string, body?: unknown): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl}/api/mobile/push-devices`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", ...opts.authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new PushApiError(res.status, json.error ?? `push devices: ${res.status}`);
  return json;
}

export function listPushDevices(opts: PushClientOptions) {
  return call<{ devices: PushDevice[]; pushEnabled: boolean; kinds: PushKind[] }>(opts, "GET");
}

export function registerPushDevice(
  opts: PushClientOptions,
  input: { token: string; platform: "ios" | "android"; deviceName?: string | null },
) {
  return call<{ device: PushDevice; pushEnabled: boolean }>(opts, "POST", {
    token: input.token,
    platform: input.platform,
    ...(input.deviceName ? { deviceName: input.deviceName.slice(0, 80) } : {}),
  });
}

export function updatePushDevice(opts: PushClientOptions, input: { token: string; enabled?: boolean; mutedKinds?: PushKind[] }) {
  return call<{ device: PushDevice }>(opts, "PATCH", input);
}

export function removePushDevice(opts: PushClientOptions, token: string) {
  return call<{ removed: number }>(opts, "DELETE", { token });
}

/** The app tab a notification's dashboard link opens. */
export type AppTab = "chat" | "approvals" | "missions" | "settings";

export function tabForPushData(data: unknown): AppTab | null {
  const d = (data ?? {}) as { href?: unknown; kind?: unknown };
  const href = typeof d.href === "string" ? d.href : "";
  if (d.kind === "approval_needed" || d.kind === "approval_decided" || href.startsWith("/dashboard/approvals")) return "approvals";
  if (d.kind === "run_failed" || href.startsWith("/dashboard/runs") || href.startsWith("/dashboard/missions")) return "missions";
  return null;
}
