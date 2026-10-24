#!/usr/bin/env bash
# usage: mkpatch.sh <snapshot-dir> <base> <out.patch>  — exact diff base→snapshot (snapshot's top-level paths),
# minus protocol-shelved.js (companion code; kept on the companion branch). Header records the base.
snap="$1"; base="$2"; out="$3"; cd /workspace
t=$(/tmp/claude-1000/-workspace/3f456ef9-85d8-4ab0-a2a2-eb674c6c7b0d/scratchpad/snapdiff.sh "$snap" "$base" --tree)
mapfile -t tops < <(git ls-tree --name-only $t)
{ echo "# base: $(git rev-parse $base) ($(git log -1 --format='%cs %s' $base | cut -c1-70))"
  echo "# apply: git switch -c <name> ${base} && git apply --binary <this file>"
  git diff --binary "$base" "$t" -- "${tops[@]}" ':(exclude)protocol-shelved.js'; } > "$out"
echo "$(basename $out): $(grep -c '^diff --git' $out) files"
