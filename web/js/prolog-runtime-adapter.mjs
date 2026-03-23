function missingFactoryError() {
  return new Error(
    "SWI-Prolog WASM runtime factory is missing. Define globalThis.createSwiplWasmRuntime in the worker scope."
  );
}

export async function createPrologRuntime() {
  let factory = globalThis.createSwiplWasmRuntime;

  if (typeof factory !== "function") {
    // This module registers globalThis.createSwiplWasmRuntime when swipl-wasm is installed.
    await import("./swipl-wasm-runtime.mjs");
    factory = globalThis.createSwiplWasmRuntime;
  }

  if (typeof factory !== "function") {
    throw missingFactoryError();
  }

  const runtime = await factory();
  if (!runtime || typeof runtime.run !== "function") {
    throw new Error("createSwiplWasmRuntime() must resolve to an object with run(code, options, hooks).");
  }

  return runtime;
}
