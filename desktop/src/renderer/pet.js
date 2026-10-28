'use strict';

/**
 * 小蝶桌宠 —— 渲染进程
 *
 * 这里只做三件事：画、响应鼠标、把文字塞进气泡。
 * 网络请求、token、SSE 解析全在主进程（见 main.js 顶部说明）。
 */

const api = window.pet;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const bubble = $('bubble');
const bubbleText = $('bubbleText');
const bubbleClose = $('bubbleClose');
const petWrap = $('petWrap');
const petRoot = document.querySelector('.pet-root');
const inputbar = $('inputbar');
const input = $('input');
const sendBtn = $('sendBtn');
const panel = $('panel');
const panelTitle = $('panelTitle');
const panelClose = $('panelClose');
const panelError = $('panelError');
const loginSection = $('loginSection');
const accountSection = $('accountSection');
const baseUrlInput = $('baseUrl');
const emailInput = $('email');
const passwordInput = $('password');
const loginBtn = $('loginBtn');
const loginTip = $('loginTip');
const accountEmail = $('accountEmail');
const personaName = $('personaName');
const petEnabledText = $('petEnabledText');
const clickThroughInput = $('clickThrough');
const refreshBtn = $('refreshBtn');
const logoutBtn = $('logoutBtn');
const voiceToggle = $('voiceToggle');
const voiceSelect = $('voiceSelect');
const voiceBtn = $('voiceBtn');
const settingsBtn = $('settingsBtn');
const topControls = $('topControls');

// ---------- 状态 ----------
const state = {
  loggedIn: false,
  displayName: '小蝶',
  busy: false,
  /** 语音播报开关（静音模式下只出气泡不出声） */
  voiceEnabled: true,
  /** 输入框或面板打开时，窗口必须可交互（否则点不到） */
  forceInteractive: false,
};

/**
 * ipcRenderer.invoke 抛出的异常会被 Electron 包一层
 * "Error invoking remote method 'xxx': Error: 真实文案"，这里把前缀剥掉。
 * 主进程的 handler 已经改成返回 { ok:false, error }，这层只是兜底。
 */
function cleanError(error) {
  const raw = (error && error.message) || String(error || '');
  const text = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
  return text || '出错了';
}

// ===========================================================================
// 鼠标穿透
// ===========================================================================

/**
 * 用**坐标命中**判断，而不是 e.target.closest()。
 *
 * 原因：窗口处于 setIgnoreMouseEvents(true, { forward: true }) 时，
 * 事件是「转发」进来的，浏览器不做命中测试，e.target 往往就是 <html>，
 * 用 closest 会永远判不到形象上，导致鼠标移过去也点不中。
 */
function hitTest(clientX, clientY) {
  for (const el of [bubble, petWrap, inputbar, panel, topControls]) {
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    ) {
      return true;
    }
  }
  return false;
}

let lastIgnore = null;
function applyMouseThrough(clientX, clientY) {
  const ignore = state.forceInteractive
    ? false
    : !hitTest(clientX, clientY);
  if (ignore === lastIgnore) return;
  lastIgnore = ignore;
  api.setIgnoreMouse(ignore);
}

let rafPending = false;
let pointerX = -1;
let pointerY = -1;
document.addEventListener('mousemove', (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    applyMouseThrough(pointerX, pointerY);
  });
});

function setForceInteractive(value) {
  state.forceInteractive = value;
  lastIgnore = null;
  applyMouseThrough(pointerX, pointerY);
}

// ===========================================================================
// 气泡
// ===========================================================================

function showBubble(text, { cursor = false } = {}) {
  bubble.hidden = false;
  bubbleText.textContent = text;
  if (cursor) {
    const caret = document.createElement('span');
    caret.className = 'cursor';
    bubbleText.appendChild(caret);
  }
  bubble.scrollTop = bubble.scrollHeight;
}

function hideBubble() {
  bubble.hidden = true;
  bubbleText.textContent = '';
}

/**
 * 气泡是纯文本，没有 markdown 渲染。
 * 不剥掉 ** / ` / 标题井号 这些标记，用户就会看到「我叫**小蝶**」——
 * 语音合成那边也会把星号当停顿读，所以显示与合成都用剥过的文本。
 */
function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '· ');
}

/** message 事件的 content 是全量累积文本，直接覆盖 */
function setBubbleStreaming(text) {
  bubble.hidden = false;
  bubbleText.textContent = stripMarkdown(text);
  const caret = document.createElement('span');
  caret.className = 'cursor';
  bubbleText.appendChild(caret);
  bubble.scrollTop = bubble.scrollHeight;
}

/**
 * 收掉闪烁光标。
 *
 * 光标是「还在说话」的视觉信号，流一结束就该消失。
 * 少了这一步，回复早就说完了、发送按钮也恢复了，气泡末尾却还一直闪，
 * 看起来像卡住了。
 */
function stopBubbleCursor() {
  bubbleText.querySelector('.cursor')?.remove();
}

bubbleClose.addEventListener('click', hideBubble);

// ===========================================================================
// 语音播报（Edge TTS 合成 → Web Audio 播放 → 文字随语音逐句显示）
// ===========================================================================
//
// 需求：文字与语音同步，边读边出字。
// 做法：把回复按句子切开，逐句「合成 → 播放 → 播到哪句就把哪句写进气泡」。
// 这样文字不是先整段刷出来再等语音，而是跟着声音一句一句出现。
// 上一句播放时会预取下一句，尽量减少句间空白。

let audioCtx = null;
let currentSource = null;
/** 语音代次：每次重置/关闭语音都 +1，用来丢弃过期的异步回调 */
let speechEpoch = 0;

/** 待播报队列：{ text, audio(undefined=未合成 / null=失败 / string=base64), synthesizing } */
const speechQueue = [];
let speechRunning = false;
/** 本轮回复的完整累积文本（来自 message 事件） */
let fullReplyText = '';
/** 已切出去播报的字符数（避免重复切句） */
let committedLength = 0;
/** 已显示在气泡里的文字（跟随播放进度） */
let revealedText = '';
/** 收尾定时器：一段时间没有新文本就把剩下的半句也切出去 */
let flushTimer = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function stopSpeaking() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* 已经停了 */
    }
    currentSource = null;
  }
  petRoot.classList.remove('talking');
}

/**
 * 播放一段 base64 mp3。onStart 在真正开始发声时调用，并传入音频时长（秒），
 * 用来驱动「逐字显示」。返回 Promise<boolean>：真正播过为 true，没播（解码失败/取消）为 false。
 */
function playBase64Audio(base64, onStart, epoch) {
  return new Promise((resolve) => {
    if (!base64) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (played) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(played));
    };
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ctx = getAudioCtx();
      ctx
        .decodeAudioData(bytes.buffer.slice(0))
        .then((buffer) => {
          if (epoch !== undefined && epoch !== speechEpoch) {
            finish(false);
            return;
          }
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          currentSource = source;
          source.onended = () => {
            if (currentSource === source) currentSource = null;
            petRoot.classList.remove('talking');
            finish(true);
          };
          petRoot.classList.add('talking');
          // 开始发声的同时开始逐字显示（把音频时长交给打字机，让文字和朗读同步）
          if (typeof onStart === 'function') onStart(buffer.duration);
          source.start();
        })
        .catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** 把当前 revealedText 画进气泡（带闪烁光标） */
function paintBubble() {
  bubble.hidden = false;
  bubbleText.textContent = revealedText;
  const caret = document.createElement('span');
  caret.className = 'cursor';
  bubbleText.appendChild(caret);
  bubble.scrollTop = bubble.scrollHeight;
}

/** 没合成出音频时：整句直接显示 */
function revealSentence(sentence) {
  revealedText += sentence;
  paintBubble();
}

/** 气泡只显示已播报的文字；还没播到就先给省略号占位 */
function renderRevealed() {
  bubble.hidden = false;
  if (!revealedText) {
    bubbleText.textContent = '…';
    return;
  }
  paintBubble();
}

// 逐字显示（跟随语音时长）——「边读边出字」
let typeTimer = null;
let typeBase = '';
let typeSentence = '';

function stopTypewriter() {
  if (typeTimer) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
}

/**
 * 这句开始发声时调用：按音频时长把这句话一个字一个字补进气泡。
 * durationSec 是这段音频的真实时长，所以文字推进速度与朗读基本一致。
 *
 * 进度按**真实经过时间**算，不是每次 tick 累加固定字数 ——
 * setInterval 本身会漂移（每 tick 晚几毫秒，一秒钟就积几十毫秒），
 * 累加写法会让句末文字比声音慢半拍，看起来像对不上。
 */
function startTypewriter(sentence, durationSec, epoch) {
  stopTypewriter();
  typeBase = revealedText;
  typeSentence = sentence;
  const total = sentence.length;
  if (total === 0) return;

  const durationMs = Math.max(500, (Number(durationSec) || total * 0.12) * 1000);
  const tickMs = 40;
  const startAt = Date.now();

  const tick = () => {
    if (epoch !== speechEpoch) {
      stopTypewriter();
      return;
    }
    // +tickMs 给一个「提前量」：开口的瞬间就蹦出第一个字，不要先空 40ms
    const ratio = Math.min(1, (Date.now() - startAt + tickMs) / durationMs);
    const shown = Math.min(total, Math.max(1, Math.floor(total * ratio)));
    revealedText = typeBase + sentence.slice(0, shown);
    paintBubble();
    if (shown >= total) stopTypewriter();
  };
  typeTimer = setInterval(tick, tickMs);
  tick();
}

/** 音频先于文字播完（或被打断）时，把整句补全 */
function finishTypewriter() {
  stopTypewriter();
  if (typeSentence) {
    revealedText = typeBase + typeSentence;
    typeSentence = '';
    paintBubble();
  }
}

/** 把一段文本按句子切开入队 */
function enqueueSentences(text) {
  const parts = text.match(/[^。！？!?\n]+[。！？!?\n]?/g) || [];
  for (const part of parts) {
    const s = stripMarkdown(part).trim();
    if (!s) continue;
    for (const piece of splitLong(s)) {
      speechQueue.push({ text: piece, audio: undefined, synthesizing: false });
    }
  }
}

/**
 * 太长的句子再按逗号切一刀。
 *
 * 合成是一段一段走的，片段越短，第一段音频回来得越早，
 * 用户等待「开口」的时间就越短。切点在逗号处，听感上仍是自然的停顿。
 */
function splitLong(sentence, limit = 45) {
  if (sentence.length <= limit) return [sentence];
  const pieces = [];
  let rest = sentence;
  while (rest.length > limit) {
    let cut = -1;
    for (let i = Math.min(rest.length - 1, limit); i >= Math.max(6, limit - 20); i--) {
      if (/[，、；：,;:]/.test(rest[i])) {
        cut = i;
        break;
      }
    }
    if (cut < 0) break;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** 预取：保证「正在播的那句」后面至少有一句已合成好，减少句间空白（最多并行 2 条） */
function prefetchNext() {
  let inflight = 0;
  for (const item of speechQueue) if (item.synthesizing) inflight++;
  if (inflight >= 2) return;

  for (const item of speechQueue) {
    if (item.audio === undefined && !item.synthesizing) {
      item.synthesizing = true;
      const epoch = speechEpoch;
      api
        .speak(item.text)
        .then((res) => {
          item.audio = res && res.ok && res.audio ? res.audio : null;
        })
        .catch(() => {
          item.audio = null;
        })
        .finally(() => {
          item.synthesizing = false;
          if (epoch === speechEpoch) void pumpSpeech();
        });
      return;
    }
  }
}

/** 播放泵：按顺序播放队列里的句子，播到哪句显示哪句 */
async function pumpSpeech() {
  if (speechRunning) return;
  if (speechQueue.length === 0) return;

  const item = speechQueue[0];
  // 当前句还没合成好 → 先合成（合成完会再叫醒本泵）
  if (item.audio === undefined) {
    prefetchNext();
    return;
  }

  const epoch = speechEpoch;
  speechRunning = true;
  speechQueue.shift();
  // 播当前句的同时预取下一句
  prefetchNext();

  if (item.audio) {
    // 关键：音频开始发声时才把这句的第一个字写进气泡，之后按音频时长逐字推进，
    // 做到「边读边出字」。音频先播完（或被打断）时由 finishTypewriter 补全整句。
    await playBase64Audio(
      item.audio,
      (duration) => startTypewriter(item.text, duration, epoch),
      epoch,
    );
    // 被打断/重置后不要再往气泡里写（否则会把新对话的气泡覆盖掉）
    if (epoch !== speechEpoch) {
      speechRunning = false;
      return;
    }
    finishTypewriter();
  } else {
    // 合成失败：文字照常显示，只是没声音
    revealSentence(item.text);
  }

  speechRunning = false;
  if (epoch !== speechEpoch) return;
  if (speechQueue.length > 0) {
    void pumpSpeech();
    return;
  }
  // 队列空了：这一轮说完了，收掉光标（否则气泡末尾会一直闪，像卡住）
  if (!currentSource) stopBubbleCursor();
}

/** 收到流式文本（语音开启时）—— 只切句，不直接刷整段文字 */
function handleVoiceStream(text) {
  fullReplyText = text;

  const pending = fullReplyText.slice(committedLength);
  // 找到最后一个句末标点，把它之前的内容切出去播报
  let cut = -1;
  for (let i = 0; i < pending.length; i++) {
    if (/[。！？!?\n]/.test(pending[i])) cut = i;
  }
  if (cut >= 0) {
    const chunk = pending.slice(0, cut + 1);
    committedLength += chunk.length;
    enqueueSentences(chunk);
    prefetchNext();
    void pumpSpeech();
  }

  if (!revealedText) renderRevealed();

  // 一段时间没有新文本 → 把剩下的半句也切出去
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushVoiceRemainder();
  }, 700);
}

/** 把还没切出去的最后半句也切出去 */
function flushVoiceRemainder() {
  if (committedLength < fullReplyText.length) {
    const rest = fullReplyText.slice(committedLength);
    committedLength = fullReplyText.length;
    enqueueSentences(rest);
    prefetchNext();
    void pumpSpeech();
  }
}

/** 新一轮对话开始前清空语音状态 */
function resetSpeech() {
  speechEpoch++;
  stopTypewriter();
  typeSentence = '';
  typeBase = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  speechQueue.length = 0;
  fullReplyText = '';
  committedLength = 0;
  revealedText = '';
  speechRunning = false;
  stopSpeaking();
}

/** 关掉语音时：停声、清队列，但把整段文字补齐，别让内容丢了 */
function abortSpeechAndShowAll() {
  speechEpoch++;
  stopTypewriter();
  typeSentence = '';
  typeBase = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  speechQueue.length = 0;
  speechRunning = false;
  stopSpeaking();
  if (fullReplyText) {
    // 显示用剥过标记的文本，和逐句播报时看到的保持一致
    const shown = stripMarkdown(fullReplyText);
    revealedText = shown;
    bubble.hidden = false;
    bubbleText.textContent = shown;
    bubble.scrollTop = bubble.scrollHeight;
  }
}

/** 同步「语音开关」在两处 UI（浮标按钮 + 设置面板）的显示 */
function setVoiceUI(enabled) {
  state.voiceEnabled = enabled;
  if (voiceToggle) voiceToggle.checked = enabled;
  if (voiceBtn) {
    voiceBtn.classList.toggle('muted', !enabled);
    voiceBtn.title = enabled ? '语音播报：开（点击静音）' : '语音播报：关（点击开启）';
  }
}

function applyVoiceEnabled(enabled) {
  setVoiceUI(enabled);
  api.setVoice({ voiceEnabled: enabled });
  if (!enabled) abortSpeechAndShowAll();
}

// ===========================================================================
// 形象：拖拽 + 点击
// ===========================================================================

let drag = null;

petWrap.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { x: event.screenX, y: event.screenY, moved: false };
  api.dragStart();
  petWrap.setPointerCapture(event.pointerId);
});

petWrap.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;

  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
    drag.moved = true;
    petWrap.classList.add('dragging');
    petRoot.classList.add('dragging');
  }
  if (drag.moved) api.dragMove(dx, dy);
});

function endDrag(event) {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  petWrap.classList.remove('dragging');
  petRoot.classList.remove('dragging');
  api.dragEnd();
  try {
    petWrap.releasePointerCapture(event.pointerId);
  } catch {
    /* 已释放 */
  }
  if (!moved) onPetClick();
}

petWrap.addEventListener('pointerup', endDrag);
petWrap.addEventListener('pointercancel', endDrag);

// 右键形象 = 打开设置（登录后唯一不靠浮标也能进设置的路子）
petWrap.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (state.loggedIn) openPanel();
});

function onPetClick() {
  if (!state.loggedIn) {
    openPanel();
    return;
  }
  if (!inputbar.hidden) {
    closeInput();
    return;
  }
  openInput();
}

// ===========================================================================
// 输入
// ===========================================================================

function openInput() {
  inputbar.hidden = false;
  setForceInteractive(true);
  api.focusInput();
  input.focus();
}

function closeInput() {
  inputbar.hidden = true;
  if (panel.hidden) setForceInteractive(false);
}

inputbar.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendMessage();
});

sendBtn.addEventListener('click', (event) => {
  event.preventDefault();
  void sendMessage();
});

async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.busy) return;

  input.value = '';
  resetSpeech();
  state.busy = true;
  sendBtn.disabled = true;
  petRoot.classList.add('talking', 'thinking');
  showBubble('…', { cursor: true });

  try {
    const result = await api.send(text);
    if (result && result.ok === false && result.error) {
      showBubble(`⚠️ ${result.error}`);
    } else if (result && result.ok === false && result.aborted) {
      showBubble('（已取消）');
    }
  } catch (error) {
    showBubble(`⚠️ ${cleanError(error)}`);
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    petRoot.classList.remove('thinking');
    // 流已经结束 → 剩下的半句不必再等 700ms 的静默判定，立刻切出去播
    if (state.voiceEnabled) flushVoiceRemainder();
    // 语音还在播（或队列里还有没播的句子）时不要收掉「说话」状态，否则嘴巴会中途停下
    if (!currentSource && !speechRunning && speechQueue.length === 0) {
      petRoot.classList.remove('talking');
    }
    stopBubbleCursor();
    if (
      !state.voiceEnabled &&
      bubble.hidden === false &&
      bubbleText.textContent.trim() === '…'
    ) {
      hideBubble();
    }
  }
}

// ===========================================================================
// SSE 事件
// ===========================================================================

const TOOL_LABELS = {
  list_workspaces: '看工作空间',
  get_workspace_overview: '看空间概况',
  list_workflows: '翻工作流列表',
  get_workflow: '看工作流详情',
  run_workflow: '跑工作流',
  list_knowledge_bases: '翻知识库',
  search_knowledge: '查知识库',
  list_agents: '看 Agent 列表',
  create_agent: '建 Agent',
  create_workflow: '建工作流',
  list_skills: '看 Skill',
  list_mcp_servers: '看 MCP',
  get_platform_overview: '看平台概况',
  create_mcp_server: '建 MCP 服务',
  create_skill: '建 Skill',
  generate_file: '生成文件',
};

api.onChatEvent((event) => {
  if (!event || typeof event !== 'object') return;

  switch (event.type) {
    case 'meta': {
      if (event.personaName) {
        state.displayName = event.personaName;
        personaName.textContent = event.personaName;
      }
      break;
    }

    case 'thinking': {
      petRoot.classList.add('thinking');
      break;
    }

    case 'tool_call': {
      const label = TOOL_LABELS[event.tool] || event.tool;
      showBubble(`正在${label}…`, { cursor: true });
      break;
    }

    case 'tool_result': {
      petRoot.classList.remove('thinking');
      break;
    }

    case 'message': {
      petRoot.classList.remove('thinking');
      petRoot.classList.add('talking');
      const content = event.content ?? '';
      if (state.voiceEnabled) {
        // 语音开启：文字跟着语音逐句显示，不先整段刷出来
        handleVoiceStream(content);
      } else {
        setBubbleStreaming(content);
      }
      break;
    }

    case 'operation': {
      const op = event.operation;
      if (op && op.status === 'FAILED') {
        showBubble(`⚠️ ${op.label || op.tool} 没成功：${op.summary || '未知原因'}`);
      }
      break;
    }

    case 'file': {
      const name = event.file?.name;
      if (name) showBubble(`文件做好了：${name}（去网页版「我的文件」下载）`);
      break;
    }

    case 'error': {
      petRoot.classList.remove('talking', 'thinking');
      showBubble(`⚠️ ${event.message}`);
      break;
    }

    case 'auth:expired': {
      petRoot.classList.remove('talking', 'thinking');
      state.loggedIn = false;
      showBubble('登录过期了，点我重新登录');
      openPanel();
      break;
    }

    case 'system': {
      showBubble(event.message);
      break;
    }

    case 'open-panel': {
      // 托盘菜单「设置…」推过来的
      openPanel();
      break;
    }

    default:
      break;
  }
});

// ===========================================================================
// 设置 / 登录面板
// ===========================================================================

function openPanel() {
  panel.hidden = false;
  setForceInteractive(true);
  panelError.hidden = true;
  closeInput();
  api.focusInput();
}

function closePanel() {
  panel.hidden = true;
  if (inputbar.hidden) setForceInteractive(false);
}

panelClose.addEventListener('click', closePanel);

function renderAccount() {
  loginSection.hidden = state.loggedIn;
  accountSection.hidden = !state.loggedIn;
  // 登录后右上角才有语音开关 / 设置入口
  if (topControls) topControls.hidden = !state.loggedIn;
  panelTitle.textContent = state.loggedIn ? '小蝶 · 设置' : '登录小蝶';
}

function showPanelError(message) {
  panelError.hidden = false;
  panelError.textContent = message;
}

loginBtn.addEventListener('click', async () => {
  const baseUrl = baseUrlInput.value.trim();
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showPanelError('邮箱和密码都要填');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '登录中…';
  panelError.hidden = true;

  try {
    const result = await api.login({ email, password, baseUrl });

    if (!result || result.ok === false) {
      showPanelError((result && result.error) || '登录失败');
      return;
    }

    state.loggedIn = true;
    state.displayName = result.displayName || result.assistant?.displayName || '小蝶';
    passwordInput.value = '';

    const loginVoiceId = result.assistant?.persona?.voiceId;
    if (loginVoiceId) {
      voiceSelect.value = loginVoiceId;
      api.setVoice({ voiceId: loginVoiceId });
    }

    accountEmail.textContent = result.user?.email || email;
    personaName.textContent = state.displayName;
    petEnabledText.textContent =
      result.assistant?.persona?.desktopPetEnabled === false
        ? '未开启（去网页版人格里打开）'
        : '已开启';
    renderAccount();
    closePanel();

    showBubble(`我回来啦～我是${state.displayName}，点我说点什么吧`);
  } catch (error) {
    showPanelError(cleanError(error));
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '登录';
  }
});

passwordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loginBtn.click();
});

clickThroughInput.addEventListener('change', async () => {
  await api.saveSettings({ clickThrough: clickThroughInput.checked });
});

voiceToggle.addEventListener('change', () => applyVoiceEnabled(voiceToggle.checked));

if (voiceBtn) {
  voiceBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    applyVoiceEnabled(!state.voiceEnabled);
  });
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openPanel();
  });
}

voiceSelect.addEventListener('change', () => {
  api.setVoice({ voiceId: voiceSelect.value });
});

// 托盘菜单里也有一个语音开关，改了要同步回来（只更新 UI，不再回写，避免来回弹）
api.onVoiceState?.((payload) => {
  if (!payload || typeof payload.voiceEnabled !== 'boolean') return;
  setVoiceUI(payload.voiceEnabled);
  if (!payload.voiceEnabled) abortSpeechAndShowAll();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  try {
    const result = await api.refreshAssistant();
    if (!result || result.ok === false) {
      showPanelError((result && result.error) || '连接失败');
      return;
    }
    state.displayName = result.displayName || '小蝶';
    personaName.textContent = state.displayName;
    petEnabledText.textContent =
      result.assistant?.persona?.desktopPetEnabled === false
        ? '未开启（去网页版人格里打开）'
        : '已开启';
    showBubble(`连接正常，我是${state.displayName}`);
    closePanel();
  } catch (error) {
    showPanelError(cleanError(error));
  } finally {
    refreshBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await api.logout();
  stopSpeaking();
  state.loggedIn = false;
  accountEmail.textContent = '-';
  personaName.textContent = '-';
  petEnabledText.textContent = '-';
  renderAccount();
  showBubble('已经退出登录啦');
});

// 点面板以外的空白区域收起面板
document.addEventListener('pointerdown', (event) => {
  if (panel.hidden) return;
  if (panel.contains(event.target)) return;
  if (petWrap.contains(event.target)) return;
  if (topControls && topControls.contains(event.target)) return;
  closePanel();
});

// ===========================================================================
// 启动
// ===========================================================================

(async function boot() {
  try {
    const info = await api.getState();

    state.loggedIn = Boolean(info.loggedIn);
    state.displayName = info.displayName || '小蝶';

    baseUrlInput.value = info.baseUrl || 'http://localhost:3000';
    emailInput.value = info.email || '';
    clickThroughInput.checked = info.clickThrough !== false;
    setVoiceUI(info.voiceEnabled !== false);
    if (info.voiceId) voiceSelect.value = info.voiceId;
    accountEmail.textContent = info.email || '-';
    personaName.textContent = state.displayName;
    petEnabledText.textContent =
      info.assistant?.persona?.desktopPetEnabled === false
        ? '未开启（去网页版人格里打开）'
        : info.loggedIn
          ? '已开启'
          : '-';

    renderAccount();

    if (!state.loggedIn) {
      showBubble('点我登录，就能开始聊天啦');
    } else if (info.error) {
      showBubble(`⚠️ ${info.error}`);
      state.loggedIn = false;
      renderAccount();
      openPanel();
    } else {
      showBubble(`我是${state.displayName}，点我说点什么吧`);
    }
  } catch (error) {
    showBubble('启动出错了，点我看看设置');
    showPanelError(cleanError(error));
    openPanel();
  }
})();
