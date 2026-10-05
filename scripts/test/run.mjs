// ShapesOS — test runner (node:test via tsx; the repo's established convention).
//
//   npm test          unit suites (no database; DATABASE_URL is unset so an
//                     unlisted DB-backed suite fails loudly instead of passing
//                     against a developer's local database)
//   npm run test:db   suites listed in scripts/test/db-tests.txt (needs a
//                     migrated DATABASE_URL — see scripts/db/migrate.sh)
//
// mobile/ has its own package (vitest) and is tested there.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.argv[2] === "db" ? "db" : "unit";
const extra = process.argv.slice(3);

const dbTests = new Set(
  readFileSync(new URL("./db-tests.txt", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

const all = execFileSync("git", ["ls-files", "*.test.ts", "*.test.tsx", "*.test.mts"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("mobile/"));

for (const f of dbTests) {
  if (!all.includes(f)) {
    console.error(`db-tests.txt lists a missing file: ${f}`);
    process.exit(2);
  }
}

const files = all.filter((f) => (mode === "db" ? dbTests.has(f) : !dbTests.has(f)));
const env = { ...process.env };
if (mode === "unit") {
  delete env.DATABASE_URL;
} else if (!env.DATABASE_URL) {
  console.error("npm run test:db needs DATABASE_URL pointing at a migrated database.");
  process.exit(2);
}

console.log(`[test:${mode}] ${files.length} files`);
const res = spawnSync(
  "npx",
  [
    "tsx",
    "--test",
    // Route-handler tests stub the session with node:test mock.module().
    "--experimental-test-module-mocks",
    `--test-concurrency=${mode === "db" ? 1 : 4}`,
    ...extra,
    ...files,
  ],
  { stdio: "inherit", env },
);
process.exit(res.status ?? 1);
