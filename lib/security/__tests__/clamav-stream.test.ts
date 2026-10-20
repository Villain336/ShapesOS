// ShapesOS — Phase 21B (WS=drive): streaming scan of large objects through clamd's
// INSTREAM protocol, against a tiny in-process FAKE clamd (a labelled mock — a real
// ClamAV daemon is UNVERIFIED-LIVE here). (unit)
// Run: npx tsx --test lib/security/__tests__/clamav-stream.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { ClamAvScanner } from "../malware-scan";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
let server: Server;
let port = 0;
const received: number[] = [];

before(async () => {
  server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let cmdSeen = false;
    let total = 0;
    let all = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!cmdSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        assert.equal(buf.subarray(0, nul).toString(), "zINSTREAM");
        buf = buf.subarray(nul + 1);
        cmdSeen = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          received.push(total);
          const found = all.includes(Buffer.from(EICAR));
          sock.end(found ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < 4 + len) return;
        const chunk = buf.subarray(4, 4 + len);
        total += chunk.length;
        all = Buffer.concat([all, chunk]);
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server.close();
});

async function* chunks(parts: Buffer[]) {
  for (const p of parts) yield p;
}

describe("ClamAvScanner.scanStream", () => {
  it("streams every chunk and reports clean", async () => {
    const s = new ClamAvScanner("127.0.0.1", port);
    const r = await s.scanStream(chunks([Buffer.alloc(300_000, 1), Buffer.alloc(300_000, 2)]));
    assert.deepEqual(r, { clean: true });
    assert.equal(received.at(-1), 600_000);
  });
  it("finds a signature even when it straddles two chunks", async () => {
    const s = new ClamAvScanner("127.0.0.1", port);
    const e = Buffer.from(EICAR);
    const r = await s.scanStream(chunks([Buffer.concat([Buffer.alloc(1000, 65), e.subarray(0, 20)]), Buffer.concat([e.subarray(20), Buffer.alloc(10, 66)])]));
    assert.deepEqual(r, { clean: false, signature: "Eicar-Test-Signature" });
  });
  it("fails closed when the daemon is unreachable", async () => {
    const s = new ClamAvScanner("127.0.0.1", 1, 500);
    await assert.rejects(() => s.scanStream(chunks([Buffer.from("x")])));
  });
});
