#!/bin/sh
# The quality gate: every baseline check, run concurrently, one summary.
#
# Ordering: the Rust test run can regenerate crates/protocol/bindings with extensionless
# imports, and check-bindings.sh restores the .js suffix. The bindings check
# therefore starts only after cargo test has finished.
#
# Cargo jobs share one target-dir lock, so they queue behind each other even
# though they are started together. The TS, desktop and coherence checks run
# beside them.
#
# Usage:
#   scripts/check.sh                 # the full gate
#   scripts/check.sh --fast          # skip cargo test and the server suite
#   scripts/check.sh --only <name>   # one check
#
# Check names: cargo-test server-test desktop-test clippy windows bindings
#              coherence
set -u

cd "$(dirname "$0")/.."

FAST=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --only)
      [ $# -ge 2 ] || { echo "check.sh: --only needs a check name" >&2; exit 2; }
      ONLY=$2
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "check.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

ALL_CHECKS="cargo-test server-test desktop-test clippy windows bindings coherence"

# 2 means SKIP: the check could not run on this host, which is not a failure.
check_cargo_test() { cargo nextest run --workspace; }
check_server_test() { npm test --workspace apps/server; }
check_desktop_test() { cd apps/desktop && npm test; }
check_clippy() { cargo clippy --workspace --all-targets -- -D warnings; }
check_windows() { ./scripts/check-windows.sh; }
check_bindings() { ./scripts/check-bindings.sh; }
check_coherence() { npm run coherence; }

now_ns() { date +%s%N; }

GATE_START=$(now_ns)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# Start one check in the background. The subshell records the exit code and
# the start/end time, so the parent only waits and reports.
start_job() {
  name=$1
  (
    start=$(now_ns)
    "check_$(echo "$name" | tr '-' '_')" >"$TMP/$name.log" 2>&1
    rc=$?
    end=$(now_ns)
    echo "$rc $start $end" >"$TMP/$name.res"
  ) &
  echo $! >"$TMP/$name.pid"
}

wait_job() {
  name=$1
  pid=$(cat "$TMP/$name.pid" 2>/dev/null) || return 0
  wait "$pid" 2>/dev/null || true
}

elapsed() {
  # $1 start ns, $2 end ns -> seconds with milliseconds
  ms=$(( ($2 - $1) / 1000000 ))
  printf '%d.%03d' $((ms / 1000)) $((ms % 1000))
}

FAILED=0
SKIPPED=0
RAN=""

case " $ALL_CHECKS " in
  *" $ONLY "*) ;;
  *)
    if [ -n "$ONLY" ]; then
      echo "check.sh: unknown check: $ONLY" >&2
      echo "checks: $ALL_CHECKS" >&2
      exit 2
    fi
    ;;
esac

if [ -n "$ONLY" ]; then
  start_job "$ONLY"
  wait_job "$ONLY"
  RAN=$ONLY
else
  for name in $ALL_CHECKS; do
    case "$name" in
      cargo-test) [ "$FAST" -eq 1 ] && continue ;;
      server-test) [ "$FAST" -eq 1 ] && continue ;;
      bindings) continue ;;
    esac
    start_job "$name"
  done

  if [ "$FAST" -eq 0 ]; then
    # Bindings must not race the bindings rewrite that cargo test performs.
    wait_job cargo-test
  fi
  start_job bindings

  for name in $ALL_CHECKS; do
    case "$name" in
      cargo-test|server-test) [ "$FAST" -eq 1 ] && continue ;;
    esac
    wait_job "$name"
  done

  RAN=$ALL_CHECKS
  [ "$FAST" -eq 1 ] && RAN="desktop-test clippy windows bindings coherence"
fi

for name in $RAN; do
  res="$TMP/$name.res"
  if [ ! -f "$res" ]; then
    printf '%-14s FAIL  (no result)\n' "$name"
    FAILED=$((FAILED + 1))
    continue
  fi
  read -r rc start end <"$res"
  secs=$(elapsed "$start" "$end")
  if [ "$rc" -eq 0 ]; then
    printf '%-14s PASS  %ss\n' "$name" "$secs"
  elif [ "$rc" -eq 2 ]; then
    printf '%-14s SKIP  %ss\n' "$name" "$secs"
    SKIPPED=$((SKIPPED + 1))
  else
    printf '%-14s FAIL  %ss\n' "$name" "$secs"
    FAILED=$((FAILED + 1))
    echo "--- $name output (tail) ---"
    tail -n 20 "$TMP/$name.log"
    echo "--- end $name ---"
  fi
done

echo
GATE_END=$(now_ns)
TOTAL=$(elapsed "$GATE_START" "$GATE_END")
if [ "$FAILED" -ne 0 ]; then
  echo "FAIL: $FAILED check(s) failed, $SKIPPED skipped in ${TOTAL}s"
  exit 1
fi
echo "PASS: all checks passed ($SKIPPED skipped) in ${TOTAL}s"
