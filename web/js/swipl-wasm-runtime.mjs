import SWIPL from "./swipl-wasm.mjs";

const SOURCE_FILES = [
  "main.pl",
  "metta.pl",
  "parser.pl",
  "translator.pl",
  "specializer.pl",
  "filereader.pl",
  "spaces.pl",
];

function ensureDir(swipl, path) {
  try {
    swipl.FS.mkdir(path);
  } catch (error) {
    if (!String(error).includes("File exists")) {
      throw error;
    }
  }
}

async function readSourceFileText(name) {
  const url = new URL(`../../src/${name}`, import.meta.url);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url.toString()} (${response.status})`);
    }
    return await response.text();
  } catch (error) {
    if (typeof process !== "undefined" && process.versions?.node) {
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import("node:fs/promises"),
        import("node:url"),
      ]);
      return await readFile(fileURLToPath(url), "utf8");
    }
    throw error;
  }
}

async function loadPrologSources(swipl) {
  ensureDir(swipl, "/src");

  for (const fileName of SOURCE_FILES) {
    const text = await readSourceFileText(fileName);
    swipl.FS.writeFile(`/src/${fileName}`, text);
  }
}

function fromPrologAtom(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  return value;
}

function deepNormalize(value) {
  if (Array.isArray(value)) {
    return value.map(deepNormalize);
  }
  if (value && typeof value === "object" && value.$t === "s" && typeof value.v === "string") {
    return value.v;
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$tag") {
        continue;
      }
      normalized[key] = deepNormalize(entry);
    }
    return normalized;
  }
  return fromPrologAtom(value);
}

function normalizeResultEnvelope(rawResult) {
  const normalized = deepNormalize(rawResult && typeof rawResult === "object" ? rawResult : {});

  return {
    ok: normalized.ok === true,
    results: Array.isArray(normalized.results) ? normalized.results : [],
    stdout: Array.isArray(normalized.stdout) ? normalized.stdout : [],
    stderr: Array.isArray(normalized.stderr) ? normalized.stderr : [],
    error: normalized.error ?? null,
    timed_out: normalized.timed_out === true,
    canceled: normalized.canceled === true,
    duration_ms:
      Number.isFinite(normalized.duration_ms) && normalized.duration_ms >= 0
        ? normalized.duration_ms
        : 0,
  };
}

function runtimeErrorEnvelope(message) {
  return {
    ok: false,
    results: [],
    stdout: [],
    stderr: [message],
    error: {
      type: "runtime_error",
      code: "prolog_query_error",
      message,
    },
    timed_out: false,
    canceled: false,
    duration_ms: 0,
  };
}

function toRunOptions(options) {
  const timeoutMs =
    Number.isInteger(options?.timeout_ms) && options.timeout_ms >= 0
      ? options.timeout_ms
      : Number.isInteger(options?.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : 5000;

  return {
    silent: options?.silent === false ? false : true,
    timeout_ms: timeoutMs,
    imports: "disabled",
  };
}

async function createRuntimeInstance() {
  let hooks = null;
  const swipl = await SWIPL({
    arguments: ["-q"],
    print(line) {
      if (hooks && typeof hooks.onStdout === "function") {
        hooks.onStdout(String(line));
      }
    },
    printErr(line) {
      if (hooks && typeof hooks.onStderr === "function") {
        hooks.onStderr(String(line));
      }
    },
  });

  await loadPrologSources(swipl);
  await swipl.prolog.consult("/src/main.pl");

  return {
    async run(code, options = {}, outputHooks = {}) {
      hooks = outputHooks;
      try {
        const result = swipl.prolog
          .query("metta_browser_run(Code, Options, Result).", {
            Code: String(code ?? ""),
            Options: toRunOptions(options),
          })
          .once();

        if (result?.error) {
          return runtimeErrorEnvelope(result.message || "Unknown Prolog runtime error.");
        }
        if (result?.success === false) {
          return runtimeErrorEnvelope("No result returned from metta_browser_run/3.");
        }

        return normalizeResultEnvelope(result.Result);
      } finally {
        hooks = null;
      }
    },
  };
}

if (typeof globalThis.createSwiplWasmRuntime !== "function") {
  globalThis.createSwiplWasmRuntime = createRuntimeInstance;
}
