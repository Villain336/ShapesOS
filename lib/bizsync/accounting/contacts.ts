// ShapesOS — Phase 11 (bizsync): import customers / vendors from QuickBooks
// Online or Xero (shared engine).
//
//   customers → OpsContact (dedupe by lower-cased email, like HubSpot)
//   vendors   → OpsVendor  (dedupe by name — unique per workspace)
// One biz_sync_links row per remote party and kind (objectType "customer" /
// "vendor"), so a re-import never duplicates; the shared conflict rule
// decides each record (remote changed = provider updated time newer than at
// the last import; local changed = the mapped fields' fingerprint differs).
// An empty remote value never erases a local one; a unique clash (email /
// name used by another local row) keeps the local value and is reported.
// Imports touch contacts and vendors only — never the journal.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { normalizeEmail } from "@/lib/ops/crm";
import { applyPulled, emptyReport, fingerprint, type SyncReport } from "../links";
import type { AccountingProvider, RemoteParty } from "./types";

const present = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as Partial<T>;

const remoteAt = (p: RemoteParty) => {
  const d = new Date(p.updatedAt);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

async function applyCustomer(workspaceId: string, provider: AccountingProvider, p: RemoteParty, report: SyncReport) {
  const email = normalizeEmail(p.email);
  const f = { name: p.name.slice(0, 200), email, phone: p.phone };
  await withWorkspaceScope(workspaceId, (tx) =>
    applyPulled({
      tx, workspaceId, provider: provider.key, objectType: "customer", remoteId: p.id, remoteAt: remoteAt(p), report,
      hashOf: (r) => fingerprint({ name: r.name, email: r.email, phone: r.phone }),
      findLocal: async (link) =>
        link ? tx.opsContact.findFirst({ where: { id: link.localId, workspaceId } }) : email ? tx.opsContact.findFirst({ where: { workspaceId, email } }) : null,
      create: () => tx.opsContact.create({ data: { workspaceId, ...f } }),
      update: async (local) => {
        const data = present(f);
        if (data.email && (await tx.opsContact.findFirst({ where: { workspaceId, email: data.email, NOT: { id: local.id } }, select: { id: true } }))) {
          report.conflicts.push({ objectType: "customer", remoteId: p.id, localId: local.id, resolution: "email used by another local contact; kept the local email" });
          delete data.email;
        }
        return tx.opsContact.update({ where: { id: local.id, workspaceId }, data });
      },
    }),
  );
}

async function applyVendor(workspaceId: string, provider: AccountingProvider, p: RemoteParty, report: SyncReport) {
  const f = { name: p.name.slice(0, 200), email: normalizeEmail(p.email), phone: p.phone, taxId: p.taxId ?? null, address: p.address ?? null };
  await withWorkspaceScope(workspaceId, (tx) =>
    applyPulled({
      tx, workspaceId, provider: provider.key, objectType: "vendor", remoteId: p.id, remoteAt: remoteAt(p), report,
      hashOf: (r) => fingerprint({ name: r.name, email: r.email, phone: r.phone, taxId: r.taxId, address: r.address }),
      findLocal: async (link) => (link ? tx.opsVendor.findFirst({ where: { id: link.localId, workspaceId } }) : tx.opsVendor.findFirst({ where: { workspaceId, name: f.name } })),
      create: () => tx.opsVendor.create({ data: { workspaceId, ...f } }),
      update: async (local) => {
        const data = present(f);
        if (data.name && data.name !== local.name && (await tx.opsVendor.findFirst({ where: { workspaceId, name: data.name, NOT: { id: local.id } }, select: { id: true } }))) {
          report.conflicts.push({ objectType: "vendor", remoteId: p.id, localId: local.id, resolution: "name used by another local vendor; kept the local name" });
          delete data.name;
        }
        return tx.opsVendor.update({ where: { id: local.id, workspaceId }, data });
      },
    }),
  );
}

export async function importParties(
  workspaceId: string,
  provider: AccountingProvider,
  opts: { kinds?: Array<"customer" | "vendor">; maxPages?: number } = {},
): Promise<SyncReport> {
  const report = emptyReport();
  const kinds = opts.kinds?.length ? opts.kinds : (["customer", "vendor"] as const);
  const max = Math.min(Math.max(Math.floor(opts.maxPages ?? 20), 1), 100);
  for (const kind of kinds) {
    let more = true;
    for (let page = 1; page <= max && more; page++) {
      const res = await provider.listParties(kind, page);
      report.pages += 1;
      for (const p of res.parties) {
        if (kind === "customer") await applyCustomer(workspaceId, provider, p, report);
        else await applyVendor(workspaceId, provider, p, report);
      }
      more = res.more;
    }
    if (more) report.truncated = true;
  }
  return report;
}
