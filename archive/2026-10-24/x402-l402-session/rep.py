# Exact-string replacement: each OLD must occur exactly once in its file.
import sys
def rep(path, old, new):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    n = text.count(old)
    if n != 1:
        sys.exit(f"FAIL {path}: expected 1 match, found {n}:\n{old[:120]}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(old, new))
    print(f"ok {path}")
