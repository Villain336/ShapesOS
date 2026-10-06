// ShapesOS Desktop: native notifications for new bell items.
// Polls GET /api/notifications?limit=8&unread=1 (the header bell's own feed);
// the first poll only seeds, so launching never floods the desktop.

import { Notification } from "electron";
import { NotificationDiffer } from "../shared/tray-state";
import type { ShapesApi } from "./api";

export class Notifier {
  private differ = new NotificationDiffer();
  private timer: ReturnType<typeof setInterval> | null = null;
  enabled = true;
  shown = 0;

  constructor(
    private api: ShapesApi,
    private open: (href: string | null) => void,
  ) {}

  start(intervalMs = 60_000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  async poll(): Promise<number> {
    try {
      const { notifications } = await this.api.notifications();
      const fresh = this.differ.next(notifications);
      if (!this.enabled) return 0;
      for (const n of fresh) this.show(n.title, n.body ?? undefined, n.href);
      return fresh.length;
    } catch {
      return 0; // signed out or offline: the tray says so
    }
  }

  show(title: string, body: string | undefined, href: string | null): void {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: title.slice(0, 120), body: body?.slice(0, 300), silent: false });
    note.on("click", () => this.open(href));
    note.show();
    this.shown += 1;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
