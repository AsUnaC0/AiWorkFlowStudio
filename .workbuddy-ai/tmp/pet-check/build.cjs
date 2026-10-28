/**
 * 桌宠渲染进程的静态预览构建器。
 *
 * 用途：只改前端样式/布局时，不想真开 Electron，就用真实 style.css + 真实 DOM 快照
 * 生成一张静态页，交给本机 Chrome 无头截图，肉眼确认「语音开关」这类小控件的位置。
 *
 * 注意：必须去掉 index.html 里的 CSP meta —— 预览页要注入 window.pet 桩脚本，
 * 内联脚本会被 `default-src 'self'` 拦掉。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const src = path.join(root, 'desktop/src/renderer');
const out = path.join(__dirname, 'preview.html');

const cssHref = 'file:///' + path.join(src, 'style.css').replace(/\\/g, '/');
const petJs = 'file:///' + path.join(src, 'pet.js').replace(/\\/g, '/');

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

// 去掉 CSP，允许内联桩脚本
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
html = html.replace('href="style.css"', `href="${cssHref}"`);

const stub = `
<script>
  // 模拟已登录 + 语音开启，用来确认右上角语音浮标的可见性
  window.pet = {
    getState: async () => ({
      baseUrl: 'http://localhost:3000',
      email: 'me@example.com',
      loggedIn: true,
      displayName: '小蝶',
      clickThrough: true,
      voiceEnabled: window.__VOICE__ !== false,
      voiceId: 'zh-CN-XiaoyiNeural',
      assistant: { persona: { desktopPetEnabled: true, voiceId: 'zh-CN-XiaoyiNeural' } },
    }),
    onChatEvent: () => () => {},
    onVoiceState: () => () => {},
    speak: async () => ({ ok: false }),
    setVoice: () => {},
    saveSettings: async () => ({}),
    setIgnoreMouse: () => {},
    dragStart: () => {},
    dragMove: () => {},
    dragEnd: () => {},
    focusInput: () => {},
    hide: () => {},
    quit: () => {},
    openExternal: () => {},
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    refreshAssistant: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
  };
</script>
`;

html = html.replace('<script src="pet.js"></script>', stub + `<script src="${petJs}"></script>`);

// 无头模式的布局视口不等于 --window-size，直接锁成真实窗口尺寸（340×480）。
// body 必须 position:relative —— 否则 .panel 这类 absolute 元素会以「视口」为包含块，
// 在无头环境里视口比 340 宽，面板会被拉宽、右侧内容被裁掉（真实窗口里不会）。
html = html.replace(
  '</head>',
  '<style>html,body{width:340px;height:480px;overflow:hidden}body{position:relative}</style></head>',
);

// 把关键元素的几何信息打在页面上，截图就能看到（无头模式拿不到 console）
const probe = `
<script>
  setTimeout(() => {
    // pet.js 是普通脚本，函数声明挂在全局，可以直接调
    if (location.hash === '#panel' && typeof openPanel === 'function') openPanel();
    if (location.hash === '#muted' && typeof setVoiceUI === 'function') setVoiceUI(false);
    const el = document.getElementById('voiceBtn');
    const box = document.createElement('pre');
    box.style.cssText =
      'position:fixed;left:0;bottom:0;z-index:9999;margin:0;padding:4px;' +
      'font:11px/1.4 monospace;background:#ffe;color:#333;';
    if (!el) {
      box.textContent = 'voiceBtn: NOT FOUND';
    } else {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      box.textContent =
        'hidden=' + el.hidden +
        ' display=' + cs.display +
        ' opacity=' + cs.opacity +
        ' z=' + cs.zIndex +
        ' rect=' + [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    }
    document.body.appendChild(box);
  }, 900);
</script>
`;

html = html.replace('</body>', probe + '</body>');

fs.writeFileSync(out, html, 'utf8');
console.log('written', out);
