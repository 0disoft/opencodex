#!/usr/bin/env bash
# Scratch diagnostic for #4956: loop the shard 1/4 batch 5 composition and capture
# process state when the Bun test process stalls. Not for merge.
set -uo pipefail

ITERATIONS="${REPRO_ITERATIONS:-40}"
STALL_SECONDS="${REPRO_STALL_SECONDS:-40}"
BUN_BIN="${REPRO_BUN:-bun}"
OUT="${REPRO_OUT:-repro-out}"
mkdir -p "$OUT"

FILES=(
  tests/ci-workflows/compatibility-version.test.ts
  tests/ci-workflows/docs-gui-screenshot-policy.test.ts
  tests/ci-workflows/docs-link-targets.test.ts
  tests/ci-workflows/exhaustive-deps-suppression.test.ts
  tests/ci-workflows/linux-desktop-packaged-ci.test.ts
  tests/ci-workflows/macos-serial-lanes.test.ts
  tests/ci-workflows/package-tree-integrity.test.ts
  tests/ci-workflows/package-tree-restart-ownership.test.ts
  tests/ci-workflows/release-notes.test.ts
  tests/ci-workflows/release-outcome-report.test.ts
  tests/ci-workflows/release-version-sources.test.ts
  tests/ci-workflows/repo-hygiene.test.ts
)
if [[ -n "${REPRO_FILES:-}" ]]; then read -r -a FILES <<<"$REPRO_FILES"; fi

descendants() {
  local all="$1" frontier="$1" next p c
  while [[ -n "$frontier" ]]; do
    next=""
    for p in $frontier; do
      for c in $(ps -o pid= --ppid "$p" 2>/dev/null); do next+=" $c"; done
    done
    all+="$next"; frontier="$next"
  done
  echo "$all"
}

dump() {
  local bunpid="$1" tag="$2" f="$OUT/stall-$2.txt" p fd t n tgt
  {
    echo "=== stall $tag bun pid $bunpid at $(date -u +%FT%TZ)"
    echo "--- process forest"
    ps -eo pid,ppid,pgid,sid,stat,wchan:32,etimes,args --forest | cut -c1-240
    echo "--- descendants of bun"
    for p in $(descendants "$bunpid"); do
      echo "## pid $p"; grep -E '^(Name|State|PPid|Threads|SigCgt|SigBlk|SigIgn)' "/proc/$p/status" 2>&1
      tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-240; echo
      echo "wchan: $(cat /proc/$p/wchan 2>/dev/null)"
      sudo cat "/proc/$p/stack" 2>&1 | head -20
    done
    echo "--- bun threads"
    for t in /proc/$bunpid/task/*; do
      echo "## tid $(basename "$t") $(cat "$t/comm") state=$(awk '{print $3}' "$t/stat") wchan=$(cat "$t/wchan")"
      sudo cat "$t/stack" 2>&1 | head -12
    done
    echo "--- bun fds"
    for fd in /proc/$bunpid/fd/*; do
      n=$(basename "$fd"); tgt=$(readlink "$fd")
      echo "fd $n -> $tgt"
      case "$tgt" in
        anon_inode:*|pipe:*|socket:*) sed 's/^/    /' "/proc/$bunpid/fdinfo/$n" 2>/dev/null ;;
      esac
    done
    echo "--- gdb"
    sudo timeout 90 gdb -p "$bunpid" -batch -ex 'info threads' -ex 'thread apply all bt 40' 2>&1 | grep -v '^\[New LWP' | head -500
  } > "$f" 2>&1
  echo "::warning::stall captured in $f"
}

stalls=0
for i in $(seq 1 "$ITERATIONS"); do
  log="$OUT/run-$i.log"
  start=$(date +%s)
  "$BUN_BIN" test --isolate --timeout 60000 "${FILES[@]}" > "$log" 2>&1 &
  pid=$!
  dumped=0
  while kill -0 "$pid" 2>/dev/null; do
    now=$(date +%s)
    if (( now - start >= STALL_SECONDS && dumped == 0 )); then
      dumped=1; stalls=$((stalls + 1))
      tail -5 "$log" | sed 's/^/  log: /'
      dump "$pid" "$i"
      kill -KILL $(descendants "$pid") 2>/dev/null
    fi
    sleep 1
  done
  wait "$pid"; status=$?
  echo "iteration $i status=$status seconds=$(( $(date +%s) - start )) stalled=$dumped"
  if (( dumped == 0 )); then rm -f "$log"; fi
done
echo "stalls=$stalls of $ITERATIONS"
echo "stalls=$stalls" >> "$OUT/summary.txt"

