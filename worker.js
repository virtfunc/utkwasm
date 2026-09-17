// UTK WebAssembly worker.
//
// Loads fiano's UTK patcher (utk.wasm, a Go js/wasm build) together with
// Go's wasm_exec.js runtime glue and runs patch jobs off the main thread.
//
// The wasm module is a Go program, not an Emscripten module: there is no
// virtual filesystem and no C main() to call. Instead the Go side registers
// the global function
//
//   utkPatch(rom: Uint8Array, patchesTxt: string, onLog: (line) => void)
//     -> { ok: true, data: Uint8Array, places: number, skipped: number }
//      | { ok: false, error: string }
//
// and this worker simply forwards messages and results to the page.

importScripts("wasm_exec.js");

var readySent = false;

function post(msg) {
  self.postMessage(msg);
}

function ready(version) {
  if (readySent) return;
  readySent = true;
  post({ type: "ready", version: version });
}

// Fetch utk.wasm, reporting download progress so the page can show a bar.
function fetchWasm(url) {
  return fetch(url).then(function (response) {
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

// The Go module calls this once its JS bindings are registered.
self.utkOnReady = function () {
  ready(self.utkVersion);
};

var go = new Go();

fetchWasm("utk.wasm")
  .then(function (buf) {
    return WebAssembly.instantiate(buf, go.importObject);
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
      });
    } else {
      post({ type: "error", text: (res && res.error) || "unknown error" });
    }
  } catch (err) {
    post({ type: "error", text: "UTK wasm module failed: " + err });
  }
};
