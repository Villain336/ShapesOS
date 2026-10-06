// ShapesOS Desktop: auto-update with electron-updater's "generic" provider
// against DESKTOP_UPDATE_URL/<channel> (an R2 public bucket). Signature
// checks are electron-updater's own (code signature on macOS, publisher
// name on Windows), so an unsigned or wrongly signed update is refused.

import { app } from "electron";
import { updaterConfig, type UpdaterConfig } from "../shared/updater-config";
import type { DesktopSettings } from "../shared/settings";

export class Updater {
  config: UpdaterConfig;
  state = "idle";

  constructor(private settings: () => DesktopSettings) {
    this.config = this.compute();
  }

  private compute(): UpdaterConfig {
    const s = this.settings();
    return updaterConfig({
      envUrl: process.env.DESKTOP_UPDATE_URL,
      builtInUrl: __DESKTOP_UPDATE_URL__,
      channel: s.updateChannel,
      autoUpdate: s.autoUpdate,
      isPackaged: app.isPackaged,
      platform: process.platform,
    });
  }

  async apply(): Promise<void> {
    this.config = this.compute();
    if (!this.config.feed) return;
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = this.config.enabled;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = this.config.allowPrerelease;
    autoUpdater.setFeedURL(this.config.feed);
    autoUpdater.removeAllListeners();
    autoUpdater.on("checking-for-update", () => (this.state = "checking"));
    autoUpdater.on("update-available", (i) => (this.state = `downloading ${i.version}`));
    autoUpdater.on("update-not-available", () => (this.state = "up to date"));
    autoUpdater.on("update-downloaded", (i) => (this.state = `${i.version} installs when you quit`));
    autoUpdater.on("error", (e) => (this.state = `error: ${e.message}`));
    if (this.config.enabled) void autoUpdater.checkForUpdates().catch(() => undefined);
  }

  async checkNow(): Promise<string> {
    this.config = this.compute();
    if (!this.config.feed) return this.config.reason ?? "Updates are off.";
    const { autoUpdater } = await import("electron-updater");
    try {
      const r = await autoUpdater.checkForUpdates();
      return r?.isUpdateAvailable ? `Version ${r.updateInfo.version} is available.` : "You're up to date.";
    } catch (e) {
      return `Couldn't check: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
