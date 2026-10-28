/**
 * 用最小 DOM 桩在 Node 里跑 pet.js，验证「文字跟着语音逐字出现」。
 *
 * 不是完整浏览器环境，只覆盖这条链路：
 *   message 事件 → 切句 → 合成(桩) → 播放(桩) → 打字机按音频时长推进
 *
 * 关键观察点：气泡文本长度应当**随时间单调增长**，而不是一步到位。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const petJs = path.resolve(__dirname, '../../../desktop/src/renderer/pet.js');
const code = fs.readFileSync(petJs, 'utf8');

// ---------------- 最小 DOM ----------------
class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, on) => (on ? self._classes.add(c) : self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v ?? '');
    this.children = [];
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  remove() {
    /* 桩：无需真的从父节点摘除 */
  }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.find((c) => c.className === cls) || null;
  }
  contains() {
    return false;
  }
  addEventListener() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
}

const ids = [
  'stage', 'bubble', 'bubbleText', 'bubbleClose', 'petWrap', 'inputbar', 'input',
  'sendBtn', 'panel', 'panelTitle', 'panelClose', 'panelError', 'loginSection',
  'accountSection', 'baseUrl', 'email', 'password', 'loginBtn', 'loginTip',
  'accountEmail', 'personaName', 'petEnabledText', 'clickThrough', 'refreshBtn',
  'logoutBtn', 'voiceToggle', 'voiceSelect', 'voiceBtn', 'settingsBtn', 'topControls',
];
const els = Object.fromEntries(ids.map((id) => [id, new FakeEl()]));
els.panel.hidden = true;
els.inputbar.hidden = true;
els.bubble.hidden = true;

const petRoot = new FakeEl('g');

const document = {
  getElementById: (id) => els[id] || null,
  querySelector: (sel) => (sel === '.pet-root' ? petRoot : null),
  createElement: (tag) => new FakeEl(tag),
  addEventListener() {},
};

// ---------------- 假音频 ----------------
let AUDIO_DURATION = 0.8; // 每段音频 0.8 秒
let startedSources = 0;
const durations = []; // 记录实际播放的时长，用于验证打字机速度

class FakeBufferSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.onended = null;
    this.buffer = null;
  }
  connect() {}
  start() {
    startedSources++;
    const ms = (this.buffer?.duration || AUDIO_DURATION) * 1000;
    setTimeout(() => {
      if (typeof this.onended === 'function') this.onended();
    }, ms);
  }
  stop() {
    /* 桩：stop 后不触发 onended 也无所谓，epoch 会兜住 */
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = {};
  }
  resume() {}
  decodeAudioData() {
    return Promise.resolve({ duration: AUDIO_DURATION });
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
}

// ---------------- 假的 window.pet ----------------
let chatHandler = null;
const api = {
  getState: async () => ({
    loggedIn: true,
    displayName: '小蝶',
    voiceEnabled: true,
    voiceId: 'zh-CN-XiaoyiNeural',
    clickThrough: true,
    assistant: { persona: { desktopPetEnabled: true } },
  }),
  onChatEvent: (cb) => {
    chatHandler = cb;
    return () => {};
  },
  onVoiceState: () => () => {},
  speak: async (text) => {
    // 模拟一次合成往返（80ms），返回一段假音频
    await new Promise((r) => setTimeout(r, 80));
    return { ok: true, audio: Buffer.from('fake-mp3').toString('base64') };
  },
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

const window = { pet: api, AudioContext: FakeAudioContext };

const sandbox = {
  window,
  document,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  Uint8Array,
  Promise,
  Math,
  Number,
  String,
  JSON,
  Buffer,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: petJs });

// ---------------- 跑场景 ----------------
const REPLY =
  '这个真帮不上忙啦，因为我这边只能打字聊天，发不了语音的。\n' +
  '不过再告诉你一次：我叫**小蝶**～ 蓝头发、戴着女仆装、后面还有条小鲸鱼尾巴的就是我啦。（笑眼）要记住我哦！ ';

const samples = [];
const t0 = Date.now();

// 模拟流式：分 6 次推累积文本
const chunks = 6;
let step = 0;
const feed = setInterval(() => {
  step++;
  const upto = Math.ceil((REPLY.length * step) / chunks);
  chatHandler({ type: 'message', content: REPLY.slice(0, upto) });
  if (step >= chunks) clearInterval(feed);
}, 120);

const sampler = setInterval(() => {
  samples.push({
    ms: Date.now() - t0,
    len: els.bubbleText.textContent.length,
    text: els.bubbleText.textContent.replace(/\n/g, '⏎'),
  });
}, 120);

setTimeout(() => {
  clearInterval(sampler);
  clearInterval(feed);

  console.log('=== 气泡文本随时间增长（len = 已显示字数）===');
  for (const s of samples) {
    console.log(String(s.ms).padStart(5), 'ms  len=' + String(s.len).padStart(3), ' |', s.text);
  }

  const finalText = els.bubbleText.textContent;
  console.log('\n=== 判定 ===');
  console.log('最终文本:', JSON.stringify(finalText));
  console.log('是否剥掉了 markdown 星号:', finalText.includes('**') ? '❌ 还有 **' : '✅ 已剥掉');
  console.log('播放过的音频段数:', startedSources);
  console.log('最终字数:', finalText.length);

  // 单调递增检查：忽略最后可能重复的采样
  let maxSeen = -1;
  let regressions = 0;
  for (const s of samples) {
    if (s.len < maxSeen) regressions++;
    maxSeen = Math.max(maxSeen, s.len);
  }
  console.log('字数是否只增不减:', regressions === 0 ? '✅' : `❌ 回退 ${regressions} 次`);

  // 是否「逐步出现」而不是一步到位
  const distinct = new Set(samples.map((s) => s.len)).size;
  console.log('出现过的不同长度数量:', distinct, distinct > 5 ? '✅ 是逐字推进' : '❌ 像是一步到位');

  process.exit(0);
}, 5200);
