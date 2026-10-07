// ShapesOS — Phase 19B (WS=panel): in-page behaviour tracker + human timing.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/simulation/browser.ts. TRACKER_SCRIPT is an
// init script injected before any navigation: scroll depth, per-section time
// (IntersectionObserver), clicks and hover dwell, read back through
// window.__drGetState(). detectRageClicks finds 3+ clicks within 800 ms on
// the same target. Analytics hosts are stripped so simulated visits never
// pollute real metrics. Pure: the Playwright side is lib/panel/browser.server.ts.

export const TRACKER_SCRIPT = `
(() => {
  if (window.__drInstalled) return;
  window.__drInstalled = true;
  var now = function () { return Date.now(); };
  var state = { maxScrollDepthPct: 0, sections: {}, clicks: [], hovers: [] };
  var describeTarget = function (el) {
    if (!(el instanceof Element)) return "unknown";
    var parts = [el.tagName.toLowerCase()];
    if (el.id) { parts.push("#" + el.id); }
    else if (typeof el.className === "string" && el.className.trim()) {
      parts.push("." + el.className.trim().split(/\\s+/).slice(0, 2).join("."));
    }
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    if (text) parts.push('"' + text + '"');
    return parts.join("");
  };
  var onScroll = function () {
    var h = document.documentElement;
    if (!h) return;
    var depth = ((window.scrollY + window.innerHeight) / Math.max(1, h.scrollHeight)) * 100;
    if (depth > state.maxScrollDepthPct) state.maxScrollDepthPct = Math.min(100, depth);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var key = e.target.getAttribute("data-dr-key") || "unknown";
      var rec = state.sections[key] || (state.sections[key] = { totalMs: 0, lastEnter: 0, views: 0 });
      if (e.isIntersecting) { rec.lastEnter = now(); rec.views += 1; }
      else if (rec.lastEnter) { rec.totalMs += now() - rec.lastEnter; rec.lastEnter = 0; }
    });
  }, { threshold: 0.4 });
  var observe = function () {
    document.querySelectorAll("section[id], main").forEach(function (el, i) {
      if (el.getAttribute("data-dr-key")) return;
      el.setAttribute("data-dr-key", el.id || (el.tagName.toLowerCase() + "[" + i + "]"));
      io.observe(el);
    });
  };
  var boot = function () { onScroll(); observe(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  document.addEventListener("click", function (e) {
    var t = e.target instanceof Element ? e.target : document.body;
    state.clicks.push({ t: now(), target: describeTarget(t), x: e.clientX || 0, y: e.clientY || 0 });
  }, true);
  var hoverStart = new Map();
  document.addEventListener("mouseover", function (e) {
    if (!(e.target instanceof Element)) return;
    var d = describeTarget(e.target);
    if (!hoverStart.has(d)) hoverStart.set(d, now());
  }, true);
  document.addEventListener("mouseout", function (e) {
    if (!(e.target instanceof Element)) return;
    var d = describeTarget(e.target);
    var s = hoverStart.get(d);
    if (s !== undefined) {
      hoverStart.delete(d);
      var dwell = now() - s;
      if (dwell >= 750) state.hovers.push({ t: now(), target: d, dwellMs: dwell });
    }
  }, true);
  window.__drGetState = function () { return JSON.parse(JSON.stringify(state)); };
})();
`;

export interface TrackerClick {
  t: number;
  target: string;
  x: number;
  y: number;
}

export interface TrackerHover {
  t: number;
  target: string;
  dwellMs: number;
}

export interface TrackerSection {
  totalMs: number;
  lastEnter: number;
  views: number;
}

export interface TrackerState {
  maxScrollDepthPct: number;
  sections: Record<string, TrackerSection>;
  clicks: TrackerClick[];
  hovers: TrackerHover[];
}

export function emptyTrackerState(): TrackerState {
  return { maxScrollDepthPct: 0, sections: {}, clicks: [], hovers: [] };
}

/** Normalise whatever window.__drGetState() returned (null when the script never ran). */
export function coerceTrackerState(raw: unknown): TrackerState {
  if (raw === null || typeof raw !== "object") return emptyTrackerState();
  const r = raw as Record<string, unknown>;
  return {
    maxScrollDepthPct: typeof r.maxScrollDepthPct === "number" ? r.maxScrollDepthPct : 0,
    sections: r.sections && typeof r.sections === "object" ? (r.sections as Record<string, TrackerSection>) : {},
    clicks: Array.isArray(r.clicks) ? (r.clicks as TrackerClick[]) : [],
    hovers: Array.isArray(r.hovers) ? (r.hovers as TrackerHover[]) : [],
  };
}

/** Total time a section key has been on screen (ms), including an open view. */
export function timeOnSectionMs(state: TrackerState, key: string, now = Date.now()): number {
  const rec = state.sections[key];
  if (!rec) return 0;
  return rec.totalMs + (rec.lastEnter > 0 ? now - rec.lastEnter : 0);
}

export interface RageBurst {
  target: string;
  count: number;
  firstT: number;
  lastT: number;
}

/** `minClicks`+ clicks on the same target within `windowMs` (inclusive); bursts don't overlap. */
export function detectRageClicks(clicks: TrackerClick[], windowMs = 800, minClicks = 3): RageBurst[] {
  const byTarget = new Map<string, TrackerClick[]>();
  for (const c of clicks) {
    const arr = byTarget.get(c.target);
    if (arr) arr.push(c);
    else byTarget.set(c.target, [c]);
  }
  const bursts: RageBurst[] = [];
  for (const [target, arr] of byTarget) {
    const sorted = [...arr].sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < sorted.length) {
      const first = sorted[i]!;
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]!.t - first.t <= windowMs) j += 1;
      const count = j - i + 1;
      if (count >= minClicks) {
        bursts.push({ target, count, firstT: first.t, lastT: sorted[j]!.t });
        i = j + 1;
      } else {
        i += 1;
      }
    }
  }
  return bursts;
}

export interface DwellOptions {
  /** Words per minute. Default 220. */
  wpm?: number;
  /** Fractional jitter, e.g. 0.25 = ±25%. Default 0.25. */
  jitter?: number;
  minMs?: number;
  maxMs?: number;
  random?: () => number;
}

/** Reading time scaled to text length, jittered, clamped. */
export function humanDwellMs(text: string, opts: DwellOptions = {}): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wpm = opts.wpm ?? 220;
  const jitter = opts.jitter ?? 0.25;
  const base = (words / Math.max(1, wpm)) * 60_000;
  const factor = 1 + ((opts.random ?? Math.random)() * 2 - 1) * jitter;
  return Math.round(Math.min(opts.maxMs ?? 12_000, Math.max(opts.minMs ?? 600, base * factor)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Analytics / tracking hosts aborted inside a walk (subdomains included). */
export const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "analytics.google.com",
  "connect.facebook.net",
  "static.hotjar.com",
  "script.hotjar.com",
  "cdn.mxpnl.com",
  "cdn.segment.com",
  "api.segment.io",
  "cdn.amplitude.com",
  "api.amplitude.com",
  "fullstory.com",
  "bat.bing.com",
  "snap.licdn.com",
  "px.ads.linkedin.com",
];

export function isAnalyticsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ANALYTICS_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}
