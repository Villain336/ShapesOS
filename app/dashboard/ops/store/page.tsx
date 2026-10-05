// ShapesOS — Phase 10 (store): /dashboard/ops/store — the workspace's public
// storefront: settings, publish switch, listed products, a link to the live
// store and recent web orders. Writes go through the generic
// /api/ops/{stores,store-listings} routes (editor+, audited).

import { headers } from "next/headers";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { requireOpsViewer } from "@/lib/ops/page-guard";
import { storeOverview } from "@/lib/ops/store/admin";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { StoreView } from "@/components/ops/StoreView";

export const dynamic = "force-dynamic";

export const metadata = { title: "Online store — ShapesOS", description: "Public storefront, listed products and web orders." };

export default async function Page() {
  const actor = await requireOpsViewer();
  const ws = actor.workspaceId;
  const data = await withWorkspaceScope(ws, async (tx) => {
    const [overview, products, taxRates, warehouses, orders, finance] = await Promise.all([
      storeOverview(tx, ws),
      tx.opsProduct.findMany({ where: { workspaceId: ws }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, sku: true, active: true } }),
      tx.opsTaxRate.findMany({ where: { workspaceId: ws, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, rateBps: true } }),
      tx.opsWarehouse.findMany({ where: { workspaceId: ws, active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
      tx.opsOrder.findMany({
        where: { workspaceId: ws, source: "web" },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: { id: true, status: true, totalCents: true, customerEmail: true, paidAt: true, createdAt: true, promotionCode: true },
      }),
      tx.opsFinanceSettings.findUnique({ where: { workspaceId: ws }, select: { currency: true } }),
    ]);
    return { overview, products, taxRates, warehouses, orders, defaultCurrency: finance?.currency ?? "USD" };
  });
  const h = await headers();
  const origin = h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : null;
  return (
    <StoreView
      workspaceId={ws}
      publicBase={appBaseUrl(process.env, origin) ?? ""}
      overview={data.overview}
      products={data.products}
      taxRates={data.taxRates}
      warehouses={data.warehouses}
      defaultCurrency={data.defaultCurrency}
      orders={data.orders.map((o) => ({ ...o, paidAt: o.paidAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString() }))}
    />
  );
}
