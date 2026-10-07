// ShapesOS Desktop: the menu-bar (macOS) / notification-area (Windows) icon.
// Shows the Needs-you count and running agents (GET /api/approvals/count,
// GET /api/agents/activity), background agent-mode runs, and the actions.

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { AgentActivityResponse, ApprovalCounts } from "../shared/contract";
import { trayState, type BackgroundRun, type TrayState } from "../shared/tray-state";
import type { ShapesApi } from "./api";

export interface TrayActions {
  openShapes: (path?: string) => void;
  ask: () => void;
  settings: () => void;
  quit: () => void;
  holdHint: () => string;
}

export class TrayController {
  private tray: Tray | null = null;
  private counts: ApprovalCounts | null = null;
  private activity: AgentActivityResponse | null = null;
  private signedIn = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  background: BackgroundRun[] = [];
  /** Last rendered state (the smoke reads it through the test hook). */
  state: TrayState = trayState({ counts: null, activity: null, background: [], signedIn: false });
  refreshes = 0;

  constructor(
    private api: ShapesApi,
    private actions: TrayActions,
    private assets: string,
  ) {}

  start(intervalMs = 30_000): void {
    const icon = nativeImage.createFromPath(join(this.assets, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
    if (process.platform === "darwin") icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.on("click", () => this.tray?.popUpContextMenu());
    this.render();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  async refresh(): Promise<TrayState> {
    this.refreshes += 1;
    try {
      const [counts, activity] = await Promise.all([this.api.approvalCounts(), this.api.activity()]);
      this.counts = counts;
      this.activity = activity;
      this.signedIn = true;
    } catch (e) {
      if ((e as { status?: number }).status === 401) this.signedIn = false;
    }
    this.render();
    return this.state;
  }

  setBackground(run: BackgroundRun): void {
    this.background = [run, ...this.background.filter((b) => b.runId !== run.runId)].slice(0, 5);
    this.render();
  }

  private render(): void {
    this.state = trayState({ counts: this.counts, activity: this.activity, background: this.background, signedIn: this.signedIn });
    if (!this.tray || this.tray.isDestroyed()) return;
    const s = this.state;
    if (process.platform === "darwin") this.tray.setTitle(s.title, { fontType: "monospacedDigit" });
    this.tray.setToolTip(s.tooltip);
    const items: MenuItemConstructorOptions[] = [];
    if (!s.signedIn) items.push({ label: "Sign in to ShapesOS", click: () => this.actions.openShapes() });
    items.push({
      label: s.needsYou > 0 ? `Needs you: ${s.needsYou}` : "Nothing needs you",
      click: () => this.actions.openShapes("/dashboard/approvals"),
    });
    if (s.running.length) {
      items.push({ type: "separator" }, { label: "Running now", enabled: false });
      for (const a of s.running.slice(0, 8)) {
        items.push({ label: `${a.name}: ${a.line}`.slice(0, 80), click: () => this.actions.openShapes(a.href ?? "/dashboard") });
      }
    }
    if (s.background.length) {
      items.push({ type: "separator" }, { label: "In the background", enabled: false });
      for (const b of s.background) {
        items.push({ label: `${b.goal} (max $${b.maxUsd}): ${b.line}`.slice(0, 90), click: () => this.actions.openShapes(`/dashboard/runs/${b.runId}`) });
      }
    }
    items.push(
      { type: "separator" },
      { label: "Open ShapesOS", click: () => this.actions.openShapes() },
      { label: `Talk: ${this.actions.holdHint()}`, enabled: false },
      { label: "Type a question…", click: () => this.actions.ask() },
      { label: "Settings…", click: () => this.actions.settings() },
      { type: "separator" },
      { label: "Quit ShapesOS", click: () => this.actions.quit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.tray?.destroy();
  }
}
