#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
UPSTREAM="$ROOT/upstream/upx"
TARGET="$ROOT/tools/static-unpack"
BUILD="$TARGET/upx-build"
OUT="$TARGET/dist"
CMAKE_BIN="${CMAKE_BIN:-$HOME/.local/bin/cmake}"
if [[ -d "$CMAKE_BIN" ]]; then
  CMAKE_BIN="${CMAKE_BIN%/}/cmake"
fi
if [[ ! -x "$CMAKE_BIN" ]]; then
  CMAKE_BIN=/usr/bin/cmake
fi
if [[ ! -x "$CMAKE_BIN" ]]; then
  CMAKE_BIN=/usr/local/bin/cmake
fi
[[ -x "$CMAKE_BIN" ]]

rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD" "$OUT"

LINK_FLAGS="-fexceptions -sDISABLE_EXCEPTION_CATCHING=0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createUpx -sENVIRONMENT=node,worker -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=16777216 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sINVOKE_RUN=0 -sEXIT_RUNTIME=0"

emcmake "$CMAKE_BIN" -S "$UPSTREAM" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-fexceptions" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS" \
  -DC_SIZEOF_SIZE_T=4 -DCXX_SIZEOF_SIZE_T=4 -DHAVE_UNISTD_H=1 \
  -DUPX_CONFIG_CMAKE_DISABLE_TEST=ON \
  -DUPX_CONFIG_CMAKE_DISABLE_INSTALL=ON \
  -DUPX_CONFIG_CMAKE_DISABLE_PLATFORM_CHECK=ON \
  -DUPX_CONFIG_DISABLE_GITREV=ON \
  -DUPX_CONFIG_DISABLE_WERROR=ON \
  -DUPX_CONFIG_DISABLE_WSTRICT=ON \
  -DUPX_CONFIG_EXPECT_THREADS=OFF

"$CMAKE_BIN" --build "$BUILD" --target upx -j2
cp "$BUILD/upx.js" "$OUT/upx.mjs"
cp "$BUILD/upx.wasm" "$OUT/upx.wasm"
