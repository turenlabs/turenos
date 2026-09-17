#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
UPSTREAM="$ROOT/upstream/libpcap"
TARGET="$ROOT/tools/libpcap"
BUILD="$TARGET/build"
OUT="$TARGET/dist"

rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD" "$OUT"

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
emcmake "$CMAKE_BIN" -S "$UPSTREAM" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG -flto -ffunction-sections -fdata-sections" \
  -DPCAP_TYPE=null -DBUILD_SHARED_LIBS=OFF -DENABLE_REMOTE=OFF \
  -DBUILD_WITH_LIBNL=OFF -DDISABLE_LINUX_USBMON=ON -DDISABLE_BLUETOOTH=ON \
  -DDISABLE_NETMAP=ON -DDISABLE_DPDK=ON -DDISABLE_DBUS=ON -DDISABLE_RDMA=ON \
  -DDISABLE_DAG=ON -DDISABLE_SEPTEL=ON -DDISABLE_SNF=ON \
  -DDISABLE_AIRPCAP=ON -DDISABLE_TC=ON -DINET6=ON

cmake --build "$BUILD" --target pcap_static

em++ -std=c++20 -O3 -flto -D_GNU_SOURCE -I"$BUILD" -idirafter "$UPSTREAM" \
  "$TARGET/src/libpcap_wasm.cpp" "$BUILD/libpcap.a" -lembind -Wl,--gc-sections --no-entry \
  -sSTRICT=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibpcap \
  -sENVIRONMENT=node,worker -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=8388608 \
  -sFILESYSTEM=0 -o "$OUT/libpcap.mjs"
