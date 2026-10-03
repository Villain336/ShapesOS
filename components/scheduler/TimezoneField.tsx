// ShapesOS — schedule timezone field (Phase 4a: per-schedule IANA timezone).
// A text input with the browser's IANA zone list as suggestions. The server
// validates the value (unknown zones → 400), so this only helps typing.

"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { inputCls, labelCls } from "@/components/settings/ui";

const FALLBACK_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** The viewer's own IANA zone (falls back to UTC). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const noopSubscribe = () => () => {};

/**
 * The viewer's zone, hydration-safe: the server render (and the first client
 * render) read UTC, then the browser's zone.
 */
export function useBrowserTimeZone(): string {
  return useSyncExternalStore(noopSubscribe, browserTimeZone, () => "UTC");
}

function zoneList(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) return supported.includes("UTC") ? supported : ["UTC", ...supported];
  } catch {
    // Older engines: the short list below.
  }
  return FALLBACK_ZONES;
}

export default function TimezoneField({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (tz: string) => void;
  className?: string;
}) {
  const listId = useId();
  const zones = useMemo(zoneList, []);
  return (
    <label className={labelCls}>
      Timezone
      <input
        className={`${inputCls} mt-1 w-64 ${className}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="UTC"
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <span className="mt-1 block text-xs font-normal text-muted">
        The schedule runs on this zone&apos;s wall clock, including daylight saving changes.
      </span>
    </label>
  );
}
