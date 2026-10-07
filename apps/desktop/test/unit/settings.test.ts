import { describe, expect, it, vi } from "vitest";
import { formatHotkey, HoldDetector, hotkeyProblem, parseHotkey, type HoldSignal } from "../../src/shared/hotkeys";
import { checkServerUrl, defaultSettings, loadSettings, validateSettings } from "../../src/shared/settings";
import { floatToPcm16, resample, sttCloseMessage, sttPlan, TranscriptAssembler } from "../../src/shared/stt";
import { NotificationDiffer, trayState } from "../../src/shared/tray-state";
import { updaterConfig } from "../../src/shared/updater-config";

describe("settings validation", () => {
  const base = defaultSettings("darwin");

  it("defaults: Ctrl+Option hold key, hosted URL, password managers excluded, no keys stored", () => {
    expect(base.holdKey).toBe("Control+Alt");
    expect(base.serverUrl).toBe("https://app.shapesos.com");
    expect(base.exclusions).toContain("1Password");
    expect(JSON.stringify(base)).not.toMatch(/apiKey|secret|token/i);
    expect(formatHotkey(base.holdKey, "darwin")).toBe("⌃⌥");
    expect(formatHotkey(defaultSettings("win32").holdKey, "win32")).toBe("Ctrl+Alt");
  });

  it("server URL: https, or http only for local/LAN self-hosts; normalised", () => {
    expect(checkServerUrl("https://os.example.com/")).toEqual({ ok: true, url: "https://os.example.com" });
    expect(checkServerUrl("https://example.com/shapes/")).toEqual({ ok: true, url: "https://example.com/shapes" });
    expect(checkServerUrl("http://localhost:3000")).toEqual({ ok: true, url: "http://localhost:3000" });
    expect(checkServerUrl("http://192.168.1.20:3000")).toMatchObject({ ok: true });
    expect(checkServerUrl("http://example.com")).toMatchObject({ ok: false });
    expect(checkServerUrl("ftp://example.com")).toMatchObject({ ok: false });
    expect(checkServerUrl("https://user:pw@example.com")).toMatchObject({ ok: false });
    expect(checkServerUrl("https://example.com/?a=1")).toMatchObject({ ok: false });
    expect(checkServerUrl("not a url")).toMatchObject({ ok: false });
  });

  it("validates fields and reports each problem", () => {
    const r = validateSettings(
      {
        serverUrl: "http://evil.example",
        holdKey: "K",
        stopKey: "Control",
        spotlightKey: "Space",
        exclusions: ["url:bad host"],
        agentDefaultUsd: -1,
        speakAnswers: "yes",
        updateChannel: "nightly",
      },
      base,
      "darwin",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["agentDefaultUsd", "exclusions", "holdKey", "serverUrl", "speakAnswers", "spotlightKey", "stopKey", "updateChannel"].sort(),
      );
    }
  });

  it("accepts a good patch and rejects duplicate global shortcuts and default > ceiling", () => {
    const ok = validateSettings({ holdKey: "Control+Alt+Space", toggleKey: "Control+Shift+T", agentCeilingUsd: 25 }, base, "darwin");
    expect(ok.ok && ok.settings.holdKey).toBe("Control+Alt+Space");
    const dup = validateSettings({ spotlightKey: "Command+Shift+Space" }, base, "darwin");
    expect(dup.ok).toBe(false);
    const cap = validateSettings({ agentDefaultUsd: 20, agentCeilingUsd: 5 }, base, "darwin");
    expect(cap.ok).toBe(false);
  });

  it("loading bad stored JSON keeps the good fields and defaults the rest", () => {
    const s = loadSettings({ serverUrl: "https://os.example.com", holdKey: "nonsense+++" }, "win32");
    expect(s.serverUrl).toBe("https://os.example.com");
    expect(s.holdKey).toBe("Control+Alt");
    expect(loadSettings("garbage", "win32")).toEqual(defaultSettings("win32"));
  });

  it("hotkey parsing", () => {
    expect(parseHotkey("CommandOrControl+Shift+K", "darwin")).toEqual({ modifiers: ["shift", "meta"], key: "k" });
    expect(parseHotkey("CommandOrControl+Shift+K", "win32")).toEqual({ modifiers: ["control", "shift"], key: "k" });
    expect(parseHotkey("Ctrl+Ctrl", "win32")).toBeNull();
    expect(hotkeyProblem("Control", "hold", "win32")).not.toBeNull();
    expect(hotkeyProblem("Control+Alt", "hold", "win32")).toBeNull();
    expect(hotkeyProblem("Escape", "stop", "win32")).toBeNull();
  });
});

describe("hold detector (key DOWN/UP → talk)", () => {
  function setup() {
    const signals: HoldSignal[] = [];
    let pending: (() => void) | null = null;
    const d = new HoldDetector(parseHotkey("Control+Alt", "darwin")!, parseHotkey("Escape", "darwin"), (s) => signals.push(s), {
      minHoldMs: 150,
      now: () => 0,
      setTimer: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    });
    return { d, signals, fire: () => pending?.() };
  }

  it("starts after the hold delay and ends on release", () => {
    const { d, signals, fire } = setup();
    d.feed({ type: "down", key: "control" });
    d.feed({ type: "down", key: "alt" });
    expect(signals).toEqual([]);
    fire();
    expect(signals).toEqual(["start"]);
    d.feed({ type: "down", key: "alt" }); // auto-repeat
    d.feed({ type: "up", key: "alt" });
    expect(signals).toEqual(["start", "end"]);
  });

  it("another key while arming means a different shortcut (no talk)", () => {
    const { d, signals, fire } = setup();
    d.feed({ type: "down", key: "control" });
    d.feed({ type: "down", key: "alt" });
    d.feed({ type: "down", key: "t" });
    fire();
    expect(signals).toEqual([]);
    d.feed({ type: "up", key: "t" });
    d.feed({ type: "up", key: "alt" });
    d.feed({ type: "up", key: "control" });
    d.feed({ type: "down", key: "control" });
    d.feed({ type: "down", key: "alt" });
    fire();
    expect(signals).toEqual(["start"]);
  });

  it("the stop key emits stop", () => {
    const { d, signals } = setup();
    d.feed({ type: "down", key: "escape" });
    expect(signals).toEqual(["stop"]);
  });
});

describe("speech-to-text messages", () => {
  it("assembles AssemblyAI v3 turns", () => {
    const a = new TranscriptAssembler();
    a.feed(JSON.stringify({ type: "Begin", id: "x" }));
    a.feed(JSON.stringify({ type: "Turn", transcript: "where do", end_of_turn: false }));
    expect(a.live).toBe("where do");
    a.feed(JSON.stringify({ type: "Turn", transcript: "Where do I approve?", end_of_turn: true }));
    a.feed(JSON.stringify({ type: "Turn", transcript: "a pay run", end_of_turn: false }));
    expect(a.final).toBe("Where do I approve? a pay run");
  });

  it("assembles Deepgram results and the ShapesOS mock", () => {
    const d = new TranscriptAssembler();
    d.feed(JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: "hello" }] }, is_final: false }));
    d.feed(JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: "hello there" }] }, is_final: true }));
    expect(d.final).toBe("hello there");
    const m = new TranscriptAssembler();
    m.feed(JSON.stringify({ type: "transcript", text: "yes", final: true }));
    m.feed("not json");
    expect(m.final).toBe("yes");
  });

  it("plans the STT transport from the transcribe-token response (authVia, mock SSE)", () => {
    const aai = sttPlan({ provider: "assemblyai", wsUrl: "wss://streaming.assemblyai.com/v3/ws", token: "tok", sampleRate: 16000, authVia: "query_token" });
    expect(aai?.transport).toBe("renderer-ws");
    expect(aai && "url" in aai ? aai.url : "").toContain("token=tok");
    expect(aai && "url" in aai ? aai.url : "").toContain("sample_rate=16000");
    // Deepgram: Authorization header, so the MAIN process opens the socket.
    const dg = sttPlan({ provider: "deepgram", wsUrl: "wss://api.deepgram.com/v1/listen", token: "jwt", sampleRate: 16000, authVia: "bearer_header" });
    expect(dg).toMatchObject({ transport: "main-ws", headers: { Authorization: "Bearer jwt" } });
    expect(dg && "url" in dg ? dg.url : "").not.toContain("jwt");
    // Without authVia, Deepgram still defaults to the header.
    expect(sttPlan({ provider: "deepgram", wsUrl: "wss://api.deepgram.com/v1/listen", token: "jwt", sampleRate: 16000 })?.transport).toBe("main-ws");
    // The labelled mock is an https SSE URL read by main (no microphone).
    expect(sttPlan({ provider: "mock", wsUrl: "https://app.example.com/api/cursor/mock-stt", token: "t", sampleRate: 16000 })).toEqual({
      transport: "main-sse",
      url: "https://app.example.com/api/cursor/mock-stt",
    });
    expect(sttPlan({ provider: "none", wsUrl: "wss://x", token: "t", sampleRate: 16000 })).toBeNull();
    expect(sttPlan({ provider: "assemblyai", wsUrl: "https://x", token: "t", sampleRate: 16000 })).toBeNull();
    expect(sttPlan({ provider: "assemblyai", wsUrl: "wss://x", token: "", sampleRate: 16000 })).toBeNull();
    expect(sttPlan({ provider: "deepgram", wsUrl: "not a url", token: "t", sampleRate: 16000 })).toBeNull();
    expect(sttCloseMessage("assemblyai")).toBe('{"type":"Terminate"}');
  });

  it("converts float samples to PCM s16le and resamples", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5]));
    const v = new DataView(pcm.buffer);
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true)]).toEqual([0, 32767, -32768, 16384]);
    expect(resample(new Float32Array(480), 48000, 16000)).toHaveLength(160);
  });
});

describe("tray and notifications", () => {
  it("counts needs-you and running agents (lead → sub-agents)", () => {
    const s = trayState({
      counts: { total: 5, actionable: 3 },
      activity: {
        tree: {
          lead: { key: "lead", name: "Lead", status: "running", line: "Routing", href: null },
          branches: [
            { key: "researcher", name: "Researcher", status: "running", line: "Reading", href: null, children: [] },
            { key: "drafter", name: "Drafter", status: "done", line: "Done", href: null },
          ],
        },
      },
      background: [],
      signedIn: true,
    });
    expect(s.needsYou).toBe(3);
    expect(s.running.map((r) => r.name)).toEqual(["Lead", "Researcher"]);
    expect(s.title).toBe("3");
    expect(s.tooltip).toBe("ShapesOS: 3 need you, 2 running");
  });

  it("notifies new unread items once, never the backlog at launch", () => {
    const n = new NotificationDiffer();
    const item = (id: string, readAt: string | null = null) => ({ id, kind: "k", title: id, body: null, href: null, readAt, createdAt: "" });
    expect(n.next([item("a"), item("b")])).toEqual([]);
    expect(n.next([item("c"), item("a"), item("d", "2026-10-06")]).map((i) => i.id)).toEqual(["c"]);
    expect(n.next([item("c")])).toEqual([]);
  });
});

describe("updater config (electron-updater generic → R2)", () => {
  const base = { channel: "stable" as const, autoUpdate: true, isPackaged: true, platform: "darwin" };

  it("points the generic provider at DESKTOP_UPDATE_URL/<channel>", () => {
    expect(updaterConfig({ ...base, builtInUrl: "https://dl.shapesos.com/desktop/" })).toEqual({
      enabled: true,
      feed: { provider: "generic", url: "https://dl.shapesos.com/desktop/stable", channel: "latest" },
      channel: "stable",
      reason: null,
      allowPrerelease: false,
    });
    expect(updaterConfig({ ...base, channel: "beta", envUrl: "https://mine.example/u", builtInUrl: "https://dl.shapesos.com" }).feed?.url).toBe(
      "https://mine.example/u/beta",
    );
  });

  it("is off, with a reason, when there is no feed, http, dev builds or Linux", () => {
    expect(updaterConfig({ ...base }).reason).toBe("No update feed is configured for this build.");
    expect(updaterConfig({ ...base, builtInUrl: "http://dl.example" }).enabled).toBe(false);
    expect(updaterConfig({ ...base, builtInUrl: "https://dl.example", isPackaged: false }).enabled).toBe(false);
    expect(updaterConfig({ ...base, builtInUrl: "https://dl.example", platform: "linux" }).enabled).toBe(false);
    expect(updaterConfig({ ...base, builtInUrl: "https://dl.example", autoUpdate: false }).enabled).toBe(false);
  });

  it("is referenced by the builder config's publish block", async () => {
    const fs = await import("node:fs");
    const yml = fs.readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(yml).toMatch(/provider: generic/);
    expect(yml).toMatch(/\$\{env\.DESKTOP_UPDATE_URL\}\/\$\{env\.DESKTOP_CHANNEL\}/);
  });
});

void vi;
