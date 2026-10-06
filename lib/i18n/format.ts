// ShapesOS — Phase 18.1 (WS=find): dates, times, numbers and money in the
// person's language and time zone (Intl only, no dependency). Pure and
// client-safe; the server and the client get the SAME zone and locale from
// the preferences, so server-rendered and hydrated text match.

import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from "./locales";
import type { HourCycle } from "@/lib/preferences/schema";

export interface FormatContext {
  locale: Locale;
  /** IANA zone; null/undefined = UTC (the preference is not set yet). */
  timeZone?: string | null;
  hourCycle?: HourCycle;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function dateFmt(ctx: FormatContext, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = INTL_LOCALE[ctx.locale] ?? INTL_LOCALE[DEFAULT_LOCALE];
  const tz = ctx.timeZone || "UTC";
  const hc = ctx.hourCycle && ctx.hourCycle !== "auto" ? ctx.hourCycle : undefined;
  const key = JSON.stringify([tag, tz, hc, opts]);
  let f = fmtCache.get(key);
  if (!f) {
    // hourCycle only matters when the format shows the hour.
    const withHc = hc && (opts.hour || opts.timeStyle) ? { ...opts, hourCycle: hc } : opts;
    f = new Intl.DateTimeFormat(tag, { ...withHc, timeZone: tz });
    if (fmtCache.size > 500) fmtCache.clear();
    fmtCache.set(key, f);
  }
  return f;
}

function toDate(d: Date | string | number): Date | null {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type DateStyle = "date" | "dateTime" | "time" | "short" | "weekday";

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: "medium" },
  dateTime: { dateStyle: "medium", timeStyle: "short" },
  time: { timeStyle: "short" },
  short: { month: "short", day: "numeric" },
  weekday: { weekday: "long", month: "long", day: "numeric" },
};

/** Format a date in the person's zone. Invalid input → "". */
export function formatDate(d: Date | string | number, ctx: FormatContext, style: DateStyle | Intl.DateTimeFormatOptions = "date"): string {
  const date = toDate(d);
  if (!date) return "";
  return dateFmt(ctx, typeof style === "string" ? STYLES[style] : style).format(date);
}

export function formatNumber(n: number, ctx: Pick<FormatContext, "locale">, opts: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat(INTL_LOCALE[ctx.locale] ?? INTL_LOCALE[DEFAULT_LOCALE], opts).format(n);
}

/** Integer cents → "$1,234.50" / "1234,50 US$" (the workspace currency, default USD). */
export function formatMoney(cents: number, ctx: Pick<FormatContext, "locale">, currency = "USD"): string {
  if (!Number.isFinite(cents)) return "";
  return formatNumber(cents / 100, ctx, { style: "currency", currency });
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.345],
  ["month", 12],
  ["year", Infinity],
];

/** "3 minutes ago" / "hace 3 minutos", relative to `now`. */
export function formatRelative(d: Date | string | number, ctx: Pick<FormatContext, "locale">, now: Date = new Date()): string {
  const date = toDate(d);
  if (!date) return "";
  let value = (date.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[ctx.locale] ?? INTL_LOCALE[DEFAULT_LOCALE], { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return rtf.format(Math.round(value), "year");
}
