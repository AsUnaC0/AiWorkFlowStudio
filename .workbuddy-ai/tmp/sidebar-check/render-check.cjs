/**
 * 用真实 TDesign 样式 + 本组件的 scoped 样式渲染一份侧边栏 DOM 快照，
 * 用于无头浏览器截图核对布局（无需启动整个应用 / 登录）。
 */
const fs = require('fs');
const path = require('path');
const less = require('less');
const { compileStyle } = require('vue/compiler-sfc');

const ROOT = process.cwd();
const SFC = path.join(ROOT, 'src/views/chat/index.vue');
const OUT_DIR = 'C:/Users/meibus/AppData/Local/Temp/sidebar-check';

const SCOPE = 'data-v-test';

async function buildCss() {
  const src = fs.readFileSync(SFC, 'utf8');
  const m = src.match(/<style[^>]*lang="less"[^>]*>([\s\S]*?)<\/style>/);
  const { css } = await less.render(m[1], {
    filename: SFC,
    paths: [path.join(ROOT, 'src/styles')],
  });
  const scoped = compileStyle({
    source: css,
    filename: SFC,
    id: SCOPE,
    scoped: true,
  });
  if (scoped.errors.length) throw new Error(scoped.errors.join('\n'));

  // 全局样式（reset / 基础字体）
  const globalLess = fs.readFileSync(
    path.join(ROOT, 'src/styles/global.less'),
    'utf8',
  );
  const globalCss = await less.render(globalLess, {
    filename: path.join(ROOT, 'src/styles/global.less'),
    paths: [path.join(ROOT, 'src/styles')],
  });

  return scoped.code + '\n' + globalCss.css;
}

const agentItem = (name, desc, type, active, tag, forceDelete, collapsed) => `
<li class="t-menu__item">
  <span class="t-menu__content">
    <div class="agent-item ${active ? 'active' : ''} ${forceDelete && !collapsed ? 'force-delete' : ''}" ${SCOPE}>
      <div class="agent-avatar ${type}" ${SCOPE}><i class="t-icon">✦</i></div>
      ${
        collapsed
          ? ''
          : `<div class="agent-info" ${SCOPE}>
        <div class="agent-name" ${SCOPE}>
          <span class="agent-name-text" ${SCOPE}>${name}</span>
          ${tag ? `<span class="t-tag t-tag--variant-light t-tag--theme-primary t-size-s default-tag" ${SCOPE}>${tag}</span>` : ''}
        </div>
        <div class="agent-desc" ${SCOPE}>${desc}</div>
      </div>
      <button class="t-button t-button--variant-text t-button--shape-square t-size-s agent-delete" ${SCOPE}>✕</button>`
      }
    </div>
  </span>
</li>`;

const sessionItem = (title, time, active) => `
<li class="t-menu__item">
  <span class="t-menu__content">
    <div class="session-item ${active ? 'active' : ''}" ${SCOPE}>
      <button class="session-main" ${SCOPE}>
        <i class="t-icon session-icon" ${SCOPE}>◍</i>
        <span class="session-title" ${SCOPE}>${title}</span>
        <span class="session-time" ${SCOPE}>${time}</span>
      </button>
      <button class="t-button t-button--variant-text t-button--shape-square t-size-s session-delete" ${SCOPE}>✕</button>
    </div>
  </span>
</li>`;

function sidebar({ collapsed, id }) {
  const w = collapsed ? 64 : 260;
  return `
<div class="chat-page" id="${id}" ${SCOPE}>
  <aside class="agent-sidebar" ${SCOPE}>
    <div class="t-default-menu t-menu--light ${collapsed ? 't-is-collapsed' : ''}" style="height:100%;width:${w}px">
      <div class="t-default-menu__inner">
        <div class="t-menu__logo">
          <button class="sidebar-toggle" ${SCOPE}>${collapsed ? '›' : '‹'}</button>
        </div>
        <ul class="t-menu t-menu--scroll">
          <div class="t-menu-group">
            <div class="t-menu-group__title">
              <div class="section-header" ${SCOPE}>
                <span>我的 Agent</span>
                <button class="t-button t-button--variant-text t-size-s">+</button>
              </div>
            </div>
            ${agentItem('平台助理', '平台内置的默认助理', 'custom', true, '平台助理', false, collapsed)}
            ${agentItem('代码助手', 'general', 'general', false, '', true, collapsed)}
            ${agentItem('这是一个非常非常长的 Agent 名称用来测试省略号是否正常工作', 'knowledge', 'knowledge', false, '默认', false, collapsed)}
          </div>
          ${
            collapsed
              ? ''
              : `<div class="t-menu-group">
            <div class="t-menu-group__title">
              <div class="section-header" ${SCOPE}>
                <span>会话</span>
                <button class="t-button t-button--variant-text t-button--shape-square t-size-s">+</button>
              </div>
            </div>
            ${sessionItem('关于 RAG 检索的讨论', '10/16 12:30', true)}
            ${sessionItem('帮我写一个爬虫', '10/15 09:12', false)}
          </div>`
          }
        </ul>
      </div>
    </div>
  </aside>
  <main class="chat-main" ${SCOPE}>
    <div style="padding:24px;color:#8b8b96;font-size:13px">聊天区域</div>
  </main>
</div>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const css = await buildCss();
  fs.writeFileSync(path.join(OUT_DIR, 'sidebar.css'), css);

  const tdesign = path
    .join(ROOT, 'node_modules/tdesign-vue-next/es/style/index.css')
    .replace(/\\/g, '/');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///${tdesign}">
<link rel="stylesheet" href="./sidebar.css">
<style>body{margin:0;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  .wrap{display:flex;gap:0;height:560px}
  .box{outline:1px dashed #d0d0d8;outline-offset:-1px;height:560px;position:relative}
  .cap{font:11px system-ui;color:#999;padding:4px 8px}
  /* 仅用于截图核对：模拟 hover，把删除按钮强制显形 */
  .force-delete .agent-delete{opacity:1!important;pointer-events:auto!important}
</style></head>
<body>
<div style="display:flex">
  <div><div class="cap">展开态 (260px)</div><div class="box" style="width:260px">${sidebar({ collapsed: false, id: 'exp' })}</div></div>
  <div><div class="cap">折叠态 (64px)</div><div class="box" style="width:64px">${sidebar({ collapsed: true, id: 'col' })}</div></div>
</div>
<pre id="metrics" style="font:12px monospace"></pre>
<script>
window.addEventListener('load', function () {
  var rows = [];
  function w(el) { return el ? Math.round(el.getBoundingClientRect().width) : 'n/a'; }
  function h(el) { return el ? Math.round(el.getBoundingClientRect().height) : 'n/a'; }
  ['exp', 'col'].forEach(function (id) {
    var root = document.getElementById(id);
    var item = root.querySelector('.t-menu__item');
    var content = root.querySelector('.t-menu__item > .t-menu__content');
    var itemCs = getComputedStyle(item);
    var contentCs = getComputedStyle(content);
    var active = root.querySelector('.agent-item.active');
    rows.push([
      id,
      'menu=' + w(root.querySelector('.t-default-menu')),
      'logoH=' + h(root.querySelector('.t-menu__logo')),
      'toggleRight=' + Math.round(root.querySelector('.sidebar-toggle').getBoundingClientRect().right),
      'itemH=' + h(item),
      'itemPad=' + itemCs.paddingTop + '/' + itemCs.paddingLeft,
      'itemBg=' + itemCs.backgroundColor,
      'contentDisplay=' + contentCs.display,
      'activeBg=' + (active ? getComputedStyle(active).backgroundColor : 'n/a')
    ].join(' '));
  });
  document.getElementById('metrics').textContent = rows.join('\\n');
});
</script>
</body></html>`;

  fs.writeFileSync(path.join(OUT_DIR, 'sidebar.html'), html);
  console.log('written to', OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
