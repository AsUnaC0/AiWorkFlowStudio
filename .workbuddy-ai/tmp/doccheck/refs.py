import os, re, glob, sys

ROOT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio"
SEARCH_ROOTS = [os.path.join(ROOT, "backend/src"), os.path.join(ROOT, "fronted/src"),
                os.path.join(ROOT, "backend/prisma"), os.path.join(ROOT, "desktop/src")]
files = {}
for sr in SEARCH_ROOTS:
    for p in glob.glob(os.path.join(sr, "**/*"), recursive=True):
        if os.path.isfile(p):
            files.setdefault(os.path.basename(p), []).append(p)


def readlines(p):
    try:
        return open(p, encoding="utf-8", errors="ignore").read().splitlines()
    except Exception:
        return []


pat = re.compile(r"([A-Za-z0-9_\-]+\.(?:ts|vue|less|prisma))[`\s]*:(\d+)(?:\s*[-~]\s*(\d+))?")
targets = sys.argv[1:] or ["docs/教程/06-前端业务与端到端链路.md", "docs/教程/07-后端知识库与RAG.md"]
for rel in targets:
    doc = os.path.join(ROOT, rel)
    txt = open(doc, encoding="utf-8").read()
    print("=" * 100)
    print(rel)
    for m in pat.finditer(txt):
        fn, a, b = m.group(1), int(m.group(2)), m.group(3)
        cands = files.get(fn)
        if not cands:
            print(f"  [NOFILE] {fn}:{a}")
            continue
        cand = max(cands, key=lambda p: len(readlines(p)))
        ls = readlines(cand)
        line = ls[a - 1].strip() if 0 < a <= len(ls) else "<<OUT OF RANGE>>"
        ctx_start = max(0, txt.rfind("\n", 0, m.start()) - 80)
        ctx = txt[ctx_start:m.start()].replace("\n", " ")[-90:]
        print(f"  {fn}:{a}{'-'+b if b else ''} -> {line[:110]}")
        print(f"      上下文: ...{ctx}")
