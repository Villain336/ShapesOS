// ShapesOS — confirm/toast store tests.
// Run: npx tsx --test lib/ui/__tests__/feedback.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_TOAST_MS,
  DEFAULT_TOAST_MS,
  FeedbackStore,
  MAX_TOASTS,
  parseConfirmMessage,
  runUndoable,
  type Clock,
} from "../feedback";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("parseConfirmMessage", () => {
  it("splits title and description and picks a destructive verb", () => {
    const p = parseConfirmMessage("Delete this brand kit? Templates using it will fall back to the default kit.");
    assert.equal(p.title, "Delete this brand kit?");
    assert.equal(p.description, "Templates using it will fall back to the default kit.");
    assert.equal(p.confirmLabel, "Delete");
    assert.equal(p.destructive, true);
    assert.equal(p.cancelLabel, "Cancel");
  });

  it("non-destructive verbs keep a black primary", () => {
    const p = parseConfirmMessage("Send this broadcast now?");
    assert.equal(p.confirmLabel, "Send");
    assert.equal(p.destructive, false);
    assert.equal(p.description, undefined);
  });

  it("'Cancel X?' never shows two Cancel buttons", () => {
    const p = parseConfirmMessage("Cancel this booking? Pending reminders will be suppressed.");
    assert.equal(p.confirmLabel, "Cancel");
    assert.equal(p.cancelLabel, "Keep");
    assert.equal(p.destructive, true);
  });

  it("handles two-word verbs and multi-line messages", () => {
    const p = parseConfirmMessage("Roll back the PRODUCTION pointer to v3? This moves the pointer only.");
    assert.equal(p.confirmLabel, "Roll back");
    assert.equal(p.destructive, true);
    const q = parseConfirmMessage("Promote v2?\n\nYou are recorded as the human approver.");
    assert.equal(q.title, "Promote v2?");
    assert.equal(q.description, "You are recorded as the human approver.");
  });

  it("falls back to Confirm when the message doesn't lead with a verb", () => {
    const p = parseConfirmMessage("Are you sure?");
    assert.equal(p.confirmLabel, "Confirm");
  });
});

describe("FeedbackStore confirm", () => {
  it("never auto-confirms without a host or native dialog", async () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    assert.equal(await store.confirm("Delete it?"), false);
  });

  it("falls back to the native dialog when no host is mounted", async () => {
    const seen: string[] = [];
    const store = new FeedbackStore(fakeClock().clock, (m) => {
      seen.push(m);
      return true;
    });
    assert.equal(await store.confirm("Delete it? Gone for good."), true);
    assert.deepEqual(seen, ["Delete it?\n\nGone for good."]);
  });

  it("queues requests and shows one dialog at a time", async () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    store.registerHost();
    const a = store.confirm({ title: "A?", destructive: true });
    const b = store.confirm("Send B?");
    const first = store.getState().confirm!;
    assert.equal(first.title, "A?");
    assert.equal(first.confirmLabel, "Delete");
    store.settle(first.id, true);
    const second = store.getState().confirm!;
    assert.equal(second.title, "Send B?");
    store.settle(second.id, false);
    assert.equal(store.getState().confirm, null);
    assert.equal(await a, true);
    assert.equal(await b, false);
  });

  it("host unmount restores the fallback", async () => {
    const store = new FeedbackStore(fakeClock().clock, () => true);
    const unregister = store.registerHost();
    assert.equal(store.hasHost, true);
    unregister();
    assert.equal(store.hasHost, false);
    assert.equal(await store.confirm("Delete?"), true);
  });
});

describe("FeedbackStore toasts", () => {
  it("auto-dismisses after the default duration", () => {
    const c = fakeClock();
    const store = new FeedbackStore(c.clock, null);
    store.toast({ title: "Saved" });
    assert.equal(store.getState().toasts.length, 1);
    assert.equal(store.getState().toasts[0]!.status, "done");
    c.advance(DEFAULT_TOAST_MS - 1);
    assert.equal(store.getState().toasts.length, 1);
    c.advance(1);
    assert.equal(store.getState().toasts.length, 0);
  });

  it("toasts with an action stay longer; durationMs 0 is sticky", () => {
    const c = fakeClock();
    const store = new FeedbackStore(c.clock, null);
    store.toast({ title: "Archived", action: { label: "Undo", onClick: () => {} } });
    store.toast({ title: "Stuck", durationMs: 0 });
    c.advance(DEFAULT_TOAST_MS);
    assert.equal(store.getState().toasts.length, 2);
    c.advance(ACTION_TOAST_MS - DEFAULT_TOAST_MS);
    assert.deepEqual(store.getState().toasts.map((t) => t.title), ["Stuck"]);
    c.advance(60_000);
    assert.equal(store.getState().toasts.length, 1);
  });

  it("caps the stack, dropping the oldest and its timer", () => {
    const c = fakeClock();
    const store = new FeedbackStore(c.clock, null);
    for (let i = 0; i < MAX_TOASTS + 2; i++) store.toast({ title: `t${i}` });
    assert.equal(store.getState().toasts.length, MAX_TOASTS);
    assert.equal(store.getState().toasts[0]!.title, "t2");
    assert.equal(c.pending(), MAX_TOASTS);
  });

  it("pause stops the timer and resume restarts it", () => {
    const c = fakeClock();
    const store = new FeedbackStore(c.clock, null);
    const id = store.toast({ title: "Hover me" });
    store.pause(id);
    c.advance(DEFAULT_TOAST_MS * 3);
    assert.equal(store.getState().toasts.length, 1);
    store.resume(id);
    c.advance(DEFAULT_TOAST_MS);
    assert.equal(store.getState().toasts.length, 0);
  });

  it("notifies subscribers and unsubscribes cleanly", () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const id = store.toast({ title: "x" });
    store.dismiss(id);
    off();
    store.toast({ title: "y" });
    assert.equal(calls, 2);
  });
});

describe("runUndoable", () => {
  it("runs, then offers Undo which calls the inverse", async () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    const log: string[] = [];
    await runUndoable(
      {
        title: "Alert dismissed",
        run: () => {
          log.push("run");
        },
        undo: () => {
          log.push("undo");
        },
        onUndone: () => log.push("refresh"),
      },
      store,
    );
    const t = store.getState().toasts[0]!;
    assert.equal(t.title, "Alert dismissed");
    assert.equal(t.action?.label, "Undo");
    assert.equal(t.action?.doneLabel, "Undone");
    await t.action!.onClick();
    assert.deepEqual(log, ["run", "undo", "refresh"]);
  });

  it("does not toast when the action itself fails", async () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    await assert.rejects(
      runUndoable({ title: "x", run: () => Promise.reject(new Error("boom")), undo: () => {} }, store),
    );
    assert.equal(store.getState().toasts.length, 0);
  });

  it("a failed undo surfaces a failed toast", async () => {
    const store = new FeedbackStore(fakeClock().clock, null);
    await runUndoable({ title: "x", run: () => {}, undo: () => Promise.reject(new Error("nope")) }, store);
    await store.getState().toasts[0]!.action!.onClick();
    const last = store.getState().toasts.at(-1)!;
    assert.equal(last.status, "failed");
  });
});
