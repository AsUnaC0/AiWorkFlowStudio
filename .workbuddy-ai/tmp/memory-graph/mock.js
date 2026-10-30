// 贴近真实规则的数据：语义相似度 ≥0.75 才连线，每点最多 4 条
// → 表现为「簇内短连线为主 + 少量跨类长线」
export function makeMockData() {
  const cats = [
    ["PREFERENCE", 46],
    ["FACT", 62],
    ["TASK", 34],
    ["EVENT", 28],
    ["EMOTION", 18],
    ["OTHER", 12],
  ];
  let seed = 20261030;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const nodes = [];
  cats.forEach(([category, count]) => {
    const topics = Math.max(1, Math.round(count / 11));
    for (let i = 0; i < count; i++) {
      const r = rnd();
      const importance = Math.min(1, 0.18 + Math.pow(r, 2.1) * 0.82);
      nodes.push({
        id: `${category}-${i}`,
        category,
        topic: `${category}-t${i % topics}`,
        summary: "示例记忆摘要内容",
        importance,
        degree: 0,
        createdAt: new Date().toISOString(),
      });
    }
  });

  const links = [];
  const seen = new Set();
  const degree = new Map();
  const add = (a, b, w) => {
    if (a === b) return;
    if ((degree.get(a) ?? 0) >= 4 || (degree.get(b) ?? 0) >= 4) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    links.push({ source: a, target: b, weight: w });
  };

  // 簇内连线：同一 topic 的节点互相连（语义相近）
  const byTopic = new Map();
  nodes.forEach((n) => {
    if (!byTopic.has(n.topic)) byTopic.set(n.topic, []);
    byTopic.get(n.topic).push(n);
  });
  byTopic.forEach((group) => {
    group.forEach((n, i) => {
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const m = group[(i + 1 + Math.floor(rnd() * (group.length - 1))) % group.length];
        if (m) add(n.id, m.id, 0.75 + rnd() * 0.23);
      }
    });
  });

  // 少量跨类长线（真正语义相近的少数）
  nodes.forEach((n) => {
    if (rnd() > 0.12) return;
    const m = nodes[Math.floor(rnd() * nodes.length)];
    add(n.id, m.id, 0.75 + rnd() * 0.15);
  });

  nodes.forEach((n) => (n.degree = degree.get(n.id) ?? 0));
  return { nodes, links };
}
