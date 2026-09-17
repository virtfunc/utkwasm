#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
    echo "error: install go" >&2
    exit 1
fi

FIANO_COMMIT=162b021e54496b89b2f9028f88234b2caec70a0c

LZMA_WASM_VERSION=1.0.7

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    else
        wget -q "$1" -O "$2"
    fi
}

rm -rf fiano

git clone https://github.com/linuxboot/fiano
(cd fiano && git -c advice.detachedHead=false checkout "$FIANO_COMMIT")
cd fiano
git apply ../fiano_sigpatcher_v5.patch
git apply ../0001-fiano-perf-fixes.patch
git apply ../0002-fiano-js-lzma-delegation.patch
cd ..

# liblzma-wasm bundle loaded by worker.js for the LZMA delegation (7x decode,
# 3x encode vs pure-Go inside js/wasm).
if [ ! -f lzma_wasm.iife.js ]; then
    echo "Vendoring lzma-wasm ${LZMA_WASM_VERSION} iife bundle..."
    fetch "https://unpkg.com/lzma-wasm@${LZMA_WASM_VERSION}/dist/iife/index.js" lzma_wasm.iife.js
fi

echo "Building utk.wasm..."
cd wasm
GOOS=js GOARCH=wasm CGO_ENABLED=0 go build \
    -ldflags="-s -w -X main.version=${FIANO_COMMIT:0:7}-perf" \
    -o ../utk.wasm .
cd ..

# Always take wasm_exec.js from the LOCAL toolchain so it matches the binary.
# (Fetching it from Go master can drift from the installed Go and break in
# subtle ways.) This overwrites the checked-in copy on purpose.
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .

du -h utk.wasm wasm_exec.js lzma_wasm.iife.js worker-lzma-glue.js worker.js | sed 's/^/  /'

