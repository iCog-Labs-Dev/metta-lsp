import test from "node:test";
import assert from "node:assert/strict";

import { createMettaRunner } from "../../web/js/metta-orchestrator.mjs";

class FakeWorker {
  constructor(script) {
    this.script = script;
    this.terminated = false;
    this.listeners = {
      message: new Set(),
      error: new Set(),
    };
  }

  addEventListener(type, handler) {
    this.listeners[type].add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners[type].delete(handler);
  }

  postMessage(message) {
    this.script(message, this);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    for (const handler of this.listeners.message) {
      handler({ data });
    }
  }

  emitError(message) {
    for (const handler of this.listeners.error) {
      handler({ message });
    }
  }
}

function queueWorkerFactory(scripts) {
  const workers = [];
  return {
    workers,
    create() {
      const script = scripts.shift();
      if (!script) {
        throw new Error("No fake worker script left in queue.");
      }
      const worker = new FakeWorker(script);
      workers.push(worker);
      return worker;
    },
  };
}

test("runMetta emits timeout envelope and terminates worker", async () => {
  const factory = queueWorkerFactory([
    () => {
      // Intentionally never responds.
    },
  ]);
  const runner = createMettaRunner({ workerFactory: () => factory.create(), defaultTimeoutMs: 20 });
  const events = [];

  const result = await runner.runMetta({ code: "!(+ 1 2)", onEvent: (event) => events.push(event) });

  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.canceled, false);
  assert.equal(factory.workers[0].terminated, true);
  assert.ok(events.some((event) => event.type === "status" && event.phase === "timeout"));
});

test("cancelCurrentRun cancels active run and recovers for next run", async () => {
  const factory = queueWorkerFactory([
    () => {
      // First run hangs until canceled.
    },
    (message, worker) => {
      if (message.type !== "run") {
        return;
      }
      setTimeout(() => {
        worker.emit({
          type: "result",
          requestId: message.requestId,
          result: {
            ok: true,
            results: [42],
            stdout: ["done"],
            stderr: [],
            error: null,
            timed_out: false,
            canceled: false,
            duration_ms: 1,
          },
        });
      }, 0);
    },
  ]);

  const runner = createMettaRunner({ workerFactory: () => factory.create(), defaultTimeoutMs: 5000 });
  const runPromise = runner.runMetta({ code: "!(loop)" });
  setTimeout(() => {
    runner.cancelCurrentRun();
  }, 10);

  const canceledResult = await runPromise;
  assert.equal(canceledResult.ok, false);
  assert.equal(canceledResult.canceled, true);
  assert.equal(factory.workers[0].terminated, true);

  const recoveredResult = await runner.runMetta({ code: "!(+ 40 2)" });
  assert.equal(recoveredResult.ok, true);
  assert.deepEqual(recoveredResult.results, [42]);
  assert.equal(factory.workers[1].terminated, true);
  assert.equal(factory.workers.length, 2);
});

test("runner creates a fresh worker for each run", async () => {
  const factory = queueWorkerFactory([
    (message, worker) => {
      worker.emit({
        type: "result",
        requestId: message.requestId,
        result: { ok: true, results: ["first"] },
      });
    },
    (message, worker) => {
      worker.emit({
        type: "result",
        requestId: message.requestId,
        result: { ok: true, results: ["second"] },
      });
    },
  ]);

  const runner = createMettaRunner({ workerFactory: () => factory.create(), defaultTimeoutMs: 1000 });
  const first = await runner.runMetta({ code: "!(first)" });
  const second = await runner.runMetta({ code: "!(second)" });

  assert.deepEqual(first.results, ["first"]);
  assert.deepEqual(second.results, ["second"]);
  assert.equal(factory.workers.length, 2);
});
