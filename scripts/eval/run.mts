// ShapesOS — Phase 17 evaluation harness: the CLI (the runner is ./runner.ts;
// read ./README.md before a real run — it costs real money).
//
//   DATABASE_URL=… npx tsx scripts/eval/run.mts --dry-run                 # FAKE model, free (CI)
//   ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/eval/run.mts --max-usd 30
//
// Exit codes: 0 done · 1 a dry-run task failed (the harness is broken) ·
// 2 bad arguments / setup · 3 stopped on the $ cap (partial table written).

import { prisma } from "@/lib/prisma";
import { parseArgs, runEval } from "./runner";

let code = 0;
try {
  const opts = parseArgs(process.argv.slice(2));
  const out = await runEval(opts);
  const failed = out.results.filter((r) => !r.pass || r.judge === "fail").length;
  if (opts.dryRun && failed > 0) code = 1; // the dry run proves the harness: every scripted task must pass
  if (out.stopped) code = 3;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 2;
} finally {
  await prisma.$disconnect();
}
process.exit(code);
