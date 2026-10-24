#!/usr/bin/env bash
# usage: verifypatch.sh <patch> <snapshot-dir> <base> — apply to base in a scratch worktree; the result must equal the
# snapshot on the snapshot's paths (protocol-shelved.js excluded by design) and leave every other path untouched.
p="$1"; snap="$2"; base="$3"; cd /workspace
t=$(/tmp/claude-1000/-workspace/3f456ef9-85d8-4ab0-a2a2-eb674c6c7b0d/scratchpad/snapdiff.sh "$snap" "$base" --tree)
mapfile -t tops < <(git ls-tree --name-only $t)
tmp=$(mktemp -d); git worktree add -q --detach $tmp $base
got=$(cd $tmp && tail -n +3 "$p" | git apply --binary && git add -A && git write-tree)
git worktree remove --force $tmp
mism=$(git diff --name-only $got $t -- "${tops[@]}" ':(exclude)protocol-shelved.js' | wc -l)
outside=$(git diff --name-only $base $got | while read f; do top=${f%%/*}; printf '%s\n' "${tops[@]}" | grep -qxF "$top" || echo "$f"; done | wc -l)
[ "$mism" = 0 ] && [ "$outside" = 0 ] && echo "ok   $(basename $p)" || echo "FAIL $(basename $p): $mism mismatched, $outside outside"
