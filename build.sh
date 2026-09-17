#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
    echo "error: install go" >&2
    exit 1
fi

rm -rf fiano

git clone https://github.com/linuxboot/fiano
cd fiano
git apply ../fiano_sigpatcher_v5.patch
cd ..

echo "Building utk.wasm..."
cd wasm
GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -ldflags="-s -w" -o ../utk.wasm .
cd ..

if [ ! -f wasm_exec.js ]; then
    wget https://raw.githubusercontent.com/golang/go/refs/heads/master/lib/wasm/wasm_exec.js
fi

du -h utk.wasm wasm_exec.js

echo "Compressing..."
