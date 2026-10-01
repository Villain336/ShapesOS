// Marketr — E-sign module tests (slice 4): templates + pipeline links.
// Run: npx tsx --test lib/esign/__tests__/templates.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTemplate,
  deleteTemplate,
  instantiateTemplate,
  resolveMergeValues,
  updateTemplate,
  type CreateTemplateInput,
} from "../templates";
import { EsignGateError } from "../envelopes";
import { firePipelineLinks, onPipelineLink, type PipelineLinkEvent } from "../pipeline";

function makeDb() {
  const templates = new Map<string, any>();
  const envelopes = new Map<string, any>();
  const auditRows: any[] = [];
  let seq = 0;
  const db = {
    templates,
    envelopes,
    auditRows,
    esignTemplate: {
      async create({ data }: any) {
        const id = `tpl_${++seq}`;
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        templates.set(id, row);
        return row;
      },
      async findFirst({ where }: any) {
        for (const t of templates.values()) {
          if (where.id && t.id !== where.id) continue;
          if (where.workspaceId && t.workspaceId !== where.workspaceId) continue;
          return t;
        }
        return null;
      },
      async update({ where, data }: any) {
        const t = templates.get(where.id);
        if (!t) throw new Error("not found");
        Object.assign(t, data, { updatedAt: new Date() });
        return t;
      },
      async delete({ where }: any) {
        templates.delete(where.id);
        return { id: where.id };
      },
    },
    esignEnvelope: {
      async create({ data }: any) {
        const id = `env_${++seq}`;
        const env: any = {
          id,
          workspaceId: data.workspaceId,
          title: data.title,
          status: data.status ?? "draft",
          signingOrder: data.signingOrder ?? "sequential",
          vendor: "documenso",
          vendorRef: null,
          vendorStatus: null,
          documentName: data.documentName ?? null,
          documentSize: data.documentSize ?? null,
          sourcePdf: data.sourcePdf ?? null,
          sourcePdfHash: data.sourcePdfHash ?? null,
          sealedPdf: null,
          sealedPdfHash: null,
          sealedPdfFetchedAt: null,
          contractType: data.contractType ?? null,
          contractRef: data.contractRef ?? null,
          pipelineRef: null,
          templateId: data.templateId ?? null,
          expiresAt: data.expiresAt ?? null,
          voidReason: null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          signers: [],
          fields: [],
        };
        for (const s of data.signers?.create ?? []) {
          env.signers.push({ id: `sgn_${++seq}`, envelopeId: id, signedAt: null, identityEvidence: null, ...s });
        }
        for (const f of data.fields?.create ?? []) {
          env.fields.push({ id: `fld_${++seq}`, envelopeId: id, signerId: null, value: null, ...f });
        }
        envelopes.set(id, env);
        return env;
      },
      async findFirst({ where }: any) {
        for (const env of envelopes.values()) {
          if (where.id && env.id !== where.id) continue;
          if (where.workspaceId && env.workspaceId !== where.workspaceId) continue;
          return env;
        }
        return null;
      },
      async update({ where, data }: any) {
        const env = envelopes.get(where.id);
        if (!env) throw new Error("not found");
        Object.assign(env, data, { updatedAt: new Date() });
        return env;
      },
    },
    esignSigner: {
      async update() {
        throw new Error("not needed");
      },
    },
    esignField: {
      async update({ where, data }: any) {
        for (const env of envelopes.values()) {
          const f = env.fields.find((x: any) => x.id === where.id);
          if (f) {
            Object.assign(f, data);
            return f;
          }
        }
        throw new Error("field not found");
      },
    },
    esignAuditEvent: {
      async findFirst({ where }: any) {
        const rows = auditRows.filter((r) => r.envelopeId === where.envelopeId);
        const last = rows[rows.length - 1];
        return last ? { hash: last.hash } : null;
      },
      async create({ data }: any) {
        if (auditRows.some((r) => r.bodyHash === data.bodyHash)) {
          const e = new Error("unique") as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        const row = { id: `evt_${++seq}`, ...data };
        auditRows.push(row);
        return row;
      },
    },
  };
  return db as any;
}

function templateInput(overrides: Partial<CreateTemplateInput> = {}): CreateTemplateInput {
  return {
    workspaceId: "ws_1",
    name: "MSA template",
    pdfBytes: new Uint8Array([1, 2, 3]),
    documentName: "msa.pdf",
    signerRoles: [
      { role: "client", orderIndex: 0, required: true },
      { role: "vendor", orderIndex: 1, required: true },
    ],
    fieldLayout: [
      { signerRole: "client", fieldType: "signature", page: 1, x: 100, y: 200 },
      { signerRole: "vendor", fieldType: "signature", page: 1, x: 300, y: 200 },
    ],
    mergeFieldMapping: {
      client_name: { source: "proposal", path: "client.name", required: true },
      effective_date: { source: "manual", path: "effectiveDate", required: false },
    },
    ...overrides,
  };
}

// ------------------------------------------------------------- templates ---

describe("createTemplate", () => {
  it("stores the blueprint with its hash", async () => {
    const db = makeDb();
    const t = await createTemplate(db, templateInput());
    assert.equal(t.name, "MSA template");
    assert.ok(t.sourceDocumentHash);
    assert.equal(t.sourceDocumentSize, 3);
  });

  it("rejects broken blueprints with named reasons", async () => {
    const db = makeDb();
    await assert.rejects(createTemplate(db, templateInput({ name: "  " })), EsignGateError);
    await assert.rejects(createTemplate(db, templateInput({ pdfBytes: new Uint8Array(0) })), EsignGateError);
    await assert.rejects(createTemplate(db, templateInput({ signerRoles: [] })), EsignGateError);
    await assert.rejects(
      createTemplate(
        db,
        templateInput({ fieldLayout: [{ signerRole: "ghost", fieldType: "signature" }] }),
      ),
      (e: unknown) => e instanceof EsignGateError && e.code === "field_role_mismatch",
    );
    await assert.rejects(
      createTemplate(
        db,
        templateInput({
          signerRoles: [
            { role: "client", orderIndex: 0, required: true },
            { role: "Client", orderIndex: 1, required: true },
          ],
        }),
      ),
      (e: unknown) => e instanceof EsignGateError && e.code === "duplicate_role",
    );
  });

  it("update re-validates; delete removes", async () => {
    const db = makeDb();
    const t = await createTemplate(db, templateInput());
    // Removing a role that a field references must fail.
    await assert.rejects(
      updateTemplate(db, {
        templateId: t.id,
        workspaceId: "ws_1",
        signerRoles: [{ role: "client", orderIndex: 0, required: true }],
      }),
      (e: unknown) => e instanceof EsignGateError && e.code === "field_role_mismatch",
    );
    const ok = await updateTemplate(db, { templateId: t.id, workspaceId: "ws_1", name: "MSA v2" });
    assert.equal(ok.name, "MSA v2");
    await deleteTemplate(db, t.id, "ws_1");
    assert.equal(db.templates.size, 0);
  });
});

// ------------------------------------------------------------------ merge ---

describe("resolveMergeValues", () => {
  const mapping = {
    client_name: { source: "proposal", path: "client.name", required: true },
    note: { source: "manual", path: "note", required: false },
  };

  it("resolves declared values", () => {
    const r = resolveMergeValues(mapping, { client_name: "Acme" });
    assert.deepEqual(r, { client_name: "Acme" });
  });

  it("blocks missing required values and unmapped extras with named reasons", () => {
    assert.throws(
      () => resolveMergeValues(mapping, {}),
      (e: unknown) => e instanceof EsignGateError && e.code === "missing_merge_value",
    );
    assert.throws(
      () => resolveMergeValues(mapping, { client_name: "Acme", rogue: "x" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "unmapped_merge_value",
    );
  });
});

// ----------------------------------------------------------- instantiate ---

describe("instantiateTemplate", () => {
  it("mints a draft from the template's exact bytes", async () => {
    const db = makeDb();
    const t = await createTemplate(db, templateInput());
    const { envelope, resolvedMergeKeys } = await instantiateTemplate(db, {
      templateId: t.id,
      workspaceId: "ws_1",
      mergeValues: { client_name: "Acme" },
      signerBindings: [
        { role: "vendor", name: "Victor", email: "v@vendor.com" },
        { role: "client", name: "Cara", email: "c@acme.com" },
      ],
    });
    assert.equal(envelope.status, "draft");
    assert.equal(envelope.templateId, t.id);
    assert.deepEqual(Array.from(envelope.sourcePdf as Uint8Array), [1, 2, 3]);
    // Ordered by role orderIndex regardless of binding order.
    assert.equal(envelope.signers[0].email, "c@acme.com");
    assert.equal(envelope.signers[1].email, "v@vendor.com");
    // Fields bound to the right signers by role.
    assert.equal(envelope.fields.length, 2);
    assert.equal(envelope.fields[0].signerId, envelope.signers[0].id);
    assert.equal(envelope.fields[1].signerId, envelope.signers[1].id);
    assert.deepEqual(resolvedMergeKeys, ["client_name"]);
    assert.ok(db.auditRows.some((r: any) => r.event === "template_instantiated"));
  });

  it("blocks every mismatch class with a named reason", async () => {
    const db = makeDb();
    const t = await createTemplate(db, templateInput());
    const good = {
      templateId: t.id,
      workspaceId: "ws_1",
      mergeValues: { client_name: "Acme" },
      signerBindings: [
        { role: "client", name: "Cara", email: "c@acme.com" },
        { role: "vendor", name: "Victor", email: "v@vendor.com" },
      ],
    };
    await assert.rejects(
      instantiateTemplate(db, { ...good, templateId: "tpl_nope" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "unknown_template",
    );
    await assert.rejects(
      instantiateTemplate(db, { ...good, mergeValues: {} }),
      (e: unknown) => e instanceof EsignGateError && e.code === "missing_merge_value",
    );
    await assert.rejects(
      instantiateTemplate(db, {
        ...good,
        signerBindings: [{ role: "client", name: "Cara", email: "c@acme.com" }],
      }),
      (e: unknown) => e instanceof EsignGateError && e.code === "unbound_signer_role",
    );
    await assert.rejects(
      instantiateTemplate(db, {
        ...good,
        signerBindings: [...good.signerBindings, { role: "ghost", name: "G", email: "g@x.com" }],
      }),
      (e: unknown) => e instanceof EsignGateError && e.code === "unknown_signer_role",
    );
    assert.equal(db.envelopes.size, 0, "a blocked instantiation creates nothing");
  });
});

// --------------------------------------------------------------- pipeline ---

describe("firePipelineLinks", () => {
  it("fires proposal/sow/contract links with a durable audit row", async () => {
    const db = makeDb();
    const seen: PipelineLinkEvent[] = [];
    const unsub = onPipelineLink((e) => {
      seen.push(e);
    });
    try {
      const fired = await firePipelineLinks(db, {
        id: "env_1",
        workspaceId: "ws_1",
        contractType: "proposal",
        contractRef: "prop_1",
        pipelineRef: null,
      });
      assert.equal(fired.length, 1);
      assert.equal(fired[0]!.kind, "proposal_to_contract");
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.refId, "prop_1");
      assert.ok(db.auditRows.some((r: any) => r.event === "pipeline_link_fired"));

      const sow = await firePipelineLinks(db, {
        id: "env_2",
        workspaceId: "ws_1",
        contractType: "sow",
        contractRef: null,
        pipelineRef: "sow_9",
      });
      assert.equal(sow[0]!.kind, "sow_to_invoice_draft");
      assert.equal(sow[0]!.refId, "sow_9");

      const none = await firePipelineLinks(db, {
        id: "env_3",
        workspaceId: "ws_1",
        contractType: null,
        contractRef: null,
        pipelineRef: null,
      });
      assert.equal(none.length, 0);
    } finally {
      unsub();
    }
  });

  it("unsubscribing stops delivery", async () => {
    const db = makeDb();
    let count = 0;
    const unsub = onPipelineLink(() => {
      count++;
    });
    unsub();
    await firePipelineLinks(db, {
      id: "env_1",
      workspaceId: "ws_1",
      contractType: "contract",
      contractRef: "ctr_1",
      pipelineRef: null,
    });
    assert.equal(count, 0);
  });
});
