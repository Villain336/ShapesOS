// ShapesOS — Phase 21A evals: tiny local fixture sites.
//
// Two origins on 127.0.0.1 (different ports are different origins): the SITE
// the task is about, and the ATTACKER, which records every request it gets.
// Pages are functions of both origins so a fixture can point at the other one.
// Used ONLY by the evals; nothing here is reachable from the app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}
export type FixturePage = string | FixtureResponse;
export interface Origins {
  site: string;
  evil: string;
}
export type PageMap = (o: Origins) => Record<string, FixturePage>;

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: string;
  at: number;
}

export interface FixtureWorld {
  origins: Origins;
  /** Every request the attacker origin received (exfiltration evidence). */
  attackerHits: RecordedRequest[];
  /** Every request the site origin received (form posts, etc.). */
  siteHits: RecordedRequest[];
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").slice(0, 100_000)));
    req.on("error", () => resolve(""));
  });
}

function serve(pages: () => Record<string, FixturePage>, hits: RecordedRequest[]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    hits.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body: await readBody(req), at: Date.now() });
    const page = pages()[url.pathname] ?? pages()[`${req.method} ${url.pathname}`];
    if (page === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const r: FixtureResponse = typeof page === "string" ? { body: page } : page;
    const type = url.pathname.endsWith(".json") || url.pathname.includes(".well-known") ? "application/json" : url.pathname.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8";
    res.writeHead(r.status ?? 200, { "content-type": type, ...(r.headers ?? {}) }).end(r.body ?? "");
  };
}

/** Start the site and the attacker; `sitePages` / `evilPages` see both origins. */
export async function startFixtureWorld(sitePages: PageMap, evilPages: PageMap = () => ({})): Promise<FixtureWorld> {
  const attackerHits: RecordedRequest[] = [];
  const siteHits: RecordedRequest[] = [];
  const origins: Origins = { site: "", evil: "" };
  const siteServer = createServer(serve(() => sitePages(origins), siteHits));
  const evilServer = createServer(serve(() => evilPages(origins), attackerHits));
  const [sp, ep] = await Promise.all([listen(siteServer), listen(evilServer)]);
  origins.site = `http://127.0.0.1:${sp}`;
  origins.evil = `http://127.0.0.1:${ep}`;
  return {
    origins,
    attackerHits,
    siteHits,
    async close() {
      await Promise.all([siteServer, evilServer].map((s) => new Promise<void>((r) => (s.closeAllConnections?.(), s.close(() => r())))));
    },
  };
}
