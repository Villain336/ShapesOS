// ShapesOS — CI guard: schema.prisma must not declare objects that no
// migration creates (the Phase 0 audit found WFH enums + a whole table that
// existed only in schema.prisma, so production DBs would have crashed).
//
// Usage: DATABASE_URL=<db built by migrations> node scripts/ci/check-schema-drift.mjs
// Diffs the migrated DB against schema.prisma and fails on any statement not
// covered by KNOWN_NOISE — differences that are intentional in raw-SQL
// migrations (trigram/tsvector indexes, generated columns, FK actions from
// the 20260926181000 reconciliation, timestamp precision, DB-side defaults).
import { execFileSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("check-schema-drift: DATABASE_URL is required");
  process.exit(2);
}

const KNOWN_NOISE = [
  /^ALTER TABLE "[a-z_0-9]+"\s*$/,
  /^ALTER TABLE "[a-z_0-9]+" ALTER COLUMN "[a-z_0-9]+" SET DATA TYPE TIMESTAMP\(3\)[,;]$/,
  /^ALTER COLUMN "[a-z_0-9]+" SET DATA TYPE TIMESTAMP\(3\)[,;]$/,
  /^(ALTER TABLE "[a-z_0-9]+" )?ALTER COLUMN "(updated_at|search_tsv)" DROP DEFAULT[,;]$/,
  /^DROP INDEX "[a-z_0-9]+_(trgm|tsv)_idx";$/,
  /^DROP INDEX "(insurance_submissions_workspace_id_renewal_id_idx|memory_consolidation_runs_workspace_id_started_at_idx)";$/,
  /^CREATE INDEX "memory_consolidation_runs_workspace_id_started_at_idx" ON .*;$/,
  /^ALTER TABLE "(billing_topup_idempotency|esign_vault_entries)" (DROP|ADD) CONSTRAINT "[a-z_]+_fkey".*;$/,
  // billing_subscriptions is a raw-SQL table (lib/metering/billing.ts), not a
  // Prisma model; the migration exists so the least-privilege role never needs DDL.
  /^DROP TABLE "billing_subscriptions";$/,
  /^ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "billing_subscriptions_[a-z_]+";$/,
];

const out = execFileSync(
  "npx",
  ["prisma", "migrate", "diff", "--from-url", url, "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

const offending = out
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("--"))
  .filter((l) => !KNOWN_NOISE.some((re) => re.test(l)));

if (offending.length) {
  console.error(`Schema drift: ${offending.length} statement(s) in schema.prisma are not created by any migration:\n`);
  for (const l of offending.slice(0, 60)) console.error("  " + l);
  console.error("\nAdd a migration (prisma migrate dev --create-only) or extend KNOWN_NOISE if intentional.");
  process.exit(1);
}
console.log("check-schema-drift: OK (migrations match schema.prisma)");
