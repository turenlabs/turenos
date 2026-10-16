#!/bin/sh
# Start Bun without inherited credentials or runtime startup controls.
set -eu
bun=$1
mode=$2
shift 2
case "$bun" in /*) ;; *) exit 64 ;; esac
test -x "$bun"
case "$mode" in runtime|service) ;; *) exit 64 ;; esac
exec /usr/bin/env -i PATH="${bun%/*}:/usr/bin:/bin" NODE_ENV=test FORGE_WORKLOAD_LAUNCHED=1 \
  "$bun" run "${0%/*}/team-output-$mode-workload.ts" "$@"
