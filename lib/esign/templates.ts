// Marketr — E-sign module: SigningTemplate CRUD + governed instantiation.
// A SigningTemplate is a reusable envelope blueprint: a blueprint PDF, signer
// roles, a field layout bound to those roles, and a merge-field mapping that
// declares which values the caller must supply. Instantiation validates
// everything up front — merge mismatches BLOCK with named reasons, never
// silent blanks — and mints a local draft from the template's exact bytes.
// The draft still goes through the heavy send gate; templates never send.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { appendAuditEvent, sha256Hex } from "./audit";
import { createEnvelopeDraft, EsignGateError, type DraftFieldInput } from "./envelopes";

export { EsignGateError };

export type EsignTemplateDb = Pick<PrismaClient, "esignTemplate">;

export interface MergeFieldDef {
  /** Where the value comes from, e.g. "proposal", "crm.contact", "manual". */
  source: string;
  /** Dotted path inside the source object, e.g. "client.name". */
  path: string;
  /** Required values block instantiation when missing. */
  required: boolean;
}

export interface SignerRoleDef {
  role: string;
  orderIndex: number;
  required: boolean;
}

export interface TemplateFieldDef {
  signerRole: string;
  fieldType: "signature" | "initials" | "date" | "text" | "checkbox";
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  required?: boolean;
}

export interface CreateTemplateInput {
  workspaceId: string;
  name: string;
  pdfBytes: Uint8Array;
  documentName?: string;
  signerRoles: SignerRoleDef[];
  fieldLayout: TemplateFieldDef[];
  mergeFieldMapping: Record<string, MergeFieldDef>;
  createdBy?: string;
}

export interface SignerBinding {
  role: string;
  name: string;
  email: string;
}

export interface InstantiateTemplateInput {
  templateId: string;
  workspaceId: string;
  title?: string;
  /** Values keyed by merge placeholder name. */
  mergeValues: Record<string, unknown>;
  signerBindings: SignerBinding[];
  expiresAt?: Date | null;
  createdBy?: string;
}

const FIELD_TYPES = ["signature", "initials", "date", "text", "checkbox"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function empty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Validate the blueprint itself. Throws EsignGateError on any defect. */
export function validateTemplateInput(input: CreateTemplateInput): void {
  if (!input.name.trim()) {
    throw new EsignGateError("missing_name", "The template needs a name.");
  }
  if (!(input.pdfBytes instanceof Uint8Array) || input.pdfBytes.length === 0) {
    throw new EsignGateError("empty_document", "The template needs a blueprint PDF.");
  }
  if (input.signerRoles.length === 0) {
    throw new EsignGateError("no_roles", "The template needs at least one signer role.");
  }
  const roles = new Set<string>();
  for (const r of input.signerRoles) {
    if (!r.role.trim()) throw new EsignGateError("blank_role", "Signer roles cannot be blank.");
    const key = r.role.trim().toLowerCase();
    if (roles.has(key)) throw new EsignGateError("duplicate_role", `Duplicate signer role "${r.role}".`);
    roles.add(key);
  }
  for (let i = 0; i < input.fieldLayout.length; i++) {
    const f = input.fieldLayout[i]!;
    if (!roles.has(f.signerRole.trim().toLowerCase())) {
      throw new EsignGateError(
        "field_role_mismatch",
        `Field #${i + 1} references unknown signer role "${f.signerRole}".`,
      );
    }
    if (!(FIELD_TYPES as readonly string[]).includes(f.fieldType)) {
      throw new EsignGateError("bad_field_type", `Field #${i + 1} has an unknown type "${f.fieldType}".`);
    }
  }
  for (const [name, def] of Object.entries(input.mergeFieldMapping)) {
    if (!name.trim()) throw new EsignGateError("blank_merge_name", "Merge placeholder names cannot be blank.");
    if (!isRecord(def) || typeof def.source !== "string" || typeof def.path !== "string") {
      throw new EsignGateError("bad_merge_def", `Merge field "${name}" needs a source and a path.`);
    }
  }
}

export async function createTemplate(db: EsignTemplateDb, input: CreateTemplateInput) {
  validateTemplateInput(input);
  const pdfHash = sha256Hex(input.pdfBytes);
  const template = await db.esignTemplate.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      sourceDocumentName: input.documentName ?? "template.pdf",
      sourceDocument: Buffer.from(input.pdfBytes),
      sourceDocumentHash: pdfHash,
      sourceDocumentSize: input.pdfBytes.length,
      signerRoles: input.signerRoles as unknown as Prisma.InputJsonValue,
      fieldLayout: input.fieldLayout as unknown as Prisma.InputJsonValue,
      mergeFieldMapping: input.mergeFieldMapping as unknown as Prisma.InputJsonValue,
      ownerUserId: input.createdBy ?? null,
    },
  });
  return template;
}

export async function updateTemplate(
  db: EsignTemplateDb,
  input: {
    templateId: string;
    workspaceId: string;
    name?: string;
    signerRoles?: SignerRoleDef[];
    fieldLayout?: TemplateFieldDef[];
    mergeFieldMapping?: Record<string, MergeFieldDef>;
    contractType?: string | null;
  },
) {
  const template = await db.esignTemplate.findFirst({
    where: { id: input.templateId, workspaceId: input.workspaceId },
  });
  if (!template) throw new EsignGateError("unknown_template", "Template not found.");

  const signerRoles = (input.signerRoles ?? (template.signerRoles as unknown as SignerRoleDef[])) as SignerRoleDef[];
  const fieldLayout = (input.fieldLayout ?? (template.fieldLayout as unknown as TemplateFieldDef[])) as TemplateFieldDef[];
  const mergeFieldMapping = (input.mergeFieldMapping ??
    (template.mergeFieldMapping as unknown as Record<string, MergeFieldDef>)) as Record<string, MergeFieldDef>;

  // Re-validate the merged blueprint so an edit can never leave it inconsistent.
  validateTemplateInput({
    workspaceId: input.workspaceId,
    name: input.name ?? template.name,
    pdfBytes: template.sourceDocument ?? new Uint8Array([0]),
    signerRoles,
    fieldLayout,
    mergeFieldMapping,
  });

  return db.esignTemplate.update({
    where: { id: template.id },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.contractType !== undefined ? { contractType: input.contractType?.trim() || null } : {}),
      signerRoles: signerRoles as unknown as Prisma.InputJsonValue,
      fieldLayout: fieldLayout as unknown as Prisma.InputJsonValue,
      mergeFieldMapping: mergeFieldMapping as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function deleteTemplate(db: EsignTemplateDb, templateId: string, workspaceId: string) {
  const template = await db.esignTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (!template) throw new EsignGateError("unknown_template", "Template not found.");
  await db.esignTemplate.delete({ where: { id: template.id } });
}

/**
 * Resolve merge values against the template's declared mapping.
 * Returns the validated values; throws EsignGateError with a NAMED reason
 * for every mismatch class. Nothing is ever silently blanked or ignored.
 */
export function resolveMergeValues(
  mapping: Record<string, MergeFieldDef>,
  mergeValues: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(mapping)) {
    const value = mergeValues[name];
    if (def.required && empty(value)) {
      throw new EsignGateError(
        "missing_merge_value",
        `Merge field "${name}" is required (source: ${def.source}, path: ${def.path}) but no value was supplied.`,
      );
    }
    if (!empty(value)) resolved[name] = value;
  }
  for (const key of Object.keys(mergeValues)) {
    if (!(key in mapping) && !empty(mergeValues[key])) {
      throw new EsignGateError(
        "unmapped_merge_value",
        `Merge value "${key}" was supplied but the template declares no such field — refusing to silently ignore it.`,
      );
    }
  }
  return resolved;
}

/**
 * Instantiate a template into a governed draft envelope. The draft is created
 * from the template's exact blueprint bytes; merge mismatches block with
 * named reasons; the send gate still applies afterwards.
 */
export async function instantiateTemplate(
  db: EsignTemplateDb & Parameters<typeof createEnvelopeDraft>[0],
  input: InstantiateTemplateInput,
) {
  const template = await db.esignTemplate.findFirst({
    where: { id: input.templateId, workspaceId: input.workspaceId },
  });
  if (!template) throw new EsignGateError("unknown_template", "Template not found.");
  if (!template.sourceDocument || !template.sourceDocumentHash) {
    throw new EsignGateError("empty_document", "The template has no blueprint document.");
  }

  const roles = template.signerRoles as unknown as SignerRoleDef[];
  const layout = template.fieldLayout as unknown as TemplateFieldDef[];
  const mapping = template.mergeFieldMapping as unknown as Record<string, MergeFieldDef>;
  const roleByName = new Map(roles.map((r) => [r.role.trim().toLowerCase(), r]));

  // Bind every required role to a real person; reject bindings to unknown roles.
  for (const b of input.signerBindings) {
    if (!roleByName.has(b.role.trim().toLowerCase())) {
      throw new EsignGateError("unknown_signer_role", `No signer role "${b.role}" on this template.`);
    }
  }
  for (const r of roles) {
    if (!r.required) continue;
    const bound = input.signerBindings.find((b) => b.role.trim().toLowerCase() === r.role.trim().toLowerCase());
    if (!bound || !bound.name.trim() || !bound.email.trim()) {
      throw new EsignGateError("unbound_signer_role", `Signer role "${r.role}" is required but not bound to a person.`);
    }
  }

  // Merge values resolve (blocking) before anything is created.
  const resolved = resolveMergeValues(mapping, input.mergeValues);

  const orderedBindings = [...input.signerBindings].sort((a, b) => {
    const ra = roleByName.get(a.role.trim().toLowerCase())!;
    const rb = roleByName.get(b.role.trim().toLowerCase())!;
    return ra.orderIndex - rb.orderIndex;
  });

  const emailByRole = new Map(
    orderedBindings.map((b) => [b.role.trim().toLowerCase(), b.email.trim().toLowerCase()]),
  );
  const fields: DraftFieldInput[] = layout.map((f) => ({
    signerEmail: emailByRole.get(f.signerRole.trim().toLowerCase()) ?? "",
    fieldType: f.fieldType,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
  }));

  const envelope = await createEnvelopeDraft(db, {
    workspaceId: input.workspaceId,
    title: input.title?.trim() || `${template.name} — ${new Date().toISOString().slice(0, 10)}`,
    signers: orderedBindings.map((b, i) => ({ name: b.name.trim(), email: b.email.trim(), orderIndex: i })),
    fields,
    signingOrder: "sequential",
    expiresAt: input.expiresAt ?? null,
    templateId: template.id,
    documentName: template.sourceDocumentName ?? "template.pdf",
    pdfBytes: new Uint8Array(template.sourceDocument),
    createdBy: input.createdBy,
  });

  // Durable record of the instantiation: which placeholders resolved (keys
  // only — values may be PII and don't belong in the audit log).
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "template_instantiated",
    actor: input.createdBy ? `user:${input.createdBy}` : "system",
    payload: {
      templateId: template.id,
      envelopeId: envelope.id,
      mergeKeys: Object.keys(resolved).sort(),
    },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["template_instantiated", template.id, envelope.id, Object.keys(resolved).sort()]))
      .digest("hex"),
  });

  return { envelope, resolvedMergeKeys: Object.keys(resolved).sort() };
}
