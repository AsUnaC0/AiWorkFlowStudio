import os, re, glob, json

ROOT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio"
SEARCH_ROOTS = [os.path.join(ROOT, "backend/src"), os.path.join(ROOT, "fronted/src"),
                os.path.join(ROOT, "backend/prisma"), os.path.join(ROOT, "desktop/src")]

files = {}
for sr in SEARCH_ROOTS:
    for p in glob.glob(os.path.join(sr, "**/*"), recursive=True):
        if os.path.isfile(p) and p.endswith((".ts", ".vue", ".less", ".prisma")):
            files.setdefault(os.path.basename(p), []).append(p)

cache = {}


def lines_of(p):
    if p not in cache:
        try:
            cache[p] = open(p, encoding="utf-8", errors="ignore").read().splitlines()
        except Exception:
            cache[p] = []
    return cache[p]


ref = re.compile(r"([A-Za-z0-9_\-]+\.(?:ts|vue|less|prisma))[`\s]*:(\d+)(?:\s*[-~/]\s*(\d+))?")
ident = re.compile(r"`([A-Za-z_][A-Za-z0-9_.]{2,})`")

rows = []
for doc in sorted(glob.glob(os.path.join(ROOT, "docs/**/*.md"), recursive=True)):
    txt = open(doc, encoding="utf-8").read().splitlines()
    for i, line in enumerate(txt):
        for m in ref.finditer(line):
            fn, a = m.group(1), int(m.group(2))
            cands = files.get(fn)
            if not cands:
                continue
            cand = max(cands, key=lambda p: len(lines_of(p)))
            ls = lines_of(cand)
            if not (0 < a <= len(ls)):
                rows.append((os.path.relpath(doc, ROOT), i + 1, fn, a, "OUT_OF_RANGE", ""))
                continue
            ids = [t.split(".")[-1] for t in ident.findall(line)]
            ids = [t for t in ids if len(t) > 3]
            if not ids:
                continue
            window = "\n".join(ls[max(0, a - 12):a + 12])
            hit = sum(1 for t in ids if t in window)
            if hit == 0:
                # try to locate the identifier anywhere in the file
                where = [n + 1 for n, l in enumerate(ls) if any(t in l for t in ids)]
                rows.append((os.path.relpath(doc, ROOT), i + 1, fn, a, "NO_IDENT_NEAR", f"ids={ids[:3]} found_at={where[:6]}"))

print("可疑行号引用 %d 处" % len(rows))
for r in rows:
    print(f"{r[0]}:{r[1]}  {r[2]}:{r[3]}  [{r[4]}]  {r[5]}")
