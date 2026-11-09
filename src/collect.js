'use strict';

/**
 * 数据采集层
 * 按不同频率采集 CPU / 网络 / GPU / 内存 / 运行时间 / 温度，汇总成一份 state 快照。
 * 采集失败时不抛错，只把对应字段置为 null，UI 显示为「—」。
 */

const { execFile } = require('child_process');
const si = require('systeminformation');

const NUM = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);

const state = {
  ts: 0,
  cpu: { load: 0, brand: '', cores: 0, threads: 0, speed: 0, temp: null },
  net: { rx: 0, tx: 0, iface: '', totalRx: null, totalTx: null, latency: null, online: false, tunRx: 0, tunTx: 0, tunIface: '', tunOnline: false },
  gpu: { name: '', load: null, vramUsed: null, vramTotal: null, temp: null, source: 'none' },
  memory: { used: null, total: null, load: null },
  uptime: null,
};

/* ------------------------------------------------------------------ */
/* 子进程工具                                                           */
/* ------------------------------------------------------------------ */

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout).trim();
      resolve(out.length ? out : null);
    });
  });
}

/** 执行一段 PowerShell，返回去空白后的输出；失败返回 null */
function runPS(script, timeout = 8000) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeout,
  );
}

function parseNum(text) {
  if (text === null || text === undefined) return null;
  const v = Number(String(text).trim());
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* CPU                                                                  */
/* ------------------------------------------------------------------ */

async function initCpu() {
  try {
    const cpu = await si.cpu();
    state.cpu.brand = [cpu.manufacturer, cpu.brand].filter(Boolean).join(' ').trim();
    state.cpu.cores = cpu.physicalCores || 0;
    state.cpu.threads = cpu.cores || 0;
  } catch { /* ignore */ }

  try {
    const load = await si.currentLoad();
    if (!state.cpu.threads && Array.isArray(load.cpus)) state.cpu.threads = load.cpus.length;
  } catch { /* ignore */ }
}

async function readCpuLoad() {
  try {
    const load = await si.currentLoad();
    state.cpu.load = round(NUM(load.currentLoad) ?? 0, 1);
  } catch { /* 保留上一次的值 */ }
}

async function readCpuSpeed() {
  try {
    const s = await si.cpuCurrentSpeed();
    const avg = NUM(s.avg);
    if (avg !== null) state.cpu.speed = round(avg, 2);
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 网络                                                                 */
/* ------------------------------------------------------------------ */

let ifaceFilter = null;
let tunIfaces = [];
let netTotals = { rx: 0, tx: 0 };
const netCounters = new Map();
let netLatencyBusy = false;

function selectedNetworkStats() {
  // 不传参数只会采集 systeminformation 选定的默认网卡。本机默认是虚拟
  // Meta，而实际流量在 WLAN，因此必须显式传入物理网卡名称。
  const names = [...new Set([...(ifaceFilter || []), ...tunIfaces])];
  return si.networkStats(names.length ? names.join(',') : '*');
}

function looksLikeClashTun(name) {
  return /clash|mihomo|wintun|tun|tap/i.test(String(name || ''));
}

async function initNet() {
  try {
    const raw = await si.networkInterfaces();
    const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
    const physical = list
      .filter((i) => i.operstate === 'up' && !i.virtual && !i.internal && i.iface)
      .map((i) => i.iface);
    ifaceFilter = physical.length ? physical : null;
    tunIfaces = list
      .filter((i) => i.operstate === 'up' && i.iface && (i.virtual || looksLikeClashTun(i.iface)))
      .map((i) => i.iface);
  } catch {
    ifaceFilter = null;
    tunIfaces = [];
  }
  // 预热：systeminformation 首次调用拿不到速率，需要先建立一个基线
  try { await selectedNetworkStats(); } catch { /* ignore */ }
}

async function readNet() {
  try {
    const raw = await selectedNetworkStats();
    const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
    const up = list.filter((i) => i.operstate === 'up' && (i.rx_sec >= 0 || i.tx_sec >= 0));
    const picked = ifaceFilter ? up.filter((i) => ifaceFilter.includes(i.iface)) : up;
    const tun = tunIfaces.length ? up.filter((i) => tunIfaces.includes(i.iface)) : [];

    let rx = 0;
    let tx = 0;
    for (const i of picked) {
      rx += Math.max(0, NUM(i.rx_sec) ?? 0);
      tx += Math.max(0, NUM(i.tx_sec) ?? 0);
    }
    let tunRx = 0;
    let tunTx = 0;
    for (const i of tun) {
      tunRx += Math.max(0, NUM(i.rx_sec) ?? 0);
      tunTx += Math.max(0, NUM(i.tx_sec) ?? 0);
    }

    state.net.rx = round(rx, 0) ?? 0;
    state.net.tx = round(tx, 0) ?? 0;
    state.net.iface = picked.length ? picked[0].iface : '';
    state.net.tunRx = round(tunRx, 0) ?? 0;
    state.net.tunTx = round(tunTx, 0) ?? 0;
    state.net.tunIface = tun.length ? tun[0].iface : '';
    state.net.tunOnline = tun.length > 0;
    state.net.online = picked.length > 0;
    for (const i of picked) {
      const previous = netCounters.get(i.iface);
      const current = { rx: NUM(i.rx_bytes), tx: NUM(i.tx_bytes) };
      if (previous) {
        if (current.rx !== null && previous.rx !== null && current.rx >= previous.rx) netTotals.rx += current.rx - previous.rx;
        if (current.tx !== null && previous.tx !== null && current.tx >= previous.tx) netTotals.tx += current.tx - previous.tx;
      }
      netCounters.set(i.iface, current);
    }
    state.net.totalRx = netTotals.rx;
    state.net.totalTx = netTotals.tx;
  } catch { /* 保留上一次的值 */ }
}

async function readLatency() {
  if (netLatencyBusy) return;
  netLatencyBusy = true;
  try {
    const out = await run('ping', ['-n', '1', '-w', '1200', '1.1.1.1'], 2500);
    const match = out && out.match(/(?:[=<])\s*(\d+)\s*ms/i);
    state.net.latency = match ? Number(match[1]) : null;
  } catch {
    state.net.latency = null;
  } finally {
    netLatencyBusy = false;
  }
}

/* ------------------------------------------------------------------ */
/* GPU                                                                  */
/* ------------------------------------------------------------------ */

let gpuSource = 'none'; // 'nvidia-smi' | 'counter' | 'none'

// WMI 的类名/属性名是英文的，不受系统语言影响；第二个分支兼容老驱动
const PS_GPU_3D =
  "$s = (Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples; " +
  "if ($s) { [math]::Round(($s | Measure-Object -Property CookedValue -Sum).Sum, 1).ToString([cultureinfo]::InvariantCulture) } else { 'NA' }";

const NV_FIELDS = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu';

async function readNvidiaSmi() {
  const out = await run('nvidia-smi', ['--query-gpu=' + NV_FIELDS, '--format=csv,noheader,nounits'], 5000);
  if (!out) return null;
  const parts = out.split(/\r?\n/)[0].split(',').map((s) => s.trim());
  if (parts.length < 5) return null;
  return {
    name: parts[0],
    load: parseNum(parts[1]),
    vramUsed: parseNum(parts[2]),
    vramTotal: parseNum(parts[3]),
    temp: parseNum(parts[4]),
  };
}

async function readGpuCounter() {
  const out = await runPS(PS_GPU_3D, 7000);
  if (!out) return null;
  const v = parseNum(out.split(/\r?\n/).pop());
  return v === null ? null : { load: Math.max(0, Math.min(100, v)) };
}

function applyNvidia(nv) {
  if (nv.name) state.gpu.name = nv.name;
  state.gpu.load = nv.load;
  if (nv.vramUsed !== null) state.gpu.vramUsed = nv.vramUsed;
  if (nv.vramTotal) state.gpu.vramTotal = nv.vramTotal;
  if (nv.temp !== null) state.gpu.temp = nv.temp;
}

async function initGpu() {
  // 1) 型号 / 显存：systeminformation 在 Windows 上通常能拿到
  try {
    const g = await si.graphics();
    const controllers = g.controllers || [];
    const ctrl = controllers.find((c) => !/virtual|oray|idd|remote|basic display/i.test(c.model || '') && NUM(c.vram) > 0)
      || controllers.find((c) => !/virtual|oray|idd|remote|basic display/i.test(c.model || ''));
    if (ctrl) {
      state.gpu.name = ctrl.model || ctrl.name || '';
      const total = NUM(ctrl.vram) ?? NUM(ctrl.memoryTotal);
      if (total) state.gpu.vramTotal = Math.round(total);
      const used = NUM(ctrl.memoryUsed);
      if (used) state.gpu.vramUsed = Math.round(used);
    }
  } catch { /* ignore */ }

  // 2) 利用率来源：nvidia-smi 优先（毫秒级），否则退回 Windows 性能计数器
  const nv = await readNvidiaSmi();
  if (nv) {
    gpuSource = 'nvidia-smi';
    applyNvidia(nv);
    state.gpu.source = gpuSource;
    return;
  }

  const counter = await readGpuCounter();
  gpuSource = counter ? 'counter' : 'none';
  state.gpu.source = gpuSource;
  if (counter) state.gpu.load = counter.load;
}

async function readGpu() {
  if (gpuSource === 'nvidia-smi') {
    const nv = await readNvidiaSmi();
    if (nv) {
      applyNvidia(nv);
    } else {
      gpuSource = 'none';
      state.gpu.source = gpuSource;
    }
    return;
  }

  if (gpuSource === 'counter') {
    const c = await readGpuCounter();
    if (c) state.gpu.load = c.load;
    else {
      gpuSource = 'none';
      state.gpu.source = gpuSource;
      state.gpu.load = null;
    }
    return;
  }

  // 之前探测不到来源，偶尔重试（驱动刚起来 / 刚接上独显）
  const nv = await readNvidiaSmi();
  if (nv) {
    gpuSource = 'nvidia-smi';
    state.gpu.source = gpuSource;
    applyNvidia(nv);
  } else {
    const counter = await readGpuCounter();
    if (counter) {
      gpuSource = 'counter';
      state.gpu.source = gpuSource;
      state.gpu.load = counter.load;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 内存 / 运行时间 / 温度                                                */
/* ------------------------------------------------------------------ */

async function readMemory() {
  try {
    const m = await si.mem();
    state.memory.total = Math.round((NUM(m.total) ?? 0) / 1024 / 1024);
    state.memory.used = Math.round((NUM(m.active) ?? NUM(m.used) ?? 0) / 1024 / 1024);
    state.memory.load = state.memory.total > 0 ? round((state.memory.used / state.memory.total) * 100, 1) : null;
  } catch { /* ignore */ }
}

async function readUptime() {
  try {
    const t = await si.time();
    state.uptime = Math.max(0, Math.round(NUM(t.uptime) ?? 0));
  } catch { /* ignore */ }
}

const PS_CPU_TEMP =
  "$t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue; " +
  "if ($t) { [math]::Round((($t | Measure-Object -Property CurrentTemperature -Maximum).Maximum / 10) - 273.15, 0) } else { 'NA' }";

let thermalFallbackEnabled = true;

async function readTemp() {
  try {
    const t = await si.cpuTemperature();
    const main = NUM(t && t.main);
    if (main !== null && main > 0) {
      state.cpu.temp = round(main, 0);
      return;
    }
  } catch { /* ignore */ }

  if (!thermalFallbackEnabled) return;

  const v = parseNum(await runPS(PS_CPU_TEMP, 9000));
  if (v !== null && v > 0 && v < 150) {
    state.cpu.temp = Math.round(v);
  } else {
    // WMI 热区在多数机器上不可用（需要管理员权限 + 厂商支持），只试一次就不再折腾
    thermalFallbackEnabled = false;
    state.cpu.temp = null;
  }
}

/* ------------------------------------------------------------------ */
/* 调度器                                                               */
/* ------------------------------------------------------------------ */

const JOBS = [
  { name: 'cpuLoad', every: 1000, initial: 0, run: readCpuLoad },
  { name: 'net', every: 1000, initial: 0, run: readNet },
  { name: 'netIfaces', every: 30000, initial: 30000, run: initNet },
  { name: 'latency', every: 10000, initial: 1200, run: readLatency },
  { name: 'cpuSpeed', every: 3000, initial: 300, run: readCpuSpeed },
  { name: 'gpu', every: 5000, initial: 800, run: readGpu },
  { name: 'memory', every: 2000, initial: 400, run: readMemory },
  { name: 'uptime', every: 10000, initial: 700, run: readUptime },
  { name: 'temp', every: 15000, initial: 1500, run: readTemp },
];

/**
 * 启动采集循环。
 * @param {(snapshot: object) => void} onTick 每秒回调一次最新快照
 * @param {(snapshot: object) => void} [onReady] 首批静态信息（型号等）就绪时回调一次
 * @returns {() => void} 停止函数
 */
function start(onTick, onReady) {
  const jobs = JOBS.map((j) => ({ ...j, nextAt: Date.now() + j.initial, busy: false }));
  let stopped = false;

  Promise.all([initCpu(), initNet(), readMemory(), readUptime()])
    .then(initGpu)
    .then(() => {
      if (!stopped && typeof onReady === 'function') onReady(state);
      readTemp(); // 温度采集较重，放到最后且不阻塞首屏
    })
    .catch(() => {});

  const timer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    for (const job of jobs) {
      if (job.busy || now < job.nextAt) continue;
      job.busy = true;
      job.nextAt = now + job.every;
      Promise.resolve()
        .then(job.run)
        .catch(() => {})
        .then(() => { job.busy = false; });
    }
    state.ts = now;
    try { onTick(state); } catch { /* ignore */ }
  }, 1000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { start, state };
