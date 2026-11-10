#!/bin/bash
# Python and TypeScript on one local root, each way round: one SDK seeds a root (logs, a view,
# a feed cursor, recipes, a transaction), the other checks that everything is as it would have
# left it, changes things, and the first verifies. Needs python3, node >= 22.18 and duckdb.
#
#     ./interop/run.sh        (prints PROBLEMS: 0 when the two agree)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"; rm -rf "$out"; mkdir -p "$out"
for seeder in py ts; do
  if [ "$seeder" = py ]; then changer=ts; else changer=py; fi
  root="$(mktemp -d "${TMPDIR:-/tmp}/archil-interop-$seeder-XXXXXX")"
  run() { # run <sdk> <step> <outfile> [args]
    if [ "$1" = py ]; then python3 "$here/side.py" "$root" "$2" "$3" "${@:4}"; else node "$here/side.ts" "$root" "$2" "$3" "${@:4}"; fi
  }
  run $seeder seed "$out/$seeder-seed-$seeder.json"
  run $changer check-and-change "$out/$seeder-check-$changer.json" "$out/$seeder-lock.json"
  run $seeder verify "$out/$seeder-verify-$seeder.json" "$out/$seeder-lock.json"
done
python3 "$here/compare.py" "$out"
