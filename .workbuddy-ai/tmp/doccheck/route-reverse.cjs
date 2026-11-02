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
const routes = new Set();
for (const f of walkDir(path.join(root, 'backend/src'), '.controller.ts')) {
  const s = fs.readFileSync(f, 'utf8');
  const cm = s.match(/@Controller\(([^)]*)\)/);
  const base = cm ? (cm[1].replace(/['"`]/g, '').trim() || '') : '';
  for (const l of s.split('\n')) {
    const m = l.match(/^\s*@(Get|Post|Put|Patch|Delete|All)\(([^)]*)\)/);
    if (!m) continue;
    const p = m[2].replace(/['"`]/g, '').trim();
    routes.add('/' + [base, p].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/:[A-Za-z0-9_]+/g, ':x'));
  }
}
const norm = (p) => p.replace(/^\/api/, '').replace(/:[A-Za-z0-9_]+/g, ':x').replace(/\/+$/, '');
const suspects = [];
for (const d of walkDir(path.join(root, 'docs'), '.md')) {
  const lines = fs.readFileSync(d, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/\b(GET|POST|PUT|PATCH|DELETE)\b/.test(l)) return;
    const paths = l.match(/\/api\/[A-Za-z0-9_\-/:]+/g) || [];
    for (let p of paths) {
      p = p.replace(/[.,;:)\]]+$/, '');
      const k = norm(p);
      if (!k || k === '/') continue;
      if (!routes.has(k)) suspects.push(path.relative(root, d) + ':' + (i + 1) + '  ' + p);
    }
  });
}
console.log('疑似不存在的接口引用 (' + new Set(suspects).size + ')：');
console.log([...new Set(suspects)].join('\n'));
