// Marketr — E-sign module API.
// POST /api/esign/agent/prepare-draft — the agent prepares a draft behind
// the send gate. It NEVER sends; the human review dialog mints the token.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { prepareEnvelopeDraft } from "@/lib/esign/agent";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

const BindingSchema = z.object({
  role: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
});

const SignerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(["signer", "approver", "cc"]).optional(),
});

const BodySchema = z.object({
  title: z.string().min(1).max(200),
  templateId: z.string().min(1).optional(),
  mergeValues: z.record(z.string(), z.unknown()).optional(),
  signerBindings: z.array(BindingSchema).optional(),
  documentName: z.string().max(255).optional(),
  signers: z.array(SignerSchema).min(1).max(50).optional(),
  signingOrder: z.enum(["sequential", "parallel"]).optional(),
  contractType: z.string().max(80).optional(),
  contractRef: z.string().max(200).optional(),
  // Raw path: base64 PDF bytes (reviewed upstream, e.g. an accepted proposal).
  pdfBase64: z.string().max(14_000_000).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid draft request." }, { status: 400 });
    const b = parsed.data;
    let pdfBytes: Uint8Array | undefined;
    if (b.pdfBase64) {
      try {
        pdfBytes = new Uint8Array(Buffer.from(b.pdfBase64, "base64"));
      } catch {
        return Response.json({ error: "pdfBase64 is not valid base64." }, { status: 400 });
      }
    }
    const res = await prepareEnvelopeDraft(prisma, {
      workspaceId: workspace.id,
      actor: `agent:${user.id}`,
      title: b.title,
      templateId: b.templateId,
      mergeValues: b.mergeValues,
      signerBindings: b.signerBindings,
      documentName: b.documentName,
      signers: b.signers,
      signingOrder: b.signingOrder,
      contractType: b.contractType,
      contractRef: b.contractRef,
      pdfBytes,
    });
    return Response.json(res);
  } catch (e) {
    if (e instanceof EsignGateError) {
      return Response.json({ error: e.message, code: e.code }, { status: 422 });
    }
    return httpErrorResponse(e);
  }
}
