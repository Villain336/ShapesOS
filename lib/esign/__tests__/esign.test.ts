// Marketr — E-sign module tests (slice 1).
// Run: npx tsx --test lib/esign/__tests__/esign.test.ts
// All network calls use injected mock fetch — no live services touched.
// Webhook fixtures mirror Documenso's documented payload shape:
//   { event, payload: { id, title, ... }, createdAt }

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  mapDocumensoStatus,
  mapDocumensoWebhookEvent,
  DOCUMENSO_WEBHOOK_EVENTS,
} from "../vendor";
import {
  addDocumensoFields,
  buildDocumensoFieldPayload,
  createDocumensoVendor,
  downloadDocumensoDocument,
  listDocumensoTemplates,
  parseDocumensoWebhook,
  verifyDocumensoWebhookSignature,
  voidDocumensoDocument,
  DOCUMENSO_WEBHOOK_SECRET_ENV,
} from "../documenso-vendor";
import { DocumensoApiError } from "@/lib/integrations/documenso";
import {
  appendAuditEvent,
  canonicalJson,
  chainEventHash,
  sha256Hex,
  verifyAuditChain,
  type AuditDb,
} from "../audit";

const ENV = {
  DOCUMENSO_URL: "https://documenso.example",
  DOCUMENSO_API_KEY: "test-key",
  [DOCUMENSO_WEBHOOK_SECRET_ENV]: "wh-secret",
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    return handler(u, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------ status map ---

describe("mapDocumensoStatus", () => {
  it("maps the documented lifecycle", () => {
    assert.equal(mapDocumensoStatus("DRAFT", 0, 2), "draft");
    assert.equal(mapDocumensoStatus("PENDING", 0, 2), "sent");
    assert.equal(mapDocumensoStatus("COMPLETED", 2, 2), "completed");
    assert.equal(mapDocumensoStatus("REJECTED", 0, 2), "declined");
    assert.equal(mapDocumensoStatus("CANCELLED", 0, 2), "voided");
  });

  it("reports partially-signed only with real progress", () => {
    assert.equal(mapDocumensoStatus("PENDING", 1, 2), "partially-signed");
    assert.equal(mapDocumensoStatus("PENDING", 0, 1), "sent");
  });

  it("never invents a status for unknown vendor states", () => {
    assert.equal(mapDocumensoStatus("SOMETHING_NEW", 0, 2), "error");
    assert.equal(mapDocumensoStatus("", 0, 0), "error");
  });

  it("is case-insensitive", () => {
    assert.equal(mapDocumensoStatus("completed", 1, 1), "completed");
  });
});

// ------------------------------------------------------- webhook mapping ---

describe("mapDocumensoWebhookEvent", () => {
  it("drives completion only on DOCUMENT_COMPLETED", () => {
    const t = mapDocumensoWebhookEvent("DOCUMENT_COMPLETED");
    assert.ok(t);
    assert.equal(t.envelopeStatus, "completed");
    assert.equal(t.terminal, true);
  });

  it("maps the signing lifecycle events", () => {
    assert.deepEqual(mapDocumensoWebhookEvent("DOCUMENT_SENT"), {
      envelopeStatus: "sent",
      terminal: false,
    });
    const signed = mapDocumensoWebhookEvent("DOCUMENT_SIGNED");
    assert.equal(signed?.envelopeStatus, "partially-signed");
    assert.equal(signed?.signerStatus, "signed");
    assert.equal(mapDocumensoWebhookEvent("DOCUMENT_REJECTED")?.envelopeStatus, "declined");
    assert.equal(mapDocumensoWebhookEvent("DOCUMENT_CANCELLED")?.envelopeStatus, "voided");
    assert.equal(mapDocumensoWebhookEvent("RECIPIENT_EXPIRED")?.envelopeStatus, "expired");
  });

  it("ignores informational events and unknown ones", () => {
    assert.equal(mapDocumensoWebhookEvent("DOCUMENT_CREATED"), null);
    assert.equal(mapDocumensoWebhookEvent("DOCUMENT_REMINDER_SENT"), null);
    assert.equal(mapDocumensoWebhookEvent("SOMETHING_ELSE"), null);
  });

  it("covers every documented event name", () => {
    for (const e of DOCUMENSO_WEBHOOK_EVENTS) {
      // Must not throw; null (ignored) is a valid answer.
      mapDocumensoWebhookEvent(e);
    }
  });
});

// ---------------------------------------------------------- webhook auth ---

describe("verifyDocumensoWebhookSignature", () => {
  it("accepts the exact shared secret", () => {
    assert.equal(verifyDocumensoWebhookSignature("wh-secret", ENV), true);
  });

  it("rejects wrong, missing, or unconfigured secrets (fail closed)", () => {
    assert.equal(verifyDocumensoWebhookSignature("nope", ENV), false);
    assert.equal(verifyDocumensoWebhookSignature(null, ENV), false);
    assert.equal(verifyDocumensoWebhookSignature("wh-secret", {}), false);
    assert.equal(verifyDocumensoWebhookSignature("", ENV), false);
  });
});

describe("parseDocumensoWebhook", () => {
  const body = JSON.stringify({
    event: "DOCUMENT_COMPLETED",
    payload: { id: "doc_123", title: "MSA — Acme" },
    createdAt: "2026-10-01T00:00:00Z",
  });

  it("parses the documented shape", () => {
    const p = parseDocumensoWebhook(body);
    assert.equal(p.event, "DOCUMENT_COMPLETED");
    assert.equal(p.documentId, "doc_123");
    assert.equal(p.title, "MSA — Acme");
  });

  it("rejects malformed bodies without partial parsing", () => {
    assert.throws(() => parseDocumensoWebhook("not json"), DocumensoApiError);
    assert.throws(() => parseDocumensoWebhook(JSON.stringify({})), DocumensoApiError);
    assert.throws(
      () => parseDocumensoWebhook(JSON.stringify({ event: "DOCUMENT_SIGNED" })),
      DocumensoApiError,
    );
    assert.throws(
      () => parseDocumensoWebhook(JSON.stringify({ event: "X", payload: {} })),
      DocumensoApiError,
    );
  });
});

// ------------------------------------------------------------ field map ---

describe("buildDocumensoFieldPayload", () => {
  it("maps field types and coordinates to the v1 shape", () => {
    const p = buildDocumensoFieldPayload({
      signerEmail: "jane@acme.com",
      fieldType: "signature",
      page: 2,
      x: 100,
      y: 200,
      width: 150,
      height: 40,
      required: true,
    });
    assert.deepEqual(p, {
      type: "SIGNATURE",
      pageNumber: 2,
      pageX: 100,
      pageY: 200,
      pageWidth: 150,
      pageHeight: 40,
      recipientEmail: "jane@acme.com",
    });
  });

  it("omits the recipient for unassigned fields", () => {
    const p = buildDocumensoFieldPayload({
      fieldType: "date",
      page: 1,
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      required: false,
    });
    assert.equal(p.type, "DATE");
    assert.ok(!("recipientEmail" in p));
  });
});

// ------------------------------------------------------ vendor endpoints ---

describe("documenso vendor endpoints (fail-closed)", () => {
  it("void sends DELETE and surfaces vendor refusals", async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch((url, init) => {
      seen.push(`${init?.method} ${url}`);
      return jsonResponse({ success: true });
    });
    await voidDocumensoDocument("doc_1", fetchImpl, ENV);
    assert.deepEqual(seen, ["DELETE https://documenso.example/api/v1/documents/doc_1"]);

    const failing = mockFetch(() => jsonResponse({ message: "Completed documents cannot be deleted." }, 400));
    await assert.rejects(() => voidDocumensoDocument("doc_1", failing, ENV), DocumensoApiError);
  });

  it("download rejects empty bodies", async () => {
    const empty = mockFetch(() => new Response(new ArrayBuffer(0), { status: 200 }));
    await assert.rejects(() => downloadDocumensoDocument("doc_1", empty, ENV), DocumensoApiError);
  });

  it("download returns bytes with a sha256 hash via the vendor", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const ok = mockFetch(() => new Response(pdf, { status: 200 }));
    const vendor = createDocumensoVendor(ok, ENV);
    const { bytes, hash } = await vendor.getSealedPdf("doc_1");
    assert.deepEqual(bytes, pdf);
    assert.equal(hash, createHash("sha256").update(pdf).digest("hex"));
  });

  it("template list parses defensively and fails closed on unknown shapes", async () => {
    const ok = mockFetch(() => jsonResponse({ templates: [{ id: "t1", title: "MSA" }] }));
    assert.deepEqual(await listDocumensoTemplates(ok, ENV), [{ id: "t1", name: "MSA" }]);

    const bare = mockFetch(() => jsonResponse([{ id: 7, name: "Offer" }]));
    assert.deepEqual(await listDocumensoTemplates(bare, ENV), [{ id: "7", name: "Offer" }]);

    const weird = mockFetch(() => jsonResponse({ nope: true }));
    await assert.rejects(() => listDocumensoTemplates(weird, ENV), DocumensoApiError);
  });

  it("addFields posts one call per field", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = mockFetch(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ id: "f1" });
    });
    await addDocumensoFields(
      "doc_1",
      [
        { fieldType: "signature", page: 1, x: 10, y: 10, width: 150, height: 40, required: true },
        { fieldType: "initials", page: 1, x: 10, y: 60, width: 80, height: 30, required: false },
      ],
      fetchImpl,
      ENV,
    );
    assert.equal(seen.length, 2);
    assert.ok(seen[0]!.url.endsWith("/documents/doc_1/fields"));
    assert.equal((seen[0]!.body as { type: string }).type, "SIGNATURE");
  });

  it("create → signers → send happy path", async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch((url, init) => {
      seen.push(`${init?.method} ${url}`);
      if (url.endsWith("/documents") && init?.method === "POST") {
        return jsonResponse({ id: "doc_9", title: "T", status: "DRAFT" });
      }
      return jsonResponse({});
    });
    const vendor = createDocumensoVendor(fetchImpl, ENV);
    const created = await vendor.createEnvelope({
      title: "T",
      pdfBytes: new Uint8Array([1, 2, 3]),
      filename: "t.pdf",
    });
    assert.equal(created.vendorRef, "doc_9");
    await vendor.addSigners("doc_9", [{ name: "A", email: "a@x.com", role: "signer", orderIndex: 0 }]);
    await vendor.sendEnvelope("doc_9");
    assert.ok(seen.some((s) => s.includes("/documents/doc_9/send")));
  });
});

// ------------------------------------------------------------------ audit ---

describe("audit hash chain", () => {
  it("is deterministic and sensitive to every input", () => {
    const a = chainEventHash(null, "created", "{}", "2026-10-01T00:00:00.000Z");
    const b = chainEventHash(null, "created", "{}", "2026-10-01T00:00:00.000Z");
    assert.equal(a, b);
    assert.equal(a, sha256Hex("GENESIS|created|2026-10-01T00:00:00.000Z|{}"));
    assert.notEqual(chainEventHash("prev", "created", "{}", "2026-10-01T00:00:00.000Z"), a);
    assert.notEqual(chainEventHash(null, "sent", "{}", "2026-10-01T00:00:00.000Z"), a);
  });

  it("canonicalJson sorts keys so payloads hash stably", () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ x: { b: 1, a: 2 } }), '{"x":{"a":2,"b":1}}');
  });

  it("verifyAuditChain catches tampering", () => {
    const rows = [
      { hash: "h1", previousHash: null },
      { hash: "h2", previousHash: "h1" },
      { hash: "h3", previousHash: "h2" },
    ];
    assert.equal(verifyAuditChain(rows), true);
    assert.equal(verifyAuditChain([{ hash: "h2", previousHash: "WRONG" }, rows[1]!]), false);
    assert.equal(verifyAuditChain([]), true);
  });
});

function fakeDb(): AuditDb & { rows: Array<{ hash: string; bodyHash: string }> } {
  const rows: Array<{ hash: string; bodyHash: string }> = [];
  const db: AuditDb = {
    esignAuditEvent: {
      async findFirst() {
        const last = rows[rows.length - 1];
        return last ? { hash: last.hash } : null;
      },
      async create({ data }) {
        const bodyHash = data.bodyHash as string;
        if (rows.some((r) => r.bodyHash === bodyHash)) {
          const e = new Error("unique") as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        const row = { hash: data.hash as string, bodyHash };
        rows.push(row);
        return { id: `evt_${rows.length}` };
      },
    },
  };
  return Object.assign(db, { rows });
}

describe("appendAuditEvent", () => {
  it("chains events and dedupes identical replays", async () => {
    const db = fakeDb();
    const first = await appendAuditEvent(db, {
      envelopeId: "env_1",
      event: "created",
      actor: "user:u1",
      payload: { title: "MSA" },
      bodyHash: sha256Hex("create-1"),
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    assert.ok(first.ok === true);
    assert.equal(db.rows.length, 1);

    const second = await appendAuditEvent(db, {
      envelopeId: "env_1",
      event: "sent",
      actor: "user:u1",
      payload: { title: "MSA" },
      bodyHash: sha256Hex("send-1"),
      createdAt: new Date("2026-10-01T00:01:00.000Z"),
    });
    assert.ok(second.ok === true && second.hash !== (first.ok ? first.hash : null));

    // Identical replay: no new row.
    const replay = await appendAuditEvent(db, {
      envelopeId: "env_1",
      event: "sent",
      actor: "user:u1",
      payload: { title: "MSA" },
      bodyHash: sha256Hex("send-1"),
      createdAt: new Date("2026-10-01T00:01:00.000Z"),
    });
    assert.deepEqual(replay, { ok: false, deduped: true });
    assert.equal(db.rows.length, 2);
  });
});
