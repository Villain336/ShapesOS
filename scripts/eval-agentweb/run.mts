// ShapesOS — Phase 21A evals: the CLI (read ./README.md before a live run: it costs money).
import { parseArgs, renderMarkdown, runAgentwebEval } from "./runner";

let code = 0;
try {
  const opts = parseArgs(process.argv.slice(2));
  const out = await runAgentwebEval(opts);
  console.log(renderMarkdown(out));
  if (out.stopped) code = 3;
  else if (!out.passBar) code = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 2;
}
process.exit(code);
