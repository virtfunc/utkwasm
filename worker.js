importScripts("wasm_exec.js");

var readySent = false;
var lzmaActive = false; // set once lzmaReady settles

function post(msg) {
  self.postMessage(msg);
}

function ready(version) {
  if (readySent) return;
  readySent = true;
  post({ type: "ready", version: version, lzma: lzmaActive });
}

// Fetch utk.wasm, reporting download progress so the page can show a bar.
// "no-cache" revalidates with the server (ETag), so a redeployed binary is
// picked up instead of a stale browser-cache copy.
function fetchWasm(url) {
  return fetch(url, { cache: "no-cache" }).then(function (response) {
    if (!response.ok) {
      throw new Error(
        "failed to fetch " + url + ": " + response.status + " " + response.statusText,
      );
    }
    var total = parseInt(response.headers.get("Content-Length"), 10);
    if (!isFinite(total) || !response.body || !response.body.getReader) {
      // Unknown length or no streaming support: plain read, no progress.
      return response.arrayBuffer();
    }
    var reader = response.body.getReader();
    var chunks = [];
    var loaded = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          post({ type: "wasmProgress", progress: 100 });
          var out = new Uint8Array(loaded);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            out.set(chunks[i], offset);
            offset += chunks[i].length;
          }
          return out.buffer;
        }
        chunks.push(r.value);
        loaded += r.value.length;
        post({
          type: "wasmProgress",
          progress: Math.min(100, Math.round((loaded / total) * 100)),
        });
        return pump();
      });
    }
    return pump();
  });
}

// --- liblzma delegation bootstrap -----------------------------------------
// Missing bundle or failed init must never break patching: every failure
// path resolves to false and utk.wasm falls back to its pure-Go LZMA.
var lzmaReady = (function () {
  try {
    // The lzma-wasm iife bundle ends with `window.LzmaWasm = lzma_wasm`,
    // which throws in workers (no window). Shim it before importScripts.
    if (typeof window === "undefined") self.window = self;
    importScripts("lzma_wasm.iife.js");
    return installJsLzma().then(
      function (ok) {
        lzmaActive = !!ok;
        console.log(
          "[worker] liblzma delegation: " +
            (lzmaActive ? "ACTIVE" : "INACTIVE (pure-Go fallback, ~3x slower)"),
        );
        return lzmaActive;
      },
      function (err) {
        console.warn("[worker] lzma init rejected, using pure-Go fallback:", err);
        return false;
      },
    );
  } catch (e) {
    // importScripts throws when a script 404s or fails to evaluate.
    console.warn(
      "[worker] lzma_wasm.iife.js/worker-lzma-glue.js unavailable, " +
        "using pure-Go LZMA (slow but correct):",
      e && (e.message || e),
    );
    return Promise.resolve(false);
  }
})();

// The Go module calls this once its JS bindings are registered.
self.utkOnReady = function () {
  ready(self.utkVersion);
};

var go = new Go();

// Start the lzma init and the wasm download in parallel, but only START the
// Go runtime after both settle. Starting Go earlier would be fine too (the
// hooks are looked up per utkPatch call), but a user could click "Patch"
// before initWasm() finishes and silently get the slow path; gating here
// removes that race entirely.
Promise.all([fetchWasm("utk.wasm"), lzmaReady.catch(function () { return false; })])
  .then(function (results) {
    return WebAssembly.instantiate(results[0], go.importObject);
  })
  .then(function (result) {
    // Starts the Go runtime; main() registers utkPatch and parks, then
    // control returns here. The returned promise settles when (if) the Go
    // program ever exits.
    var running = go.run(result.instance);
    // Fallback in case the ready callback was not invoked for some reason.
    if (typeof self.utkPatch === "function") {
      ready(self.utkVersion);
    }
    return running;
  })
  .catch(function (err) {
    post({ type: "error", text: "Failed to load UTK wasm module: " + err });
  });

self.onmessage = function (e) {
  if (e.data.type !== "runPatch") return;

  if (typeof self.utkPatch !== "function") {
    post({ type: "error", text: "UTK is still loading, try again in a moment." });
    return;
  }

  // Loud diagnostic: if this says FALLBACK while lzma_wasm.iife.js is
  // deployed, something is wrong with the glue wiring — check the console.
  console.log(
    "[worker] utkPatch: liblzma delegation " +
      (typeof self.utkLzmaDecompress === "function" ? "ACTIVE" : "FALLBACK (pure Go)"),
  );

  var inputRomArray = e.data.inputRomArray;
  var patchesTxt = e.data.patchesTxt || "";
  if (!patchesTxt.trim()) {
    post({ type: "error", text: "No patches selected. Tick at least one patch." });
    return;
  }

  try {
    var res = self.utkPatch(inputRomArray, patchesTxt, function (line) {
      post({ type: "stdout", text: line });
    });
    if (res && res.ok) {
      post({
        type: "complete",
        data: res.data,
        places: res.places,
        skipped: res.skipped,
        lzma: lzmaActive,
      });
    } else {
      post({ type: "error", text: (res && res.error) || "unknown error" });
    }
  } catch (err) {
    post({ type: "error", text: "UTK wasm module failed: " + err });
  }
};
//LZMA GLUE FUNCS
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
