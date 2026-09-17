#!/bin/sh
# Import the pinned Mono subset for the monodis WASM target.
set -eu

COMMIT="0f53e9e151d92944cacab3e24ac359410c606df6"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/upstream"

if [ -f "$DEST/mono/dis/main.c" ]; then
  echo "upstream/ already imported; remove it to re-import" >&2
  exit 0
fi

rm -rf "$DEST"
git init -q "$DEST"
cd "$DEST"
git remote add origin https://github.com/mono/mono.git
git fetch -q --depth 1 origin "$COMMIT"
git checkout -q "$COMMIT"
# Cone-mode sparse checkout: directories via `set`, root files via
# `add --skip-checks` (plain `set` rejects file paths as "not a directory").
git sparse-checkout set mono/dis mono/metadata mono/utils mono/eglib mono/sgen mono/zlib mono/cil mono/culture support/libm
git sparse-checkout add --skip-checks LICENSE PATENTS.TXT support/zlib-helper.c
test -f mono/dis/main.c
test -f LICENSE
test -f PATENTS.TXT
# Apply Turen-maintained patches; each must apply cleanly to the pinned commit.
for patch in ../patches/*.patch; do
  git apply --check "$patch"
  git apply "$patch"
done
echo "imported mono@$COMMIT into $DEST"
