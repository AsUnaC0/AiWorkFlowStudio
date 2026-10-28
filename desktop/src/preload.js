'use strict';

/**
 * 预加载脚本：主进程 ↔ 渲染进程的唯一桥。
 *
 * 只暴露白名单方法，token 与 HTTP 请求都留在主进程 —— 渲染进程连 baseUrl 之外的
 * 东西都拿不到，也就没有「被页面脚本直接打后端」的可能。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // ---- 状态与账号 ----
  getState: () => ipcRenderer.invoke('pet:state'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  refreshAssistant: () => ipcRenderer.invoke('assistant:refresh'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),

  // ---- 对话 ----
  send: (input) => ipcRenderer.invoke('chat:send', { input }),
  abort: () => ipcRenderer.send('chat:abort'),
  onChatEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  },

  // ---- 语音（Edge TTS） ----
  speak: (text) => ipcRenderer.invoke('tts:speak', { text }),
  setVoice: (payload) => ipcRenderer.send('tts:set-voice', payload),
  /** 托盘菜单改了开关时，主进程推回来让浮标按钮同步 */
  onVoiceState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('tts:state', handler);
    return () => ipcRenderer.removeListener('tts:state', handler);
  },

  // ---- 窗口行为 ----
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('pet:drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  focusInput: () => ipcRenderer.send('pet:focus-input'),
  hide: () => ipcRenderer.send('pet:hide'),
  quit: () => ipcRenderer.send('pet:quit'),
  openExternal: (url) => ipcRenderer.send('shell:open', url),
});
