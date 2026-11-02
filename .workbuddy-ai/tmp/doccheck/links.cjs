const fs = require('fs'), path = require('path');
const root = process.argv[2];

function walkMd(d, acc = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walkMd(p, acc);
    else if (f.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

const files = walkMd(path.join(root, 'docs'));
const bad = [];
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  lines.forEach((line, i) => {
    // markdown 链接 [text](target)
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(line))) {
      let t = m[1];
      if (/^(https?:|mailto:|#)/.test(t)) continue;
      const anchor = t.indexOf('#');
      if (anchor >= 0) t = t.slice(0, anchor);
      if (!t) continue;
      let decoded = t;
      try { decoded = decodeURIComponent(t); } catch (e) { /* keep */ }
      const target = path.resolve(path.dirname(f), decoded);
      if (!fs.existsSync(target)) {
        bad.push(path.relative(root, f) + ':' + (i + 1) + '  ->  ' + m[1]);
      }
    }
  });
}
console.log('=== 失效的相对链接 (' + bad.length + ') ===');
console.log(bad.join('\n'));
