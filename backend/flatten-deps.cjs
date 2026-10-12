const fs = require("fs");
const path = require("path");

const root = process.cwd();
const pnpmDir = path.join(root, "node_modules", ".pnpm");
const destRoot = path.join(root, "node_modules");

let count = 0;
let skipped = 0;

if (!fs.existsSync(pnpmDir)) {
  console.log("no .pnpm dir");
  process.exit(0);
}

const pnpmEntries = fs.readdirSync(pnpmDir);
for (const entry of pnpmEntries) {
  const nm = path.join(pnpmDir, entry, "node_modules");
  if (!fs.existsSync(nm)) continue;
  const pkgs = fs.readdirSync(nm);
  for (const pkg of pkgs) {
    if (pkg === ".bin") continue;
    const src = path.join(nm, pkg);
    const dst = path.join(destRoot, pkg);
    try {
      fs.cpSync(src, dst, { recursive: true });
      count++;
    } catch (e) {
      skipped++;
      // ignore individual copy errors (existing/merge conflicts)
    }
  }
}

console.log(`flattened ${count} packages, skipped ${skipped}`);
