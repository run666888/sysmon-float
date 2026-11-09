'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const collector = require('./src/collect');
const glass = require('@hicccc77/electron-liquid-glass');

const WIDTH = 360;
const HORIZONTAL_WIDTH = 760;
const INITIAL_HEIGHT = 400;

let win = null;
let tray = null;
let stopCollector = null;
let saveTimer = null;
let shuttingDown = false;
let readyToShow = false;
let captureReady = false;
let latestCaptureFrame = null;
let showFallbackTimer = null;
let userHidden = false;
let captureDisplayId = null;
let captureInFlight = null;
let glassPanel = null;
let glassCapturePolicy = 'all';
let edgeCaptureTimer = null;
let edgeCaptureInFlight = false;

/* ------------------------------------------------------------------ */
/* 配置持久化（userData/settings.json）                                  */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  alwaysOnTop: true,
  autoStart: false,
  hiddenToTray: false,
  layout: 'vertical',
  theme: 'midnight',
  opacity: 100,
  x: null,
  y: null,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch { /* 配置存不下来不影响使用 */ }
  }, 400);
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                 */
/* ------------------------------------------------------------------ */

function createWindow() {
  userHidden = false;
  const { workArea } = screen.getPrimaryDisplay();
  const defaultX = workArea.x + workArea.width - WIDTH - 24;
  const defaultY = workArea.y + 24;
  let x = Number.isFinite(settings.x) ? settings.x : defaultX;
  let y = Number.isFinite(settings.y) ? settings.y : defaultY;

  // 显示器拔掉/分辨率变了之后，上次记住的位置可能已经在屏幕外，这里拉回来
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + WIDTH > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height;
  });
  if (!visible) {
    x = defaultX;
    y = defaultY;
  }

  win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    // 完全透明窗口：玻璃材质由 CSS 绘制，保证圆角与卡片边界完全一致
    backgroundColor: '#00000000',
    hasShadow: false,
    // 无边框窗口没有可拖拽的边框，保持 resizable 才能让渲染层上报高度后自适应
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: '系统状态',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  captureDisplayId = String(screen.getDisplayMatching(win.getBounds()).id);

  // 实验性的原生光学层。此电脑上实测会呈现黑色，默认停用。
  // 保留显式开关供其他硬件验证，不让未验收的材质影响正常启动。
  try {
    if (process.env.SYSMON_NATIVE_GLASS === '1' && glass.isSupported()) {
      glassCapturePolicy = 'all';
      const bounds = glassBounds();
      glassPanel = glass.createPanel({
        ...bounds,
        dpr: screen.getDisplayMatching(win.getBounds()).scaleFactor,
        cornerRadius: 24 * screen.getDisplayMatching(win.getBounds()).scaleFactor,
        blurSigma: 4,
        displacementScale: 70,
        aberrationIntensity: 1,
        saturation: 1.1,
        capturePolicy: glassCapturePolicy,
        anchorWindow: win,
        lumaBands: [{ id: 0, x: 0, y: 0, width: bounds.width, height: bounds.height }],
        onLuma: (bands) => {
          if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
            win.webContents.send('glass:luma', bands[0]);
          }
        },
      });
    }
  } catch (error) {
    console.warn('Native glass:', error.message);
    glassPanel = null;
  }

  win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    pushScreenRect();
    if (!glassPanel && latestCaptureFrame) win.webContents.send('screen:frame', latestCaptureFrame);
  });

  readyToShow = false;
  win.once('ready-to-show', () => {
    readyToShow = true;
    if ((glassPanel || captureReady) && !userHidden) win.show();
    else showFallbackTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible() && !userHidden) {
        win.show();
      }
    }, 6000);
  });
  win.on('show', () => {
    if (glassPanel) glassPanel.show(0);
    pushScreenRect();
  });
  win.on('hide', () => {
    stopEdgeCapture();
    if (glassPanel) {
      glassPanel.hide(0);
      return;
    }
    pushScreenRect();
    captureReady = false;
    latestCaptureFrame = null;
    if (!shuttingDown) captureHiddenDesktop();
  });
  win.on('move', () => {
    if (!win) return;
    const [px, py] = win.getPosition();
    settings.x = px;
    settings.y = py;
    persist();
    const displayId = String(screen.getDisplayMatching(win.getBounds()).id);
    if (displayId !== captureDisplayId) {
      captureDisplayId = displayId;
      if (win.isVisible() && !glassPanel) win.hide();
    }
    updateGlassBounds();
    pushScreenRect();
  });
  win.on('resize', () => { updateGlassBounds(); pushScreenRect(); });
  win.on('closed', () => {
    stopEdgeCapture();
    if (glassPanel) { glassPanel.destroy(); glassPanel = null; }
    win = null;
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function publicConfig() {
  return {
    alwaysOnTop: !!settings.alwaysOnTop,
    layout: settings.layout,
    theme: settings.theme,
    opacity: settings.opacity,
    hiddenToTray: !!settings.hiddenToTray,
    version: app.getVersion(),
    nativeGlass: !!glassPanel,
  };
}

function applyAlwaysOnTop(value, { broadcast = true } = {}) {
  settings.alwaysOnTop = !!value;
  persist();
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    if (broadcast) win.webContents.send('config', publicConfig());
  }
  refreshTrayMenu();
}

function fitWindowToWorkArea(width, height) {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: current.x, y: current.y });
  const area = display.workArea;
  const maxWidth = Math.max(260, area.width - 24);
  const maxHeight = Math.max(120, area.height - 24);
  const targetWidth = settings.layout === 'horizontal' ? HORIZONTAL_WIDTH : WIDTH;
  const nextWidth = Math.min(Math.max(260, targetWidth), maxWidth);
  const nextHeight = Math.min(Math.max(100, Math.round(height)), maxHeight);
  const nextX = Math.min(Math.max(current.x, area.x + 12), area.x + area.width - nextWidth - 12);
  const nextY = Math.min(Math.max(current.y, area.y + 12), area.y + area.height - nextHeight - 12);
  if (current.x !== nextX || current.y !== nextY || current.width !== nextWidth || current.height !== nextHeight) {
    win.setBounds({ x: nextX, y: nextY, width: nextWidth, height: nextHeight });
  }
  settings.x = nextX;
  settings.y = nextY;
  persist();
  pushScreenRect();
}

/** 窗口在屏幕上的位置与所在显示器信息，供渲染层裁切捕获画面 */
function screenRectInfo() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    displayId: String(display.id),
    displayBounds: display.bounds,
    displaySize: display.size,
    scaleFactor: display.scaleFactor,
    windowBounds: bounds,
    physicalWindow: screen.dipToScreenRect(win, bounds),
  };
}

function glassBounds() {
  const rect = screen.dipToScreenRect(win, win.getBounds());
  const dpr = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  const inset = Math.round(10 * dpr);
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(1, rect.width - inset * 2),
    height: Math.max(1, rect.height - inset * 2),
  };
}

function updateGlassBounds() {
  if (!glassPanel || !win || win.isDestroyed()) return;
  const bounds = glassBounds();
  glassPanel.setBounds(bounds);
  glassPanel.setParams({
    cornerRadius: 24 * screen.getDisplayMatching(win.getBounds()).scaleFactor,
    blurSigma: 4,
    displacementScale: 70,
    aberrationIntensity: 1,
    saturation: 1.1,
  });
  glassPanel.setLumaBands([{ id: 0, x: 0, y: 0, width: bounds.width, height: bounds.height }]);
}

// 窗口隐藏时截取一次真实桌面；显示期间不再次截屏，避免窗口自拍。
// 截图在圆角卡片内柔化显示；外侧保持真实透明。
function captureHiddenDesktop() {
  if (glassPanel) return Promise.resolve();
  if (shuttingDown || !win || win.isDestroyed() || win.isVisible()) return Promise.resolve();
  if (captureInFlight) return captureInFlight;
  captureInFlight = (async () => {
    const target = win;
  const display = screen.getDisplayMatching(target.getBounds());
  const physical = screen.dipToScreenRect(target, display.bounds);
  const thumbnailScale = Math.min(1, 1600 / physical.width, 1000 / physical.height);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(physical.width * thumbnailScale)),
      height: Math.max(1, Math.round(physical.height * thumbnailScale)),
    },
    });
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('未找到当前显示器的桌面画面');
    if (target.isDestroyed() || target.isVisible()) return;
    const frame = {
      capture: physical,
      window: screen.dipToScreenRect(target, target.getBounds()),
      data: source.thumbnail.toJPEG(82).toString('base64'),
    };
    latestCaptureFrame = frame;
    captureReady = true;
    clearTimeout(showFallbackTimer);
    if (!target.webContents.isLoading()) target.webContents.send('screen:frame', frame);
    if (readyToShow && !userHidden) target.show();
  })().catch((error) => console.warn('Desktop capture:', error.message))
    .finally(() => { captureInFlight = null; });
  return captureInFlight;
}

function startEdgeCapture() {
  if (edgeCaptureTimer || glassPanel || settings.theme !== 'clear' || !win || !win.isVisible()) return;
  captureVisibleEdges();
  edgeCaptureTimer = setInterval(captureVisibleEdges, 500);
}

function stopEdgeCapture() {
  clearInterval(edgeCaptureTimer);
  edgeCaptureTimer = null;
}

async function captureVisibleEdges() {
  if (edgeCaptureInFlight || !win || win.isDestroyed() || !win.isVisible() || settings.theme !== 'clear') return;
  edgeCaptureInFlight = true;
  try {
    const target = win;
    const display = screen.getDisplayMatching(target.getBounds());
    const physical = screen.dipToScreenRect(target, display.bounds);
    const scale = Math.min(1, 720 / physical.width, 450 / physical.height);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(physical.width * scale), height: Math.round(physical.height * scale) },
    });
    const source = sources.find((item) => item.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty() || target.isDestroyed() || !target.isVisible()) return;
    target.webContents.send('screen:edge-frame', {
      capture: physical,
      window: screen.dipToScreenRect(target, target.getBounds()),
      data: source.thumbnail.toJPEG(72).toString('base64'),
    });
  } catch (error) {
    console.warn('Edge capture:', error.message);
  } finally {
    edgeCaptureInFlight = false;
  }
}

let screenRectTimer = null;

function pushScreenRect() {
  if (!win || win.isDestroyed()) return;
  // 合并同一帧内的位置事件，同时在拖动期间持续更新材质采样坐标。
  if (screenRectTimer) return;
  screenRectTimer = setTimeout(() => {
    screenRectTimer = null;
    if (!win || win.isDestroyed()) return;
    const info = screenRectInfo();
    if (info) win.webContents.send('screen:rect', info);
  }, 16);
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                 */
/* ------------------------------------------------------------------ */

function refreshTrayMenu() {
  if (!tray) return;
  const autoStart = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏悬浮窗', click: toggleVisible },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (mi) => applyAlwaysOnTop(mi.checked) },
    { label: '开机自动启动', type: 'checkbox', checked: autoStart, click: (mi) => setAutoStart(mi.checked) },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('系统状态悬浮窗');
  tray.on('click', toggleVisible);
  refreshTrayMenu();
}

function toggleVisible() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible()) {
    userHidden = true;
    win.hide();
  } else {
    userHidden = false;
    if (glassPanel || captureReady) win.show();
    else captureHiddenDesktop();
  }
}

function setAutoStart(enabled) {
  settings.autoStart = !!enabled;
  persist();
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.autoStart,
      path: process.execPath,
      // 开发模式下 execPath 是 electron.exe，需要把项目目录作为参数传进去
      args: app.isPackaged ? [] : [path.resolve(app.getAppPath())],
    });
  } catch { /* 某些精简版系统不支持，忽略 */ }
  refreshTrayMenu();
}

function quitApp() {
  app.quit();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig());
  ipcMain.handle('screen:video-source', async () => {
    if (!win || win.isDestroyed()) return null;
    const display = screen.getDisplayMatching(win.getBounds());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((item) => item.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    return source ? {
      id: source.id,
      capture: screen.dipToScreenRect(win, display.bounds),
      window: screen.dipToScreenRect(win, win.getBounds()),
    } : null;
  });
  ipcMain.on('screen:edge-fallback', startEdgeCapture);
  ipcMain.on('screen:edge-stop', stopEdgeCapture);

  ipcMain.handle('config:alwaysOnTop', (_e, value) => {
    applyAlwaysOnTop(value);
    return publicConfig();
  });

  ipcMain.handle('screen:source', () => screenRectInfo());

  // 渲染层测出真实内容尺寸后回调，让窗口贴着内容
  ipcMain.on('renderer:size', (_e, size) => {
    if (!win || win.isDestroyed()) return;
    const w = Math.round(Number(size && size.width));
    const h = Math.round(Number(size && size.height));
    // 只拦截明显异常的值；正常高度完全由卡片自身决定，窗口与卡片保持等大
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 240 || w > 1400 || h < 100 || h > 1400) return;
    fitWindowToWorkArea(w, h);
  });

  ipcMain.handle('config:update', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return publicConfig();
    if (['vertical', 'horizontal'].includes(patch.layout)) settings.layout = patch.layout;
    if (['midnight', 'graphite', 'ocean', 'clear'].includes(patch.theme)) settings.theme = patch.theme;
    if (Number.isFinite(Number(patch.opacity))) settings.opacity = Math.max(0, Math.min(100, Number(patch.opacity)));
    persist();
    if (settings.theme !== 'clear') stopEdgeCapture();
    if (win && !win.isDestroyed()) win.webContents.send('config', publicConfig());
    return publicConfig();
  });

  ipcMain.on('window:hide', () => {
    userHidden = true;
    if (win && !win.isDestroyed()) win.hide();
  });
  ipcMain.on('app:quit', quitApp);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  // Windows 上不设置 AppUserModelID 的话，任务栏/托盘图标会被归到 electron.exe 名下
  app.setAppUserModelId('com.sysmon.float');

  app.whenReady().then(() => {
    settings = loadSettings();
    registerIpc();
    createWindow();
    createTray();
    captureHiddenDesktop();

    const push = (snapshot) => {
      if (win && !win.isDestroyed()) win.webContents.send('stats', snapshot);
    };
    stopCollector = collector.start(push, push);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    shuttingDown = true;
    clearTimeout(showFallbackTimer);
    stopEdgeCapture();
    if (glassPanel) { glassPanel.destroy(); glassPanel = null; }
    glass.shutdown();
    if (stopCollector) stopCollector();
  });
}
