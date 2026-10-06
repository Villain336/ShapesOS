// ShapesOS Desktop: the cursor companion's conductor.
//
// Hold the talk key → listen (STT) + see (screenshots, ONLY while held) →
// release → a turn streams back from ShapesOS → captions + speech + pointer
// + drawings + proposal / dictation cards. Short spoken answers ("yes",
// "no") decide a pending card locally under the approval gate; "…in the
// background, max $3" starts agent mode. The stop key cuts everything.

import { BrowserWindow, screen, systemPreferences } from "electron";
import type { CursorSession, Point2, ProposalEvent, TurnApp, TurnEvent, TurnRequest, UiMapEntry } from "../shared/contract";
import { CaptureMachine, type Shot } from "../shared/capture-machine";
import {
  numberDisplays,
  rectCenter,
  resolveElementPoint,
  resolveScreenPoint,
  localToGlobal,
  uiMapForTurn,
  type NumberedDisplay,
  type Rect,
} from "../shared/coords";
import { gateClick, gateVoice, parseVoiceAnswer, proposalHint, tierLabel } from "../shared/approval";
import { confirmDictation, previewText } from "../shared/dictation";
import { exclusionMessage, matchExclusion, type FocusedApp } from "../shared/exclusions";
import { decideCap, parseAgentIntent, usd } from "../shared/intents";
import type { DesktopSettings } from "../shared/settings";
import { ApiError, type ShapesApi } from "./api";
import { captureScreens } from "./capture";
import { focusedApp } from "./focused-app";
import type { HoldKeyService } from "./hold-key";
import type { OverlayManager } from "./overlay-manager";
import { electronClipboard, pastePort } from "./paste";
import { SentenceBuffer, type SpeechIn, type SpeechOut } from "./speech";
import type { TrayController } from "./tray";

export interface ControllerDeps {
  api: ShapesApi;
  overlays: OverlayManager;
  speechIn: SpeechIn;
  speechOut: SpeechOut;
  holdKey: HoldKeyService;
  tray: TrayController;
  settings: () => DesktopSettings;
  mainWindow: () => BrowserWindow | null;
  getUiMap: () => Promise<UiMapEntry[] | null>;
  notify: (title: string, body: string, href: string | null) => void;
}

interface PressContext {
  gen: number;
  displays: NumberedDisplay[];
  app: TurnApp | null;
  excluded: string | null;
  uiMap: UiMapEntry[] | null;
  contentBounds: Rect | null;
  zoom: number;
  session: CursorSession | null;
}

/** What the test hook (and Settings) can observe. Never contains images. */
export interface ControllerDebug {
  holds: { start: number; end: number | null }[];
  turns: { transcript: string; screenshots: number; uiMap: number; app: string | null; mode: string }[];
  approvals: { approvalId: string; decision: string; via: string; status: number | null }[];
  voiceIgnored: { approvalId: string; tier: number }[];
  agentRuns: { runId: string; maxUsd: number; goal: string }[];
  points: { displayId: number; x: number; y: number; label: string }[];
  captions: string[];
}

export class CursorController {
  readonly capture: CaptureMachine;
  private gen = 0;
  private holding = false;
  private press: PressContext | null = null;
  private pressReady: Promise<void> | null = null;
  private turnAbort: AbortController | null = null;
  private conversationId: string | undefined;
  private proposal: { ev: ProposalEvent; anchor: Point2 | undefined } | null = null;
  private dictation: string | null = null;
  private lastPointGlobal: Point2 | undefined;
  private captionTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCtx: PressContext | null = null;
  readonly debug: ControllerDebug = {
    holds: [],
    turns: [],
    approvals: [],
    voiceIgnored: [],
    agentRuns: [],
    points: [],
    captions: [],
  };

  /** Test builds only: replace OS-dependent inputs (see test-hooks.ts). */
  testOverrides: {
    focusedApp?: () => Promise<FocusedApp | null>;
    transcript?: string | null;
    capture?: () => Promise<Shot[]>;
  } = {};

  constructor(private d: ControllerDeps) {
    this.capture = new CaptureMachine({
      capture: () => (this.testOverrides.capture ? this.testOverrides.capture() : captureScreens(this.d.settings().captureScreens)),
      indicator: (on) => this.d.overlays.capturing(on),
      refreshMs: 4000,
      onError: () => this.caption("Couldn't capture the screen. Check screen recording permission in Settings.", "error"),
    });
  }

  // ---- talk key ---------------------------------------------------------------

  async holdStart(): Promise<void> {
    if (this.holding) return;
    this.holding = true;
    const gen = ++this.gen;
    this.debug.holds.push({ start: Date.now(), end: null });
    // Pressing the key again interrupts the answer.
    this.d.speechOut.stop();
    this.turnAbort?.abort();
    this.d.holdKey.armStop(this.d.settings().stopKey);
    this.d.overlays.listening(true);
    this.caption("Listening…", "listening", false);

    let resolveReady!: () => void;
    this.pressReady = new Promise((r) => (resolveReady = r));
    try {
      const [app, session] = await Promise.all([this.whichApp(), this.d.api.ensureSession().catch((e: unknown) => e)]);
      if (gen !== this.gen) return;
      const sess = session instanceof Error || !session ? null : (session as CursorSession);
      const displays = this.displays();
      const ctx: PressContext = {
        gen,
        displays,
        app: app.turnApp,
        excluded: null,
        uiMap: null,
        contentBounds: null,
        zoom: 1,
        session: sess,
      };
      this.press = ctx;

      // The capture decision: never without the key held, never for an
      // excluded or unknown app, never when vision isn't configured.
      let reason: string | null = null;
      if (!sess) reason = session instanceof ApiError ? session.message : "Can't reach ShapesOS.";
      else if (sess.providers.vision === "none") reason = "Screen understanding isn't configured on this server.";
      else if (!app.focused) reason = "Couldn't tell which app is in front, so nothing was captured.";
      else {
        const hit = matchExclusion(app.focused, this.d.settings().exclusions);
        if (hit) {
          reason = exclusionMessage(app.focused, hit);
          ctx.excluded = reason;
        } else if (process.platform === "darwin" && !this.testOverrides.capture && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
          reason = "Screen recording is off for ShapesOS. Turn it on in Settings.";
        }
      }
      if (this.holding && gen === this.gen) this.capture.press(reason ? { allowed: false, reason } : { allowed: true });

      // Inside ShapesOS: also the page's element map.
      if (app.turnApp?.isShapesOS) {
        const win = this.d.mainWindow();
        const map = await this.d.getUiMap();
        if (win && map) {
          ctx.uiMap = map;
          ctx.contentBounds = win.getContentBounds();
          ctx.zoom = win.webContents.getZoomFactor();
        }
      }

      // Voice in.
      if (this.testOverrides.transcript === undefined) {
        if (!sess) this.caption(session instanceof ApiError ? session.message : "Can't reach ShapesOS.", "error", false);
        else if (sess.providers.stt === "none") {
          this.caption("Speech-to-text isn't configured on this server. Type instead.", "notice", false);
        } else {
          this.d.speechIn.onLive = (t) => {
            if (this.holding) this.caption(t || "Listening…", "listening", false);
          };
          const ok = await this.d.speechIn.start().catch((e: unknown) => {
            this.d.speechIn.error = e instanceof Error ? e.message : String(e);
            return false;
          });
          if (!ok) this.caption(this.d.speechIn.error ?? "Couldn't start listening.", "error", false);
        }
      }
    } finally {
      resolveReady();
    }
  }

  async holdEnd(): Promise<void> {
    if (!this.holding) return;
    this.holding = false;
    const last = this.debug.holds[this.debug.holds.length - 1];
    if (last) last.end = Date.now();
    this.d.overlays.listening(false);
    await this.pressReady;
    const ctx = this.press;
    this.press = null;
    const scripted = this.testOverrides.transcript;
    const transcript = scripted !== undefined && scripted !== null ? scripted : await this.d.speechIn.stop();
    const { shots, blockedReason } = await this.capture.release();
    if (!transcript) {
      this.caption("I didn't catch that. Hold the key while you talk, or type instead.", "notice");
      this.disarmSoon();
      return;
    }
    await this.utterance(transcript, { shots, blockedReason, ctx, spoken: true });
  }

  /** The typing fallback: no key held, so no screenshot (the rule). */
  async typed(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    this.d.holdKey.armStop(this.d.settings().stopKey);
    const app = await this.whichApp();
    await this.utterance(t, {
      shots: [],
      blockedReason: null,
      ctx: { gen: this.gen, displays: this.displays(), app: app.turnApp, excluded: null, uiMap: null, contentBounds: null, zoom: 1, session: null },
      spoken: false,
    });
  }

  /** Stop key: cut the answer, the turn, listening and capture at once. */
  stop(): void {
    this.d.speechOut.stop();
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (this.holding) {
      this.holding = false;
      this.d.speechIn.cancel();
      this.d.overlays.listening(false);
    }
    this.capture.discard();
    this.d.overlays.capturing(false);
    this.d.overlays.clearMarks();
    this.caption(null);
    this.d.holdKey.armStop(null);
  }

  // ---- utterances ---------------------------------------------------------------

  private async utterance(
    text: string,
    o: { shots: Shot[]; blockedReason: string | null; ctx: PressContext | null; spoken: boolean },
  ): Promise<void> {
    // A short answer to a pending card.
    const answer = parseVoiceAnswer(text);
    if (answer && this.proposal) {
      if (!o.spoken) {
        this.caption("Use the card's buttons to approve or reject.", "notice");
        return;
      }
      await this.voiceDecision(answer);
      return;
    }
    if (answer && this.dictation !== null) {
      if (answer === "yes") await this.dictationAction("paste");
      else await this.dictationAction("cancel");
      return;
    }
    const agent = parseAgentIntent(text);
    if (agent) {
      await this.startAgent(agent.goal, agent.maxUsd);
      return;
    }
    await this.runTurn(text, o);
  }

  private async runTurn(
    transcript: string,
    o: { shots: Shot[]; blockedReason: string | null; ctx: PressContext | null },
  ): Promise<void> {
    this.turnAbort?.abort();
    const abort = new AbortController();
    this.turnAbort = abort;
    this.d.overlays.clearMarks();
    const ctx = o.ctx;
    this.turnCtx = ctx;
    const body: TurnRequest = { transcript, screenshots: o.shots, mode: "answer" };
    if (this.conversationId) body.conversationId = this.conversationId;
    if (ctx?.app) {
      // An excluded app is named, but its title/URL are not sent.
      body.app = ctx.excluded ? { name: ctx.app.name, isShapesOS: false } : ctx.app;
    }
    if (ctx?.uiMap && ctx.contentBounds) {
      const m = uiMapForTurn(ctx.uiMap, ctx.contentBounds, ctx.zoom, ctx.displays);
      if (m.entries.length) body.uiMap = m.entries;
    }
    this.debug.turns.push({
      transcript,
      screenshots: body.screenshots.length,
      uiMap: body.uiMap?.length ?? 0,
      app: body.app?.name ?? null,
      mode: body.mode ?? "answer",
    });

    let answer = "";
    if (o.blockedReason && ctx?.excluded) {
      answer = `${o.blockedReason} `;
      this.d.speechOut.say(o.blockedReason);
    }
    this.caption(answer || "Thinking…", "answering", false);
    const sentences = new SentenceBuffer();
    this.d.speechOut.enabled = this.d.settings().speakAnswers;
    this.d.speechOut.provider = ctx?.session?.providers.tts ?? this.d.api.current?.providers.tts ?? "none";
    try {
      for await (const ev of this.d.api.turn(body, abort.signal)) {
        if (abort.signal.aborted) break;
        if (ev.type === "text_delta") {
          answer += ev.text;
          this.caption(answer, "answering", false);
          for (const s of sentences.push(ev.text)) this.d.speechOut.say(s);
          continue;
        }
        if (ev.type === "done") {
          for (const s of sentences.flush()) this.d.speechOut.say(s);
        }
        this.event(ev, transcript);
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.caption(msg, "error");
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
    if (!abort.signal.aborted) {
      await this.d.speechOut.idle();
      this.disarmSoon();
    }
  }

  private event(ev: TurnEvent, transcript: string): void {
    const ctx = this.turnCtx;
    const displays = ctx?.displays ?? this.displays();
    switch (ev.type) {
      case "turn_started":
        this.conversationId = ev.conversationId;
        return;
      case "point": {
        if ("elementId" in ev) {
          const hit = this.resolveElement(ev.elementId);
          if (hit) this.pointAt(hit.displayId, hit.local, ev.label);
          return;
        }
        const r = resolveScreenPoint(displays, ev);
        if (r) this.pointAt(r.display.id, r.local, ev.label);
        return;
      }
      case "draw": {
        const first = resolveScreenPoint(displays, { screen: ev.screen, ...ev.points[0]! });
        if (!first) return;
        const pts = ev.points.map((p) => resolveScreenPoint(displays, { screen: ev.screen, ...p })!.local);
        this.d.overlays.draw(first.display.id, { kind: ev.kind, points: pts, step: ev.step, label: ev.label });
        return;
      }
      case "proposal": {
        let anchor: Point2 | undefined = this.lastPointGlobal;
        if (ev.elementId) {
          const hit = this.resolveElement(ev.elementId);
          if (hit) anchor = hit.global;
        }
        this.proposal = { ev, anchor };
        this.d.overlays.proposal(
          {
            approvalId: ev.approvalId,
            tool: ev.tool,
            summary: ev.summary,
            tierLabel: tierLabel(ev),
            hint: proposalHint(ev),
            voiceApprovable: ev.voiceApprovable,
            status: "pending",
          },
          anchor,
        );
        return;
      }
      case "dictation":
        this.dictation = ev.text;
        this.d.overlays.dictation({ text: previewText(ev.text), status: "preview", message: null });
        return;
      case "agent_started":
        void this.trackAgent(ev.runId, ev.maxUsd, transcript);
        return;
      case "error":
        this.caption(ev.message, "error");
        this.d.speechOut.say(ev.message);
        return;
      default:
        return;
    }
  }

  private resolveElement(elementId: string): { displayId: number; local: Point2; global: Point2 } | null {
    const win = this.d.mainWindow();
    const ctx = this.turnCtx;
    if (!win || !ctx?.uiMap) return null;
    const bounds = win.getContentBounds();
    const r = resolveElementPoint(ctx.uiMap, elementId, bounds, win.webContents.getZoomFactor(), screen.getAllDisplays());
    if (!r) return null;
    return { displayId: r.display.id, local: r.local, global: rectCenter(r.rect) };
  }

  private pointAt(displayId: number, local: Point2, label: string): void {
    const d = screen.getAllDisplays().find((x) => x.id === displayId);
    if (d) this.lastPointGlobal = localToGlobal(local, d);
    this.debug.points.push({ displayId, x: Math.round(local.x), y: Math.round(local.y), label });
    this.d.overlays.pointAt(displayId, local, label);
  }

  // ---- approvals -----------------------------------------------------------------

  private async voiceDecision(answer: "yes" | "no"): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const g = gateVoice(p.ev, answer);
    if (g.action === "ignore") {
      this.debug.voiceIgnored.push({ approvalId: p.ev.approvalId, tier: p.ev.tier });
      this.d.overlays.updateProposal((c) => ({ ...c, hint: g.say }));
      this.caption(g.say, "notice");
      this.d.speechOut.provider = this.d.api.current?.providers.tts ?? "none";
      this.d.speechOut.say(g.say);
      return;
    }
    await this.sendDecision(g.request, g.say);
  }

  /** A click on the card (the only path for Tier 3 and destructive actions). */
  async clickDecision(approvalId: string, decision: "approve" | "reject"): Promise<void> {
    const p = this.proposal;
    if (!p || p.ev.approvalId !== approvalId) return;
    await this.sendDecision(gateClick(p.ev, decision), decision === "approve" ? "Approved." : "Rejected.");
  }

  private async sendDecision(req: { approvalId: string; decision: "approve" | "reject"; via: "voice" | "click" }, say: string): Promise<void> {
    const rec: ControllerDebug["approvals"][number] = { ...req, status: null };
    this.debug.approvals.push(rec);
    this.d.overlays.updateProposal((c) => ({ ...c, status: "sending" }));
    try {
      await this.d.api.approve(req);
      rec.status = 200;
      const done = req.decision === "approve" ? "approved" : "rejected";
      this.d.overlays.updateProposal((c) => ({ ...c, status: done }));
      this.caption(say, "notice");
      this.proposal = null;
      setTimeout(() => {
        if (!this.proposal) this.d.overlays.proposal(null);
      }, 1800);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      rec.status = status;
      const msg =
        e instanceof ApiError && e.code === "voice_not_allowed"
          ? "Click to approve; voice can't approve this."
          : e instanceof Error
            ? e.message
            : "Couldn't send that.";
      this.d.overlays.updateProposal((c) => ({ ...c, status: "pending", hint: msg }));
      this.caption(msg, "error");
    }
    void this.d.tray.refresh();
  }

  // ---- dictation --------------------------------------------------------------------

  async dictationAction(action: "paste" | "cancel"): Promise<void> {
    const text = this.dictation;
    if (text === null) return;
    if (action === "cancel") {
      this.dictation = null;
      this.d.overlays.dictation(null);
      return;
    }
    this.d.overlays.dictation({ text: previewText(text), status: "pasting", message: null });
    const r = await confirmDictation(text, { clipboard: electronClipboard, paste: pastePort(), platform: process.platform });
    this.dictation = null;
    this.d.overlays.dictation({ text: previewText(text), status: "done", message: r.say });
    setTimeout(() => {
      if (this.dictation === null) this.d.overlays.dictation(null);
    }, 2500);
  }

  // ---- agent mode -----------------------------------------------------------------

  async startAgent(goal: string, spoken: number | null): Promise<void> {
    const s = this.d.settings();
    const cap = decideCap(spoken, { defaultUsd: s.agentDefaultUsd, ceilingUsd: s.agentCeilingUsd });
    this.d.speechOut.provider = this.d.api.current?.providers.tts ?? (await this.d.api.ensureSession().catch(() => null))?.providers.tts ?? "none";
    if (!cap.ok) {
      this.caption(cap.say, "notice");
      this.d.speechOut.say(cap.say);
      return;
    }
    try {
      const { runId } = await this.d.api.agent({ goal, maxUsd: cap.maxUsd, conversationId: this.conversationId });
      const say = `Started in the background, max ${usd(cap.maxUsd)}. I'll tell you when it's done.${cap.note ? ` ${cap.note}` : ""}`;
      this.caption(say, "notice");
      this.d.speechOut.say(say);
      void this.trackAgent(runId, cap.maxUsd, goal);
    } catch (e) {
      this.caption(e instanceof Error ? e.message : "Couldn't start the background run.", "error");
    }
  }

  private async trackAgent(runId: string, maxUsd: number, goal: string): Promise<void> {
    if (this.debug.agentRuns.some((r) => r.runId === runId)) return;
    this.debug.agentRuns.push({ runId, maxUsd, goal });
    const short = goal.length > 60 ? `${goal.slice(0, 59)}…` : goal;
    this.d.tray.setBackground({ runId, goal: short, maxUsd, line: "Starting", status: "running" });
    void this.d.tray.refresh();
    const abort = new AbortController();
    let summary: string | null = null;
    let status: "done" | "failed" | "needs" = "done";
    try {
      for await (const m of this.d.api.watchRun(runId, abort.signal)) {
        if (m.event === "delegation") {
          try {
            const v = JSON.parse(m.data) as { runStatus?: string; plans?: { line?: string; tasks?: { summary?: string | null }[] }[] };
            const line = v.plans?.[0]?.line ?? v.runStatus ?? "Running";
            const sums = (v.plans ?? []).flatMap((p) => (p.tasks ?? []).map((t) => t.summary)).filter((x): x is string => !!x);
            if (sums.length) summary = sums.join(" ").slice(0, 200);
            if (v.runStatus === "failed") status = "failed";
            if (v.runStatus === "awaiting_confirmation") status = "needs";
            this.d.tray.setBackground({ runId, goal: short, maxUsd, line, status: "running" });
          } catch {
            /* malformed view: keep going */
          }
        } else if (m.event === "end") {
          break;
        }
      }
    } catch {
      this.d.tray.setBackground({ runId, goal: short, maxUsd, line: "Open the run to follow it", status: "running" });
      return;
    }
    const words =
      status === "failed"
        ? `The background run "${short}" failed. Open it in ShapesOS to see why.`
        : status === "needs"
          ? `The background run "${short}" needs you.`
          : `Done. ${summary ?? short}`;
    this.d.tray.setBackground({ runId, goal: short, maxUsd, line: status === "done" ? "Done" : status === "failed" ? "Failed" : "Needs you", status });
    this.d.notify(status === "done" ? "Background run done" : "Background run", words, `/dashboard/runs/${runId}`);
    this.d.speechOut.say(words);
    void this.d.tray.refresh();
  }

  // ---- helpers ------------------------------------------------------------------------

  private displays(): NumberedDisplay[] {
    const all = screen.getAllDisplays().map((x) => ({ id: x.id, bounds: x.bounds, scaleFactor: x.scaleFactor }));
    return numberDisplays(all, screen.getPrimaryDisplay().id);
  }

  private async whichApp(): Promise<{ focused: FocusedApp | null; turnApp: TurnApp | null }> {
    const win = this.d.mainWindow();
    if (win && !win.isDestroyed() && win.isFocused()) {
      const url = win.webContents.getURL();
      return {
        focused: { name: "ShapesOS", title: win.getTitle(), url },
        turnApp: { name: "ShapesOS", title: win.getTitle(), url, isShapesOS: true },
      };
    }
    const f = this.testOverrides.focusedApp ? await this.testOverrides.focusedApp() : await focusedApp();
    if (!f) return { focused: null, turnApp: null };
    return { focused: f, turnApp: { name: f.name, title: f.title, url: f.url, isShapesOS: false } };
  }

  private caption(text: string | null, kind: "listening" | "answering" | "notice" | "error" = "answering", autoHide = true): void {
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.captionTimer = null;
    if (text) this.debug.captions.push(text.slice(0, 200));
    if (this.debug.captions.length > 50) this.debug.captions.splice(0, this.debug.captions.length - 50);
    this.d.overlays.caption(text, kind);
    if (text && autoHide) this.captionTimer = setTimeout(() => this.d.overlays.caption(null), 6000);
  }

  private disarmSoon(): void {
    if (!this.d.speechOut.active && !this.turnAbort && !this.holding) this.d.holdKey.armStop(null);
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => this.d.overlays.caption(null), 6000);
  }
}
