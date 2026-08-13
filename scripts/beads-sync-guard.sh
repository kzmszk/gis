#!/usr/bin/env sh
# Remembers whether `bd dolt push` is getting through, so a failure cannot pass
# unnoticed.
#
# The failure this guards against is not hypothetical: a cloud session filed
# three issues, pushed, was rejected as non-fast-forward, and vanished with the
# environment before anyone read the message. bd behaved correctly — it refuses
# to overwrite, exactly like git. The bug is that nobody heard it. See gis-apr.
#
# A single warning is not enough for that, because the context that would read
# it may already be gone. So the outcome is written down: pre-push escalates
# from a warning to a blocked push once the failures pile up, and a session
# start replays the state to whoever shows up next.
#
# Usage:
#   beads-sync-guard.sh success          record a push that got through
#   beads-sync-guard.sh failure <output> record a push that did not; prints the
#                                        new consecutive-failure count
#   beads-sync-guard.sh count            print the consecutive-failure count
#   beads-sync-guard.sh check            report an unsynced state on stdout
#
# State lives in .beads/push-state.json, which .beads/.gitignore already
# reserves: it is per-machine, and one clone being behind says nothing about
# another.

set -u

root=${BEADS_SYNC_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
state="$root/.beads/push-state.json"

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Reads one numeric field. A missing or unparsable file counts as zero failures:
# the guard must never turn its own corruption into a blocked push.
read_number() {
  [ -f "$state" ] || {
    printf '0'
    return
  }
  value=$(tr -d '\n' <"$state" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p")
  case "$value" in
    '' | *[!0-9]*) printf '0' ;;
    *) printf '%s' "$value" ;;
  esac
}

read_string() {
  [ -f "$state" ] || return 0
  tr -d '\n' <"$state" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# Flattens push output into something that survives being a JSON string value:
# no newlines, no quotes or backslashes to unbalance it, no unbounded growth.
json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\\"' | cut -c1-600
}

write_state() {
  mkdir -p "$root/.beads" || return 1
  cat >"$state" <<EOF
{
  "consecutive_failures": $1,
  "last_outcome": "$2",
  "last_outcome_at": "$(now)",
  "last_error": "$(json_escape "$3")"
}
EOF
}

case "${1:-}" in
  success)
    write_state 0 success ''
    ;;
  failure)
    count=$(read_number consecutive_failures)
    count=$((count + 1))
    write_state "$count" failure "${2:-}"
    printf '%s\n' "$count"
    ;;
  count)
    read_number consecutive_failures
    printf '\n'
    ;;
  check)
    count=$(read_number consecutive_failures)
    [ "$count" -gt 0 ] || exit 0
    printf 'beads: the issue database has not reached the remote.\n'
    printf 'beads: `bd dolt push` has failed %s time(s) in a row, most recently at %s.\n' \
      "$count" "$(read_string last_outcome_at)"
    error=$(read_string last_error)
    [ -n "$error" ] && printf 'beads:   %s\n' "$error"
    printf 'beads: bead changes made here are not visible anywhere else. Recover with\n'
    printf 'beads: `bd dolt pull` and then `DOLT_REMOTE_INFO_BRANCH= bd dolt push`; if the\n'
    printf 'beads: pull reports a merge conflict, stop and report it — it needs a human.\n'
    ;;
  *)
    echo >&2 "usage: beads-sync-guard.sh success|failure <output>|count|check"
    exit 2
    ;;
esac
