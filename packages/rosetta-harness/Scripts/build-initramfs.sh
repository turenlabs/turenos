#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BUSYBOX=$1
OUTPUT=$2
VIRTIOFS_MODULE=${3:-}
BINFMT_MODULE=${4:-}
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/turen-rosetta-initramfs.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$STAGING/bin"
cp "$BUSYBOX" "$STAGING/bin/busybox"
cp "$ROOT/Resources/init" "$STAGING/init"
chmod 0555 "$STAGING/bin/busybox" "$STAGING/init"
if [ -n "$VIRTIOFS_MODULE" ]; then
  mkdir -p "$STAGING/lib"
  cp "$VIRTIOFS_MODULE" "$STAGING/lib/virtiofs.ko"
  chmod 0444 "$STAGING/lib/virtiofs.ko"
fi
if [ -n "$BINFMT_MODULE" ]; then
  mkdir -p "$STAGING/lib"
  cp "$BINFMT_MODULE" "$STAGING/lib/binfmt_misc.ko"
  chmod 0444 "$STAGING/lib/binfmt_misc.ko"
fi

mkdir -p "$(dirname "$OUTPUT")"
(cd "$STAGING" && find . -print0 | cpio -o -0 -H newc 2>/dev/null) | gzip -9 > "$OUTPUT"
