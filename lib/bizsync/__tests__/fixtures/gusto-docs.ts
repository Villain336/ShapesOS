// Phase 14 (connectors): Gusto example payloads copied from Gusto's own docs
// (fetched 2026-10-05). Used by the unit and DB tests so the mapping is
// proven against the documented shapes, not against shapes we invented.
// Live Gusto stays UNVERIFIED-LIVE until demo keys exist.

/**
 * docs.gusto.com/app-integrations/docs/updating-payrolls — "1. Retrieve
 * Upcoming Payroll" (GET …/payrolls?processing_statuses=unprocessed).
 */
export const DOC_UNPROCESSED_PAYROLLS = [
  {
    payroll_deadline: "2021-02-18T20:00:00Z",
    check_date: "2021-02-22",
    processed: false,
    processed_date: null,
    calculated_at: null,
    payroll_uuid: "b50e611d-8f3d-4f24-b001-46675f7b5777",
    company_uuid: "6bf7807c-a5a0-4f4d-b2e7-3fbb4b2299fb",
    pay_period: { start_date: "2021-02-01", end_date: "2021-02-15", pay_schedule_uuid: "00ebc4a4-ec88-4435-8f45-c505bb63e501" },
  },
  {
    payroll_deadline: "2021-03-01T20:00:00Z",
    check_date: "2021-03-05",
    processed: false,
    processed_date: null,
    calculated_at: null,
    payroll_uuid: "79598603-2975-40fc-9b18-a6cf835a4744",
    company_uuid: "6bf7807c-a5a0-4f4d-b2e7-3fbb4b2299fb",
    pay_period: { start_date: "2021-02-15", end_date: "2021-02-28", pay_schedule_uuid: "00ebc4a4-ec88-4435-8f45-c505bb63e501" },
  },
];

/** Same page — "2. Prepare the Payroll": the sample prepare response. */
export const DOC_PREPARED_PAYROLL = {
  payroll_deadline: "2021-02-18T20:00:00Z",
  check_date: "2021-02-22",
  processed: false,
  processed_date: null,
  calculated_at: null,
  off_cycle: false,
  payroll_uuid: "b50e611d-8f3d-4f24-b001-46675f7b5777",
  company_uuid: "6bf7807c-a5a0-4f4d-b2e7-3fbb4b2299fb",
  pay_period: { start_date: "2021-02-01", end_date: "2021-02-15", pay_schedule_uuid: "00ebc4a4-ec88-4435-8f45-c505bb63e501" },
  payroll_status_meta: {
    cancellable: false,
    expected_check_date: "2021-02-22",
    initial_check_date: "2021-02-22",
    expected_debit_time: "2021-02-18T23:00:00Z",
    payroll_late: false,
    initial_debit_cutoff_time: "2021-02-18T23:00:00Z",
  },
  employee_compensations: [
    {
      employee_uuid: "187412e1-3dbe-491a-bb2f-2f40323a7067",
      version: "19289df18e6e20f797de4a585ea5a91535c7ddf7",
      excluded: false,
      gross_pay: "2791.25",
      net_pay: "1953.31",
      payment_method: "Direct Deposit",
      fixed_compensations: [
        { name: "Bonus", amount: "100.00", job_uuid: "94e0d15e-9ed2-4077-98f6-64554f242ba5" },
        { name: "Reimbursement", amount: "100.00", job_uuid: "91bc3b43-ded0-4ee7-98fe-215499e909ba" },
      ],
      hourly_compensations: [
        { name: "Regular Hours", hours: "10.000", job_uuid: "bd378298-3e0c-4145-904a-baadf8a91fa3", compensation_multiplier: 1 },
        { name: "Overtime", hours: "0.000", job_uuid: "9d3760f0-d1f9-4700-8817-0fe2dce5cf23", compensation_multiplier: 1.5 },
        { name: "Double overtime", hours: "0.000", job_uuid: "b5eef9a9-4a87-4649-a80d-14878c05f44e", compensation_multiplier: 2 },
      ],
      paid_time_off: [
        { name: "Vacation Hours", hours: "20.000" },
        { name: "Sick Hours", hours: "0.000" },
        { name: "Holiday Hours", hours: "0.000" },
      ],
    },
  ],
  fixed_compensation_types: [{ name: "Bonus" }, { name: "Commission" }, { name: "Correction Payment" }, { name: "Cash Tips" }, { name: "Paycheck Tips" }, { name: "Reimbursement" }],
};

/**
 * docs.gusto.com/app-integrations/reference/get-v1-token-info —
 * Token-Info x-examples.company_admin_token.
 */
export const DOC_TOKEN_INFO = {
  scope: "companies:read public",
  resource: { type: "Company", uuid: "7b1d0df1-6403-4a06-8768-c1dd7d24d27a" },
  resource_owner: { type: "CompanyAdmin", uuid: "8fdc31f0-a8a7-4872-a9f1-dcb5e6f876e3" },
};

/**
 * docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-employees —
 * Show-Employees x-examples.success_status[0] (trimmed to the fields read).
 */
export const DOC_EMPLOYEE = {
  uuid: "d7282d99-ab6b-42f5-ba45-f4a670e886a8",
  first_name: "Boaty",
  middle_initial: null,
  last_name: "Koss",
  email: "keena.feest@kiehn.co.uk",
  company_uuid: "e904cc79-818a-4da8-9d37-0be0a86fdda8",
  terminated: false,
  onboarded: true,
  preferred_first_name: null,
  work_email: null,
  jobs: [{ uuid: "bc875f9d-adc5-40f6-99db-ed8470bda25f", primary: true, title: "", payment_unit: "Year" }],
};

/**
 * docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-payrolls-payroll_id —
 * Payroll-Show x-examples.success_status (a processed payroll; the example's
 * employee_compensations list is empty, so the per-employee entry below is
 * built field-for-field from the documented schema
 * Payroll-Employee-Compensations-Type + …-Included: gross_pay, net_pay,
 * check_amount, hourly_compensations[].amount, taxes[{ name, employer,
 * amount }], benefits[{ name, employee_deduction, company_contribution }],
 * deductions[{ name, amount }]; "net_pay = gross_pay − employee taxes −
 * employee deductions or garnishments − cash tips").
 */
export const DOC_PROCESSED_PAYROLL = {
  uuid: "b441a30b-2adb-489e-b7b7-9d094011a3f8",
  payroll_uuid: "b441a30b-2adb-489e-b7b7-9d094011a3f8",
  company_uuid: "9aa93530-43d5-484e-b608-33214109420d",
  off_cycle: false,
  auto_payroll: false,
  processed: true,
  processed_date: "2025-06-16",
  calculated_at: "2025-06-16T16:58:03Z",
  pay_period: { start_date: "2025-05-25", end_date: "2025-06-09", pay_schedule_uuid: "40ff5990-0191-4796-9717-32f7dd3e94d5" },
  check_date: "2025-06-13",
  external: false,
  payroll_deadline: "2025-06-17T23:00:00Z",
  processing_request: { status: "submit_success", errors: [] },
  submission_blockers: [],
  credit_blockers: [],
  employee_compensations: [] as unknown[],
};

/** A processed employee compensation per the documented schema (see above). */
export function processedComp(employeeUuid: string, over: Record<string, unknown> = {}) {
  return {
    employee_uuid: employeeUuid,
    excluded: false,
    first_name: "Bob",
    last_name: "Hourly",
    gross_pay: "1550.00",
    net_pay: "1132.42",
    check_amount: "1132.42",
    payment_method: "Direct Deposit",
    fixed_compensations: [],
    hourly_compensations: [
      { name: "Regular Hours", hours: "70.000", amount: "1400.00", job_uuid: "job-bob", compensation_multiplier: 1 },
      { name: "Overtime", hours: "5.000", amount: "150.00", job_uuid: "job-bob", compensation_multiplier: 1.5 },
    ],
    taxes: [
      { name: "Federal Income Tax", employer: false, amount: "150.00" },
      { name: "Social Security", employer: false, amount: "96.10" },
      { name: "Medicare", employer: false, amount: "22.48" },
      { name: "Social Security", employer: true, amount: "96.10" },
      { name: "Medicare", employer: true, amount: "22.48" },
      { name: "FUTA", employer: true, amount: "9.30" },
    ],
    benefits: [{ name: "Medical", employee_deduction: "100.00", company_contribution: "200.00", imputed: false }],
    deductions: [{ name: "Garnishment", amount: "49.00" }],
    ...over,
  };
}
