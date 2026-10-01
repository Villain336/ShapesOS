// Marketr — Wave 2 Insurance slice 2: thin MCP shim over the vendor adapter.
//
// CoverForce exposes REST, not MCP, so the OS ships this small shim letting
// OS agents call insurance as tools. Tool-shaped (never 1:1 REST mirrors),
// zod-validated, workspace-scoped, and honest: responses are labeled fixtures
// (`live: false`) until the Startup Program credentials exist — never
// fabricated data presented as real.

import { z } from "zod";
import { CoverForceVendor } from "./coverforce";
import { InsuranceVendorError } from "./mock-vendor";
import {
  executeBind,
  serializeBindPolicy,
  serializePaymentHandoff,
} from "./binding";
import { InsuranceError, LINE_LABELS } from "./types";

const LINE_VALUES = Object.keys(LINE_LABELS);

export interface ShimContext {
  workspaceId: string;
  actor: string;
}

export interface ShimToolResult {
  data: Record<string, unknown>;
}

export class ShimToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShimToolError";
  }
}

type Handler = (ctx: ShimContext, args: Record<string, unknown>) => Promise<ShimToolResult>;

export interface ShimToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: Handler;
}

function vendor(): CoverForceVendor {
  // Fixture mode until the Startup Program paperwork is signed.
  return new CoverForceVendor({ mode: "fixture" });
}

const appetiteSchema = z.object({
  line: z.enum(LINE_VALUES as [string, ...string[]]),
  classCode: z.string().max(20).optional(),
  state: z.string().regex(/^[A-Z]{2}$/i).optional(),
});

const submitSchema = z.object({
  line: z.enum(LINE_VALUES as [string, ...string[]]),
  applicantName: z.string().trim().min(1).max(200),
  state: z.string().regex(/^[A-Z]{2}$/i),
  payrollCents: z.number().int().min(0).nullable().optional(),
  revenueCents: z.number().int().min(0).nullable().optional(),
});

const quotesSchema = z.object({
  submissionRef: z.string().trim().min(1).max(80),
});

const bindSchema = z.object({
  quoteId: z.string().trim().min(1).max(100),
  approvalId: z.string().trim().min(1).max(100),
});

export const INSURANCE_SHIM_TOOLS: ShimToolDef[] = [
  {
    name: "insurance_check_appetite",
    description:
      "Check which carriers have appetite for a line of business and state. " +
      "Fixture data until CoverForce credentials exist; always labeled.",
    inputSchema: appetiteSchema,
    handler: async (_ctx, args) => {
      const parsed = appetiteSchema.parse(args);
      const result = await vendor().checkAppetite({
        line: parsed.line as keyof typeof LINE_LABELS,
        classCode: parsed.classCode,
        state: parsed.state?.toUpperCase(),
      });
      return { data: { ...result, live: false } };
    },
  },
  {
    name: "insurance_submit_risk",
    description:
      "Submit a risk packet to carriers for quoting. Discloses business data — " +
      "call only after the workspace owner approves the submission.",
    inputSchema: submitSchema,
    handler: async (_ctx, args) => {
      const parsed = submitSchema.parse(args);
      const result = await vendor().submit({
        line: parsed.line as keyof typeof LINE_LABELS,
        applicantName: parsed.applicantName,
        state: parsed.state.toUpperCase(),
        payrollCents: parsed.payrollCents ?? null,
        revenueCents: parsed.revenueCents ?? null,
      });
      return { data: { ...result, live: false } };
    },
  },
  {
    name: "insurance_get_quotes",
    description:
      "Fetch quotes for a submission, normalized for comparison. Declines are " +
      "first-class results with documented reasons.",
    inputSchema: quotesSchema,
    handler: async (_ctx, args) => {
      const parsed = quotesSchema.parse(args);
      const quotes = await vendor().getQuotes({ submissionRef: parsed.submissionRef });
      return { data: { quotes, live: false } };
    },
  },
  {
    name: "insurance_bind_policy",
    description:
      "Execute a bind for an APPROVED bind_policy governed action. Heavy " +
      "gate: requires the explicit human approval id, an appointed licensed " +
      "partner, and a quoted, unexpired quote whose terms still match the " +
      "approval disclosure. Premium moves carrier-direct (zero custody) — " +
      "the OS never holds funds. Fixture data until CoverForce credentials " +
      "exist; always labeled.",
    inputSchema: bindSchema,
    handler: async (ctx, args) => {
      const parsed = bindSchema.parse(args);
      try {
        const result = await executeBind({
          workspaceId: ctx.workspaceId,
          quoteId: parsed.quoteId,
          approvalId: parsed.approvalId,
          requestedBy: ctx.actor,
        });
        return {
          data: {
            policy: serializeBindPolicy(result.policy),
            paymentHandoff: serializePaymentHandoff(result.paymentHandoff),
            live: result.live,
            replayed: result.replayed,
          },
        };
      } catch (e) {
        if (e instanceof InsuranceError || e instanceof InsuranceVendorError) {
          throw new ShimToolError(e.code, e.message);
        }
        throw e;
      }
    },
  },
];

/** Look up a shim tool by name; throws a named error for unknown tools. */
export function getShimTool(name: string): ShimToolDef {
  const tool = INSURANCE_SHIM_TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new ShimToolError("UNKNOWN_TOOL", `Unknown insurance tool: ${name}.`);
  }
  return tool;
}
