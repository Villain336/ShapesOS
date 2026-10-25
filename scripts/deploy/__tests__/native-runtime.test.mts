import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

it("loads the native embedding runtime without downloading models", () => {
  // A native ONNX abort kills the process, so isolate the import as Next's
  // page-data workers do. Importing alone must not initialize any models.
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@xenova/transformers")'],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
