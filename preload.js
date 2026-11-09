'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('sysmon', {
  /** 每秒推送一次采集快照 */
  onStats: (cb) => subscribe('stats', cb),
  /** 置顶等配置变化时推送 */
  onConfig: (cb) => subscribe('config', cb),
  /** 上报内容真实尺寸，窗口据此自适应 */
  reportSize: (size) => ipcRenderer.send('renderer:size', size),
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('config:alwaysOnTop', v),
  /** 显示器与窗口位置 */
  getScreenSource: () => ipcRenderer.invoke('screen:source'),
  getLiveScreenSource: () => ipcRenderer.invoke('screen:video-source'),
  startEdgeFallback: () => ipcRenderer.send('screen:edge-fallback'),
  stopEdgeFallback: () => ipcRenderer.send('screen:edge-stop'),
  /** 窗口移动/缩放后主进程推送新的屏幕位置 */
  onScreenRect: (cb) => subscribe('screen:rect', cb),
  /** 窗口隐藏时截取的干净桌面底图 */
  onScreenFrame: (cb) => subscribe('screen:frame', cb),
  /** “透”模式仅采样窗口外部的实时边缘颜色 */
  onEdgeFrame: (cb) => subscribe('screen:edge-frame', cb),
  /** 原生玻璃透过区域的实时亮度 */
  onGlassLuma: (cb) => subscribe('glass:luma', cb),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
});
