const fs = require('fs'), path = require('path');
const root = process.argv[2];

function walkDir(d, ext, acc = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walkDir(p, ext, acc);
    else if (f.name.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/** 一个文件里可能有多个 @Controller，按 @Controller 出现位置分段 */
function extractRoutes(file) {
  const s = fs.readFileSync(file, 'utf8');
  const idxs = [];
  const re = /@Controller\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s))) idxs.push({ at: m.index, base: m[1].replace(/['"`]/g, '').trim() });
  const out = [];
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i].at;
    const end = i + 1 < idxs.length ? idxs[i + 1].at : s.length;
    const body = s.slice(start, end);
    const base = idxs[i].base;
    for (const l of body.split('\n')) {
      const mm = l.match(/^\s*@(Get|Post|Put|Patch|Delete|All)\(([^)]*)\)/);
      if (!mm) continue;
      const p = mm[2].replace(/['"`]/g, '').trim();
      out.push({
        method: mm[1].toUpperCase(),
        path: '/' + [base, p].filter(Boolean).join('/').replace(/\/+/g, '/'),
        file: path.basename(file),
      });
    }
  }
  return out;
}

const routes = [];
for (const f of walkDir(path.join(root, 'backend/src'), '.controller.ts')) routes.push(...extractRoutes(f));

const norm = (p) => p.replace(/^\/api/, '').replace(/:[A-Za-z0-9_]+/g, ':x').replace(/\/+$/, '');
const set = new Set(routes.map((r) => norm(r.path)));

console.log('=== 代码路由总数: ' + routes.length + ' ===');

// 1) 文档里有没有漏掉的路由
const docs = walkDir(path.join(root, 'docs'), '.md').map((p) => ({ p, t: fs.readFileSync(p, 'utf8') }));
const docSet = new Set();
for (const d of docs) {
  const re2 = /\/[a-z][a-z0-9-]*(?:\/:[A-Za-z0-9_]+|\/[a-z][a-z0-9-]*)*/gi;
  for (const mm of d.t.match(re2) || []) docSet.add(norm(mm));
}
const notInDocs = routes.filter((r) => !docSet.has(norm(r.path)));
console.log('\n--- 文档中完全没出现的路由 (' + notInDocs.length + ') ---');
console.log(notInDocs.map((r) => r.method + ' ' + r.path + '  <- ' + r.file).join('\n'));

// 2) 文档里引用了但代码里没有的
const suspects = [];
for (const d of docs) {
  fs.readFileSync(d.p, 'utf8').split('\n').forEach((l, i) => {
    if (!/\b(GET|POST|PUT|PATCH|DELETE)\b/.test(l)) return;
    for (let p of l.match(/\/api\/[A-Za-z0-9_\-/:]+/g) || []) {
      p = p.replace(/[.,;:)\]]+$/, '');
      const k = norm(p);
      if (!k || k === '/') continue;
      if (!set.has(k)) suspects.push(path.relative(root, d.p) + ':' + (i + 1) + '  ' + p);
    }
  });
}
const uniq = [...new Set(suspects)];
console.log('\n--- 文档引用但代码中不存在 (' + uniq.length + ') ---');
console.log(uniq.join('\n'));
