#!/bin/bash
LZMA_EXPECTED_HASH=7a85f11aad8ee776880fdc58fe237f1d0e3c1695cfd5a1d92277f94096490a7c
FIANO_COMMIT=162b021e54496b89b2f9028f88234b2caec70a0c
LZMA_WASM_VERSION=1.0.7

set -e
cd "$(dirname "$0")"

mkdir -p fiano
git -C fiano init
git -C fiano checkout "$FIANO_COMMIT" 2>/dev/null || git -C fiano fetch --depth 1 https://github.com/linuxboot/fiano "$FIANO_COMMIT"
git -C fiano reset --hard "$FIANO_COMMIT"
git -C fiano clean -fd
git -C fiano apply ../fiano_sigpatcher_v5.patch ../0001-fiano-perf-fixes.patch ../0002-fiano-js-lzma-delegation.patch

wget -qO lzma_wasm.iife.js "https://unpkg.com/lzma-wasm@${LZMA_WASM_VERSION}/dist/iife/index.js"
[ "$(sha256sum < lzma_wasm.iife.js)" = "$LZMA_EXPECTED_HASH  -" ] # we cant trust randoms on unpkg to not get compromised

GOOS=js GOARCH=wasm go build -C wasm \
  -ldflags="-s -w -X main.version=${FIANO_COMMIT:0:7}-perf" \
  -o ../utk.wasm .

cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" .

ls -l utk.wasm wasm_exec.js lzma_wasm.iife.js worker-lzma-glue.js worker.js
