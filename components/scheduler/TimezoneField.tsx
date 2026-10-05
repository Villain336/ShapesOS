// ShapesOS — schedule timezone field (Phase 4a: per-schedule IANA timezone).
// A text input with the browser's IANA zone list as suggestions. The server
// validates the value (unknown zones → 400), so this only helps typing.

"use client";

import { useId, useMemo, useSyncExternalStore } from "react";
import { Globe } from "lucide-react";
import { Field } from "@/components/aos/Controls";

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
  const zones = useMemo(() => zoneList(), []);
  return (
    <>
      <Field
        label="Timezone"
        className={`w-full max-w-72 ${className}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="UTC"
        autoComplete="off"
        spellCheck={false}
        leading={<Globe className="size-4" aria-hidden />}
        helper="The schedule runs on this zone's wall clock, including daylight saving changes."
      />
      <datalist id={listId}>
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}
