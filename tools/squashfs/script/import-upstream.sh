#!/bin/sh
# Import the pinned backhand source for the squashfs WASM target.
#
# backhand is a Cargo path dependency at tools/squashfs/upstream/backhand:
# a crates.io dependency cannot carry the maintained wasm32 patch, and the
# crate uses `license.workspace = true`, so the workspace root manifest and
# licenses must be vendored beside it.
set -eu

COMMIT="eccf81b6f599cb90245d7c9694e95ee6023cad06"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/upstream"

if [ -f "$DEST/backhand/src/lib.rs" ]; then
  echo "upstream/ already imported; remove it to re-import" >&2
  exit 0
fi

rm -rf "$DEST"
git init -q "$DEST"
cd "$DEST"
git remote add origin https://github.com/wcampbell0x2a/backhand.git
git fetch -q --depth 1 origin "$COMMIT"
git checkout -q "$COMMIT"
# The workspace members must exist for the vendored root manifest to resolve;
# only `backhand` itself is compiled into the module.
git sparse-checkout set backhand backhand-cli backhand-test
git sparse-checkout add --skip-checks Cargo.toml LICENSE-APACHE LICENSE-MIT CHANGELOG.md
test -f backhand/src/lib.rs
test -f Cargo.toml
test -f LICENSE-APACHE
test -f LICENSE-MIT
# Apply Turen-maintained patches; each must apply cleanly to the pinned commit.
for patch in ../patches/*.patch; do
  git apply --check "$patch"
  git apply "$patch"
done
echo "imported backhand@$COMMIT into $DEST"
