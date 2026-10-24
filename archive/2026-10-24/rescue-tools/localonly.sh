#!/usr/bin/env bash
# usage: localonly.sh <repo> <ls-remote file>  — commits on local branches that no remote ref contains
cd "$1"; R="$2"
KNOWN=$(awk '{print $1}' "$R" | sort -u | while read s; do git cat-file -e "$s^{commit}" 2>/dev/null && echo "^$s"; done)
git for-each-ref --format='%(refname:short) %(objectname)' refs/heads | while read b sha; do
  n=$(git rev-list --count "$sha" $KNOWN)
  [ "$n" -gt 0 ] && printf "%-34s %3s local-only  (tip %s)\n" "$b" "$n" "$(git log -1 --format='%h %cs %s' "$sha" | cut -c1-80)"
done
true
