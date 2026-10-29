import os, re, json, sys, glob

ROOT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio"
SRC = os.path.join(ROOT, "backend/src")
DOCS = os.path.join(ROOT, "docs")

routes = []  # (method, path, file)

dec_re = re.compile(r"^\s*@(Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)'|\"([^\"]*)\")?\s*\)")
ctrl_re = re.compile(r"^\s*@Controller\(\s*(?:'([^']*)'|\"([^\"]*)\")?\s*\)")

for dirpath, _, files in os.walk(SRC):
    for fn in files:
        if not fn.endswith(".ts") or fn.endswith(".spec.ts"):
            continue
        p = os.path.join(dirpath, fn)
        txt = open(p, encoding="utf-8").read()
        if "@Controller(" not in txt:
            continue
        prefix = ""
        for line in txt.splitlines():
            mc = ctrl_re.match(line)
            if mc:
                prefix = mc.group(1) if mc.group(1) is not None else (mc.group(2) or "")
                continue
            m = dec_re.match(line)
            if m:
                method = m.group(1).upper()
                seg = m.group(2) if m.group(2) is not None else (m.group(3) or "")
                full = "/" + "/".join(x for x in [prefix, seg] if x)
                full = re.sub(r"//+", "/", full).rstrip("/") or "/"
                routes.append((method, full, os.path.relpath(p, SRC).replace("\\", "/")))

def norm_path(s):
    s = s.strip()
    s = re.sub(r"^https?://[^/]+", "", s)
    s = re.sub(r"^/api(?=/|$)", "", s)
    s = s.split("?")[0].split("#")[0]
    s = s.rstrip("/.,)`）】。、；;：:")
    s = re.sub(r"//+", "/", s)
    return s

def key(method, path):
    p = norm_path(path).lower()
    p = re.sub(r":[a-z0-9_]+", ":", p)
    p = re.sub(r"\{[^}]*\}", ":", p)
    return method.upper() + " " + p

route_keys = {}
for m, p, f in routes:
    route_keys.setdefault(key(m, p), []).append((m, p, f))

doc_text = {}
for p in glob.glob(os.path.join(DOCS, "**/*.md"), recursive=True):
    doc_text[p] = open(p, encoding="utf-8").read()

# extract documented endpoints
doc_hits = {}
pat = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE|ALL)\s+`?(/api)?(/[A-Za-z0-9_\-:/{}\*\.]+)")
for p, txt in doc_text.items():
    for m in pat.finditer(txt):
        method = m.group(1)
        path = m.group(3)
        doc_hits.setdefault(key(method, path), set()).add(os.path.relpath(p, DOCS).replace("\\", "/"))

print("实际路由数:", len(routes))
missing = []
for k, v in sorted(route_keys.items()):
    if k not in doc_hits:
        missing.append(v[0])
print("\n=== 文档中从未出现的接口 (%d) ===" % len(missing))
for m, p, f in sorted(missing, key=lambda x: x[2]):
    print(f"  {m:6} {p:55} {f}")

# documented but no matching route (potential stale docs) - only report those that look like real endpoints
extra = []
for k, files in sorted(doc_hits.items()):
    if k not in route_keys:
        extra.append((k, sorted(files)))
print("\n=== 文档中出现但代码里没有的接口 (%d) ===" % len(extra))
for k, files in extra:
    print(f"  {k:60} {', '.join(files)}")
