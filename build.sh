#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
    echo "error: install go" >&2
    exit 1
fi

FIANO_COMMIT=162b021e54496b89b2f9028f88234b2caec70a0c
LZMA_WASM_VERSION=1.0.7

mkdir -p fiano
git -C fiano init
git -C fiano checkout "$FIANO_COMMIT" 2>/dev/null || git -C fiano fetch --depth 1 https://github.com/linuxboot/fiano "$FIANO_COMMIT"
git -C fiano reset --hard "$FIANO_COMMIT"
git -C fiano clean -fd
git -C fiano apply ../fiano_sigpatcher_v5.patch ../0001-fiano-perf-fixes.patch ../0002-fiano-js-lzma-delegation.patch

wget -q "https://unpkg.com/lzma-wasm@${LZMA_WASM_VERSION}/dist/iife/index.js" -O lzma_wasm.iife.js

GOOS=js GOARCH=wasm go build -C wasm \
  -ldflags="-s -w -X main.version=${FIANO_COMMIT:0:7}-perf" \
  -o ../utk.wasm .

cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .

du -h utk.wasm wasm_exec.js lzma_wasm.iife.js worker-lzma-glue.js worker.js
