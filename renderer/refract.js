'use strict';

// 窗口隐藏时取得干净底图；先连续柔化，再由 WebGL 绘制边缘折射。
// 仅在圆角卡片内部渲染，避免系统 Acrylic 的矩形外沿。
const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_origin;
uniform vec2 u_scale;
uniform vec2 u_texel;
uniform vec2 u_size;
uniform float u_centerAlpha;
uniform float u_liveEdge;
uniform vec4 u_edgeAvailable;

vec3 scene(vec2 p) {
  vec2 uv = u_origin + p * u_scale;
  vec2 stepSize = u_texel * 2.0;
  vec3 sum = vec3(0.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      float wx = x == 0 ? 2.0 : 1.0;
      float wy = y == 0 ? 2.0 : 1.0;
      sum += texture2D(u_tex, clamp(uv + vec2(float(x), float(y)) * stepSize, vec2(0.0), vec2(1.0))).rgb * wx * wy;
    }
  }
  return sum / 16.0;
}

void main() {
  vec2 p = (v_uv - 0.5) * u_size;
  vec2 q = abs(p) - (u_size * 0.5 - vec2(24.0));
  float signedDistance = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - 24.0;
  float edge = -signedDistance;
  float rim = 1.0 - smoothstep(0.0, 24.0, edge);
  vec2 outward = normalize(v_uv - 0.5 + vec2(0.0001));
  vec2 bent = v_uv + outward * rim * 0.026;
  if (u_liveEdge > 0.5) {
    vec2 distanceToSide = min(v_uv, vec2(1.0) - v_uv);
    vec2 outside = vec2(45.0) / u_size;
    if (distanceToSide.x < distanceToSide.y) {
      bool useLeft = v_uv.x < 0.5 ? u_edgeAvailable.x > 0.5 : u_edgeAvailable.y < 0.5;
      bent.x = useLeft ? -outside.x : 1.0 + outside.x;
      bent.y = v_uv.y;
    } else {
      bool useBottom = v_uv.y < 0.5 ? u_edgeAvailable.z > 0.5 : u_edgeAvailable.w < 0.5;
      bent.y = useBottom ? -outside.y : 1.0 + outside.y;
      bent.x = v_uv.x;
    }
  }
  vec3 color = scene(bent);
  float center = smoothstep(10.0, 58.0, edge);
  gl_FragColor = vec4(color, mix(1.0, u_centerAlpha, center));
}`;


function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Glass shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vert || !frag) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function bootRefraction() {
  const canvas = document.getElementById('refract');
  const card = document.querySelector('.card');
  const api = window.sysmon;
  if (!canvas || !card || !api?.onScreenFrame) return;

  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
  });
  const program = gl && buildProgram(gl);
  if (!program) return;
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const u = {
    tex: gl.getUniformLocation(program, 'u_tex'),
    origin: gl.getUniformLocation(program, 'u_origin'),
    scale: gl.getUniformLocation(program, 'u_scale'),
    texel: gl.getUniformLocation(program, 'u_texel'),
    size: gl.getUniformLocation(program, 'u_size'),
    centerAlpha: gl.getUniformLocation(program, 'u_centerAlpha'),
    liveEdge: gl.getUniformLocation(program, 'u_liveEdge'),
    edgeAvailable: gl.getUniformLocation(program, 'u_edgeAvailable'),
  };
  gl.uniform1i(u.tex, 0);

  let frame = null;
  let softenedFrame = null;
  let frameInfo = null;
  let baseFrame = null;
  let baseSoftenedFrame = null;
  let baseFrameInfo = null;
  let pending = null;
  let decoding = false;
  let textureChanged = false;
  let positionChanged = false;
  let appearanceChanged = false;
  let centerAlpha = 1;
  let liveEdge = false;
  let latestWindow = null;
  let stopped = false;
  let drawFrame = 0;
  let toneTimer = 0;
  let liveStream = null;
  let liveVideo = null;
  let liveFrameCallback = 0;
  let liveGeneration = 0;
  let liveStarting = false;
  let wantsLiveEdge = false;
  let lastLivePaint = 0;
  const liveCanvas = document.createElement('canvas');
  const liveCtx = liveCanvas.getContext('2d', { alpha: false });
  const toneCanvas = document.createElement('canvas');
  toneCanvas.width = 8;
  toneCanvas.height = 8;
  const toneCtx = toneCanvas.getContext('2d', { willReadFrequently: true });
  function frameUV(info) {
    const c = info.capture;
    const w = info.window;
    return {
      origin: [(w.x - c.x) / c.width, (c.y + c.height - w.y - w.height) / c.height],
      scale: [w.width / c.width, w.height / c.height],
      source: [(w.x - c.x) / c.width, (w.y - c.y) / c.height],
    };
  }

  function updateLocalTones(image, info) {
    if (!toneCtx) return;
    const scaleX = info.window.width / window.innerWidth;
    const scaleY = info.window.height / window.innerHeight;
    const elements = document.querySelectorAll('.metric, .metric .name, .metric .val, .metric .sub, .titlebar .title, .titlebar .icon-btn');
    for (const element of elements) {
      if (element.getClientRects().length === 0) continue;
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left - 5);
      const top = Math.max(0, rect.top - 4);
      const width = Math.min(window.innerWidth - left, rect.width + 10);
      const height = Math.min(window.innerHeight - top, rect.height + 8);
      const sx = (info.window.x - info.capture.x + left * scaleX) / info.capture.width * image.width;
      const sy = (info.window.y - info.capture.y + top * scaleY) / info.capture.height * image.height;
      const sw = width * scaleX / info.capture.width * image.width;
      const sh = height * scaleY / info.capture.height * image.height;
      try {
        toneCtx.clearRect(0, 0, 8, 8);
        toneCtx.drawImage(image, sx, sy, sw, sh, 0, 0, 8, 8);
        const pixels = toneCtx.getImageData(0, 0, 8, 8).data;
        let brightness = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          brightness += (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 255;
        }
        brightness /= 64;
        const threshold = element.dataset.localTone === 'light' ? .36 : .43;
        element.dataset.localTone = brightness >= threshold ? 'light' : 'dark';
      } catch { /* 保留上一次可读配色 */ }
    }
  }

  function updateTone() {
    if (!frame || !frameInfo || !toneCtx) return;
    const uv = frameUV(frameInfo);
    const imageWidth = frame.videoWidth || frame.width;
    const imageHeight = frame.videoHeight || frame.height;
    let sx = Math.max(0, uv.source[0] * imageWidth);
    let sy = Math.max(0, uv.source[1] * imageHeight);
    let sw = Math.max(1, uv.scale[0] * imageWidth);
    let sh = Math.max(1, uv.scale[1] * imageHeight);
    if (liveEdge) {
      const c = frameInfo.capture;
      const w = frameInfo.window;
      const offset = 50 * (window.devicePixelRatio || 1);
      const sampleX = w.x - c.x >= offset ? w.x - offset : w.x + w.width + offset;
      sx = (sampleX - c.x) / c.width * imageWidth;
      sy = (w.y + w.height / 2 - c.y) / c.height * imageHeight;
      sw = 8;
      sh = 8;
    }
    try {
      toneCtx.drawImage(frame, sx, sy, sw, sh, 0, 0, 8, 8);
      const pixels = toneCtx.getImageData(0, 0, 8, 8).data;
      let brightness = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        brightness += (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 255;
      }
      brightness /= 64;
      if (brightness > .59) document.body.dataset.tone = 'light';
      else if (brightness < .43) document.body.dataset.tone = 'dark';
    } catch { /* 取色失败时保留系统配色 */ }
  }

  function decodeNext() {
    if (decoding || !pending || stopped) return;
    decoding = true;
    const payload = pending;
    pending = null;
    const image = new Image();
    image.onload = () => {
      if (!stopped) {
        frame = image;
        const softened = document.createElement('canvas');
        softened.width = Math.max(1, Math.ceil(image.naturalWidth / 2));
        softened.height = Math.max(1, Math.ceil(image.naturalHeight / 2));
        const softCtx = softened.getContext('2d', { alpha: false });
        softCtx.filter = payload.liveEdge ? 'blur(2px)' : 'blur(9px)';
        softCtx.drawImage(image, 0, 0, softened.width, softened.height);
        softenedFrame = softened;
        frameInfo = { capture: payload.capture, window: latestWindow || payload.window };
        liveEdge = !!payload.liveEdge;
        if (!liveEdge) {
          baseFrame = frame;
          baseSoftenedFrame = softenedFrame;
          baseFrameInfo = frameInfo;
        }
        textureChanged = true;
        positionChanged = true;
        card.classList.add('has-refract');
        updateTone();
        if (liveEdge) document.querySelectorAll('[data-local-tone]').forEach((element) => element.removeAttribute('data-local-tone'));
        else updateLocalTones(frame, frameInfo);
        scheduleDraw();
      }
      decoding = false;
      decodeNext();
    };
    image.onerror = () => { decoding = false; decodeNext(); };
    image.src = 'data:image/jpeg;base64,' + payload.data;
  }

  const unsubscribe = api.onScreenFrame((payload) => {
    if (!payload?.data || !payload.capture || !payload.window) return;
    if (liveStream) return;
    pending = payload;
    decodeNext();
  });
  const unsubscribeEdge = api.onEdgeFrame((payload) => {
    if (!payload?.data || !payload.capture || !payload.window) return;
    if (liveStream) return;
    pending = { ...payload, liveEdge: true };
    document.body.dataset.edgeSource = 'fallback';
    decodeNext();
  });

  function stopLiveEdge() {
    liveGeneration += 1;
    if (liveVideo && liveFrameCallback) liveVideo.cancelVideoFrameCallback(liveFrameCallback);
    liveFrameCallback = 0;
    if (liveStream) liveStream.getTracks().forEach((track) => track.stop());
    liveStream = null;
    liveVideo = null;
    liveStarting = false;
    delete document.body.dataset.edgeSource;
    api.stopEdgeFallback();
    if (!wantsLiveEdge && baseFrame) {
      frame = baseFrame;
      softenedFrame = baseSoftenedFrame;
      frameInfo = { ...baseFrameInfo, window: latestWindow || baseFrameInfo.window };
      liveEdge = false;
      textureChanged = true;
      positionChanged = true;
      updateTone();
      updateLocalTones(frame, frameInfo);
      scheduleDraw();
    }
  }

  async function startLiveEdge() {
    if (stopped || document.hidden || !wantsLiveEdge || liveStarting || liveStream) return;
    liveStarting = true;
    const generation = ++liveGeneration;
    let stream = null;
    try {
      const source = await api.getLiveScreenSource();
      if (!source) throw new Error('未找到屏幕视频源');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: {
          chromeMediaSource: 'desktop', chromeMediaSourceId: source.id,
          maxWidth: 720, maxHeight: 450, maxFrameRate: 12,
        } },
      });
      if (generation !== liveGeneration || document.hidden || !wantsLiveEdge) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      liveStream = stream;
      liveVideo = video;
      document.body.dataset.edgeSource = 'video';
      api.stopEdgeFallback();
      const receiveFrame = (now) => {
        if (generation !== liveGeneration || stopped || !liveVideo) return;
        liveFrameCallback = video.requestVideoFrameCallback(receiveFrame);
        if (now - lastLivePaint < 80) return;
        lastLivePaint = now;
        const width = Math.max(1, Math.ceil(video.videoWidth / 2));
        const height = Math.max(1, Math.ceil(video.videoHeight / 2));
        if (liveCanvas.width !== width) liveCanvas.width = width;
        if (liveCanvas.height !== height) liveCanvas.height = height;
        liveCtx.filter = 'blur(2px)';
        liveCtx.drawImage(video, 0, 0, liveCanvas.width, liveCanvas.height);
        frame = video;
        softenedFrame = liveCanvas;
        frameInfo = { capture: source.capture, window: latestWindow || source.window };
        liveEdge = true;
        textureChanged = true;
        positionChanged = true;
        card.classList.add('has-refract');
        updateTone();
        document.querySelectorAll('[data-local-tone]').forEach((element) => element.removeAttribute('data-local-tone'));
        scheduleDraw();
      };
      liveFrameCallback = video.requestVideoFrameCallback(receiveFrame);
    } catch (error) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (generation === liveGeneration && wantsLiveEdge && !document.hidden) {
        console.warn('Live glass edge:', error.message);
        api.startEdgeFallback();
      }
    } finally {
      if (generation === liveGeneration) liveStarting = false;
    }
  }
  const unsubscribeRect = api.onScreenRect((info) => {
    if (!info?.physicalWindow) return;
    latestWindow = info.physicalWindow;
    if (!frameInfo) return;
    frameInfo.window = latestWindow;
    positionChanged = true;
    scheduleDraw();
    if (!toneTimer) {
      toneTimer = setTimeout(() => {
        toneTimer = 0;
        if (!stopped && frame && frameInfo) {
          updateTone();
          if (!liveEdge) updateLocalTones(frame, frameInfo);
        }
      }, 150);
    }
  });

  function applyGlassConfig(config) {
    if (!config) return;
    // “透”模式中心直接透出当前桌面；静态底图只负责圆角边缘的柔化与折射。
    centerAlpha = config.theme === 'clear' ? 0 : 1;
    wantsLiveEdge = config.theme === 'clear';
    if (wantsLiveEdge) startLiveEdge();
    else stopLiveEdge();
    appearanceChanged = true;
    scheduleDraw();
  }
  const unsubscribeConfig = api.onConfig(applyGlassConfig);
  api.getConfig().then(applyGlassConfig).catch(() => {});

  function scheduleDraw() {
    if (drawFrame || stopped) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      draw();
    });
  }

  function draw() {
    if (stopped) return;
    if (document.hidden) return;
    if (!frame || !frameInfo) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    let resized = false;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      resized = true;
    }
    const needsDraw = textureChanged || positionChanged || appearanceChanged || resized;
    if (textureChanged) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, softenedFrame);
      textureChanged = false;
    }
    if (!needsDraw) return;
    positionChanged = false;
    appearanceChanged = false;

    const uv = frameUV(frameInfo);
    gl.uniform2f(u.origin, uv.origin[0], uv.origin[1]);
    gl.uniform2f(u.scale, uv.scale[0], uv.scale[1]);
    gl.uniform2f(u.texel, 1 / softenedFrame.width, 1 / softenedFrame.height);
    gl.uniform2f(u.size, canvas.clientWidth, canvas.clientHeight);
    gl.uniform1f(u.centerAlpha, centerAlpha);
    gl.uniform1f(u.liveEdge, liveEdge ? 1 : 0);
    const c = frameInfo.capture;
    const w = frameInfo.window;
    const margin = 50 * dpr;
    gl.uniform4f(u.edgeAvailable,
      w.x - c.x > margin ? 1 : 0,
      c.x + c.width - w.x - w.width > margin ? 1 : 0,
      c.y + c.height - w.y - w.height > margin ? 1 : 0,
      w.y - c.y > margin ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const resizeObserver = new ResizeObserver(scheduleDraw);
  resizeObserver.observe(canvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLiveEdge();
    else if (wantsLiveEdge) startLiveEdge();
  });

  window.addEventListener('pagehide', () => {
    stopped = true;
    unsubscribe();
    unsubscribeEdge();
    unsubscribeRect();
    unsubscribeConfig();
    stopLiveEdge();
    clearTimeout(toneTimer);
    cancelAnimationFrame(drawFrame);
    resizeObserver.disconnect();
    gl.deleteTexture(texture);
    gl.deleteBuffer(quad);
    gl.deleteProgram(program);
  });
}

window.sysmon.getConfig().then((config) => {
  if (!config.nativeGlass) bootRefraction();
}).catch(bootRefraction);
