// ShapesOS — Phase 18.3 (WS=flow): the offline write queue (lib/offline/queue.ts).
//   - enqueue is idempotent on the client id; replay is in order
//   - a replay of a write that DID land (lost response) is acknowledged once
//     by a server keyed on the client id — never a duplicate
//   - network errors stop the replay and keep the rest; 4xx drops (reported)
//   - writes queued while a send is in flight are kept
//   - only the safe writes are queueable; client ids are well formed

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySend,
  clearQueue,
  enqueue,
  genericQueue,
  isClientId,
  isOfflineWriteKind,
  newClientId,
  OFFLINE_WRITES,
  readQueue,
  replayQueue,
  storageKey,
  type KeyValueStore,
  type QueuedWrite,
  type SendResult,
} from "../queue";

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** A fake server keyed on client id, like POST /api/notes with clientId. */
function fakeServer() {
  const rows = new Map<string, string>();
  let n = 0;
  return {
    rows,
    handle(w: QueuedWrite): { status: number; data: Record<string, unknown> } {
      const prior = rows.get(w.clientId);
      if (prior) return { status: 200, data: { note: { id: prior }, replayed: true } };
      const id = `note_${++n}`;
      rows.set(w.clientId, id);
      return { status: 201, data: { note: { id } } };
    },
  };
}

const note = (clientId: string, title: string) => ({ clientId, kind: "note_create", method: "POST" as const, url: OFFLINE_WRITES.note_create.url, body: { title, clientId } });

describe("offline queue", () => {
  it("enqueue is idempotent on the client id and keeps order", () => {
    const s = memStore();
    enqueue(s, "app", note("w_aaaaaaaa1", "one"));
    enqueue(s, "app", note("w_aaaaaaaa2", "two"));
    enqueue(s, "app", note("w_aaaaaaaa1", "one again"));
    const q = readQueue(s, "app");
    assert.deepEqual(q.map((w) => w.clientId), ["w_aaaaaaaa1", "w_aaaaaaaa2"]);
    assert.equal(q[0]!.body.title, "one", "the first enqueue wins");
    assert.equal(q[0]!.attempts, 0);
    assert.ok(s.data.has(storageKey("app")));
  });

  it("replays in order; a lost response replayed again never duplicates (server keyed on client id)", async () => {
    const s = memStore();
    const server = fakeServer();
    enqueue(s, "app", note("w_bbbbbbbb1", "a"));
    enqueue(s, "app", note("w_bbbbbbbb2", "b"));
    // First attempt: the server writes "a" but the response is lost.
    let lost = true;
    const r1 = await replayQueue(s, "app", async (w) => {
      const res = server.handle(w);
      if (lost) {
        lost = false;
        return classifySend(null, null);
      }
      return classifySend(res.status, res.data, "note.id");
    });
    assert.deepEqual(r1, { sent: [], failed: [], remaining: 2 });
    assert.equal(readQueue(s, "app")[0]!.attempts, 1);
    assert.equal(readQueue(s, "app")[0]!.lastError, "No connection");
    // Back online: replay again — "a" comes back as replayed, "b" is new.
    const r2 = await replayQueue(s, "app", async (w) => {
      const res = server.handle(w);
      return classifySend(res.status, res.data, "note.id");
    });
    assert.deepEqual(r2.sent, [
      { clientId: "w_bbbbbbbb1", id: "note_1", replayed: true },
      { clientId: "w_bbbbbbbb2", id: "note_2", replayed: false },
    ]);
    assert.equal(r2.remaining, 0);
    assert.equal(server.rows.size, 2, "two writes, two rows — never three");
    const r3 = await replayQueue(s, "app", async () => assert.fail("nothing left to send"));
    assert.equal(r3.remaining, 0);
  });

  it("a 4xx refusal leaves the queue (reported); 5xx/408/429 keep it", async () => {
    const s = memStore();
    enqueue(s, "app", note("w_cccccccc1", "bad"));
    enqueue(s, "app", note("w_cccccccc2", "good"));
    const outcomes: SendResult[] = [classifySend(400, { error: "Invalid note" }), classifySend(503, null)];
    const r = await replayQueue(s, "app", async () => outcomes.shift()!);
    assert.deepEqual(r.failed, [{ clientId: "w_cccccccc1", error: "Invalid note" }]);
    assert.equal(r.remaining, 1);
    assert.equal(classifySend(429, null).ok, false);
    assert.equal((classifySend(429, null) as { permanent: boolean }).permanent, false);
    assert.equal((classifySend(408, null) as { permanent: boolean }).permanent, false);
    assert.deepEqual(classifySend(200, { updated: 3 }, null), { ok: true, replayed: false, id: "ok" });
    assert.equal(classifySend(201, {}, "id").ok, false, "a 2xx without the id is not an acknowledgement");
  });

  it("keeps a write enqueued while a send was in flight", async () => {
    const s = memStore();
    enqueue(s, "app", note("w_dddddddd1", "first"));
    const r = await replayQueue(s, "app", async (w) => {
      if (w.clientId === "w_dddddddd1") enqueue(s, "app", note("w_dddddddd2", "typed meanwhile"));
      return { ok: true, replayed: false, id: `id-${w.clientId}` };
    });
    assert.equal(r.sent.length, 2, "the new one was sent in the same pass");
    assert.equal(readQueue(s, "app").length, 0);
  });

  it("clearQueue empties it (sign-out); separate queues don't mix; corrupt storage reads as empty", () => {
    const s = memStore();
    enqueue(s, "app", note("w_eeeeeeee1", "x"));
    enqueue(s, "other", note("w_eeeeeeee2", "y"));
    clearQueue(s, "app");
    assert.equal(readQueue(s, "app").length, 0);
    assert.equal(readQueue(s, "other").length, 1);
    s.setItem(storageKey("app"), "{not json");
    assert.deepEqual(readQueue(s, "app"), []);
    const g = genericQueue<{ k: string }>("custom", (x) => x.k);
    g.enqueue(s, { k: "1" });
    g.enqueue(s, { k: "1" });
    assert.equal(g.read(s).length, 1);
  });

  it("only safe writes are queueable; client ids are well formed", () => {
    assert.deepEqual(Object.keys(OFFLINE_WRITES).sort(), ["note_create", "notifications_read", "reminder_create"]);
    assert.equal(isOfflineWriteKind("note_create"), true);
    assert.equal(isOfflineWriteKind("mail_send"), false);
    const id = newClientId("n");
    assert.ok(isClientId(id), id);
    assert.notEqual(newClientId(), newClientId());
    assert.equal(isClientId("short"), false);
    assert.equal(isClientId("has space in it!"), false);
  });
});
