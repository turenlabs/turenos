#!/bin/sh
# Import the pinned Mandiant capa-rules ruleset for the capa-match WASM target.
#
# capa-rules is a data dependency, not code: the YAML rule files are compiled
# into a compact normalized blob by build.rs and embedded into the module via
# include_bytes!. The vendored tree lives at tools/capa-match/upstream/capa-rules
# and is gitignored; this script is the only supported way to populate it.
set -eu

COMMIT="805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/upstream/capa-rules"

if [ -d "$DEST/lib" ]; then
  echo "upstream/ already imported; remove it to re-import" >&2
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
git init -q "$DEST"
cd "$DEST"
git remote add origin https://github.com/mandiant/capa-rules.git
git fetch -q --depth 1 origin "$COMMIT"
git checkout -q "$COMMIT"
# Rule files live under namespace directories at the repository root; every
# *.yml file at any depth is a rule. Keep documentation and the license for
# provenance, drop CI/tooling that is irrelevant to the blob.
test -f LICENSE.txt
test -f lib/delay-execution.yml
test -d host-interaction
test -d nursery
echo "imported capa-rules@$COMMIT into $DEST"
find . -name '*.yml' -not -path './.github/*' | wc -l | tr -d ' ' | xargs echo "rule files:"
