#!/bin/sh
# Run one of the plugin's hooks, or say nothing.
# A hook must never get in the way of the work: without Node there is nothing to run, and that is fine.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(dirname "$0")/../scripts/hook.mjs" "$@"
