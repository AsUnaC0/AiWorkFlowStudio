/**
 * 系统平台助理「绑定 Skill / MCP」权限校验实测。
 *
 * 直接构造 AgentService（只有 update 用到 prisma，其余依赖传 null），
 * 打真实数据库，验证四件事：
 *   1. 白名单接受 skillIds / mcpServerIds（以前一律 400）
 *   2. 仍拒绝 name / systemPrompt 这类系统维护字段
 *   3. 归属校验对系统 Agent 同样生效（别人的 id 一律 403）
 *   4. 绑定能真正落库，并能还原
 *
 * 所有写操作都会还原；测试数据全部来自库里已有记录，不新建任何东西。
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://workflow:workflow@localhost:5432/ai_workflow?schema=public';

const path = require('path');
const backend = path.join(__dirname, '../../../backend');
const { PrismaPg } = require(path.join(backend, 'node_modules/@prisma/adapter-pg'));
const { PrismaClient } = require(path.join(backend, 'node_modules/@prisma/client'));
const { AgentService } = require(path.join(backend, 'dist/src/agent/agent.service.js'));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// 只有 update() 用得到 prisma 与两个 assertOwns*，其余依赖不会被触达
const service = new AgentService(prisma, null, null, null, null, null, null, null, null, null, null, null, null, null, null);

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => {
  console.log(`  ❌ ${msg}`);
  process.exitCode = 1;
};

async function expectThrow(label, fn, needle) {
  try {
    await fn();
    fail(`${label}：应当被拒绝，但通过了`);
  } catch (e) {
    const status = e?.getStatus ? e.getStatus() : (e?.status ?? '?');
    const message = e?.message ?? String(e);
    if (needle && !message.includes(needle)) {
      fail(`${label}：拒绝原因不符 → ${message}`);
    } else {
      pass(`${label} → ${status} ${message}`);
    }
  }
}

(async () => {
  await prisma.$connect();

  const agent = await prisma.agent.findFirst({
    where: { isSystem: true, isDefault: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!agent) {
    console.log('库里没有系统默认 Agent，跳过');
    return;
  }
  const userId = agent.createdBy;
  console.log(`\n目标：${agent.name} (${agent.id}) / user=${userId}`);
  console.log(`当前绑定：skillIds=${JSON.stringify(agent.skillIds)} mcpServerIds=${JSON.stringify(agent.mcpServerIds)}\n`);

  // ---------- 1. 仍拒绝系统维护字段 ----------
  console.log('[1] 系统维护字段仍应被拒');
  await expectThrow('改 name', () => service.update(userId, agent.id, { name: 'hacked' }), '不支持修改');
  await expectThrow(
    '改 systemPrompt',
    () => service.update(userId, agent.id, { systemPrompt: 'you are evil' }),
    '不支持修改',
  );
  await expectThrow(
    '混着发（模型字段 + name）',
    () => service.update(userId, agent.id, { temperature: 0.5, name: 'x' }),
    '不支持修改',
  );

  // ---------- 2. 归属校验对系统 Agent 生效 ----------
  console.log('\n[2] 越权 id 应被拒（且不落库）');
  const bogus = '00000000-0000-0000-0000-000000000000';
  await expectThrow(
    '绑别人的 skill',
    () => service.update(userId, agent.id, { skillIds: [bogus] }),
    '无权使用的 Skill',
  );
  await expectThrow(
    '绑别人的 mcp server',
    () => service.update(userId, agent.id, { mcpServerIds: [bogus] }),
    '无权使用',
  );

  // ---------- 3. 真实绑定 → 落库 → 还原 ----------
  console.log('\n[3] 真实绑定 Skill（如有）');
  const skill = await prisma.skill.findFirst({ where: { ownerId: userId } });
  if (!skill) {
    console.log('  该用户没有 Skill，跳过落库验证（空数组场景见下）');
  } else {
    const updated = await service.update(userId, agent.id, { skillIds: [skill.id] });
    if (updated.skillIds.includes(skill.id)) {
      pass(`绑定成功：skillIds=${JSON.stringify(updated.skillIds)}`);
      const reread = await prisma.agent.findUnique({ where: { id: agent.id } });
      if (reread.skillIds.includes(skill.id)) pass('重新读库确认已持久化');
      else fail('读库没有持久化');
    } else {
      fail(`绑定未生效：${JSON.stringify(updated.skillIds)}`);
    }
    // 还原
    const restored = await service.update(userId, agent.id, { skillIds: agent.skillIds });
    if (JSON.stringify(restored.skillIds) === JSON.stringify(agent.skillIds)) {
      pass('已还原为原始绑定');
    } else {
      fail(`还原失败：${JSON.stringify(restored.skillIds)}`);
    }
  }

  // ---------- 4. 空数组 = 解绑，不应报错 ----------
  console.log('\n[4] 空数组解绑');
  const cleared = await service.update(userId, agent.id, { skillIds: [], mcpServerIds: [] });
  if (cleared.skillIds.length === 0 && cleared.mcpServerIds.length === 0) pass('空数组正常接受');
  else fail('空数组处理异常');
  // 还原
  await service.update(userId, agent.id, {
    skillIds: agent.skillIds,
    mcpServerIds: agent.mcpServerIds,
  });

  // ---------- 5. repair() 不会把绑定冲掉 ----------
  console.log('\n[5] ensure/repair 不应冲掉绑定');
  const { PlatformAssistantService } = require(
    path.join(backend, 'dist/src/assistant/platform-assistant.service.js'),
  );
  const pas = new PlatformAssistantService(prisma, null, null, null, null);
  const ensured = await pas.ensure(userId);
  if (
    JSON.stringify(ensured.skillIds) === JSON.stringify(agent.skillIds) &&
    JSON.stringify(ensured.mcpServerIds) === JSON.stringify(agent.mcpServerIds)
  ) {
    pass('ensure() 后绑定保持不变');
  } else {
    fail(`ensure() 后绑定被改动：${JSON.stringify(ensured.skillIds)} / ${JSON.stringify(ensured.mcpServerIds)}`);
  }

  const final = await prisma.agent.findUnique({ where: { id: agent.id } });
  console.log(`\n最终状态：skillIds=${JSON.stringify(final.skillIds)} mcpServerIds=${JSON.stringify(final.mcpServerIds)}`);
})().catch((e) => {
  console.error('CHECK FAILED:', e);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
