/**
 * Browser-compatible ES module wrapper for swipl-wasm.
 *
 * The published swipl-wasm npm package ships swipl-bundle.js as a UMD/IIFE
 * bundle: `var SWIPL = (()=>{ … return async function(moduleArg){…} })()`.
 * It is NOT an ES module, so it cannot be `import`-ed directly by the
 * browser.  We fetch the source, wrap it to expose the factory on
 * `globalThis`, create a Blob URL, and load it as a classic script in a way
 * that works in BOTH the main thread and module Workers.
 */

const bundleUrl = new URL(
  "../../node_modules/swipl-wasm/dist/swipl/swipl-bundle.js",
  import.meta.url
).href;

if (typeof globalThis.SWIPL !== "function") {
  // Fetch the raw bundle source
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch swipl-bundle.js (${response.status}): ${bundleUrl}`
    );
  }

  // Wrap the IIFE so it assigns the factory to globalThis instead of a local var.
  // The original source starts with: `var SWIPL = (()=>{...})();`
  // We prepend a reassignment so the result ends up on globalThis.
  const src = await response.text();
  const wrapped = src.replace(/^var SWIPL\s*=/, "globalThis.SWIPL =");

  // Evaluate in the current scope via a Blob + dynamic import of the blob.
  // Using a blob with MIME type "application/javascript" makes it work as
  // a module-worker-compatible classic-ish script.
  const blob = new Blob([wrapped], { type: "application/javascript" });
  const objUrl = URL.createObjectURL(blob);
  try {
    // importScripts is available in classic workers but NOT in module workers.
    // Instead we use a dynamic import trick: load the blob as a module script.
    // The blob has no exports so the module resolves to an empty namespace,
    // but the side-effect (globalThis.SWIPL = …) has already executed.
    await import(/* @vite-ignore */ objUrl);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

if (typeof globalThis.SWIPL !== "function") {
  throw new Error(
    "swipl-bundle.js loaded but globalThis.SWIPL is still not a function. " +
    "Check that the bundle format hasn't changed."
  );
}

export default globalThis.SWIPL;
