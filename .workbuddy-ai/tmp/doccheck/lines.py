import os, re, glob

ROOT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio"
SEARCH_ROOTS = [os.path.join(ROOT, "backend/src"), os.path.join(ROOT, "fronted/src"), os.path.join(ROOT, "backend/prisma"), os.path.join(ROOT, "desktop/src")]
files = {}
for sr in SEARCH_ROOTS:
    for p in glob.glob(os.path.join(sr, "**/*"), recursive=True):
        if os.path.isfile(p):
            files.setdefault(os.path.basename(p), []).append(p)

def lines_of(p):
    try:
        return sum(1 for _ in open(p, encoding="utf-8", errors="ignore"))
    except Exception:
        return 0

pat = re.compile(r"([A-Za-z0-9_\-]+\.(?:ts|vue|less|prisma|json))[`\s]*:(\d+)(?:\s*[-~]\s*(\d+))?")
bad = []
unknown = []
for doc in sorted(glob.glob(os.path.join(ROOT, "docs/**/*.md"), recursive=True)):
    txt = open(doc, encoding="utf-8").read()
    for m in pat.finditer(txt):
        fn, a, b = m.group(1), int(m.group(2)), m.group(3)
        cands = files.get(fn)
        if not cands:
            unknown.append((os.path.relpath(doc, ROOT), fn, a))
            continue
        # pick the longest candidate (most likely the real one)
        cand = max(cands, key=lines_of)
        n = lines_of(cand)
        hi = int(b) if b else a
        if hi > n:
            bad.append((os.path.relpath(doc, ROOT), fn, a, b, n))

print("=== 引用的行号超出文件实际行数 (%d) ===" % len(bad))
for r in bad:
    print(f"  {r[0]}: {r[1]}:{r[2]}{'-'+r[3] if r[3] else ''}  (实际仅 {r[4]} 行)")

print("\n=== 找不到对应源文件的引用 (%d) ===" % len(unknown))
seen = set()
for r in unknown:
    k = (r[0], r[1])
    if k in seen:
        continue
    seen.add(k)
    print(f"  {r[0]}: {r[1]}:{r[2]}")
