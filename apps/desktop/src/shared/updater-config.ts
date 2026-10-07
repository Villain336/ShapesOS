// ShapesOS Desktop: auto-update configuration (electron-updater "generic").
//
// Builds live in an R2 public bucket: DESKTOP_UPDATE_URL/<channel>/latest.yml
// (Windows) and latest-mac.yml (macOS). The URL is baked in at build time
// and can be overridden by the DESKTOP_UPDATE_URL environment variable (a
// self-hoster's own bucket). No URL → updates are off and Settings says so;
// never a made-up feed.

export interface UpdaterConfig {
  enabled: boolean;
  /** electron-updater setFeedURL options when enabled. */
  feed: { provider: "generic"; url: string; channel: "latest" } | null;
  channel: "stable" | "beta";
  /** Why updates are off (shown in Settings). */
  reason: string | null;
  allowPrerelease: boolean;
}

export function updaterConfig(input: {
  envUrl?: string | undefined;
  builtInUrl?: string | undefined;
  channel: "stable" | "beta";
  autoUpdate: boolean;
  isPackaged: boolean;
  platform: string;
}): UpdaterConfig {
  const off = (reason: string): UpdaterConfig => ({
    enabled: false,
    feed: null,
    channel: input.channel,
    reason,
    allowPrerelease: input.channel === "beta",
  });
  if (!input.isPackaged) return off("Updates run in installed builds only.");
  if (input.platform !== "darwin" && input.platform !== "win32") return off("Auto-update covers macOS and Windows.");
  const raw = (input.envUrl?.trim() || input.builtInUrl?.trim() || "").replace(/\/+$/, "");
  if (!raw) return off("No update feed is configured for this build.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return off("The update feed address is not a valid URL.");
  }
  if (u.protocol !== "https:") return off("The update feed must use https.");
  if (u.search || u.hash) return off("The update feed address can't have ? or #.");
  if (!input.autoUpdate) {
    return {
      enabled: false,
      feed: { provider: "generic", url: `${raw}/${input.channel}`, channel: "latest" },
      channel: input.channel,
      reason: "Automatic updates are off in Settings.",
      allowPrerelease: input.channel === "beta",
    };
  }
  return {
    enabled: true,
    // electron-updater reads <url>/latest.yml (win) or latest-mac.yml (mac);
    // the R2 layout puts each channel in its own folder.
    feed: { provider: "generic", url: `${raw}/${input.channel}`, channel: "latest" },
    channel: input.channel,
    reason: null,
    allowPrerelease: input.channel === "beta",
  };
}
