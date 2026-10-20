import type { DesktopBridge } from "../shared/ipc";

/** The internal preload's bridge (src/preload/internal.ts). */
export const desktop = (window as unknown as { desktop: DesktopBridge }).desktop;
