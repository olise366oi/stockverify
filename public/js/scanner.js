/**
 * 扫码模块
 * 模式：摄像头预览 → 用户对准后按"拍照识别" → 定格当前帧 → 静态图片识别
 * 基于 html5-qrcode 库（内部用 ZXing），支持 EAN-13/CODE-128/QR 等一维/二维码
 */
const Scanner = (() => {
  let mediaStream = null;
  let videoEl = null;
  let containerEl = null;
  let isPreviewing = false;
  let html5QrCode = null; // 用于静态图片识别
  let lastCaptureTime = 0;
  const CAPTURE_COOLDOWN = 1500; // 拍照冷却，防止重复

  /**
   * 打开摄像头预览（不识别，只显示画面）
   * @param {string} elementId - 容器元素ID
   */
  async function startPreview(elementId) {
    if (isPreviewing) return;
    containerEl = document.getElementById(elementId);
    if (!containerEl) throw new Error('扫码容器不存在');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问，请使用最新版 Chrome/Safari');
    }

    // 清空容器，创建 video
    containerEl.innerHTML = '';
    videoEl = document.createElement('video');
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('autoplay', '');
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.style.objectFit = 'cover';
    videoEl.style.display = 'block';
    containerEl.appendChild(videoEl);

    // 叠加扫码框提示（窄一点，一维码更容易对准）
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5;';
    overlay.innerHTML = '<div style="border:2px dashed rgba(255,255,255,0.85);border-radius:10px;width:72%;height:50%;max-width:300px;max-height:260px;box-shadow:0 0 0 9999px rgba(0,0,0,0.35);"></div>';
    containerEl.appendChild(overlay);

    try {
      // 优先后置，失败回退默认；请求高分辨率
      const constraints = [
        { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
        { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: true, audio: false }
      ];
      let lastErr = null;
      for (const c of constraints) {
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia(c);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.warn('摄像头配置失败:', e);
        }
      }
      if (lastErr) throw lastErr;

      videoEl.srcObject = mediaStream;
      await videoEl.play();
      isPreviewing = true;

      // 初始化静态识别实例（用一个隐藏容器）
      if (!html5QrCode) {
        const hiddenDiv = document.createElement('div');
        hiddenDiv.id = 'hidden-qr-scanner-' + Date.now();
        hiddenDiv.style.display = 'none';
        document.body.appendChild(hiddenDiv);
        html5QrCode = new Html5Qrcode(hiddenDiv.id, { verbose: false });
      }
      return true;
    } catch (err) {
      console.error('启动摄像头失败:', err);
      isPreviewing = false;
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
      containerEl.innerHTML = '';
      videoEl = null;
      throw formatCameraError(err);
    }
  }

  /**
   * 检查是否支持原生 BarcodeDetector
   */
  function supportsBarcodeDetector() {
    return typeof BarcodeDetector !== 'undefined';
  }

  /**
   * 用原生 BarcodeDetector 识别（准确率最高）
   */
  async function detectWithBarcodeDetector(canvas) {
    try {
      const detector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'codabar', 'itf']
      });
      const codes = await detector.detect(canvas);
      if (codes && codes.length > 0) {
        return codes[0].rawValue;
      }
      return null;
    } catch (e) {
      console.warn('BarcodeDetector 失败:', e);
      return null;
    }
  }

  /**
   * 多种预处理方式重试识别（传入的已是扫码框区域放大图）
   */
  async function recognizeWithRetry(ctx, vw, vh) {
    const variants = [];

    // 1. 原图
    variants.push({ canvas: ctx.canvas, label: 'cropped' });

    // 2. 灰度+强对比度
    try {
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.drawImage(ctx.canvas, 0, 0);
      const id = cctx.getImageData(0, 0, vw, vh);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
        const e = g < 85 ? 0 : (g > 170 ? 255 : Math.round((g-85)*255/85));
        d[i] = d[i+1] = d[i+2] = e;
      }
      cctx.putImageData(id, 0, 0);
      variants.push({ canvas: c, label: 'gray-enhanced' });
    } catch (e) {}

    // 3. 再放大1.5倍
    try {
      const c = document.createElement('canvas');
      c.width = Math.round(vw * 1.5); c.height = Math.round(vh * 1.5);
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(ctx.canvas, 0, 0, c.width, c.height);
      variants.push({ canvas: c, label: 'zoom1.5' });
    } catch (e) {}

    // 4. 对每个变体尝试旋转90度和270度（一维码方向敏感）
    const allVariants = [];
    for (const v of variants) {
      allVariants.push(v);
      try {
        allVariants.push({ canvas: rotateCanvas(v.canvas, 90), label: v.label + '-r90' });
      } catch (e) {}
      try {
        allVariants.push({ canvas: rotateCanvas(v.canvas, -90), label: v.label + '-r270' });
      } catch (e) {}
    }

    // 依次尝试：优先 BarcodeDetector，降级 html5-qrcode
    const useBD = supportsBarcodeDetector();
    for (const v of allVariants) {
      if (useBD) {
        const r = await detectWithBarcodeDetector(v.canvas);
        if (r) {
          console.log('识别成功 (' + v.label + ', BarcodeDetector):', r);
          return r;
        }
      }
      const r2 = await tryRecognize(v.canvas);
      if (r2) {
        console.log('识别成功 (' + v.label + ', html5-qrcode):', r2);
        return r2;
      }
    }
    return null;
  }

  /**
   * 旋转 canvas
   */
  function rotateCanvas(srcCanvas, degrees) {
    const rad = degrees * Math.PI / 180;
    const w = srcCanvas.width, h = srcCanvas.height;
    const newW = Math.abs(Math.round(w * Math.cos(rad) + h * Math.sin(rad)));
    const newH = Math.abs(Math.round(w * Math.sin(rad) + h * Math.cos(rad)));
    const c = document.createElement('canvas');
    c.width = newW; c.height = newH;
    const ctx = c.getContext('2d');
    ctx.translate(newW / 2, newH / 2);
    ctx.rotate(rad);
    ctx.drawImage(srcCanvas, -w / 2, -h / 2);
    return c;
  }

  async function tryRecognize(canvas) {
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'capture.png', { type: 'image/png' });
      return await html5QrCode.scanFile(file, false);
    } catch (e) {
      return null;
    }
  }

  /**
   * 计算扫码框在视频帧中的实际坐标（考虑 object-fit: cover）
   */
  function getBoxFrameCoords() {
    if (!videoEl || !containerEl) return null;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;
    if (!vw || !vh || !cw || !ch) return null;

    // object-fit: cover 的缩放和偏移
    const scale = Math.max(cw / vw, ch / vh);
    const displayW = vw * scale;
    const displayH = vh * scale;
    const offsetX = (cw - displayW) / 2;
    const offsetY = (ch - displayH) / 2;

    // 扫码框在容器中的位置（72%宽 x 50%高，居中）
    const boxW = cw * 0.72;
    const boxH = ch * 0.50;
    const boxX = (cw - boxW) / 2;
    const boxY = (ch - boxH) / 2;

    // 转换到视频帧坐标
    const frameX = (boxX - offsetX) / scale;
    const frameY = (boxY - offsetY) / scale;
    const frameW = boxW / scale;
    const frameH = boxH / scale;

    // 边界保护
    return {
      x: Math.max(0, Math.round(frameX)),
      y: Math.max(0, Math.round(frameY)),
      w: Math.min(vw - Math.max(0, Math.round(frameX)), Math.round(frameW)),
      h: Math.min(vh - Math.max(0, Math.round(frameY)), Math.round(frameH))
    };
  }

  /**
   * 拍照定格当前帧并识别条码（只识别扫码框区域）
   * @returns {Promise<string|null>} 识别到的条码文本，失败返回 null
   */
  async function captureAndRecognize() {
    if (!isPreviewing || !videoEl) return null;
    const now = Date.now();
    if (now - lastCaptureTime < CAPTURE_COOLDOWN) return null;
    lastCaptureTime = now;

    try {
      const vw = videoEl.videoWidth || 640;
      const vh = videoEl.videoHeight || 480;

      // 完整帧 canvas（用于定格显示）
      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = vw;
      fullCanvas.height = vh;
      const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
      fullCtx.drawImage(videoEl, 0, 0, vw, vh);

      // 计算扫码框在视频帧中的位置
      const box = getBoxFrameCoords();
      let cropCanvas, cropCtx, cropW, cropH;

      if (box && box.w > 20 && box.h > 20) {
        // 只裁剪扫码框区域，放大3倍
        const zoom = 3;
        cropW = box.w * zoom;
        cropH = box.h * zoom;
        cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropW;
        cropCanvas.height = cropH;
        cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
        cropCtx.imageSmoothingEnabled = true;
        cropCtx.imageSmoothingQuality = 'high';
        cropCtx.drawImage(fullCanvas, box.x, box.y, box.w, box.h, 0, 0, cropW, cropH);
      } else {
        //  fallback：用完整帧
        cropCanvas = fullCanvas;
        cropCtx = fullCtx;
        cropW = vw;
        cropH = vh;
      }

      // 定格效果：显示裁剪后的区域
      const snapshot = document.createElement('img');
      snapshot.src = cropCanvas.toDataURL('image/jpeg', 0.95);
      snapshot.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:10;background:#000;';
      containerEl.appendChild(snapshot);

      // 识别（多种预处理重试）
      const decodedText = await recognizeWithRetry(cropCtx, cropW, cropH);

      if (decodedText) {
        if (navigator.vibrate) navigator.vibrate(100);
        setTimeout(() => { if (snapshot.parentNode) snapshot.remove(); }, 600);
        return decodedText.trim();
      } else {
        setTimeout(() => { if (snapshot.parentNode) snapshot.remove(); }, 1200);
        return null;
      }
    } catch (err) {
      console.error('拍照识别异常:', err);
      return null;
    }
  }

  /**
   * 停止摄像头预览
   */
  async function stopPreview() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl = null;
    }
    if (containerEl) {
      containerEl.innerHTML = '';
    }
    isPreviewing = false;
  }

  function getIsPreviewing() {
    return isPreviewing;
  }

  function formatCameraError(err) {
    let msg = '无法启动摄像头';
    let detail = '';
    if (err && err.name) {
      switch (err.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          msg = '摄像头权限被拒绝';
          detail = '请在浏览器设置中允许此网站访问摄像头，然后刷新页面重试。\niOS：设置 → Safari → 摄像头 → 允许';
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          msg = '未检测到摄像头设备';
          detail = '请确认设备有可用摄像头';
          break;
        case 'NotReadableError':
        case 'TrackStartError':
          msg = '摄像头被占用';
          detail = '请关闭其他使用摄像头的应用（如微信、相机）后重试';
          break;
        case 'OverconstrainedError':
          msg = '摄像头不支持请求的参数';
          detail = '请尝试刷新页面';
          break;
        case 'TypeError':
          msg = '当前环境不支持摄像头';
          detail = '请确认通过 HTTPS 或 localhost 访问（PWA 需重新添加到主屏幕）';
          break;
        default:
          msg = '摄像头启动失败';
          detail = err.message || err.name || '未知错误';
      }
    } else if (err && err.message) {
      detail = err.message;
    }
    return new Error(detail ? msg + '：' + detail : msg);
  }

  // 兼容旧接口
  async function start(elementId, callback) {
    await startPreview(elementId);
    // 旧接口：启动后自动持续拍照识别（每2秒一次）
    const interval = setInterval(async () => {
      if (!isPreviewing) { clearInterval(interval); return; }
      const result = await captureAndRecognize();
      if (result && callback) callback(result);
    }, 2000);
  }
  async function stop() { await stopPreview(); }

  return { startPreview, captureAndRecognize, stopPreview, getIsPreviewing, start, stop };
})();
