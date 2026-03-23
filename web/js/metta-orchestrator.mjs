const DEFAULT_TIMEOUT_MS = 5000;

function nowMs() {
  return Date.now();
}

function isFunction(value) {
  return typeof value === "function";
}

function normalizeEventCallback(callback) {
  return isFunction(callback) ? callback : () => {};
}

function normalizeTimeout(timeoutMs, fallback) {
  if (Number.isInteger(timeoutMs) && timeoutMs >= 0) {
    return timeoutMs;
  }
  return fallback;
}

function normalizeResult(base, stdout, stderr, durationMs) {
  const safeBase = base && typeof base === "object" ? base : {};
  return {
    ok: safeBase.ok === true,
    results: Array.isArray(safeBase.results) ? safeBase.results : [],
    stdout: Array.isArray(safeBase.stdout) ? safeBase.stdout : stdout,
    stderr: Array.isArray(safeBase.stderr) ? safeBase.stderr : stderr,
    error: safeBase.error ?? null,
    timed_out: safeBase.timed_out === true,
    canceled: safeBase.canceled === true,
    duration_ms:
      Number.isFinite(safeBase.duration_ms) && safeBase.duration_ms >= 0
        ? safeBase.duration_ms
        : durationMs,
  };
}

function bindWorkerHandlers(worker, onMessage, onError) {
  if (isFunction(worker.addEventListener)) {
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    return () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  }

  const prevMessage = worker.onmessage;
  const prevError = worker.onerror;
  worker.onmessage = onMessage;
  worker.onerror = onError;
  return () => {
    worker.onmessage = prevMessage;
    worker.onerror = prevError;
  };
}

function defaultWorkerFactory() {
  if (!isFunction(globalThis.Worker)) {
    throw new Error("Worker API is unavailable. Provide a custom workerFactory().");
  }
  return new Worker(new URL("./metta-worker.mjs", import.meta.url), { type: "module" });
}

export function createMettaRunner({
  workerFactory = defaultWorkerFactory,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let activeRun = null;
  let requestId = 0;

  function finalizeActive(result, terminateWorker = true) {
    if (!activeRun) {
      return;
    }

    const run = activeRun;
    activeRun = null;

    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
    }

    run.detachHandlers();

    if (terminateWorker && isFunction(run.worker.terminate)) {
      run.worker.terminate();
    }

    run.resolve(result);
  }

  function cancelCurrentRun() {
    if (!activeRun) {
      return false;
    }

    const durationMs = nowMs() - activeRun.startedAt;
    const result = normalizeResult(
      {
        ok: false,
        results: [],
        error: {
          type: "runtime_control",
          code: "canceled",
          message: "Execution canceled by user.",
        },
        timed_out: false,
        canceled: true,
      },
      activeRun.stdout,
      [...activeRun.stderr, "Execution canceled by user."],
      durationMs
    );

    activeRun.emit({
      type: "status",
      requestId: activeRun.requestId,
      phase: "canceled",
    });
    finalizeActive(result, true);
    return true;
  }

  async function runMetta({ code, timeoutMs, onEvent, silent = true } = {}) {
    if (activeRun) {
      throw new Error("A MeTTa run is already in progress.");
    }
    if (typeof code !== "string") {
      throw new TypeError("runMetta requires a string `code` value.");
    }

    const emit = normalizeEventCallback(onEvent);
    const runTimeoutMs = normalizeTimeout(timeoutMs, defaultTimeoutMs);
    const worker = workerFactory();
    const currentRequestId = ++requestId;
    const stdout = [];
    const stderr = [];
    const startedAt = nowMs();

    return await new Promise((resolve) => {
      const doneResult = (partialResult) => {
        const durationMs = nowMs() - startedAt;
        const result = normalizeResult(partialResult, stdout, stderr, durationMs);
        finalizeActive(result, true);
      };

      const onMessage = (event) => {
        const message = event && event.data ? event.data : event;
        if (!message || message.requestId !== currentRequestId) {
          return;
        }

        if (message.type === "stdout") {
          stdout.push(String(message.line));
          emit(message);
          return;
        }
        if (message.type === "stderr") {
          stderr.push(String(message.line));
          emit(message);
          return;
        }
        if (message.type === "status") {
          emit(message);
          return;
        }
        if (message.type === "result") {
          doneResult(message.result);
        }
      };

      const onError = (errorEvent) => {
        const message = errorEvent?.message || "Worker crashed during MeTTa execution.";
        stderr.push(message);
        doneResult({
          ok: false,
          results: [],
          error: {
            type: "runtime_error",
            code: "worker_error",
            message,
          },
          timed_out: false,
          canceled: false,
        });
      };

      const detachHandlers = bindWorkerHandlers(worker, onMessage, onError);
      const timeoutHandle =
        runTimeoutMs > 0
          ? setTimeout(() => {
              emit({
                type: "status",
                requestId: currentRequestId,
                phase: "timeout",
              });
              doneResult({
                ok: false,
                results: [],
                error: {
                  type: "timeout",
                  code: "timeout",
                  message: `Execution exceeded ${runTimeoutMs}ms.`,
                },
                timed_out: true,
                canceled: false,
              });
            }, runTimeoutMs)
          : null;

      activeRun = {
        requestId: currentRequestId,
        worker,
        stdout,
        stderr,
        startedAt,
        timeoutHandle,
        detachHandlers,
        resolve,
        emit,
      };

      emit({ type: "status", requestId: currentRequestId, phase: "starting" });
      worker.postMessage({
        type: "run",
        requestId: currentRequestId,
        payload: {
          code,
          options: {
            silent: !!silent,
            timeout_ms: runTimeoutMs,
            imports: "disabled",
          },
        },
      });
    });
  }

  return { runMetta, cancelCurrentRun };
}

const defaultRunner = createMettaRunner();

export function runMetta(args) {
  return defaultRunner.runMetta(args);
}

export function cancelCurrentRun() {
  return defaultRunner.cancelCurrentRun();
}
