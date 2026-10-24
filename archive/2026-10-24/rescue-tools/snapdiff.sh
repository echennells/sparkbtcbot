#!/usr/bin/env bash
# usage: snapdiff.sh <snapshot-dir> <base-commit> [--tree]  — diffstat of the snapshot vs base,
# limited to the snapshot's top-level paths; --tree prints only the snapshot's tree id.
snap="$1"; base="$2"; cd /workspace
idx=$(mktemp); rm -f $idx
( cd "$snap" && GIT_INDEX_FILE=$idx GIT_DIR=/workspace/.git git -c core.excludesFile=/workspace/.gitignore --work-tree="$snap" add -A -- . ':!**/node_modules/**' ':!node_modules' 2>/dev/null )
t=$(GIT_INDEX_FILE=$idx git write-tree); rm -f $idx
[ "$3" = "--tree" ] && { echo $t; exit; }
mapfile -t tops < <(git ls-tree --name-only $t)
git diff --stat=110 "$base" "$t" -- "${tops[@]}"
