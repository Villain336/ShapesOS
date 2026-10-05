// ShapesOS — Phase 10 (store): storefront tools for the agent surface.
//
// Part of OPS_TOOLS (lib/chat/ops-tools.ts spreads STORE_OPS_TOOLS into it)
// — same ToolDef contract, same runOps scoping, no new registry.
//
//   ops_store_overview       read (safe, viewer): the store, its listings,
//                            web-order counts and the latest web orders.
//   ops_store_list_product   put a product in the store, update its copy, or
//                            take it off the store (publish kind, editor,
//                            action write_store_listing — Tier 2, always asks).
// Nothing here moves money: buyers pay on Stripe, the signed webhook records
// it. Publishing the whole store stays a person's switch on the Online store
// page.

import type { Prisma } from "@prisma/client";
import { opsCreate, opsEntityDef, opsList, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { storeOverview } from "@/lib/ops/store/admin";
import { orderLabel } from "@/lib/ops/store/view";
import type { ToolContext, ToolDef, ToolResult } from "./tools";

type Tx = Prisma.TransactionClient;

const opsTools = () => import("./ops-tools");

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function run<T>(ctx: ToolContext, fn: (tx: Tx, actor: OpsActor) => Promise<T>): Promise<T> {
  return (await opsTools()).runOps(ctx, fn);
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export async function storeOverviewCore(tx: Tx, actor: OpsActor): Promise<ToolResult> {
  const ov = await storeOverview(tx, actor.workspaceId);
  if (!ov.store) {
    return { summary: "No online store yet — create one on /dashboard/ops/store.", details: { store: null } };
  }
  const { rows } = await opsList(tx, opsEntityDef("orders"), actor, { limit: 10, filters: { source: "web" } });
  const listed = ov.listings.filter((l) => l.listed && l.productActive).length;
  return {
    summary:
      `Store "${ov.store.name}" (/shop/${ov.store.slug}) is ${ov.store.published ? "published" : "unpublished"}; ` +
      `${listed} product(s) on sale; Stripe ${ov.stripeConnected ? "connected" : "NOT connected (checkout is off)"}; ` +
      `web orders: ${ov.webOrders.confirmed} confirmed, ${ov.webOrders.fulfilled} fulfilled, ${ov.webOrders.draft} awaiting payment; ` +
      `${money(ov.webOrders.paidCents30d)} paid in the last 30 days.`,
    details: {
      ...ov,
      recentWebOrders: rows.map((r) => ({
        id: r.id,
        label: orderLabel(String(r.id)),
        status: r.status,
        totalCents: r.totalCents,
        customerEmail: r.customerEmail ?? null,
        paidAt: r.paidAt ?? null,
      })),
    },
  };
}

export async function storeListProductCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const productId = str(args.productId);
  if (!productId) throw new Error('"productId" is required');
  const ov = await storeOverview(tx, actor.workspaceId);
  if (!ov.store) throw new Error("This workspace has no online store yet — a person creates it on /dashboard/ops/store.");
  const listedArg = str(args.listed);
  const listed = listedArg === undefined ? true : listedArg !== "false";
  const copy: Record<string, unknown> = {};
  if (str(args.title) !== undefined) copy.title = str(args.title);
  if (str(args.description) !== undefined) copy.description = str(args.description);
  const existing = ov.listings.find((l) => l.productId === productId);
  const def = opsEntityDef("store-listings");
  const r = existing
    ? await opsPatch(tx, def, actor, { id: existing.id, listed, ...copy })
    : await opsCreate(tx, def, actor, { storeId: ov.store.id, productId, listed, position: ov.listings.length + 1, ...copy });
  if (r.outcome !== "done") throw new Error("expected a direct write, got an approval request");
  const row = r.row;
  return {
    summary: `${existing ? "Updated" : "Added"} listing /shop/${ov.store.slug}/p/${String(row.slug)} — ${listed ? "shown" : "hidden"} in the store${ov.store.published ? "" : " (the store itself is unpublished)"}.`,
    details: row,
  };
}

export const STORE_OPS_TOOLS: ToolDef[] = [
  {
    name: "ops_store_overview",
    description:
      "The workspace's online store: address, published or not, whether Stripe is connected, the products on sale (price, stock), web-order counts and the latest web orders.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: {} },
    async execute(ctx) {
      return run(ctx, (tx, actor) => storeOverviewCore(tx, actor));
    },
  },
  {
    name: "ops_store_list_product",
    description:
      "Put a product in the online store (or update its store title/description, or hide it with listed=\"false\"). Price and stock always come from the product. Does not publish the store.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product id (required)." },
        listed: { type: "string", description: '"true" (default) to show it, "false" to hide it.' },
        title: { type: "string", description: "Title in the store (optional; defaults to the product name)." },
        description: { type: "string", description: "Store description (optional)." },
      },
      required: ["productId"],
    },
    async execute(ctx, args) {
      return run(ctx, (tx, actor) => storeListProductCore(tx, actor, args));
    },
  },
];
