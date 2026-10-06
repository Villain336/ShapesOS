// ShapesOS Desktop: OS permissions, explained before they are asked for.
//
// macOS (systemPreferences):
//   * Microphone — getMediaAccessStatus('microphone') / askForMediaAccess.
//   * Screen Recording — getMediaAccessStatus('screen'); macOS has no API to
//     prompt directly: the first desktopCapturer call registers the app, then
//     the person enables it in System Settings (deep link below).
//   * Accessibility — isTrustedAccessibilityClient(prompt) for the paste
//     keystroke and the global hold key (Input Monitoring).
// Windows: the microphone privacy switch (getMediaAccessStatus works there
// too); screen capture and key hooks need no permission.

import { desktopCapturer, shell, systemPreferences } from "electron";
import type { PermissionKind, PermissionStatus } from "../shared/ipc";

export const PERMISSION_COPY: Record<PermissionKind, { title: string; why: string }> = {
  microphone: {
    title: "Microphone",
    why: "Hear you while you hold the talk key. Audio streams to ShapesOS's speech service only while the key is held.",
  },
  screen: {
    title: "Screen recording",
    why: "See your screen while you hold the talk key, so answers can point at the right thing. Screenshots are never saved.",
  },
  accessibility: {
    title: "Accessibility",
    why: "Notice the talk key in any app and paste dictated text where you are typing.",
  },
};

const DEEP_LINKS: Record<string, Partial<Record<PermissionKind, string>>> = {
  darwin: {
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  win32: {
    microphone: "ms-settings:privacy-microphone",
  },
};

export function permissionStatus(kind: PermissionKind, platform = process.platform): PermissionStatus {
  if (platform === "darwin") {
    if (kind === "accessibility") return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
    return systemPreferences.getMediaAccessStatus(kind);
  }
  if (platform === "win32") {
    if (kind === "microphone") return systemPreferences.getMediaAccessStatus("microphone");
    return "not-needed";
  }
  return "not-needed";
}

export function allPermissions(platform = process.platform): Record<PermissionKind, PermissionStatus> {
  return {
    microphone: permissionStatus("microphone", platform),
    screen: permissionStatus("screen", platform),
    accessibility: permissionStatus("accessibility", platform),
  };
}

/** Ask (where the OS lets us), else open the right System Settings pane. */
export async function requestPermission(kind: PermissionKind, platform = process.platform): Promise<PermissionStatus> {
  if (platform === "darwin") {
    if (kind === "microphone") {
      await systemPreferences.askForMediaAccess("microphone");
    } else if (kind === "accessibility") {
      systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt
    } else if (kind === "screen") {
      // Registers the app in the Screen Recording list (and prompts once);
      // the thumbnail is 1×1 and discarded.
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
      if (systemPreferences.getMediaAccessStatus("screen") !== "granted") await openSystemSettings(kind, platform);
    }
  } else if (platform === "win32" && kind === "microphone") {
    if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") await openSystemSettings(kind, platform);
  }
  return permissionStatus(kind, platform);
}

export async function openSystemSettings(kind: PermissionKind, platform = process.platform): Promise<boolean> {
  const link = DEEP_LINKS[platform]?.[kind];
  if (!link) return false;
  await shell.openExternal(link);
  return true;
}

/** Which permissions are missing for talk/see/paste on this OS. */
export function missingPermissions(platform = process.platform): PermissionKind[] {
  const s = allPermissions(platform);
  return (Object.keys(s) as PermissionKind[]).filter((k) => s[k] !== "granted" && s[k] !== "not-needed");
}
