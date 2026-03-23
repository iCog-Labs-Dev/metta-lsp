import test from "node:test";
import assert from "node:assert/strict";

import { executeRunMessage, normalizeRuntimeResult } from "../../web/js/metta-worker.mjs";

test("normalizeRuntimeResult fills missing envelope fields", () => {
  const result = normalizeRuntimeResult({ ok: true, results: [1] }, ["a"], ["b"], 12);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [1]);
  assert.deepEqual(result.stdout, ["a"]);
  assert.deepEqual(result.stderr, ["b"]);
  assert.equal(result.duration_ms, 12);
  assert.equal(result.error, null);
});

test("executeRunMessage streams stdout/stderr before final result", async () => {
  const events = [];
  const runtime = {
    async run(_code, _options, hooks) {
      hooks.onStdout("first");
      hooks.onStderr("problem");
      hooks.onStdout("second");
      return { ok: true, results: [3] };
    },
  };

  await executeRunMessage(runtime, { code: "!(+ 1 2)", options: {} }, (event) => events.push(event));

  assert.deepEqual(
    events.map((event) => event.type),
    ["status", "stdout", "stderr", "stdout", "result"]
  );
  assert.deepEqual(events[4].result.stdout, ["first", "second"]);
  assert.deepEqual(events[4].result.stderr, ["problem"]);
  assert.equal(events[4].result.ok, true);
});

test("executeRunMessage returns runtime_error envelope on failure", async () => {
  const events = [];
  const runtime = {
    async run() {
      throw new Error("runtime exploded");
    },
  };

  await executeRunMessage(runtime, { code: "!(+ 1 2)", options: {} }, (event) => events.push(event));

  const final = events.at(-1);
  assert.equal(final.type, "result");
  assert.equal(final.result.ok, false);
  assert.equal(final.result.error.type, "runtime_error");
  assert.equal(final.result.error.code, "worker_runtime_error");
  assert.match(final.result.error.message, /runtime exploded/);
});
