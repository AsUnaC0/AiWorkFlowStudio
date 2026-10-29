import os, re, glob, urllib.parse

ROOT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio/docs"
pat = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
bad = []
for p in glob.glob(os.path.join(ROOT, "**/*.md"), recursive=True):
    txt = open(p, encoding="utf-8").read()
    for m in pat.finditer(txt):
        link = m.group(1).strip()
        if link.startswith(("http://", "https://", "#", "mailto:")):
            continue
        target = link.split("#")[0]
        if not target:
            continue
        target = urllib.parse.unquote(target)
        full = os.path.normpath(os.path.join(os.path.dirname(p), target))
        if not os.path.exists(full):
            bad.append((os.path.relpath(p, ROOT), link))
print("断链:", len(bad))
for r in bad:
    print("  ", r[0], "->", r[1])
