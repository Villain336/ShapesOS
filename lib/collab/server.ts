// ShapesOS — Phase 18.2 (WS=content): the live-collaboration server.
//
// @hocuspocus/server (yjs over WebSocket). Runs in the WORKER image — never in
// a Next route module (bundle-size rule): scripts/worker.mts starts it when
// COLLAB_PORT is set (local, docker compose), and scripts/collab.mts runs it
// alone (Render's shapesos-collab web service: a background worker can't
// take inbound connections, see docs/deploy/RENDER.md).
//
// ONE process serves every document. Hocuspocus scales out only through its
// Redis extension, and there is no Redis here; two processes holding the
// same document would each merge edits the other never sees. So: exactly one
// collab process (numInstances: 1), and Postgres is the durable store —
// a restart loses nothing but in-flight keystrokes since the last store
// (debounce 2 s, at most 10 s).
//
// Security:
//   onAuthenticate   the short-lived HMAC token from /api/collab/token
//                    (lib/collab/token.ts): signature, expiry, and the
//                    document it names must be the one being opened. "read"
//                    tokens make the connection read-only HERE — Hocuspocus
//                    drops a read-only connection's document updates, so a
//                    viewer can never change the note, whatever its client
//                    sends.
//   every DB access  under the token's workspace (FORCE RLS), see
//                    lib/collab/persistence.ts.
// Restores: when a document's version changes underneath a live copy (a
// version restore, a non-live save), the server tells every editor to reload
// (stateless {"type":"reset"}), closes their connections, drops the stale
// copy without storing it, and loads the new state for the next connection.

import { Server, type Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";
import { parseDocName, verifyCollabToken, collabSecret, type CollabClaims } from "./token";
import { docVersions, loadCollabDoc, storeCollabDoc } from "./persistence";

export const COLLAB_STORE_DEBOUNCE_MS = 2_000;
export const COLLAB_STORE_MAX_DEBOUNCE_MS = 10_000;
export const COLLAB_POLL_MS = 3_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

interface CollabContext {
  claims: CollabClaims;
}

interface LiveDoc {
  workspaceId: string;
  docId: string;
  kind: "note";
  version: number;
  lastUserId: string | null;
}

export interface CollabServerHandle {
  server: Server<CollabContext>;
  port: number;
  /** Store every live document, close every connection, stop listening. */
  close(): Promise<void>;
  /** Tests: the server's view of loaded documents. */
  live: Map<string, LiveDoc>;
  /** Tests: run the restore poll once now. */
  pollOnce(): Promise<void>;
}

export interface CollabServerOptions {
  port: number;
  host?: string;
  /** Defaults to AUTH_SECRET / NEXTAUTH_SECRET. */
  secret?: string;
  pollMs?: number;
  log?: (msg: string) => void;
}

export async function startCollabServer(opts: CollabServerOptions): Promise<CollabServerHandle> {
  const secret = opts.secret ?? collabSecret();
  if (!secret) throw new Error("[collab] AUTH_SECRET (or NEXTAUTH_SECRET) is required to verify collaboration tokens.");
  const log = opts.log ?? ((m: string) => console.log(`[collab] ${m}`));
  const live = new Map<string, LiveDoc>();
  // Documents being reset: new connections wait until the stale copy is gone.
  const resetting = new Map<string, Promise<void>>();
  let instance: Hocuspocus<CollabContext> | null = null;

  async function resetDocument(name: string, why: string): Promise<void> {
    if (!instance || resetting.has(name)) return;
    const document = instance.documents.get(name);
    if (!document) {
      live.delete(name);
      return;
    }
    log(`reset ${name}: ${why}`);
    const done = (async () => {
      live.delete(name); // storeDocument skips a doc it no longer tracks
      document.broadcastStateless(JSON.stringify({ type: "reset" }));
      instance!.closeConnections(name);
      instance!.flushPendingStores();
      for (let i = 0; i < 50 && instance!.documents.has(name); i++) {
        await new Promise((r) => setTimeout(r, 100));
        const d = instance!.documents.get(name);
        if (d) await instance!.unloadDocument(d);
      }
    })().finally(() => resetting.delete(name));
    resetting.set(name, done);
    await done;
  }

  const server = new Server<CollabContext>({
    port: opts.port,
    address: opts.host,
    quiet: true,
    stopOnSignals: false,
    debounce: COLLAB_STORE_DEBOUNCE_MS,
    maxDebounce: COLLAB_STORE_MAX_DEBOUNCE_MS,
    unloadImmediately: false,
    websocketOptions: { maxPayload: MAX_PAYLOAD_BYTES },

    async onRequest({ request, response }) {
      // Health for the platform's checks; everything else is WebSocket only.
      if ((request.url ?? "").split("?")[0] === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, documents: instance?.getDocumentsCount() ?? 0, connections: instance?.getConnectionsCount() ?? 0 }));
        throw null; // handled — stop the default response
      }
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      throw null;
    },

    async onAuthenticate({ token, documentName, connectionConfig }) {
      const v = verifyCollabToken(token, secret);
      if (!v.ok) throw new Error(`collab token ${v.reason}`);
      if (v.claims.doc !== documentName) throw new Error("collab token is for another document");
      const pending = resetting.get(documentName);
      if (pending) await pending;
      connectionConfig.readOnly = v.claims.role !== "write";
      return { claims: v.claims };
    },

    async onLoadDocument({ documentName, context }) {
      const parsed = parseDocName(documentName);
      const claims = (context as CollabContext | undefined)?.claims;
      if (!parsed || !claims) throw new Error("unknown document");
      const loaded = await loadCollabDoc(claims.ws, parsed.kind, parsed.id);
      if (!loaded) throw new Error("document not found");
      live.set(documentName, { workspaceId: claims.ws, docId: parsed.id, kind: parsed.kind, version: loaded.version, lastUserId: null });
      return loaded.update;
    },

    async onChange({ documentName, context }) {
      const d = live.get(documentName);
      const uid = (context as CollabContext | undefined)?.claims?.uid;
      if (d && uid) d.lastUserId = uid;
    },

    async onStoreDocument({ documentName, document }) {
      const d = live.get(documentName);
      if (!d) return; // reset / unknown: never write a stale copy
      const res = await storeCollabDoc(d.workspaceId, d.kind, d.docId, document as unknown as Y.Doc, d.version, d.lastUserId);
      if (res.status === "stored" || res.status === "unchanged") {
        d.version = res.version;
        if (res.status === "stored") {
          // Spotlight + agents read the new text (lazy: the indexer loads on first use).
          void import("@/lib/search/text-index")
            .then((m) => m.scheduleUniverDocTextIndex(d.workspaceId, d.docId))
            .catch(() => undefined);
        }
      } else if (res.status === "stale") {
        void resetDocument(documentName, `replaced underneath (now version ${res.version})`);
      } else {
        void resetDocument(documentName, "the document is gone");
      }
    },

    async afterUnloadDocument({ documentName }) {
      live.delete(documentName);
    },
  });

  instance = server.hocuspocus;
  await server.listen();
  const port = server.address.port;
  log(`listening on ${port}`);

  async function pollOnce(): Promise<void> {
    const byWs = new Map<string, Array<[string, LiveDoc]>>();
    for (const entry of live) {
      const list = byWs.get(entry[1].workspaceId) ?? [];
      list.push(entry);
      byWs.set(entry[1].workspaceId, list);
    }
    for (const [ws, entries] of byWs) {
      const versions = await docVersions(ws, entries.map(([, d]) => d.docId)).catch(() => null);
      if (!versions) continue;
      for (const [name, d] of entries) {
        const now = versions.get(d.docId);
        if (now === undefined) void resetDocument(name, "the document is gone");
        else if (now !== d.version && live.get(name) === d) void resetDocument(name, `version ${d.version} → ${now}`);
      }
    }
  }

  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce()
      .catch((err) => log(`poll failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        polling = false;
      });
  }, opts.pollMs ?? COLLAB_POLL_MS);
  timer.unref?.();

  return {
    server,
    port,
    live,
    pollOnce,
    async close() {
      clearInterval(timer);
      // destroy() stores every loaded document, then closes connections.
      await server.destroy();
      log("stopped");
    },
  };
}
