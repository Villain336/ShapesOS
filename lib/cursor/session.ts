// ShapesOS — Phase 19A (WS=server): what POST /api/cursor/session returns,
// and the person's cursor voice (Settings → You → Cursor).

import { getUserPreferences, setUserPreferences } from "@/lib/preferences";
import { loadWorkspaceModelKeys } from "@/lib/llm/workspace-keys";
import { sttProviderName, type SttProviderName } from "@/lib/voice/stt";
import { listTtsVoices, ttsProviderName, type TtsProviderName, type TtsVoice } from "@/lib/voice/tts";
import { cursorTokenSecret, signCursorToken } from "./token";
import { talkAllowance } from "./metering";
import { cursorVisionProvider, type CursorVisionProvider } from "./brain";

export interface CursorVoiceChoice {
  provider: TtsProviderName;
  id: string;
  label: string;
}

/** The saved choice (UserPreference.voice.cursor), if it is for the provider in use. */
export function savedCursorVoice(voicePref: Record<string, unknown> | null | undefined): CursorVoiceChoice | null {
  const v = (voicePref ?? {})["cursor"] as Partial<CursorVoiceChoice> | undefined;
  if (!v || typeof v.id !== "string" || typeof v.provider !== "string") return null;
  return { provider: v.provider as TtsProviderName, id: v.id, label: typeof v.label === "string" ? v.label : v.id };
}

export async function getCursorVoice(userId: string): Promise<CursorVoiceChoice | null> {
  const prefs = await getUserPreferences(userId);
  return savedCursorVoice(prefs.voice);
}

/**
 * Save the person's voice — only an id the provider itself lists (never an
 * invented one). Returns the saved choice.
 */
export async function setCursorVoice(userId: string, voiceId: string, deps: { list?: (p: TtsProviderName) => Promise<TtsVoice[]> } = {}): Promise<CursorVoiceChoice> {
  const provider = ttsProviderName();
  if (provider === "none") throw Object.assign(new Error("Spoken answers are not configured on this server."), { status: 503, code: "tts_not_configured" });
  const voices = await (deps.list ?? ((p) => listTtsVoices(p)))(provider);
  const v = voices.find((x) => x.id === voiceId);
  if (!v) throw Object.assign(new Error("That voice isn't available. Pick one from the list."), { status: 400, code: "tts_bad_voice" });
  const prefs = await getUserPreferences(userId);
  const choice: CursorVoiceChoice = { provider, id: v.id, label: v.label };
  await setUserPreferences(userId, { voice: { ...(prefs.voice ?? {}), cursor: choice } });
  return choice;
}

export interface CursorSessionPayload {
  token: string | null;
  expiresAt: number | null;
  workspaceId: string;
  user: { id: string; name: string | null };
  voice: { id: string | null; label: string };
  limits: { talkMinutesIncluded: number | null; talkMinutesUsed: number; byok: boolean };
  providers: { stt: SttProviderName; tts: TtsProviderName; vision: CursorVisionProvider };
}

export async function cursorSession(caller: { userId: string; name: string | null; workspaceId: string }): Promise<CursorSessionPayload> {
  const secret = cursorTokenSecret();
  const signed = secret ? signCursorToken({ userId: caller.userId, workspaceId: caller.workspaceId }, secret) : null;
  const tts = ttsProviderName();
  const [voice, allowance, keys, vision] = await Promise.all([
    getCursorVoice(caller.userId).catch(() => null),
    talkAllowance(caller.workspaceId),
    loadWorkspaceModelKeys(caller.workspaceId).catch(() => ({})),
    cursorVisionProvider(caller.workspaceId),
  ]);
  const usable = voice && voice.provider === tts ? voice : null;
  return {
    token: signed?.token ?? null,
    expiresAt: signed?.expiresAt ?? null,
    workspaceId: caller.workspaceId,
    user: { id: caller.userId, name: caller.name },
    voice: usable ? { id: usable.id, label: usable.label } : { id: null, label: "Default" },
    limits: { talkMinutesIncluded: allowance.included, talkMinutesUsed: allowance.used, byok: Object.keys(keys).length > 0 },
    providers: { stt: sttProviderName(), tts, vision },
  };
}
