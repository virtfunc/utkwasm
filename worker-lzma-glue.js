// worker-lzma-glue.js
//
// Registers the JS-side LZMA hooks that utk.wasm (built with
// 0002-fiano-js-lzma-delegation.patch) delegates to when present.
//
// Load order matters: worker.js shims `window`, then importScripts
// "lzma_wasm.iife.js" (defines the global `lzma_wasm`, embeds its own
// wasm) and only THEN this file, and finally AWAITS the promise returned
// here before starting the Go runtime:
//
//     if (typeof window === "undefined") self.window = self;
//     importScripts("lzma_wasm.iife.js");
//     importScripts("worker-lzma-glue.js");
//     var lzmaReady = installJsLzma();   // <-- promise, must settle first
//
// Contract with the Go side (pkg/compression/jslzma_js.go):
//   utkLzmaCompress(data: Uint8Array, level: number) -> Uint8Array
//       LZMA-alone stream, lc=3 lp=0 pb=2 (props 0x5D), exact size in header
//   utkLzmaDecompress(data: Uint8Array, expectedSize: number) -> Uint8Array
//   Returning an empty Uint8Array makes the Go side fall back to its pure-Go
//   implementation for that call (used below on any decoder error).
//
// Both functions must be SYNCHRONOUS (lzma-wasm's compress/decompress are
// sync once initWasm() has resolved — verified).

function installJsLzma() {
  if (typeof lzma_wasm === "undefined") {
    console.warn("[lzma-glue] lzma_wasm global not found; skipping delegation");
    return Promise.resolve(false);
  }
  return lzma_wasm.initWasm().then(
    function () {
      globalThis.utkLzmaCompress = function (data, level) {
        // Level capped at 1 on purpose: for firmware FVMAIN payloads,
        // level 1 is ~3.4x faster than the pure-Go encoder inside js/wasm
        // and produces output ~4% SMALLER than the pure-Go level-7 encoder
        // (so it cannot overflow a volume the current build already fits).
        // Raise the cap if you need maximum ratio instead.
        try {
          return lzma_wasm.compress(data, { format: "lzma", level: Math.min(level, 1) });
        } catch (e) {
          console.warn("[lzma-glue] compress failed, falling back to pure Go:", e && e.message);
          return new Uint8Array(0);
        }
      };
      globalThis.utkLzmaDecompress = function (data, expectedSize) {
        try {
          if (expectedSize > 0) {
            return lzma_wasm.decompress(data, { expectedSize: expectedSize });
          }
          return lzma_wasm.decompress(data);
        } catch (e) {
          console.warn("[lzma-glue] decompress failed, falling back to pure Go:", e && e.message);
          return new Uint8Array(0);
        }
      };
      console.log("[lzma-glue] utkLzmaCompress/utkLzmaDecompress registered (liblzma-wasm active)");
      return true;
    },
    function (err) {
      console.warn("[lzma-glue] initWasm() failed; pure-Go fallback:", err);
      return false;
    },
  );
}
