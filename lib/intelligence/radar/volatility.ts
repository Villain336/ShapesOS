// Marketr — Phase 10 M2: volatility corroboration (read-only, display-only).
//
// Cross-references public volatility trackers for SERP-flux confirmation —
// as CORROBORATION, never as the impact source (docs/specs/SPEC-PHASE10.md §M2).
// Graceful when unreachable: a tracker that 403s server-side (SEMrush
// Sensor) yields available:false, never an error, never a guess.

import type { VolatilityReading } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function unavailable(provider: VolatilityReading["provider"], label: string, detailUrl: string): VolatilityReading {
  return {
    provider,
    label,
    available: false,
    value: null,
    valueLabel: null,
    interpretation: null,
    observedAt: null,
    detailUrl,
  };
}

/**
 * MozCast embeds its weather series as a Vue data array:
 *   weather: [{"dateStr":"Sep 25","dayStr":"Friday",...,"temp":138}, ...]
 * The first entry is the most recent day. Pure function over the HTML for
 * unit tests.
 */
export function parseMozCast(html: string): VolatilityReading {
  const base = unavailable("mozcast", "MozCast", "https://moz.com/mozcast");
  // NOTE: no /s (dotAll) flag — project target is ES2017.
  if (!/weather:\s*\[/.test(html)) return base;
  // Grab the whole array safely: find the matching closing bracket of "weather: [...]"
  const startIdx = html.indexOf("weather:");
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) return base;
  try {
    const arr = JSON.parse(html.slice(startIdx + "weather:".length, endIdx + 1)) as Array<{
      dateStr?: string;
      dayStr?: string;
      temp?: number;
      date?: string;
    }>;
    const latest = arr[0];
    if (!latest || typeof latest.temp !== "number") return base;
    const temp = Math.round(latest.temp);
    // Qualitative bands are OUR heuristic, labeled as such — not Moz's scale.
    const interpretation =
      temp >= 100 ? "Stormy (heuristic band)" :
      temp >= 80 ? "Hot (heuristic band)" :
      temp >= 60 ? "Warm (heuristic band)" :
      "Calm (heuristic band)";
    return {
      provider: "mozcast",
      label: "MozCast",
      available: true,
      value: temp,
      valueLabel: `${temp}° — ${latest.dayStr ?? ""} ${latest.dateStr ?? ""}`.trim(),
      interpretation,
      observedAt: latest.date ? new Date(latest.date).toISOString() : null,
      detailUrl: "https://moz.com/mozcast",
    };
  } catch {
    return base;
  }
}

export async function fetchMozCast(): Promise<VolatilityReading> {
  try {
    return parseMozCast(await fetchText("https://moz.com/mozcast"));
  } catch {
    return unavailable("mozcast", "MozCast", "https://moz.com/mozcast");
  }
}

/** SEMrush Sensor blocks server-side fetches (HTTP 403) — expected: graceful. */
export async function fetchSemrushSensor(): Promise<VolatilityReading> {
  const base = unavailable("semrush_sensor", "SEMrush Sensor", "https://www.semrush.com/sensor/");
  try {
    const html = await fetchText("https://www.semrush.com/sensor/");
    const m = html.match(/"score"\s*:\s*([0-9.]+)/);
    if (!m) return base;
    const score = Number(m[1]);
    return {
      ...base,
      available: true,
      value: score,
      valueLabel: `sensor score ${score}`,
      interpretation: score >= 8 ? "High flux (heuristic band)" : score >= 5 ? "Elevated (heuristic band)" : "Normal (heuristic band)",
      observedAt: new Date().toISOString(),
    };
  } catch {
    return base;
  }
}

/** Parallel, never throws — one tracker's outage can't sink the page. */
export async function getVolatilityReadings(): Promise<VolatilityReading[]> {
  const [moz, semrush] = await Promise.all([fetchMozCast(), fetchSemrushSensor()]);
  return [moz, semrush];
}
