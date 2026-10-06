// ShapesOS Desktop: settings on disk, encrypted with Electron safeStorage
// (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux). Only
// the server URL and preferences are stored — never a provider key or a
// screenshot. When the OS has no encryption backend (some Linux setups) the
// file is plain JSON and Settings says "Stored without encryption".

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, validateSettings, type DesktopSettings, type SettingsResult } from "../shared/settings";

export class SettingsStore {
  private value: DesktopSettings;
  private listeners = new Set<(s: DesktopSettings, prev: DesktopSettings) => void>();

  constructor(
    private dir = app.getPath("userData"),
    private platform = process.platform,
  ) {
    this.value = loadSettings(this.read(), platform);
  }

  get(): DesktopSettings {
    return this.value;
  }

  get encrypted(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  onChange(fn: (s: DesktopSettings, prev: DesktopSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(patch: unknown): SettingsResult {
    const r = validateSettings(patch, this.value, this.platform);
    if (!r.ok) return r;
    const prev = this.value;
    this.value = r.settings;
    this.write(r.settings);
    for (const fn of this.listeners) fn(r.settings, prev);
    return r;
  }

  private encPath(): string {
    return join(this.dir, "settings.enc");
  }

  private plainPath(): string {
    return join(this.dir, "settings.json");
  }

  private read(): unknown {
    try {
      if (existsSync(this.encPath()) && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(readFileSync(this.encPath())));
      }
      if (existsSync(this.plainPath())) return JSON.parse(readFileSync(this.plainPath(), "utf8"));
    } catch {
      /* unreadable → defaults */
    }
    return null;
  }

  private write(s: DesktopSettings): void {
    mkdirSync(this.dir, { recursive: true });
    const json = JSON.stringify(s);
    if (safeStorage.isEncryptionAvailable()) {
      const tmp = `${this.encPath()}.tmp`;
      writeFileSync(tmp, safeStorage.encryptString(json), { mode: 0o600 });
      renameSync(tmp, this.encPath());
    } else {
      const tmp = `${this.plainPath()}.tmp`;
      writeFileSync(tmp, json, { mode: 0o600 });
      renameSync(tmp, this.plainPath());
    }
  }
}
