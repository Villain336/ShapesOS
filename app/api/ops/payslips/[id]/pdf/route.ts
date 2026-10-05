// ShapesOS — Phase 12 (people): GET /api/ops/payslips/[id]/pdf.
// One payslip as a PDF (lib/ops/payroll/pdf.tsx on the existing lib/pdf
// engine), with the "verify with your accountant" banner. Admins see every
// payslip; anyone else only their OWN (the team member linked to their
// user). Workspace-scoped: other workspaces' payslips are 404.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { requireWorkspaceRole } from "@/lib/authz";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { financeSettings } from "@/lib/ops/finance/invoicing";
import { OpsError } from "@/lib/ops/doctype";
import { payslipFilename, renderPayslipPdf } from "@/lib/ops/payroll/pdf";
import { payrollTaxTableById } from "@/lib/ops/payroll/tax";
import type { PayslipLine } from "@/lib/ops/payroll/rules";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const isAdmin = await requireWorkspaceRole(actor.userId, actor.workspaceId, "admin");
    const data = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const slip = await tx.opsPayslip.findFirst({
        where: { id, workspaceId: actor.workspaceId },
        include: { payRun: true, member: { select: { userId: true } } },
      });
      if (!slip || (!isAdmin && slip.member.userId !== actor.userId)) throw new OpsError(404, "Payslip not found");
      if (slip.payRun.status === "cancelled") throw new OpsError(409, "This pay run was cancelled");
      return { slip, settings: await financeSettings(tx, actor.workspaceId) };
    });
    const { slip, settings } = data;
    const table = payrollTaxTableById(slip.taxTable, slip.payRun.payDate);
    const pdf = await renderPayslipPdf({
      employer: settings.fromName,
      runNumber: slip.payRun.number,
      periodStart: slip.payRun.periodStart,
      periodEnd: slip.payRun.periodEnd,
      payDate: slip.payRun.payDate,
      memberName: slip.memberName,
      structureName: slip.structureName,
      regularMinutes: slip.regularMinutes,
      overtimeMinutes: slip.overtimeMinutes,
      grossCents: slip.grossCents,
      preTaxDeductionCents: slip.preTaxDeductionCents,
      employeeTaxCents: slip.employeeTaxCents,
      postTaxDeductionCents: slip.postTaxDeductionCents,
      netCents: slip.netCents,
      employerTaxCents: slip.employerTaxCents,
      employerContribCents: slip.employerContribCents,
      lines: (slip.lines as unknown as PayslipLine[]) ?? [],
      taxTable: slip.taxTable,
      taxSource: table?.source ?? "Tax table no longer shipped — amounts as computed at the time.",
      warnings: Array.isArray(slip.warnings) ? (slip.warnings as string[]) : [],
      currency: settings.currency,
    });
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${payslipFilename(slip.payRun.number, slip.memberName, slip.id)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return financeError(err);
  }
}
