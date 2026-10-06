// ShapesOS Desktop: which app is in front (for the exclusion list).
//
// Uses get-windows (MIT, prebuilt: a Swift helper on macOS, an N-API binding
// on Windows). It is an optional dependency loaded lazily; when it can't load
// or answer, focusedApp() returns null and the caller FAILS CLOSED (no
// capture), because an exclusion list that can't be checked protects nobody.
// The macOS permission prompts get-windows can trigger are turned off: we
// only need the owner's name / bundle id, plus the tab URL when available.

import type { FocusedApp } from "../shared/exclusions";

type ActiveWindow = (opts?: { accessibilityPermission?: boolean; screenRecordingPermission?: boolean }) => Promise<
  | {
      title: string;
      owner: { name: string; path: string; bundleId?: string };
      url?: string;
    }
  | undefined
>;

let loader: Promise<ActiveWindow | null> | null = null;
let loadError: string | null = null;

function load(): Promise<ActiveWindow | null> {
  loader ??= import("get-windows")
    .then((m: { activeWindow: ActiveWindow }) => m.activeWindow)
    .catch((e: unknown) => {
      loadError = e instanceof Error ? e.message : String(e);
      return null;
    });
  return loader;
}

export function focusedAppError(): string | null {
  return loadError;
}

export async function focusedApp(): Promise<FocusedApp | null> {
  const activeWindow = await load();
  if (!activeWindow) return null;
  try {
    const w = await activeWindow({ accessibilityPermission: false, screenRecordingPermission: false });
    if (!w) return null;
    return {
      name: w.owner.name,
      bundleId: w.owner.bundleId,
      path: w.owner.path,
      title: w.title || undefined,
      url: w.url,
    };
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    return null;
  }
}
