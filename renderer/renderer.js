'use strict';

const $ = (id) => document.getElementById(id);
const HIST = 60; // sparkline 保留的历史点数（每秒 1 点 = 60 秒）

const cpuVal = $('cpuVal'), cpuSub = $('cpuSub'), cpuBar = $('cpuBar'), cpuSpark = $('cpuSpark');
const netRx = $('netRx'), netTx = $('netTx'), netSub = $('netSub');
const netTotal = $('netTotal'), vpnSub = $('vpnSub');
const modeBtn = $('modeBtn'), modeLabel = $('modeLabel');
const layoutBtn = $('layoutBtn'), layoutLabel = $('layoutLabel');
const themeBtn = $('themeBtn'), themeLabel = $('themeLabel');
const opacityBtn = $('opacityBtn'), opacityLabel = $('opacityLabel');
const gpuVal = $('gpuVal'), gpuSub = $('gpuSub'), gpuBar = $('gpuBar'), gpuSpark = $('gpuSpark');
const memoryVal = $('memoryVal'), memorySub = $('memorySub'), memoryBar = $('memoryBar'), memorySpark = $('memorySpark');
const uptimeVal = $('uptimeVal'), uptimeSub = $('uptimeSub');
const led = $('led'), spark = $('netSpark');

let pinState = true;
let rxHist = [];
let txHist = [];
let cpuHist = [];
let gpuHist = [];
let memoryHist = [];
let peakRef = 8192;
let mode = 'standard';
const MODES = ['standard', 'compact', 'detail'];

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function fmtRate(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0 B/s';
  let n = v;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  const text = i === 0 || n >= 100 ? String(Math.round(n)) : n.toFixed(1);
  return `${text} ${UNITS[i]}/s`;
}

function fmtBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  let n = v;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${UNITS[i]}`;
}

/** 显存成对格式化，避免出现「686 MB / 8.0 GB」这种单位混用 */
function fmtVram(used, total) {
  const t = Number(total);
  const u = Number(used);
  // 集显通常只上报一个不可靠的“总显存”而没有实时占用，此时不展示误导性数字。
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(u) || u <= 0) return null;
  const inGb = t >= 1024;
  const show = (mb) => (inGb ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  return `${show(u)} / ${show(t)}`;
}

function fmtGb(mb) {
  const v = Number(mb);
  if (!Number.isFinite(v) || v < 0) return '—';
  return `${(v / 1024).toFixed(1)} GB`;
}

/** 把「Intel Gen Intel® Core™ i7-13700H」压成「i7-13700H」 */
function shortCpu(brand) {
  if (!brand) return '';
  const m = String(brand).match(/(i[3579]-\d{3,5}\w*|Ryzen\s+\d+\s+\w+|Core\s+Ultra\s+\d+\s*\w*)/i);
  const text = m ? m[1] : String(brand).trim().split(/\s+/).pop();
  return text.replace(/[®™]/g, '').trim();
}

/** 去掉厂商前缀，GPU 名字才放得下 */
function shortGpu(name) {
  return String(name || '')
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/^(NVIDIA|AMD|Intel)\s+/i, '')
    .replace(/GeForce\s+/i, '')
    .replace(/\s*Graphics\s*/i, ' ')
    .replace(/\s*\(\d+\s*GB\)/i, '')
    .trim();
}

function setBar(el, pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = `${v}%`;
}

/** 负载越高颜色越警示；返回空串表示用 CSS 里的默认色 */
function loadColor(pct) {
  if (pct >= 90) return 'var(--crit)';
  if (pct >= 70) return 'var(--warn)';
  return '';
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render(s) {
  /* ---- CPU ---- */
  const load = Number(s.cpu.load) || 0;
  cpuVal.textContent = `${Math.round(load)}%`;
  cpuVal.style.color = load >= 90 ? 'var(--crit)' : load >= 70 ? 'var(--warn)' : '';
  setBar(cpuBar, load);
  cpuBar.style.background = loadColor(load);

  const cpuBits = [];
  const brand = shortCpu(s.cpu.brand);
  if (brand) cpuBits.push(brand);
  if (s.cpu.cores && s.cpu.threads) cpuBits.push(`${s.cpu.cores} 核 ${s.cpu.threads} 线程`);
  else if (s.cpu.threads) cpuBits.push(`${s.cpu.threads} 线程`);
  if (Number.isFinite(s.cpu.temp) && s.cpu.temp > 0) cpuBits.push(`${Math.round(s.cpu.temp)}°C`);
  else if (s.cpu.speed > 0) cpuBits.push(`${s.cpu.speed.toFixed(2)} GHz`);
  cpuSub.textContent = cpuBits.join(' · ') || '正在读取…';
  cpuHist.push(load);
  if (cpuHist.length > HIST) cpuHist.shift();

  led.style.background = loadColor(load) || 'var(--cpu)';
  led.style.color = loadColor(load) || 'var(--cpu)';

  /* ---- 网络 ---- */
  const rx = Number(s.net.rx) || 0;
  const tx = Number(s.net.tx) || 0;
  netRx.textContent = fmtRate(rx);
  netTx.textContent = fmtRate(tx);
  const latencyText = Number.isFinite(s.net.latency) ? `${s.net.latency} ms` : '延迟 —';
  netSub.textContent = s.net.online ? `${s.net.iface || '网络'} · ${latencyText}` : '未检测到已连接的网卡';
  netTotal.textContent = `本次流量：↓${fmtBytes(s.net.totalRx)} · ↑${fmtBytes(s.net.totalTx)}`;
  vpnSub.textContent = s.net.tunOnline
    ? `Clash Verge TUN · ${s.net.tunIface} · ↓${fmtRate(s.net.tunRx)} ↑${fmtRate(s.net.tunTx)}`
    : 'Clash Verge：未检测到 TUN';

  rxHist.push(rx);
  txHist.push(tx);
  if (rxHist.length > HIST) rxHist.shift();
  if (txHist.length > HIST) txHist.shift();
  drawSpark();

  /* ---- GPU ---- */
  const gpuLoad = Number.isFinite(s.gpu.load) ? Math.max(0, s.gpu.load) : null;
  gpuVal.textContent = gpuLoad === null ? '—' : `${Math.round(Math.min(100, gpuLoad))}%`;
  gpuVal.style.color = gpuLoad === null ? '' : gpuLoad >= 90 ? 'var(--crit)' : gpuLoad >= 70 ? 'var(--warn)' : '';
  setBar(gpuBar, gpuLoad === null ? 0 : Math.min(100, gpuLoad));

  const gpuBits = [];
  const gpuName = shortGpu(s.gpu.name);
  if (gpuName) gpuBits.push(gpuName);
  const vram = fmtVram(s.gpu.vramUsed, s.gpu.vramTotal);
  if (vram) gpuBits.push(`显存 ${vram}`);
  if (Number.isFinite(s.gpu.temp) && s.gpu.temp > 0) gpuBits.push(`${Math.round(s.gpu.temp)}°C`);
  if (!gpuBits.length) gpuBits.push('未检测到显卡');
  else if (gpuLoad === null) gpuBits.push('利用率不可用');
  gpuSub.textContent = gpuBits.join(' · ');
  if (gpuLoad !== null) {
    gpuHist.push(gpuLoad);
    if (gpuHist.length > HIST) gpuHist.shift();
  }

  /* ---- 内存 ---- */
  const memoryLoad = Number.isFinite(s.memory.load) ? s.memory.load : null;
  memoryVal.textContent = memoryLoad === null ? '—' : `${Math.round(memoryLoad)}%`;
  memoryVal.style.color = memoryLoad === null ? '' : memoryLoad >= 90 ? 'var(--crit)' : memoryLoad >= 70 ? 'var(--warn)' : '';
  setBar(memoryBar, memoryLoad === null ? 0 : memoryLoad);
  memoryBar.style.background = loadColor(memoryLoad || 0);
  memorySub.textContent = Number.isFinite(s.memory.used) && Number.isFinite(s.memory.total)
    ? `${fmtGb(s.memory.used)} / ${fmtGb(s.memory.total)}`
    : '正在读取…';
  if (memoryLoad !== null) {
    memoryHist.push(memoryLoad);
    if (memoryHist.length > HIST) memoryHist.shift();
  }

  /* ---- 运行时间 ---- */
  if (Number.isFinite(s.uptime)) {
    const days = Math.floor(s.uptime / 86400);
    const hours = Math.floor((s.uptime % 86400) / 3600);
    const mins = Math.floor((s.uptime % 3600) / 60);
    uptimeVal.textContent = days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${mins} 分`;
    uptimeSub.textContent = '系统已连续运行';
  } else {
    uptimeVal.textContent = '—';
    uptimeSub.textContent = '正在读取…';
  }
}


/* ------------------------------------------------------------------ */
/* 网络 sparkline                                                       */
/* ------------------------------------------------------------------ */

function paintSeries(ctx, series, xAt, yAt, w, h, rgb) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${rgb}, 0.32)`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);

  ctx.beginPath();
  series.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo(xAt(series.length - 1), h);
  ctx.lineTo(xAt(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  series.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawMiniSpark(canvas, series, color) {
  if (!canvas || series.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(100, ...series);
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - 2 - (Math.min(v, max) / max) * (h - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawSpark() {
  drawMiniSpark(cpuSpark, cpuHist, 'rgba(56, 189, 248, 0.9)');
  drawMiniSpark(gpuSpark, gpuHist, 'rgba(52, 211, 153, 0.9)');
  drawMiniSpark(memorySpark, memoryHist, 'rgba(167, 139, 250, 0.9)');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, spark.clientWidth);
  const h = Math.max(1, spark.clientHeight);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (spark.width !== pw || spark.height !== ph) {
    spark.width = pw;
    spark.height = ph;
  }

  const ctx = spark.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const n = Math.min(rxHist.length, txHist.length);
  if (n < 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 1.5);
    ctx.lineTo(w, h - 1.5);
    ctx.stroke();
    return;
  }

  // 峰值缓慢衰减，避免一次突发把之后 60 秒的波形压平
  peakRef = Math.max(8192, peakRef * 0.92, ...rxHist, ...txHist);

  const step = w / (HIST - 1);
  const xAt = (i) => w - (n - 1 - i) * step;
  const yAt = (v) => h - 2 - (Math.min(v, peakRef) / peakRef) * (h - 5);

  paintSeries(ctx, txHist, xAt, yAt, w, h, '167, 139, 250');
  paintSeries(ctx, rxHist, xAt, yAt, w, h, '56, 189, 248');
}

/* ------------------------------------------------------------------ */
/* 窗口高度自适应 + 交互                                                 */
/* ------------------------------------------------------------------ */

const card = document.querySelector('.card');
let lastHeight = '';

function reportSize() {
  const rect = card.getBoundingClientRect();
  const padding = 20;
  const size = { width: Math.ceil(rect.width + padding), height: Math.ceil(rect.height + padding) };
  const key = `${size.width}x${size.height}`;
  if (key !== lastHeight) {
    lastHeight = key;
    window.sysmon.reportSize(size);
  }
}

new ResizeObserver(reportSize).observe(card);
window.addEventListener('load', reportSize);

function applyConfig(cfg) {
  if (!cfg) return;
  document.body.dataset.glass = cfg.nativeGlass ? 'native' : 'snapshot';
  pinState = !!cfg.alwaysOnTop;
  const btn = $('btnPin');
  btn.classList.toggle('active', pinState);
  btn.title = pinState ? '已置顶（点击取消）' : '窗口置顶';
  applyLayout(cfg.layout || 'vertical');
  applyTheme(cfg.theme || 'midnight');
  applyOpacity(cfg.opacity ?? 100);
  reportSize();
}

$('btnPin').addEventListener('click', async () => {
  applyConfig(await window.sysmon.setAlwaysOnTop(!pinState));
});

$('btnQuit').addEventListener('click', () => window.sysmon.hide());

let layout = 'vertical';
let theme = 'midnight';
let opacity = 100;

function applyLayout(next) {
  layout = next === 'horizontal' ? 'horizontal' : 'vertical';
  document.body.dataset.layout = layout;
  layoutLabel.textContent = layout === 'horizontal' ? '横' : '竖';
  layoutBtn.title = layout === 'horizontal' ? '切换为纵向布局' : '切换为横向布局';
}

function applyTheme(next) {
  theme = ['midnight', 'graphite', 'ocean', 'clear'].includes(next) ? next : 'midnight';
  document.body.dataset.theme = theme;
  const names = { midnight: '夜', graphite: '灰', ocean: '海', clear: '透' };
  themeLabel.textContent = names[theme];
  themeBtn.title = `当前配色：${names[theme]}，点击切换`;
  applyOpacity(opacity);
}

function applyOpacity(next) {
  const value = Number(next);
  opacity = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  const transparency = 100 - opacity;
  document.body.dataset.tintClear = opacity === 0 ? 'true' : 'false';
  const clear = theme === 'clear';
  document.body.style.setProperty('--surface-alpha', String(clear ? opacity / 100 * 0.04 : opacity / 100 * 0.14));
  document.body.style.setProperty('--fallback-alpha', String(clear ? 0.40 + opacity / 100 * 0.18 : 0.48 + opacity / 100 * 0.20));
  opacityLabel.textContent = String(transparency);
  opacityBtn.title = `色垫透明度 ${transparency}%，点击切换`;
}

layoutBtn.addEventListener('click', async () => {
  const next = layout === 'vertical' ? 'horizontal' : 'vertical';
  applyLayout(next);
  applyConfig(await window.sysmon.updateConfig({ layout: next }));
});

themeBtn.addEventListener('click', async () => {
  const themes = ['midnight', 'graphite', 'ocean', 'clear'];
  const next = themes[(themes.indexOf(theme) + 1) % themes.length];
  applyTheme(next);
  applyConfig(await window.sysmon.updateConfig({ theme: next }));
});

opacityBtn.addEventListener('click', async () => {
  const levels = [0, 25, 50, 75, 100];
  const nextTransparency = levels.find((level) => level > 100 - opacity) ?? 0;
  const next = 100 - nextTransparency;
  applyOpacity(next);
  applyConfig(await window.sysmon.updateConfig({ opacity: next }));
});

function applyMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  const labels = { standard: '标', compact: '简', detail: '详' };
  modeLabel.textContent = labels[mode];
  modeBtn.title = mode === 'standard' ? '标准模式（点击切换）' : mode === 'compact' ? '极简模式（点击切换）' : '详细模式（点击切换）';
}

modeBtn.addEventListener('click', () => {
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  applyMode(next);
});

applyMode('standard');

document.body.dataset.tone = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

window.sysmon.onConfig(applyConfig);
window.sysmon.onStats(render);
window.sysmon.getConfig().then(applyConfig);
window.sysmon.onGlassLuma((sample) => {
  if (!sample) return;
  const brightness = (sample.r * .2126 + sample.g * .7152 + sample.b * .0722) / 255;
  document.body.dataset.tone = brightness >= .52 ? 'light' : 'dark';
});
window.addEventListener('resize', drawSpark);
