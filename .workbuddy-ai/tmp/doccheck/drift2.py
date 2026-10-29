import os, re, glob

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


ref = re.compile(r"([A-Za-z0-9_\-./]+\.(?:ts|vue|less|prisma))[`\s]*:(\d+)(?:\s*[-~/]\s*(\d+))?")
ident = re.compile(r"`([A-Za-z_][A-Za-z0-9_.]{2,})`")

out = []
for doc in sorted(glob.glob(os.path.join(ROOT, "docs/**/*.md"), recursive=True)):
    dl = open(doc, encoding="utf-8").read().splitlines()
    for i, line in enumerate(dl):
        for m in ref.finditer(line):
            fn, a = m.group(1), int(m.group(2))
            base = os.path.basename(fn)
            cands = files.get(base)
            if not cands:
                continue
            # narrow by path suffix if the doc gives a directory
            if "/" in fn:
                suffix = fn.replace("\\", "/")
                narrowed = [c for c in cands if c.replace("\\", "/").endswith(suffix)]
                if narrowed:
                    cands = narrowed
            ids = [t.split(".")[-1] for t in ident.findall(line)]
            ids = [t for t in ids if len(t) > 3 and not t.endswith(".md")]

            best = None
            for c in cands:
                ls = lines_of(c)
                if not (0 < a <= len(ls)):
                    continue
                window = "\n".join(ls[max(0, a - 12):a + 12])
                hit = sum(1 for t in ids if t in window)
                if best is None or hit > best[0]:
                    best = (hit, c, ls)
            if best is None:
                out.append((os.path.relpath(doc, ROOT), i + 1, fn, a, "OUT_OF_RANGE", ""))
                continue
            if not ids:
                continue
            hit, c, ls = best
            if hit == 0:
                where = [n + 1 for n, l in enumerate(ls) if any(t in l for t in ids)]
                out.append((os.path.relpath(doc, ROOT), i + 1, fn, a,
                            "NO_IDENT_NEAR", f"{os.path.basename(c)} ids={ids[:3]} at={where[:5]}"))

print("可疑 %d 处" % len(out))
for r in out:
    print(f"{r[0]}:{r[1]}  {r[2]}:{r[3]}  [{r[4]}] {r[5]}")
