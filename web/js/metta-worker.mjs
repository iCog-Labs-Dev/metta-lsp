import { createPrologRuntime } from "./prolog-runtime-adapter.mjs";

function errorToString(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function normalizeRuntimeResult(result, stdout, stderr, durationMs) {
  const safeResult = result && typeof result === "object" ? result : {};

  return {
    ok: safeResult.ok === true,
    results: Array.isArray(safeResult.results) ? safeResult.results : [],
    stdout: Array.isArray(safeResult.stdout) ? safeResult.stdout : stdout,
    stderr: Array.isArray(safeResult.stderr) ? safeResult.stderr : stderr,
    error: safeResult.error ?? null,
    timed_out: safeResult.timed_out === true,
    canceled: safeResult.canceled === true,
    duration_ms:
      Number.isFinite(safeResult.duration_ms) && safeResult.duration_ms >= 0
        ? safeResult.duration_ms
        : durationMs,
  };
}

function runtimeErrorResult(error, stdout, stderr, durationMs) {
  return {
    ok: false,
    results: [],
    stdout,
    stderr: [...stderr, errorToString(error)],
    error: {
      type: "runtime_error",
      code: "worker_runtime_error",
      message: errorToString(error),
    },
    timed_out: false,
    canceled: false,
    duration_ms: durationMs,
  };
}

export async function executeRunMessage(runtime, payload, emit) {
  const { code, options } = payload;
  const stdout = [];
  const stderr = [];
  const startedAt = Date.now();

  const hooks = {
    onStdout(line) {
      const text = String(line);
      stdout.push(text);
      emit({ type: "stdout", line: text });
    },
    onStderr(line) {
      const text = String(line);
      stderr.push(text);
      emit({ type: "stderr", line: text });
    },
  };

  emit({ type: "status", phase: "running" });

  try {
    const result = await runtime.run(code, options, hooks);
    const durationMs = Date.now() - startedAt;
    emit({
      type: "result",
      result: normalizeRuntimeResult(result, stdout, stderr, durationMs),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    emit({ type: "result", result: runtimeErrorResult(error, stdout, stderr, durationMs) });
  }
}

let runtimePromise = null;

function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise = createPrologRuntime();
  }
  return runtimePromise;
}

export async function handleWorkerMessage(data, emit) {
  if (!data || data.type !== "run") {
    return;
  }

  const requestId = data.requestId;
  const payload = data.payload || {};

  const emitWithId = (message) => emit({ ...message, requestId });
  emitWithId({ type: "status", phase: "initializing" });

  try {
    const runtime = await ensureRuntime();
    await executeRunMessage(runtime, payload, emitWithId);
  } catch (error) {
    emitWithId({
      type: "result",
      result: runtimeErrorResult(error, [], [], 0),
    });
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async (event) => {
    await handleWorkerMessage(event.data, (message) => self.postMessage(message));
  };
}
