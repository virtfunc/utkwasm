// Command utkwasm exposes fiano's UTK firmware patcher to JavaScript.
//
// It is built with GOOS=js GOARCH=wasm (see ../build.sh) and is loaded by
// worker.js together with Go's wasm_exec.js runtime glue. The module keeps
// running for the lifetime of the worker and answers patch requests through
// the global utkPatch() function:
//
//	utkPatch(rom: Uint8Array, patchesTxt: string, onLog: (line: string) => void)
//	  -> { ok: true, data: Uint8Array, places: number, skipped: number }
//	   | { ok: false, error: string }
//
// patchesTxt uses the UEFIPatch patches.txt format: one rule per line of the
// form "FileGuid SectionType PatchType:FindPatternOrOffset:ReplacePattern",
// with '#' comments and blank lines ignored (same as the `patch` command of
// the utk CLI, see fiano/pkg/visitors/patch.go).
//
// The equivalent CLI invocation is:
//
//	utk firmware.rom patch save firmware_patched.rom
//
// except that patches which do not apply to the image are reported and
// skipped instead of aborting the run (the CLI behaves the same way when it
// reads the rules from a patches.txt file).
package main

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"syscall/js"

	fianolog "github.com/linuxboot/fiano/pkg/log"
	"github.com/linuxboot/fiano/pkg/uefi"
	"github.com/linuxboot/fiano/pkg/visitors"
)

// version is stamped at build time with
// -ldflags "-X main.version=<fiano commit>". It is exposed to JS as the
// global string utkVersion.
var version = "dev"

// fatalError is panicked by jsLogger.Fatalf so that a fatal condition inside
// fiano surfaces as a regular error to the caller instead of exiting the
// wasm instance (os.Exit is a no-op trap on js/wasm).
type fatalError struct{ msg string }

func (e fatalError) Error() string { return e.msg }

// jsLogger implements fiano's log.Logger interface on top of a line
// callback, so internal warnings and errors become visible in the page.
type jsLogger struct{ emit func(string) }

func (l jsLogger) Warnf(format string, args ...interface{}) {
	l.emit("[warn] " + fmt.Sprintf(format, args...))
}

func (l jsLogger) Errorf(format string, args ...interface{}) {
	l.emit("[error] " + fmt.Sprintf(format, args...))
}

func (l jsLogger) Fatalf(format string, args ...interface{}) {
	panic(fatalError{fmt.Sprintf(format, args...)})
}

// lineWriter turns io.Writer writes into individual log lines. Writers used
// by fiano write whole lines, but stay correct even for partial writes.
type lineWriter struct {
	emit func(string)
	buf  bytes.Buffer
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			// Incomplete line: keep it buffered for the next write.
			w.buf.WriteString(line)
			break
		}
		w.emit(strings.TrimSuffix(line, "\n"))
	}
	return len(p), nil
}

func main() {
	js.Global().Set("utkVersion", version)
	js.Global().Set("utkPatch", js.FuncOf(utkPatch))

	// Let the host know the bindings are in place. The worker defines this
	// callback before starting the module.
	if ready := js.Global().Get("utkOnReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}

	// Park main forever; the runtime stays alive and services JS callbacks.
	// (js/wasm returns control to JS here instead of tripping the deadlock
	// detector, because the scheduler can always be resumed by an event.)
	select {}
}

// utkPatch implements the JS-facing utkPatch(rom, patchesTxt, onLog).
func utkPatch(this js.Value, args []js.Value) (result interface{}) {
	// Convert any panic (including fiano's Fatalf) into an error result so
	// the worker survives and can report the problem to the user.
	defer func() {
		if r := recover(); r != nil {
			var msg string
			if fe, ok := r.(fatalError); ok {
				msg = fe.msg
			} else {
				msg = fmt.Sprintf("unexpected internal error: %v", r)
			}
			result = errorResult(msg)
		}
	}()

	if len(args) != 3 {
		return errorResult("utkPatch expects (rom: Uint8Array, patches: string, onLog: function)")
	}
	romArg, patchesArg, logArg := args[0], args[1], args[2]

	if romArg.Type() != js.TypeObject || !romArg.InstanceOf(js.Global().Get("Uint8Array")) {
		return errorResult("rom must be a Uint8Array")
	}
	if patchesArg.Type() != js.TypeString {
		return errorResult("patches must be a string")
	}
	emit := func(string) {} // logging is optional
	if logArg.Type() == js.TypeFunction {
		emit = func(line string) { logArg.Invoke(line) }
	}

	rom := make([]byte, romArg.Length())
	if js.CopyBytesToGo(rom, romArg) != len(rom) {
		return errorResult("could not copy the firmware image")
	}
	if len(rom) == 0 {
		return errorResult("the firmware image is empty")
	}

	log := &lineWriter{emit: emit}

	// Route fiano's internal warnings/errors through the same callback.
	prevLogger := fianolog.DefaultLogger
	fianolog.DefaultLogger = jsLogger{emit: emit}
	defer func() { fianolog.DefaultLogger = prevLogger }()

	out, places, skipped, err := patchROM(rom, patchesArg.String(), log)
	if err != nil {
		return errorResult(err.Error())
	}

	res := js.Global().Get("Object").New()
	res.Set("ok", true)
	res.Set("places", places)
	res.Set("skipped", skipped)
	outArr := js.Global().Get("Uint8Array").New(len(out))
	js.CopyBytesToJS(outArr, out)
	res.Set("data", outArr)
	return res
}

// patchROM parses the firmware image, applies the UEFIPatch style rules and
// reassembles the image, mirroring `utk <rom> patch save <out>`.
func patchROM(rom []byte, patchesTxt string, log io.Writer) (out []byte, places, skipped int, err error) {
	patches, err := visitors.ParsePatchFile(strings.NewReader(patchesTxt))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("invalid patches: %w", err)
	}

	root, err := uefi.Parse(rom)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("could not parse firmware image: %w", err)
	}

	patcher := &visitors.Patch{Patches: patches, Lenient: true, W: log}
	if err := patcher.Run(root); err != nil {
		return nil, 0, 0, fmt.Errorf("could not apply patches: %w", err)
	}

	// Assemble the tree back into a flat image (same as the save command).
	assemble := &visitors.Assemble{}
	if err := root.Apply(assemble); err != nil {
		return nil, 0, 0, fmt.Errorf("could not assemble the patched image: %w", err)
	}
	return root.Buf(), places, len(patcher.Skipped), nil
}

func errorResult(msg string) interface{} {
	res := js.Global().Get("Object").New()
	res.Set("ok", false)
	res.Set("error", msg)
	return res
}
