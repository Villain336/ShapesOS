// Marketr — Phase 13D Worker A: LiveKit integration scaffold.
//
// DECISION (locked at build, 2026-09-28): default provider mode is
// `rehearsal` — no real rooms, no dialing, no media. Two real lanes exist:
//   - `self-hosted` (RECOMMENDED): the LiveKit stack runs on the residual VPS
//     from the Cloudflare migration (see Cloudflare plan). Media never goes
//     to the edge — the agent worker needs real compute + low-latency media,
//     which the edge cannot provide.
//   - `cloud`: LiveKit Cloud via env credentials (speed over cost).
//
// Lane selection: VOICE_LIVEKIT_MODE=rehearsal|self-hosted|cloud (default
// rehearsal). self-hosted reads LIVEKIT_URL / LIVEKIT_API_KEY /
// LIVEKIT_API_SECRET (the VPS LiveKit server). cloud reads
// LIVEKIT_CLOUD_URL / LIVEKIT_CLOUD_API_KEY / LIVEKIT_CLOUD_API_SECRET.
//
// HARD GUARANTEES:
//   1. This module never places a call. Room/token helpers are only used for
//      sessions that passed all four gates in requestSession() AND carry a
//      human approval (assertLiveAllowed below).
//   2. Even with a live-approved session, nothing dials unless
//      LIVE_DIALING=1. In rehearsal mode this throws by construction.
//   3. The agent-worker entrypoint config targets the container/VPS lane
//      (Docker Compose / systemd), never the edge.

import { AccessToken } from "livekit-server-sdk";

export type LiveKitMode = "rehearsal" | "self-hosted" | "cloud";

export interface LiveKitConfig {
  mode: LiveKitMode;
  /** LiveKit server URL (ws:// or wss://). Null in rehearsal mode. */
  url: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  /** Container/VPS lane for the agent worker — never the edge. */
  workerLane: "container" | "vps";
}

export interface SessionRoomPlan {
  roomName: string;
  identity: string;
  participantName: string;
}

export class LiveKitNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`LiveKit not configured for live sessions: ${detail}`);
    this.name = "LiveKitNotConfiguredError";
  }
}

export class LiveDialingDisabledError extends Error {
  constructor() {
    super(
      "Live dialing is disabled: LIVE_DIALING=1 is required AND the session must carry a human approval.",
    );
    this.name = "LiveDialingDisabledError";
  }
}

/**
 * Resolve the LiveKit mode from the environment. Anything unrecognized
 * falls back to rehearsal (fail-closed).
 */
export function resolveLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const raw = (env.VOICE_LIVEKIT_MODE ?? "rehearsal").trim().toLowerCase();
  if (raw === "self-hosted") {
    const url = (env.LIVEKIT_URL ?? "").trim() || null;
    const apiKey = (env.LIVEKIT_API_KEY ?? "").trim() || null;
    const apiSecret = (env.LIVEKIT_API_SECRET ?? "").trim() || null;
    if (!url || !apiKey || !apiSecret)
      throw new LiveKitNotConfiguredError(
        "VOICE_LIVEKIT_MODE=self-hosted requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
      );
    return { mode: "self-hosted", url, apiKey, apiSecret, workerLane: "vps" };
  }
  if (raw === "cloud") {
    const url = (env.LIVEKIT_CLOUD_URL ?? "").trim() || null;
    const apiKey = (env.LIVEKIT_CLOUD_API_KEY ?? "").trim() || null;
    const apiSecret = (env.LIVEKIT_CLOUD_API_SECRET ?? "").trim() || null;
    if (!url || !apiKey || !apiSecret)
      throw new LiveKitNotConfiguredError(
        "VOICE_LIVEKIT_MODE=cloud requires LIVEKIT_CLOUD_URL, LIVEKIT_CLOUD_API_KEY, LIVEKIT_CLOUD_API_SECRET",
      );
    return { mode: "cloud", url, apiKey, apiSecret, workerLane: "container" };
  }
  return { mode: "rehearsal", url: null, apiKey: null, apiSecret: null, workerLane: "vps" };
}

/** Deterministic, tenant-scoped room name per session. */
export function roomNameForSession(workspaceId: string, sessionId: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return `voice-${clean(workspaceId)}-${clean(sessionId)}`;
}

/**
 * The agent-worker entrypoint config for the container/VPS lane. This is
 * what the ops side (Docker Compose / systemd on the VPS) consumes to run
 * the LiveKit Agents worker: STT → LLM → TTS (VoiceStudio, local
 * http://localhost:3900 — no cloud TTS vendor in the default path).
 */
export function agentWorkerEntrypoint(
  cfg: LiveKitConfig,
  plan: SessionRoomPlan,
): Record<string, unknown> {
  if (cfg.mode === "rehearsal") {
    return {
      mode: "rehearsal",
      note: "No worker started in rehearsal mode. This is the expected default.",
    };
  }
  return {
    mode: cfg.mode,
    lane: cfg.workerLane,
    livekitUrl: cfg.url,
    room: plan.roomName,
    agentIdentity: plan.identity,
    pipeline: {
      stt: "livekit/deepgram (lane-local)",
      llm: "workspace LLM provider",
      tts: "voicestudio http://localhost:3900/v1/audio/speech (default; per-workspace BYO voice id)",
    },
    tts: {
      backend: "voicestudio",
      endpoint: "http://localhost:3900/v1/audio/speech",
      voicesEndpoint: "http://localhost:3900/v1/audio/voices",
      note: "VoiceStudio is the default TTS backend per standing instruction; the worker calls it directly from the VPS lane.",
    },
    env: ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
  };
}

/**
 * Mint a participant access token for a live session room. Throws in
 * rehearsal mode. Callers must pass assertLiveAllowed() first.
 */
export async function mintSessionToken(
  cfg: LiveKitConfig,
  plan: SessionRoomPlan,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  if (cfg.mode === "rehearsal" || !cfg.url || !cfg.apiKey || !cfg.apiSecret) {
    throw new LiveKitNotConfiguredError(
      "cannot mint tokens in rehearsal mode or without server credentials",
    );
  }
  const token = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: plan.identity,
    name: plan.participantName,
    ttl: `${opts?.ttlSeconds ?? 3600}s`,
  });
  token.addGrant({
    roomJoin: true,
    room: plan.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}

/**
 * Final live-dial assertion: the session must have passed all four gates
 * (sessions.ts guarantees this for status=queued) AND carry a human
 * approval AND LIVE_DIALING=1 must be set. Throws otherwise. This is the
 * single choke point before any room creation or dialing code.
 */
export function assertLiveAllowed(session: {
  status: string;
  auditTrail: unknown;
}): void {
  if (process.env.LIVE_DIALING !== "1") throw new LiveDialingDisabledError();
  if (session.status !== "queued")
    throw new LiveDialingDisabledError();
  const trail = (session.auditTrail ?? []) as Array<{ action?: string; detail?: string }>;
  const approved = trail.some(
    (e) => e.action === "gates_passed" && (e.detail ?? "").includes("approved_by="),
  );
  if (!approved) throw new LiveDialingDisabledError();
}

/**
 * Convenience: resolve config, assert live-allowed, and build the room plan
 * for a queued session. In rehearsal mode this throws LiveDialingDisabled
 * (via assertLiveAllowed) before any room exists — by design.
 */
export function planLiveSession(
  workspaceId: string,
  session: { id: string; status: string; auditTrail: unknown },
  env: NodeJS.ProcessEnv = process.env,
): { cfg: LiveKitConfig; plan: SessionRoomPlan } {
  assertLiveAllowed(session);
  const cfg = resolveLiveKitConfig(env);
  const plan: SessionRoomPlan = {
    roomName: roomNameForSession(workspaceId, session.id),
    identity: `agent-${session.id}`,
    participantName: "ShapesOS voice agent",
  };
  return { cfg, plan };
}
