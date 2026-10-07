// ShapesOS Desktop: screenshots with Electron desktopCapturer
// (ScreenCaptureKit on macOS, Windows Graphics Capture / DXGI on Windows).
//
// Called ONLY by the CaptureMachine while the talk key is held. The images
// are JPEG-encoded in memory, budgeted to the turn limits and handed to the
// turn request; nothing here (or anywhere in this app) writes them to disk.
// Our own overlay windows use setContentProtection(true), so the companion
// pointer and capture indicator are not in the screenshots.

import { desktopCapturer, screen } from "electron";
import { TURN_LIMITS } from "../shared/contract";
import { fitScreenshots, type EncodableShot, type Shot } from "../shared/capture-machine";
import { captureSize, displayForPoint, imageScale, numberDisplays, type NumberedDisplay } from "../shared/coords";

export function currentDisplays(): NumberedDisplay[] {
  const all = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor }));
  return numberDisplays(all, screen.getPrimaryDisplay().id);
}

export async function captureScreens(mode: "all" | "cursor"): Promise<Shot[]> {
  const displays = currentDisplays();
  const cursor = screen.getCursorScreenPoint();
  const under = displayForPoint(displays, cursor);
  const wanted = mode === "cursor" && under ? [under] : displays;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: captureSize(wanted),
    fetchWindowIcons: false,
  });
  const candidates: EncodableShot[] = [];
  wanted.forEach((d, i) => {
    // display_id matches Display.id where the platform provides it; else fall
    // back to the source order (which follows the OS display order).
    const src = sources.find((s) => s.display_id && s.display_id === String(d.id)) ?? sources[i];
    if (!src || src.thumbnail.isEmpty()) return;
    const img = src.thumbnail;
    const size = img.getSize();
    const dx = Math.max(d.bounds.x - cursor.x, 0, cursor.x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - cursor.y, 0, cursor.y - (d.bounds.y + d.bounds.height));
    candidates.push({
      screen: d.screen,
      primary: d.primary,
      cursorDistance: Math.hypot(dx, dy),
      encode: (quality) => ({
        jpegBase64: img.toJPEG(quality).toString("base64"),
        width: size.width,
        height: size.height,
        scaleFactor: Math.round(imageScale(d, size.width) * 10000) / 10000,
      }),
    });
  });
  return fitScreenshots(candidates, TURN_LIMITS);
}
