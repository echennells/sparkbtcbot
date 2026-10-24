#!/usr/bin/env bash
# usage: snapmatch.sh <snapshot-dir>  — hash the snapshot (repo .gitignore rules, no node_modules) into a
# tree, then report the closest commits by changed-file count, comparing only the snapshot's top-level paths.
snap="$1"; cd /workspace
idx=$(mktemp); rm -f $idx
( cd "$snap" && GIT_INDEX_FILE=$idx GIT_DIR=/workspace/.git git -c core.excludesFile=/workspace/.gitignore --work-tree="$snap" add -A -- . ':!**/node_modules/**' ':!node_modules' 2>/dev/null )
t=$(GIT_INDEX_FILE=$idx git write-tree); rm -f $idx
mapfile -t tops < <(git ls-tree --name-only $t)
for c in $(git rev-list --since=2026-09-15 --all); do
  n=$(git diff --name-only $c $t -- "${tops[@]}" | wc -l); echo "$n $c"
done | sort -n | head -2 | while read n c; do echo "$(basename $snap) $t $n $c $(git log -1 --format='%cs %s' $c | cut -c1-60)"; done
