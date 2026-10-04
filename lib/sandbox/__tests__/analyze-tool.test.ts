// ShapesOS Phase 11 (seotools): analyze_data without a database — argument
// checks, the "no sandbox" refusal, XLSX → CSV conversion, and a real run of
// Python and JavaScript in the TEST-ONLY fake sandbox (a temp dir on this
// machine; the runtime only ever uses sandboxForRun()).
// Run: npx tsx --test lib/sandbox/__tests__/analyze-tool.test.ts

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "@/lib/chat/tools";
import { toolAction, toolGroup } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { buildXlsx } from "@/lib/documents/xlsx";
import { createFakeSandbox } from "@/lib/ship/__tests__/fake-sandbox";
import { SandboxUnavailableError } from "../index";
import { analyze_data, parsePackages, safeFileName, setAnalyzeSandboxForTests, xlsxToCsvFiles } from "../analyze-tool";

const ctx: ToolContext = { projectId: "p", workspaceId: "w", userId: "u", role: "editor", confirmed: true };

after(() => setAnalyzeSandboxForTests(null));

describe("analyze_data registration", () => {
  it("is a code-group tool with bash's tier", () => {
    assert.equal(toolGroup("analyze_data"), "code");
    assert.equal(toolAction("analyze_data"), toolAction("bash"));
    assert.equal(evaluateTier({ kind: toolAction("analyze_data") }, { smallActionThresholdCents: 0 } as never), 2);
  });
});

describe("analyze_data helpers", () => {
  it("validates package specs", () => {
    assert.deepEqual(parsePackages("pandas matplotlib==3.9.2, numpy>=2"), ["pandas", "matplotlib==3.9.2", "numpy>=2"]);
    assert.deepEqual(parsePackages(undefined), []);
    assert.throws(() => parsePackages("pandas; rm -rf /"), /not a valid package/);
    assert.throws(() => parsePackages("$(curl evil)"), /not a valid package/);
    assert.throws(() => parsePackages("--index-url=http://evil"), /not a valid package/);
  });

  it("makes safe file names", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("Q3 sales (final).xlsx"), "Q3-sales-final-.xlsx");
    assert.equal(safeFileName(".hidden"), "hidden");
  });

  it("converts every XLSX sheet to CSV, data kept exactly", async () => {
    const bytes = await buildXlsx({ sheets: [{ name: "Sales", rows: [["Region", "Total"], ["North, East", 10], ["=x", -5]] }, { name: "Empty", rows: [] }] });
    const csvs = await xlsxToCsvFiles(bytes, "q3");
    assert.deepEqual(csvs.map((c) => c.name), ["q3.Sales.csv", "q3.Empty.csv"]);
    assert.equal(csvs[0].csv, 'Region,Total\r\n"North, East",10\r\n=x,-5\r\n');
  });
});

describe("analyze_data runs", () => {
  it("says why when there is no sandbox, and does nothing", async () => {
    setAnalyzeSandboxForTests(async () => {
      throw new SandboxUnavailableError("Sandboxes are switched off (SANDBOX_PROVIDER=off).");
    });
    const r = await analyze_data.execute(ctx, { code: "print(1)" });
    assert.match(r.summary, /code sandbox is not available: Sandboxes are switched off/);
    assert.deepEqual(r.details, { unavailable: true, reason: "Sandboxes are switched off (SANDBOX_PROVIDER=off)." });
  });

  it("refuses empty code, bad packages and viewers", async () => {
    assert.match((await analyze_data.execute(ctx, { code: " " })).summary, /needs code/);
    assert.match((await analyze_data.execute(ctx, { code: "x", packages: "a;b" })).summary, /not a valid package/);
    await assert.rejects(analyze_data.execute({ ...ctx, role: "viewer" }, { code: "print(1)" }), /editor role/);
  });

  it("runs Python and JavaScript with INPUT_DIR / OUTPUT_DIR in the (fake) sandbox", async () => {
    const sb = createFakeSandbox();
    setAnalyzeSandboxForTests(async () => sb);
    try {
      const py = await analyze_data.execute(ctx, {
        code: "import os\nprint('in', os.path.isdir(os.environ['INPUT_DIR']), 'backend', os.environ['MPLBACKEND'])\nprint(sum(range(10)))",
      });
      const d = py.details as { exitCode: number; language: string; files: unknown[] };
      assert.equal(d.exitCode, 0, py.summary);
      assert.equal(d.language, "python");
      assert.match(py.summary, /in True backend Agg\n45/);
      assert.deepEqual(d.files, []);

      const js = await analyze_data.execute(ctx, { language: "javascript", code: "console.log([1,2,3].reduce((a,b)=>a+b), typeof process.env.OUTPUT_DIR)" });
      assert.match(js.summary, /→ exit 0[\s\S]*6 string/);

      const bad = await analyze_data.execute(ctx, { code: "raise SystemExit(3)" });
      assert.equal((bad.details as { exitCode: number }).exitCode, 3);

      const slow = await analyze_data.execute(ctx, { code: "import time\ntime.sleep(30)", timeout_ms: 5000 });
      assert.equal((slow.details as { timedOut: boolean }).timedOut, true);
    } finally {
      await sb.destroy();
    }
  });
});
