// Phase 19A (WS=server): the cursor's speech providers against fake fetches —
// the platform key goes only to the provider, the desktop gets a short-lived
// token; nothing configured → "none" (never a mock in production); the
// labelled mock only with ALLOW_FAKE_PROVIDERS=1; TTS falls through.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASSEMBLYAI_TOKEN_URL, DEEPGRAM_GRANT_URL, mintSttToken, mockSttMessages, sttProviderName } from "@/lib/voice/stt";
import { ELEVENLABS_TTS_URL, OPENAI_SPEECH_URL, listTtsVoices, silentMp3, synthesizeSpeech, ttsProviderChain, ttsProviderName } from "@/lib/voice/tts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, (c: Call) => Response>): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    if (!key) return new Response("no route", { status: 599 });
    return routes[key]!({ url: u, init });
  }) as typeof fetch;
  return { f, calls };
}

describe("STT", () => {
  it("picks AssemblyAI, then Deepgram, else none; mock only with the opt-in", () => {
    assert.equal(sttProviderName({ ASSEMBLYAI_API_KEY: "a", DEEPGRAM_API_KEY: "d" }), "assemblyai");
    assert.equal(sttProviderName({ ASSEMBLYAI_API_KEY: "a", DEEPGRAM_API_KEY: "d", CURSOR_STT_PROVIDER: "deepgram" }), "deepgram");
    assert.equal(sttProviderName({ DEEPGRAM_API_KEY: "d" }), "deepgram");
    assert.equal(sttProviderName({ NODE_ENV: "production" }), "none");
    assert.equal(sttProviderName({ NODE_ENV: "development" }), "none");
    assert.equal(sttProviderName({ ALLOW_FAKE_PROVIDERS: "1" }), "mock");
  });
  it("AssemblyAI: key in the header, token + ws URL back", async () => {
    const { f, calls } = fakeFetch({ [ASSEMBLYAI_TOKEN_URL]: () => Response.json({ token: "tmp_123", expires_in_seconds: 60 }) });
    const t = await mintSttToken({ env: { ASSEMBLYAI_API_KEY: "secret-key" }, fetchImpl: f, now: 1_000 });
    assert.equal(t.provider, "assemblyai");
    assert.equal(t.token, "tmp_123");
    assert.equal(t.expiresAt, 61_000);
    assert.equal(t.sampleRate, 16000);
    assert.equal(t.encoding, "pcm_s16le");
    assert.equal(t.authVia, "query_token");
    assert.match(t.wsUrl, /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?sample_rate=16000&encoding=pcm_s16le/);
    assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "secret-key");
    assert.match(calls[0]!.url, /expires_in_seconds=60&max_session_duration_seconds=600/);
    assert.ok(!JSON.stringify(t).includes("secret-key"));
  });
  it("Deepgram: Token auth, bearer access token back", async () => {
    const { f, calls } = fakeFetch({ [DEEPGRAM_GRANT_URL]: () => Response.json({ access_token: "jwt.abc", expires_in: 30 }) });
    const t = await mintSttToken({ env: { DEEPGRAM_API_KEY: "dg-key" }, fetchImpl: f, now: 0 });
    assert.equal(t.provider, "deepgram");
    assert.equal(t.authVia, "bearer_header");
    assert.equal(t.expiresAt, 30_000);
    assert.match(t.wsUrl, /encoding=linear16&sample_rate=16000/);
    assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Token dg-key");
    assert.ok(!JSON.stringify(t).includes("dg-key"));
  });
  it("provider errors are 502, nothing configured is 503", async () => {
    const { f } = fakeFetch({ [ASSEMBLYAI_TOKEN_URL]: () => new Response("no", { status: 401 }) });
    await assert.rejects(mintSttToken({ env: { ASSEMBLYAI_API_KEY: "k" }, fetchImpl: f }), (e: unknown) => (e as { status: number }).status === 502);
    await assert.rejects(mintSttToken({ env: {} }), (e: unknown) => (e as { code: string }).code === "stt_not_configured");
  });
  it("the mock is labelled", async () => {
    const t = await mintSttToken({ env: { ALLOW_FAKE_PROVIDERS: "1" }, mockUrl: "https://x/api/cursor/mock-stt" });
    assert.equal(t.mock, true);
    assert.equal(t.provider, "mock");
    const msgs = mockSttMessages();
    assert.ok(msgs.every((m) => m.mock === true));
    assert.match(String(msgs[msgs.length - 2]!.transcript), /^Mock transcript/);
  });
});

describe("TTS", () => {
  it("chain order and none", () => {
    assert.deepEqual(ttsProviderChain({ ELEVENLABS_API_KEY: "e", VOICESTUDIO_URL: "http://vs", OPENAI_API_KEY: "o" }), ["elevenlabs", "voicestudio", "openai"]);
    assert.equal(ttsProviderName({}), "none");
    assert.equal(ttsProviderName({ ALLOW_FAKE_PROVIDERS: "1" }), "mock");
    assert.equal(ttsProviderName({ ALLOW_FAKE_PROVIDERS: "1", OPENAI_API_KEY: "o" }), "openai");
  });
  it("ElevenLabs streams with the person's voice, key only in the header", async () => {
    const { f, calls } = fakeFetch({ [ELEVENLABS_TTS_URL]: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }) });
    const out = await synthesizeSpeech({ text: "Hello", voice: "voice_abc", voiceProvider: "elevenlabs" }, { env: { ELEVENLABS_API_KEY: "el-key" }, fetchImpl: f });
    assert.equal(out.provider, "elevenlabs");
    assert.equal(out.voice, "voice_abc");
    assert.equal(out.mock, false);
    assert.match(calls[0]!.url, /\/v1\/text-to-speech\/voice_abc\/stream\?output_format=mp3_44100_128$/);
    assert.equal((calls[0]!.init!.headers as Record<string, string>)["xi-api-key"], "el-key");
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(body.text, "Hello");
  });
  it("falls through ElevenLabs → OpenAI when ElevenLabs fails", async () => {
    const { f } = fakeFetch({
      [ELEVENLABS_TTS_URL]: () => new Response("busy", { status: 503 }),
      [OPENAI_SPEECH_URL]: () => new Response(new Uint8Array([9]), { headers: { "content-type": "audio/mpeg" } }),
    });
    const out = await synthesizeSpeech({ text: "Hi", voice: "voice_abc", voiceProvider: "elevenlabs" }, { env: { ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v", OPENAI_API_KEY: "o" }, fetchImpl: f });
    assert.equal(out.provider, "openai");
    assert.equal(out.voice, "alloy", "another provider's voice id is never sent to OpenAI");
  });
  it("VoiceStudio uses a discovered voice", async () => {
    const out = await synthesizeSpeech(
      { text: "Hi" },
      { env: { VOICESTUDIO_URL: "http://vs" }, voiceStudio: { listVoices: async () => [{ voice_id: "demo0001", name: "Demo" }], synthesize: async () => Buffer.from([1]) } },
    );
    assert.equal(out.provider, "voicestudio");
    assert.equal(out.voice, "demo0001");
  });
  it("nothing configured → 503; the mock is a labelled silent clip", async () => {
    await assert.rejects(synthesizeSpeech({ text: "Hi" }, { env: {} }), (e: unknown) => (e as { status: number }).status === 503);
    const m = await synthesizeSpeech({ text: "Hi" }, { env: { ALLOW_FAKE_PROVIDERS: "1" } });
    assert.equal(m.mock, true);
    assert.equal(silentMp3().length, 4170);
    assert.deepEqual([...silentMp3().slice(0, 2)], [0xff, 0xfb]);
  });
  it("voices come from the provider (ElevenLabs list, OpenAI documented built-ins)", async () => {
    const { f } = fakeFetch({ "https://api.elevenlabs.io/v2/voices": () => Response.json({ voices: [{ voice_id: "v1", name: "Rachel" }, { name: "no id" }] }) });
    assert.deepEqual(await listTtsVoices("elevenlabs", { env: { ELEVENLABS_API_KEY: "e" }, fetchImpl: f }), [{ id: "v1", label: "Rachel" }]);
    const oa = await listTtsVoices("openai", { env: { OPENAI_API_KEY: "o" } });
    assert.ok(oa.some((v) => v.id === "alloy"));
  });
  it("OpenAI: tts-1 is offered only the voices it supports; gpt-4o-mini-tts gets all 13", async () => {
    const t1 = (await listTtsVoices("openai", { env: { OPENAI_API_KEY: "o" } })).map((v) => v.id);
    assert.equal(t1.length, 9);
    for (const v of ["ballad", "verse", "marin", "cedar"]) assert.ok(!t1.includes(v), v);
    const mini = await listTtsVoices("openai", { env: { OPENAI_API_KEY: "o", OPENAI_TTS_MODEL: "gpt-4o-mini-tts" } });
    assert.equal(mini.length, 13);
    // A saved gpt-4o-mini-tts voice is never sent to tts-1 (it would be refused).
    const sent: string[] = [];
    const f: typeof fetch = async (_u, init) => {
      sent.push(JSON.parse(String(init?.body)).voice);
      return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
    };
    await synthesizeSpeech({ text: "Hi", voice: "marin", voiceProvider: "openai" }, { env: { OPENAI_API_KEY: "o" }, fetchImpl: f });
    await synthesizeSpeech({ text: "Hi", voice: "marin", voiceProvider: "openai" }, { env: { OPENAI_API_KEY: "o", OPENAI_TTS_MODEL: "gpt-4o-mini-tts" }, fetchImpl: f });
    assert.deepEqual(sent, ["alloy", "marin"]);
  });
});
