"use client";

// ShapesOS — Phase 12 (people): client islands for /dashboard/ops/payroll —
// new pay run, new salary structure (with its components), new salary
// assignment (W-4 tax profile + state), and the pay-run actions: compute,
// request approval → approve (Tier 3, through the existing approval card),
// request posting → post, cancel. Writes go through the generic
// /api/ops/{entity} route and POST /api/ops/pay-runs/{id}/{action} (admin).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, denseInputCls, inputCls, labelCls, parseMoneyInput } from "@/components/ops-finance/kit";
import { confirmAction } from "@/lib/ui/feedback";
import { jsonPost, useGated } from "@/components/ops-finance/useGated";

async function readErr(r: Response): Promise<string> {
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return d.error ?? "That didn't work.";
}

const today = () => new Date().toISOString().slice(0, 10);

export function NewPayRunButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [periodStart, setStart] = useState(today());
  const [periodEnd, setEnd] = useState(today());
  const [payDate, setPay] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/pay-runs", { periodStart, periodEnd, payDate });
    if (!r.ok) {
      setBusy(false);
      return setError(await readErr(r));
    }
    const d = (await r.json()) as { row: { id: string } };
    const c = await jsonPost(`/api/ops/pay-runs/${d.row.id}/compute`, {});
    setBusy(false);
    if (!c.ok) {
      // The draft exists; open it so the person sees why it didn't compute.
      router.push(`/dashboard/ops/payroll/${d.row.id}?error=${encodeURIComponent(await readErr(c))}`);
      return;
    }
    router.push(`/dashboard/ops/payroll/${d.row.id}`);
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New pay run
      </button>
      {open ? (
        <Dialog title="New pay run" onClose={() => !busy && setOpen(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Period starts</span>
                <input type="date" className={inputCls} value={periodStart} onChange={(e) => setStart(e.target.value)} required />
              </label>
              <label>
                <span className={labelCls}>Period ends</span>
                <input type="date" className={inputCls} value={periodEnd} onChange={(e) => setEnd(e.target.value)} required />
              </label>
            </div>
            <label>
              <span className={labelCls}>Pay date</span>
              <input type="date" className={inputCls} value={payDate} onChange={(e) => setPay(e.target.value)} required />
            </label>
            <p className="text-sm text-muted">Everyone with a salary assignment covering the period gets a payslip. Hourly pay uses approved timesheet hours only.</p>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Computing" : "Create and compute"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

interface ComponentDraft {
  code: string;
  label: string;
  kind: string;
  calc: "fixed" | "percent";
  value: string;
  reducesFicaWages: boolean;
}

const KINDS: Array<{ id: string; label: string }> = [
  { id: "allowance", label: "Allowance" },
  { id: "pre_tax_deduction", label: "Pre-tax deduction" },
  { id: "post_tax_deduction", label: "Post-tax deduction" },
  { id: "employer_contribution", label: "Employer contribution" },
];

export function NewStructureButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [payType, setPayType] = useState<"salary" | "hourly">("salary");
  const [payFrequency, setFreq] = useState("biweekly");
  const [amount, setAmount] = useState("");
  const [overtime, setOvertime] = useState(true);
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setC = (i: number, p: Partial<ComponentDraft>) => setComponents(components.map((c, j) => (j === i ? { ...c, ...p } : c)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cents = parseMoneyInput(amount);
    if (Number.isNaN(cents)) return setError(payType === "salary" ? "Enter the annual salary." : "Enter the hourly rate.");
    const comps = [];
    for (const c of components) {
      const v = c.calc === "fixed" ? parseMoneyInput(c.value) : Math.round(Number(c.value) * 100);
      if (!c.code.trim() || Number.isNaN(v)) return setError("Every component needs a code and an amount.");
      comps.push({
        code: c.code.trim().toLowerCase(),
        label: c.label.trim() || c.code.trim(),
        kind: c.kind,
        calc: c.calc,
        ...(c.calc === "fixed" ? { amountCents: v } : { rateBps: v }),
        ...(c.kind === "pre_tax_deduction" && c.reducesFicaWages ? { reducesFicaWages: true } : {}),
      });
    }
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/salary-structures", {
      name: name.trim(),
      payType,
      payFrequency,
      ...(payType === "salary" ? { annualSalaryCents: cents } : { hourlyRateCents: cents }),
      overtimeEnabled: overtime,
      components: comps,
    });
    setBusy(false);
    if (!r.ok) return setError(await readErr(r));
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> New structure
      </button>
      {open ? (
        <Dialog title="New salary structure" onClose={() => !busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>Name</span>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Salaried staff" required />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label>
                <span className={labelCls}>Pay type</span>
                <select className={inputCls} value={payType} onChange={(e) => setPayType(e.target.value as "salary" | "hourly")}>
                  <option value="salary">Salary</option>
                  <option value="hourly">Hourly</option>
                </select>
              </label>
              <label>
                <span className={labelCls}>Pay frequency</span>
                <select className={inputCls} value={payFrequency} onChange={(e) => setFreq(e.target.value)}>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every two weeks</option>
                  <option value="semimonthly">Twice a month</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                <span className={labelCls}>{payType === "salary" ? "Annual salary" : "Hourly rate"}</span>
                <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={payType === "salary" ? "65000" : "28.50"} />
              </label>
            </div>
            {payType === "hourly" ? (
              <label className="flex items-center gap-2 text-md">
                <input type="checkbox" checked={overtime} onChange={(e) => setOvertime(e.target.checked)} />
                Overtime at 1.5× past 40 hours a week
              </label>
            ) : null}
            <div className="flex flex-col gap-2">
              <span className={labelCls}>Allowances, deductions and employer contributions</span>
              {components.map((c, i) => (
                <div key={i} className="grid grid-cols-[100px_1fr_170px_110px_100px_36px] items-center gap-2">
                  <input className={denseInputCls} value={c.code} onChange={(e) => setC(i, { code: e.target.value })} placeholder="401k" aria-label={`Component ${i + 1} code`} />
                  <input className={denseInputCls} value={c.label} onChange={(e) => setC(i, { label: e.target.value })} placeholder="Retirement plan" aria-label={`Component ${i + 1} label`} />
                  <select className={denseInputCls} value={c.kind} onChange={(e) => setC(i, { kind: e.target.value })} aria-label={`Component ${i + 1} kind`}>
                    {KINDS.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <select className={denseInputCls} value={c.calc} onChange={(e) => setC(i, { calc: e.target.value as "fixed" | "percent" })} aria-label={`Component ${i + 1} calculation`}>
                    <option value="fixed">Per period</option>
                    <option value="percent">% of pay</option>
                  </select>
                  <input className={denseInputCls} inputMode="decimal" value={c.value} onChange={(e) => setC(i, { value: e.target.value })} placeholder={c.calc === "fixed" ? "50.00" : "5"} aria-label={`Component ${i + 1} amount`} />
                  <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} onClick={() => setComponents(components.filter((_, j) => j !== i))} aria-label={`Remove component ${i + 1}`}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                  {c.kind === "pre_tax_deduction" ? (
                    <label className="col-span-6 flex items-center gap-2 text-sm text-muted">
                      <input type="checkbox" checked={c.reducesFicaWages} onChange={(e) => setC(i, { reducesFicaWages: e.target.checked })} />
                      Also exempt from Social Security and Medicare (a Section 125 plan, e.g. health premiums)
                    </label>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className={aosButton({ variant: "quiet", size: "xs", className: "self-start" })}
                onClick={() => setComponents([...components, { code: "", label: "", kind: "pre_tax_deduction", calc: "percent", value: "", reducesFicaWages: false }])}
              >
                <Plus size={14} aria-hidden /> Add component
              </button>
            </div>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Saving" : "Save structure"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function NewAssignmentButton({
  members,
  structures,
  states,
}: {
  members: Array<{ id: string; name: string }>;
  structures: Array<{ id: string; name: string; payType: string }>;
  states: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    memberId: members[0]?.id ?? "",
    structureId: structures[0]?.id ?? "",
    effectiveFrom: today(),
    pay: "",
    filingStatus: "single",
    w4Step2: false,
    dependents: "",
    extra: "",
    stateCode: "",
    stateRate: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const structure = structures.find((s) => s.id === f.structureId);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const money = (v: string) => (v.trim() ? parseMoneyInput(v) : 0);
    const pay = f.pay.trim() ? parseMoneyInput(f.pay) : null;
    const dependents = money(f.dependents);
    const extra = money(f.extra);
    if ([pay ?? 0, dependents, extra].some((n) => Number.isNaN(n))) return setError("Check the amounts.");
    const rate = f.stateRate.trim() ? Math.round(Number(f.stateRate) * 100) : null;
    if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 2000)) return setError("The state rate is a percentage between 0 and 20.");
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/salary-assignments", {
      memberId: f.memberId,
      structureId: f.structureId,
      effectiveFrom: f.effectiveFrom,
      ...(pay !== null ? (structure?.payType === "hourly" ? { hourlyRateCents: pay } : { annualSalaryCents: pay }) : {}),
      filingStatus: f.filingStatus,
      w4Step2: f.w4Step2,
      dependentsCreditCents: dependents,
      extraWithholdingCents: extra,
      ...(f.stateCode ? { stateCode: f.stateCode } : {}),
      ...(rate !== null ? { stateRateBps: rate } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(await readErr(r));
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)} disabled={!members.length || !structures.length}>
        <Plus size={16} aria-hidden /> Assign structure
      </button>
      {open ? (
        <Dialog title="Assign a salary structure" onClose={() => !busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-3">
              <label>
                <span className={labelCls}>Team member</span>
                <select className={inputCls} value={f.memberId} onChange={(e) => set({ memberId: e.target.value })}>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelCls}>Structure</span>
                <select className={inputCls} value={f.structureId} onChange={(e) => set({ structureId: e.target.value })}>
                  {structures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelCls}>Effective from</span>
                <input type="date" className={inputCls} value={f.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} required />
              </label>
            </div>
            <label>
              <span className={labelCls}>{structure?.payType === "hourly" ? "Hourly rate for this person (optional)" : "Annual salary for this person (optional)"}</span>
              <input className={inputCls} inputMode="decimal" value={f.pay} onChange={(e) => set({ pay: e.target.value })} placeholder="Leave blank to use the structure's" />
            </label>
            <fieldset className="flex flex-col gap-3 rounded-md bg-canvas p-4">
              <legend className="px-1 text-xs font-semibold text-muted">Form W-4 and state</legend>
              <div className="grid grid-cols-3 gap-3">
                <label>
                  <span className={labelCls}>Filing status (step 1c)</span>
                  <select className={inputCls} value={f.filingStatus} onChange={(e) => set({ filingStatus: e.target.value })}>
                    <option value="single">Single or married filing separately</option>
                    <option value="married_jointly">Married filing jointly</option>
                    <option value="head_of_household">Head of household</option>
                  </select>
                </label>
                <label>
                  <span className={labelCls}>Dependents credit a year (step 3)</span>
                  <input className={inputCls} inputMode="decimal" value={f.dependents} onChange={(e) => set({ dependents: e.target.value })} placeholder="0" />
                </label>
                <label>
                  <span className={labelCls}>Extra withholding per period (4c)</span>
                  <input className={inputCls} inputMode="decimal" value={f.extra} onChange={(e) => set({ extra: e.target.value })} placeholder="0" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-md">
                <input type="checkbox" checked={f.w4Step2} onChange={(e) => set({ w4Step2: e.target.checked })} />
                Step 2 box checked (multiple jobs, or spouse works)
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className={labelCls}>Work state</span>
                  <select className={inputCls} value={f.stateCode} onChange={(e) => set({ stateCode: e.target.value })}>
                    <option value="">No state income tax withheld</option>
                    {states.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className={labelCls}>State rate % (optional override)</span>
                  <input className={inputCls} inputMode="decimal" value={f.stateRate} onChange={(e) => set({ stateRate: e.target.value })} placeholder="Use the built-in flat rate" />
                </label>
              </div>
            </fieldset>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Saving" : "Save assignment"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function EndAssignmentButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function end(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/salary-assignments", { id, effectiveTo: date }, "PATCH");
    setBusy(false);
    if (!r.ok) return setError(await readErr(r));
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        End
      </button>
      {open ? (
        <Dialog title={`End ${name}'s assignment`} onClose={() => !busy && setOpen(false)}>
          <form onSubmit={end} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>Last day on this structure</span>
              <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <p className="text-sm text-muted">To change someone's pay, end this assignment and assign the new structure from the next day.</p>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Saving" : "End assignment"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function PayRunActions({ id, label, status, summary }: { id: string; label: string; status: string; summary: string }) {
  const router = useRouter();
  const gated = useGated();
  const [busy, setBusy] = useState(false);

  async function plain(action: "compute" | "cancel") {
    if (action === "cancel" && !(await confirmAction({ title: `Cancel pay run ${label}?`, description: "Nothing has been posted. Its people can be paid in a new run.", confirmLabel: "Cancel run", cancelLabel: "Keep it", destructive: true }))) return;
    setBusy(true);
    gated.setError(null);
    const r = await jsonPost(`/api/ops/pay-runs/${id}/${action}`, {});
    setBusy(false);
    if (!r.ok) return gated.setError(await readErr(r));
    gated.setNote(action === "compute" ? "Recomputed." : "Cancelled.");
    router.refresh();
  }

  const gatedAction = (action: "approve" | "post") =>
    gated.start({
      label: action === "approve" ? "Approve pay run" : "Post pay run to the books",
      summary,
      executeLabel: action === "approve" ? "Approve pay run" : "Post to the books",
      send: (approvalId) => jsonPost(`/api/ops/pay-runs/${id}/${action}`, approvalId ? { approvalId } : {}),
      onDone: () => {
        gated.setNote(action === "approve" ? "Approved. Post it to the books when you're ready." : "Posted to the books.");
        router.refresh();
      },
    });

  return (
    <div className="flex flex-col items-end gap-3">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "draft" || status === "computed" ? (
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} disabled={busy || gated.busy} onClick={() => plain("compute")}>
            {status === "draft" ? "Compute" : "Recompute"}
          </button>
        ) : null}
        {status === "computed" ? (
          <button type="button" className={aosButton({ variant: "primary", size: "sm" })} disabled={busy || gated.busy} onClick={() => gatedAction("approve")}>
            Request approval
          </button>
        ) : null}
        {status === "approved" ? (
          <button type="button" className={aosButton({ variant: "primary", size: "sm" })} disabled={busy || gated.busy} onClick={() => gatedAction("post")}>
            Post to the books
          </button>
        ) : null}
        {status === "draft" || status === "computed" || status === "approved" ? (
          <button type="button" className={aosButton({ variant: "deny", size: "sm" })} disabled={busy || gated.busy} onClick={() => plain("cancel")}>
            Cancel run
          </button>
        ) : null}
      </div>
      {gated.card}
      {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
      {gated.note ? <Note>{gated.note}</Note> : null}
    </div>
  );
}
