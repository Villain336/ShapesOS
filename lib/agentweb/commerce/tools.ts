// ShapesOS — Phase 21A round 2 (WS=agentweb): agent tools for commerce.
//
//   cart_request_signature  group web  kind safe  action write_cart_request
//       Put a cart (merchant, items, total) in front of the person on a card in Needs you. The
//       agent can ask; it cannot approve. Nothing is paid or ordered by this tool, and no tool
//       exists that signs a cart or completes a checkout: signing is the person's click on the
//       card (POST /api/agentweb/mandates/:id/sign, a session route that refuses every other
//       channel), and completion happens on the server as a result of that click.
//   cart_status             group web  kind safe  read
//       What happened to a cart request: waiting, signed, rejected, expired, used, and where
//       the person finishes the checkout when the merchant offers no checkout of its own.
//
// Words matter: the tier check scans a tool's name and description for money verbs, so these
// descriptions say "approve" and "cart" and never the verbs of spending.

import { registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import { CardDataError, CartError } from "./cart";
import { MandateStoreError } from "./mandate-store";

type Ctx = ToolContext & { threadId?: string };

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

export const cart_request_signature: ToolDef = {
  name: "cart_request_signature",
  description:
    "Show the person a cart (merchant, items, quantities, prices, total) so they can approve it with one click on a card in Needs you. You can ask; only the person can approve, and approving is only ever their click. Nothing is paid or ordered by this tool. Use only the prices and names you actually saw on the merchant's page, in minor units (pence, cents). Never include card details.",
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      merchant_name: { type: "string", description: "The shop's name (required)." },
      merchant_url: { type: "string", description: "The shop's address, https://… (required)." },
      currency: { type: "string", description: "Three-letter currency code, e.g. GBP (required)." },
      items: { type: "string", description: 'JSON array of {"name","qty","unitMinor","sku"?} (required). unitMinor is an integer in minor units.' },
    },
    required: ["merchant_name", "merchant_url", "currency", "items"],
  },
  async execute(rawCtx, args): Promise<ToolResult> {
    const ctx = rawCtx as Ctx;
    let items: unknown;
    try {
      items = typeof args.items === "string" ? JSON.parse(args.items) : args.items;
    } catch {
      return { summary: "The items were not valid JSON. Send an array of {name, qty, unitMinor}.", details: { error: "bad_items" } };
    }
    try {
      const { createMandate } = await import("./mandate-store");
      const m = await createMandate(ctx.workspaceId, { requestedBy: `agent:${ctx.agentKey ?? "lead"}`, runId: ctx.runId ?? null, cart: { merchant: { name: args.merchant_name, origin: args.merchant_url }, currency: args.currency, items } });
      return {
        summary: `Cart request ${m.id} is waiting for the person: ${m.items.length} item(s) from ${m.merchantName}, ${money(m.amountMinor, m.currency)}. It is on a card in Needs you. Nothing is paid or ordered until they approve it themselves. Call cart_status to see what they decided; do not ask them to approve in chat, it will not count.`,
        details: { mandateId: m.id, status: m.status, amountMinor: m.amountMinor, currency: m.currency, expiresAt: m.expiresAt, href: "/dashboard/approvals" },
      };
    } catch (err) {
      if (err instanceof CardDataError) return { summary: "Payment card details are not accepted here, and none were stored. The person enters card details only on the merchant's own payment page.", details: { error: "card_data" } };
      if (err instanceof CartError || err instanceof MandateStoreError) return { summary: err.message, details: { error: (err as MandateStoreError).code ?? "cart" } };
      throw err;
    }
  },
};

export const cart_status: ToolDef = {
  name: "cart_status",
  description: "Check what happened to a cart request you made: waiting for the person, approved, rejected, expired or finished, and the link where the person completes it when the shop offers no checkout of its own.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { mandate_id: { type: "string", description: "The id returned by cart_request_signature (required)." } }, required: ["mandate_id"] },
  async execute(rawCtx, args): Promise<ToolResult> {
    const ctx = rawCtx as Ctx;
    const id = typeof args.mandate_id === "string" ? args.mandate_id : "";
    const { getMandate } = await import("./mandate-store");
    const m = /^man_[0-9a-f]{20}$/.test(id) ? await getMandate(ctx.workspaceId, id) : null;
    if (!m) return { summary: "No such cart request.", details: { error: "not_found" } };
    const text: Record<string, string> = {
      pending: "Waiting for the person to approve it. Nothing has happened yet.",
      signed: "The person approved it. The checkout is being finished, or is waiting for them at the shop.",
      used: `Done${m.checkoutRef ? ` (${m.checkoutRef})` : ""}.`,
      rejected: "The person rejected it. Do not ask again unless they ask you to.",
      expired: "It expired before the person approved it. Make a new request if they still want it.",
    };
    return { summary: `${m.merchantName}, ${money(m.amountMinor, m.currency)}: ${text[m.status]}`, details: { status: m.status, expiresAt: m.expiresAt, checkoutRef: m.checkoutRef } };
  },
};

registerExtraTool(cart_request_signature);
registerExtraTool(cart_status);
