#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
KERNEL=${1:?path to uncompressed ARM64 Linux Image}
BUSYBOX=${2:?path to static ARM64 BusyBox}
VIRTIOFS=${3:?path to virtiofs.ko for the pinned kernel}
BINFMT=${4:?path to binfmt_misc.ko for the pinned kernel}
OUT=${5:?output directory}

mkdir -p "$OUT"
cp "$KERNEL" "$OUT/kernel"
"$ROOT/Scripts/build-initramfs.sh" "$BUSYBOX" "$OUT/initrd.gz" "$VIRTIOFS" "$BINFMT"
swift build --package-path "$ROOT" -c release
cp "$ROOT/.build/release/turen-rosetta-harness" "$OUT/turen-rosetta-harness"
codesign --force --sign - --entitlements "$ROOT/Resources/entitlements.plist" "$OUT/turen-rosetta-harness"
shasum -a 256 "$OUT/kernel" "$OUT/initrd.gz" "$OUT/turen-rosetta-harness" > "$OUT/SHA256SUMS"
