#!/usr/bin/env bash
# usage: unsaved.sh <snapshot-dir> <base>  — added/modified files (vs base) whose exact content is in NO commit on any branch.
cd /workspace; t=$(/tmp/claude-1000/-workspace/3f456ef9-85d8-4ab0-a2a2-eb674c6c7b0d/scratchpad/snapdiff.sh "$1" "$2" --tree)
mapfile -t tops < <(git ls-tree --name-only $t)
git diff --diff-filter=AM --name-only "$2" "$t" -- "${tops[@]}" | while read f; do
  blob=$(git rev-parse "$t:$f"); found=$(git log --all --since=2026-07-01 --format=%h --find-object=$blob -1)
  [ -z "$found" ] && echo "    UNSAVED $f" || echo "    saved   $f (in $found)"
done
