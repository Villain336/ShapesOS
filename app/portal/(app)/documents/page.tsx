// ShapesOS — Phase 10 (portal): /portal/documents — what is already shared
// with this client elsewhere in ShapesOS: white-label reports (PDF),
// e-sign envelopes they are a signer on (sealed PDF once completed), and
// data-room links that list their email (the data room keeps its own access
// check). Nothing is re-rendered here.

import { Download, ExternalLink } from "lucide-react";
import { portalPage } from "@/lib/portal/page";
import { listPortalDocuments } from "@/lib/portal/data";
import { btnQuietSm, chipCls, emptyCls, fmtDate, pageHintCls, pageTitleCls, rowCls, stateLabel, tableCls, tableWrapCls, tdCls, thCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documents — Client portal" };

export default async function PortalDocuments() {
  const p = await portalPage("documents");
  const d = await listPortalDocuments(p);
  const rows = [
    ...d.reports.map((r) => ({
      key: `r:${r.id}`,
      title: r.title,
      kind: "Report",
      state: "Sent",
      date: r.sentAt,
      action: (
        <a className={btnQuietSm} href={`/api/portal/documents/reports/${encodeURIComponent(r.id)}`}>
          <Download size={15} aria-hidden /> PDF
        </a>
      ),
    })),
    ...d.signatures.map((s) => ({
      key: `s:${s.id}`,
      title: s.title,
      kind: "Signature",
      state: stateLabel(s.status),
      date: s.updatedAt,
      action: s.downloadable ? (
        <a className={btnQuietSm} href={`/api/portal/documents/signed/${encodeURIComponent(s.id)}`}>
          <Download size={15} aria-hidden /> Signed PDF
        </a>
      ) : (
        <span className="text-sm text-muted">Signing link sent by email</span>
      ),
    })),
    ...d.dataRooms.map((r) => ({
      key: `d:${r.href}`,
      title: r.title,
      kind: "Data room",
      state: r.expiresAt ? `Until ${fmtDate(r.expiresAt)}` : "Shared",
      date: r.sharedAt,
      action: (
        <a className={btnQuietSm} href={r.href} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} aria-hidden /> Open
        </a>
      ),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Documents</h1>
        <p className={pageHintCls}>Reports, documents to sign and data rooms {p.workspaceName} has shared with you.</p>
      </div>
      {rows.length === 0 ? (
        <div className={emptyCls}>Nothing shared with you yet.</div>
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Document</th>
                <th className={thCls}>Type</th>
                <th className={thCls}>State</th>
                <th className={thCls}>Date</th>
                <th className={`${thCls} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={rowCls}>
                  <td className={`${tdCls} font-semibold`}>{r.title}</td>
                  <td className={tdCls}>{r.kind}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{r.state}</span>
                  </td>
                  <td className={tdCls}>{fmtDate(r.date)}</td>
                  <td className={`${tdCls} text-right`}>{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
