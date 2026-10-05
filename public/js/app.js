/**
 * 主应用逻辑（合作商家端）
 * StockVerify SG · 新加坡零售核销与对账系统
 * 合作商家扫码出入库 · 入库自动核对品牌方发货单（√/×） · 售价/成本按商品档案 · 三语
 */
const App = (() => {
  // ========== 状态 ==========
  let currentUser = null;
  let currentShop = null;
  let currentView = 'dashboard';
  let scanType = 'outbound'; // inbound / outbound
  let currentScanProduct = null;
  let currentDiscount = { type: 'none', medical: null, social: null }; // 活动折扣：类型 + 两张凭证图(base64)
  let reportData = [];
  let shipmentDetailId = null; // 正在查看的发货单
  let lastLang = null;         // 记录已应用的语言，避免重复重渲染
  const FIXED_PRICE = 188; // 缺省标价（实际以商品档案 sell_price 为准）

  // ========== 初始化 ==========
  async function init() {
    // 三语初始化
    I18n.init();
    // 语言真正变化后才重渲染动态内容
    window.__onLangChange = (lang) => {
      updateOfflineBar(0);
      if (lang === lastLang) return;
      lastLang = lang;
      if (currentUser) {
        renderNav();
        if (currentView) navigate(currentView, true);
      }
    };

    // 注册 Service Worker
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch (e) {
        console.warn('Service Worker 注册失败:', e);
      }
    }

    // 检查登录状态
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    const shopStr = localStorage.getItem('shop');

    if (token && userStr && shopStr) {
      currentUser = JSON.parse(userStr);
      currentShop = JSON.parse(shopStr);
      Finance.setConfig({ gstRate: currentShop.gstRate });
      showApp();
    } else {
      showLogin();
    }

    // 绑定事件
    bindEvents();

    // 初始化同步管理器
    SyncManager.init((count) => {
      updateOfflineBar(count);
    });
  }

  // ========== 页面切换 ==========
  function showLogin() {
    document.getElementById('page-login').classList.add('active');
    document.getElementById('page-app').classList.remove('active');
    document.getElementById('login-password').value = '';
    document.getElementById('login-username').value = '';
  }

  function showApp() {
    document.getElementById('page-login').classList.remove('active');
    document.getElementById('page-app').classList.add('active');

    // 更新头部信息（店铺名 + 当前账号 + 身份）
    document.getElementById('header-shop-name').textContent = currentShop.name;
    document.getElementById('header-user-name').textContent = currentUser.username;
    const roleText = { merchant: I18n.t('role_merchant'), staff: I18n.t('role_staff') };
    document.getElementById('header-user-role').textContent = roleText[currentUser.role] || currentUser.role;

    // 先定视图再渲染导航（避免误触发旧视图重渲染）
    applyPermissions();
    lastLang = I18n.getLang();
    currentView = 'dashboard';
    renderNav();
    navigate('dashboard');
  }

  function applyPermissions() {
    const isStaff = currentUser.role === 'staff';
    // 店员不能添加/删除商品
    const addBtn = document.getElementById('btn-add-product');
    if (addBtn) addBtn.style.display = isStaff ? 'none' : 'flex';
    const batchArea = document.getElementById('batch-import-area');
    if (batchArea) batchArea.classList.toggle('hidden', isStaff);
  }

  // ========== 底部导航（合作商家） ==========
  function renderNav() {
    const nav = document.getElementById('bottom-nav');
    if (!nav) return;
    let html = '';
    const item = (view, key, icon) => `
      <button class="nav-item" data-view="${view}" onclick="App.navigate('${view}')">
        ${icon}
        <span data-i18n="${key}"></span>
      </button>`;
    html += item('dashboard', 'nav_home', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>');
    html += item('scan-outbound', 'nav_scan', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2M7 12h10"/></svg>');
    html += item('products', 'nav_products', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>');
    html += item('reports', 'nav_reports', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>');
    html += item('purchase', 'nav_purchase', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293a1 1 0 00.707 1.707H19M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z"/></svg>');
    html += item('shipments', 'nav_shipments', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>');
    html += item('settings', 'nav_settings', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>');
    nav.innerHTML = html;
    I18n.apply();
  }

  function navigate(view, skipReload) {
    // 扫码视图特殊处理
    if (view === 'scan-inbound' || view === 'scan-outbound') {
      scanType = view === 'scan-inbound' ? 'inbound' : 'outbound';
      document.getElementById('scan-title').textContent = scanType === 'inbound' ? I18n.t('scan_inbound_title') : I18n.t('scan_outbound_title');
      document.getElementById('confirm-qty-label').textContent = scanType === 'inbound' ? I18n.t('qty_label_in') : I18n.t('qty_label_out');
      view = 'scan';
    }

    currentView = view;

    // 隐藏所有视图
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // 显示目标视图
    const target = document.getElementById('view-' + view);
    if (target) target.classList.add('active');

    // 更新底部导航
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
      const navView = item.dataset.view;
      if (navView === view || (view === 'scan' && navView === 'scan-outbound')) {
        item.classList.add('active');
      }
    });

    // 视图特定加载
    if (view === 'dashboard') loadDashboard();
    if (view === 'products') loadProducts();
    if (view === 'reports') { loadTrendProductOptions().then(() => loadSalesTrend('month', 'sales-trend-chart')); }
    if (view === 'logs') loadLogs();
    if (view === 'staff') loadStaff();
    if (view === 'shipments') loadShipments();
    if (view === 'shipment-detail') loadShipmentDetail();
    if (view === 'settings') loadSettings();
    if (view === 'purchase') loadPurchaseView();

    // 离开扫码页时停止摄像头
    if (view !== 'scan') {
      Scanner.stop();
      document.getElementById('btn-start-scan')?.classList.remove('hidden');
      document.getElementById('btn-stop-scan')?.classList.add('hidden');
    }
  }

  // ========== 登录（合作商家，用户名 + 密码） ==========
  async function handleLogin() {
    const password = document.getElementById('login-password').value.trim();
    const username = document.getElementById('login-username').value.trim();

    if (!password || !username) {
      showToast('请输入用户名和密码');
      return;
    }

    try {
      const res = await fetch('/api/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败');

      currentUser = data.user;
      currentShop = data.shop;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('shop', JSON.stringify(data.shop));

      Finance.setConfig({ gstRate: data.shop.gstRate });

      showToast((I18n.t('login_success') + ' ' + username));
      showApp();
    } catch (err) {
      showToast(err.message);
    }
  }

  function handleLogout() {
    Scanner.stop();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('shop');
    currentUser = null;
    currentShop = null;
    showLogin();
    showToast(I18n.t('logout_success'));
  }

  // ========== API 辅助 ==========
  async function api(url, options = {}) {
    const token = localStorage.getItem('token');
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '请求失败');
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  // 通用：带重试的接口调用（应对 SW 刚接管时的瞬时失败）
  async function apiWithRetry(fn, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        // 仅对网络/5xx 类瞬时错误重试，业务 4xx 不重试
        if (err.status && err.status < 500) throw err;
        await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  // ========== 仪表盘 ==========
  async function loadDashboard() {
    try {
      const stats = await apiWithRetry(() => api('/api/stats/dashboard'));
      // 待入库数量（在途总数）
      let inTransit = 0;
      try {
        const catalog = await api('/api/merchant/catalog-summary');
        inTransit = catalog.reduce((s, c) => s + (Number(c.in_transit) || 0), 0);
      } catch (e) { /* 忽略 */ }
      document.getElementById('stat-products').textContent = inTransit;
      document.getElementById('stat-low-stock').textContent = stats.lowStockCount;
      document.getElementById('stat-sales').textContent = Finance.format(stats.todayOutbound.amt);
      document.getElementById('stat-gst').textContent = Finance.format(stats.todayOutbound.gst);

      drawWeeklyChart(stats.weekly || []);
      loadTrendProductOptions().then(() => loadSalesTrend('week', 'dashboard-trend-chart'));
    } catch (err) {
      console.error('加载仪表盘失败:', err);
    }
  }

  function drawWeeklyChart(weekly) {
    const canvas = document.getElementById('chart-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const padding = { top: 20, right: 16, bottom: 30, left: 40 };
    const chartW = W - padding.left - padding.right;
    const chartH = H - padding.top - padding.bottom;

    ctx.clearRect(0, 0, W, H);

    if (weekly.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(I18n.t('no_sales_data'), W / 2, H / 2);
      return;
    }

    const maxVal = Math.max(...weekly.map(d => d.sales), 1);
    const barW = chartW / weekly.length * 0.6;
    const gap = chartW / weekly.length * 0.4;

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + chartH * (i / 4);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(W - padding.right, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('$' + Math.round(maxVal * (1 - i / 4)), padding.left - 4, y + 3);
    }

    weekly.forEach((d, i) => {
      const x = padding.left + i * (barW + gap) + gap / 2;
      const barH = (d.sales / maxVal) * chartH;
      const y = padding.top + chartH - barH;

      const gradient = ctx.createLinearGradient(x, y, x, y + barH);
      gradient.addColorStop(0, '#3b82f6');
      gradient.addColorStop(1, '#1e40af');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
      ctx.fill();

      ctx.fillStyle = '#64748b';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const date = new Date(d.date);
      ctx.fillText((date.getMonth() + 1) + '/' + date.getDate(), x + barW / 2, H - 8);
    });
  }

  // ========== 扫码 ==========
  async function startScan() {
    // 恢复扫码区域原始内容
    const reader = document.getElementById('scanner-reader');
    if (reader && !document.getElementById('scan-placeholder-text')) {
      reader.innerHTML = `<div class="scanner-placeholder">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#94a3b8" stroke-width="1.5"><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2M4 12h16M9 7v10M15 7v10"/></svg>
        <p id="scan-placeholder-text">点击下方按钮启动摄像头</p>
      </div>`;
    }
    try {
      document.getElementById('btn-start-scan').classList.add('hidden');
      document.getElementById('btn-capture-scan').classList.remove('hidden');
      document.getElementById('btn-stop-scan').classList.remove('hidden');
      await Scanner.startPreview('scanner-reader');
      showToast('摄像头已启动，对准条码后按"拍照识别"');
    } catch (err) {
      showToast(err.message);
      const readerEl = document.getElementById('scanner-reader');
      if (readerEl) {
        readerEl.innerHTML = `<div class="scanner-placeholder" style="padding:20px;text-align:center;">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ef4444" stroke-width="1.5"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
          <p style="color:#ef4444;font-weight:600;margin:8px 0;">摄像头启动失败</p>
          <p style="color:#64748b;font-size:13px;white-space:pre-line;line-height:1.6;">${escapeHtml(err.message)}</p>
        </div>`;
      }
      document.getElementById('btn-start-scan').classList.remove('hidden');
      document.getElementById('btn-capture-scan').classList.add('hidden');
      document.getElementById('btn-stop-scan').classList.add('hidden');
    }
  }

  // 拍照识别：定格当前帧并识别条码
  async function captureScan() {
    if (!Scanner.getIsPreviewing()) { showToast('请先启动摄像头'); return; }
    showToast('正在识别...');
    const result = await Scanner.captureAndRecognize();
    if (result) {
      showToast('识别成功: ' + result);
      await handleScanResult(result);
    } else {
      showToast('未识别到条码，请对准后重试');
    }
  }

  async function stopScan() {
    await Scanner.stopPreview();
    document.getElementById('btn-start-scan').classList.remove('hidden');
    document.getElementById('btn-capture-scan').classList.add('hidden');
    document.getElementById('btn-stop-scan').classList.add('hidden');
    // 恢复占位
    const reader = document.getElementById('scanner-reader');
    if (reader) {
      reader.innerHTML = `<div class="scanner-placeholder">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#94a3b8" stroke-width="1.5"><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2M4 12h16M9 7v10M15 7v10"/></svg>
        <p id="scan-placeholder-text">点击下方按钮启动摄像头</p>
      </div>`;
    }
  }

  async function handleScanResult(barcode) {
    await processBarcode(barcode);
  }

  async function handleManualScan() {
    const barcode = document.getElementById('manual-barcode').value.trim();
    if (!barcode) { showToast('请输入条码'); return; }
    document.getElementById('manual-barcode').value = '';
    await processBarcode(barcode);
  }

  async function processBarcode(barcode) {
    // 防重复扫描检查
    const isDup = await LocalDB.isDuplicateScan(barcode, scanType, 3000);
    if (isDup) {
      showToast('该条码刚刚已扫描，请确认数量后再扫');
      return;
    }
    await LocalDB.addScanHistory(barcode, scanType);

    // 查找商品（优先本地缓存，离线时可用）
    let product = null;
    if (navigator.onLine) {
      try {
        product = await api('/api/products/barcode/' + encodeURIComponent(barcode));
      } catch (e) {
        product = await LocalDB.getCachedProductByBarcode(barcode);
      }
    } else {
      product = await LocalDB.getCachedProductByBarcode(barcode);
    }

    // 入库时商品未建档也允许进入确认（由服务器按发货单核对并自动建档）
    if (!product && scanType === 'inbound') {
      product = { barcode, name: '待核对商品', cost_price: 0, sell_price: FIXED_PRICE, stock: 0, _unregistered: true };
    }

    if (!product) {
      showToast('未找到该商品，请先在商品管理中添加');
      return;
    }

    currentScanProduct = product;
    // 重置折扣状态（仅出库销售可享折扣）
    currentDiscount = { type: 'none', medical: null, social: null };
    document.getElementById('confirm-discount').value = 'none';
    document.getElementById('discount-medical-input').value = '';
    document.getElementById('discount-social-input').value = '';
    document.getElementById('discount-medical-name').textContent = I18n.t('tap_to_upload');
    document.getElementById('discount-social-name').textContent = I18n.t('tap_to_upload');
    document.getElementById('discount-medical-preview').classList.add('hidden');
    document.getElementById('discount-social-preview').classList.add('hidden');
    document.getElementById('discount-medical-box').classList.add('hidden');
    document.getElementById('discount-social-box').classList.add('hidden');
    const discSection = document.getElementById('discount-section');
    if (discSection) discSection.classList.toggle('hidden', scanType !== 'outbound');

    // 显示确认界面
    document.getElementById('confirm-product-name').textContent = product.name;
    document.getElementById('confirm-barcode').textContent = product.barcode;
    document.getElementById('confirm-stock').textContent = product._unregistered ? '-' : product.stock;
    document.getElementById('confirm-quantity').value = 1;
    document.getElementById('confirm-price').value = product.sell_price || FIXED_PRICE; // 售价读商品档案

    // 财务预览
    const financeDiv = document.getElementById('confirm-finance');
    financeDiv.classList.remove('hidden');
    updateFinancePreview();

    document.getElementById('scan-confirm').classList.remove('hidden');
    document.getElementById('scan-result').classList.add('hidden');
    document.getElementById('scan-success').classList.add('hidden');
    await Scanner.stop();
  }

  const DISCOUNT_VALUES = { none: 0, medical: 10, social: 10, both: 20 };

  function updateFinancePreview() {
    const qty = parseInt(document.getElementById('confirm-quantity').value) || 0;
    const price = currentScanProduct?.sell_price || FIXED_PRICE;
    const discEl = document.getElementById('confirm-discount');
    const dtype = discEl ? discEl.value : 'none';
    const discount = DISCOUNT_VALUES[dtype] || 0;
    const discountedPrice = Math.max(0, price - discount);
    const f = Finance.calculate(qty, discountedPrice, 'outbound');
    document.getElementById('fin-base').textContent = Finance.format(f.amountBeforeGST);
    document.getElementById('fin-discount').textContent = '-' + Finance.format(discount * qty);
    document.getElementById('fin-gst').textContent = Finance.format(f.gstAmount);
    document.getElementById('fin-total').textContent = Finance.format(f.totalAmount);
    const dr = document.getElementById('fin-discount-row');
    if (dr) dr.style.display = discount > 0 ? '' : 'none';
  }

  // ========== 活动折扣：图片上传 ==========
  function clickUpload(kind) {
    const input = document.getElementById(kind === 'medical' ? 'discount-medical-input' : 'discount-social-input');
    if (input) input.click();
  }

  async function handleUploadFile(kind, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      currentDiscount[kind] = dataUrl;
      const preview = document.getElementById(kind === 'medical' ? 'discount-medical-preview' : 'discount-social-preview');
      const nameEl = document.getElementById(kind === 'medical' ? 'discount-medical-name' : 'discount-social-name');
      if (preview) { preview.src = dataUrl; preview.classList.remove('hidden'); }
      if (nameEl) nameEl.textContent = '✓ ' + (file.name || I18n.t('uploaded'));
      showToast(I18n.t('uploaded'));
    } catch (err) {
      showToast('图片处理失败: ' + err.message);
    }
  }

  // 压缩图片（手机原图太大，压缩后上传，≤3MB）
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const MAX = 1280;
          let w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            const r = Math.min(MAX / w, MAX / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        };
        img.onerror = () => reject(new Error('无法读取图片'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('无法读取文件'));
      reader.readAsDataURL(file);
    });
  }

  function onDiscountChange() {
    const dtype = document.getElementById('confirm-discount').value;
    currentDiscount.type = dtype;
    const needMedical = dtype === 'medical' || dtype === 'both';
    const needSocial = dtype === 'social' || dtype === 'both';
    document.getElementById('discount-medical-box').classList.toggle('hidden', !needMedical);
    document.getElementById('discount-social-box').classList.toggle('hidden', !needSocial);
    updateFinancePreview();
  }

  async function submitScan() {
    if (!currentScanProduct) return;

    const quantity = parseInt(document.getElementById('confirm-quantity').value) || 1;
    const unitPrice = currentScanProduct.sell_price || FIXED_PRICE; // 售价读商品档案
    const clientRecordId = LocalDB.generateClientRecordId();
    const clientTimestamp = new Date().toISOString();

    // 折扣（仅出库）：校验凭证
    let discountType = 'none';
    if (scanType === 'outbound') {
      const discEl = document.getElementById('confirm-discount');
      discountType = discEl ? discEl.value : 'none';
      if (discountType === 'medical' || discountType === 'both') {
        if (!currentDiscount.medical) { showToast(I18n.t('need_medical_img')); return; }
      }
      if (discountType === 'social' || discountType === 'both') {
        if (!currentDiscount.social) { showToast(I18n.t('need_social_img')); return; }
      }
    }

    const record = {
      barcode: currentScanProduct.barcode,
      type: scanType,
      quantity,
      unitPrice,
      clientRecordId,
      clientTimestamp,
      productName: currentScanProduct.name,
      discountType,
      discountMedicalImg: currentDiscount.medical || null,
      discountSocialImg: currentDiscount.social || null
    };

    document.getElementById('scan-confirm').classList.add('hidden');

    if (!navigator.onLine) {
      // 离线：存到本地
      await LocalDB.addPendingRecord(record);
      SyncManager.updatePendingCount();
      showScanResult(true, '已保存到本地，网络恢复后自动上传', true);
      return;
    }

    try {
      const endpoint = scanType === 'inbound' ? '/api/transactions/inbound' : '/api/transactions/outbound';
      const result = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ ...record, operatorName: currentUser.username })
      });

      if (result.duplicate) {
        showScanResult(true, '该记录已存在，跳过');
      } else {
        await LocalDB.updateCachedProduct(result.product);
        if (scanType === 'inbound') {
          showScanResult(true, `${result.product.name} 入库成功（√ 核对通过），当前库存: ${result.product.stock}`);
        } else {
          const fin = result.finance || {};
          const msg = fin.discount > 0
            ? `${result.product.name} 出库成功，折扣 −$${Number(fin.discount).toFixed(2)}，折后 $${Number(fin.discountedPrice).toFixed(2)}，当前库存: ${result.product.stock}`
            : `${result.product.name} 出库成功，当前库存: ${result.product.stock}`;
          showScanResult(true, msg, false, result.lowStockWarning);
        }
      }
    } catch (err) {
      // 入库核对失败（×）：不入待同步队列
      if (scanType === 'inbound' && (err.code === 'SHIPMENT_MISMATCH' || /发货清单|核对/.test(err.message || ''))) {
        showScanResult(false, err.message || '该条码不在品牌方发货清单中（×）');
        return;
      }
      // 业务错误（如库存不足）→ 显示失败，不入队
      if (err.status && err.status < 500) {
        showScanResult(false, err.message || '操作失败');
        return;
      }
      // 网络/服务器错误：离线兜底
      await LocalDB.addPendingRecord(record);
      SyncManager.updatePendingCount();
      showScanResult(true, '提交失败，已保存到本地，网络恢复后自动上传', true);
    }
  }

  function showScanResult(ok, message, isOffline = false, lowStockWarning = false) {
    const icon = document.getElementById('result-icon');
    const title = document.getElementById('result-title');
    icon.textContent = ok ? '✓' : '×';
    icon.className = 'result-icon ' + (ok ? 'result-ok' : 'result-fail');
    if (ok && scanType === 'inbound' && !isOffline) {
      title.textContent = '√ 核对通过';
    } else if (!ok) {
      title.textContent = '× 核对失败';
    } else {
      title.textContent = I18n.t('scan_success');
    }
    document.getElementById('result-message').textContent = message;
    document.getElementById('scan-result').classList.remove('hidden');
    document.getElementById('scan-success').classList.add('hidden');
    if (lowStockWarning) {
      setTimeout(() => showToast('⚠️ ' + (currentScanProduct ? currentScanProduct.name : '') + ' ' + I18n.t('only_low')), 500);
    }
  }

  function resetScan() {
    document.getElementById('scan-result').classList.add('hidden');
    document.getElementById('scan-success').classList.add('hidden');
    currentScanProduct = null;
    if (Scanner.getIsScanning()) return;
    document.getElementById('btn-start-scan').classList.add('hidden');
    document.getElementById('btn-stop-scan').classList.remove('hidden');
    Scanner.start('scanner-reader', handleScanResult).catch(() => {
      document.getElementById('btn-start-scan').classList.remove('hidden');
      document.getElementById('btn-stop-scan').classList.add('hidden');
    });
  }

  function cancelScan() {
    document.getElementById('scan-confirm').classList.add('hidden');
    currentScanProduct = null;
    if (!Scanner.getIsScanning()) {
      Scanner.start('scanner-reader', handleScanResult).catch(() => {});
    }
  }

  // ========== 商品管理 ==========
  async function loadProducts() {
    const search = document.getElementById('product-search').value;
    const filter = document.getElementById('product-filter').value;

    try {
      // 一物一码：按类目聚合库存
      let url = '/api/merchant/catalog-summary?';
      const catalogs = await api(url);
      renderCatalogList(catalogs);
    } catch (err) {
      document.getElementById('product-list').innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8;">加载失败</div>`;
    }
  }

  function renderCatalogList(catalogs) {
    const container = document.getElementById('product-list');
    if (catalogs.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8;">暂无库存商品</div>`;
      return;
    }
    container.innerHTML = catalogs.map(c => `
      <div class="product-item" style="cursor:pointer;" onclick="App.loadCatalogDetail(${c.catalog_id}, '${escapeHtml(c.name)}')">
        <div class="product-info">
          <div class="product-name">${escapeHtml(c.name)}</div>
          <div class="product-meta">售价: S$${Number(c.sell_price || 0).toFixed(2)}</div>
        </div>
        <div style="display:flex;gap:20px;align-items:center;">
          <div class="product-stock">
            <div class="stock-num">${c.in_stock}</div>
            <div class="stock-label">库存</div>
          </div>
          <div class="product-stock">
            <div class="stock-num" style="color:#f59e0b;">${c.in_transit}</div>
            <div class="stock-label" style="color:#f59e0b;">在途</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  async function loadCatalogDetail(catalogId, catalogName) {
    try {
      const data = await api('/api/merchant/catalog/' + catalogId + '/items');
      renderCatalogItems(data, catalogId, catalogName);
    } catch (err) {
      showToast('加载失败');
    }
  }

  function renderCatalogItems(data, catalogId, catalogName) {
    const container = document.getElementById('product-list');
    const items = data.items || [];
    const inStock = items.filter(i => i.status === 'merchant_stock');
    const sold = items.filter(i => i.status === 'sold');

    container.innerHTML = `
      <div style="margin-bottom:16px;">
        <button class="btn btn-secondary" onclick="App.loadProducts()">← 返回类目列表</button>
      </div>
      <div style="background:#f8fafc;padding:16px;border-radius:12px;margin-bottom:16px;">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px;">${escapeHtml(catalogName)}</div>
        <div style="display:flex;gap:24px;">
          <div><span style="color:#64748b;">在库：</span><strong>${inStock.length}</strong> 件</div>
          <div><span style="color:#64748b;">已售：</span><strong>${sold.length}</strong> 件</div>
        </div>
      </div>
      <div style="font-size:14px;font-weight:600;margin-bottom:8px;color:#475569;">在库条码</div>
      ${inStock.length === 0 ? '<div style="color:#94a3b8;padding:12px;">暂无在库商品</div>' :
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">' +
        inStock.map(i => `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-family:monospace;font-size:13px;">${escapeHtml(i.barcode)}</div>`).join('') +
        '</div>'
      }
      ${sold.length > 0 ? `
        <div style="font-size:14px;font-weight:600;margin:16px 0 8px;color:#475569;">已售条码</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
          ${sold.map(i => `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-family:monospace;font-size:13px;color:#94a3b8;text-decoration:line-through;">${escapeHtml(i.barcode)}</div>`).join('')}
        </div>
      ` : ''}
    `;
  }

  let editingProductId = null;

  let salesTrendCharts = {};
  async function loadTrendProductOptions() {
    // 加载商品选项到两个下拉框
    try {
      const data = await api('/api/merchant/catalog-summary');
      const selects = ['dashboard-trend-product', 'report-trend-product'];
      selects.forEach(sid => {
        const sel = document.getElementById(sid);
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">全部商品</option>';
        data.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.catalog ? c.catalog.name : c.name;
          opt.textContent = c.catalog ? c.catalog.name : c.name;
          sel.appendChild(opt);
        });
        sel.value = current;
      });
    } catch (e) { /* 忽略 */ }
  }

  async function loadSalesTrend(period, canvasId) {
    const cid = canvasId || 'sales-trend-chart';
    const pointR = (period === 'month_all' || period === 'quarter' || period === 'year_all') ? 0 : 3;
    // 切换按钮状态（只切换当前容器内的按钮）
    const container = document.getElementById(cid).closest('.section-card');
    if (container) {
      container.querySelectorAll('.trend-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
      });
    }
    // 读取商品筛选
    const productSelect = container ? container.querySelector('select') : null;
    const catalogId = productSelect ? productSelect.value : '';

    try {
      const url = '/api/merchant/sales-trend?period=' + period + (catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : '');
      const data = await api(url);
      const labels = data.data.map(d => {
        if (data.labelFmt === 'hour') return d.label + ':00';
        return d.label;
      });
      const revenues = data.data.map(d => Number(d.revenue).toFixed(2));
      const qtys = data.data.map(d => d.qty);

      const ctx = document.getElementById(cid).getContext('2d');
      if (salesTrendCharts[cid]) salesTrendCharts[cid].destroy();

      // 渐变填充
      const gradient = ctx.createLinearGradient(0, 0, 0, 240);
      gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
      gradient.addColorStop(1, 'rgba(99,102,241,0.02)');

      salesTrendCharts[cid] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '营收 (S$)',
              data: revenues,
              borderColor: '#6366f1',
              backgroundColor: gradient,
              fill: true,
              tension: 0.35,
              pointRadius: pointR,
              pointHoverRadius: 6,
              pointBackgroundColor: '#6366f1',
              pointBorderColor: '#fff',
              pointBorderWidth: 2,
              borderWidth: 2,
              yAxisID: 'y'
            },
            {
              label: '销量 (件)',
              data: qtys,
              borderColor: '#f59e0b',
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.35,
              pointRadius: pointR > 0 ? 2 : 0,
              pointHoverRadius: 5,
              pointBackgroundColor: '#f59e0b',
              pointBorderColor: '#fff',
              pointBorderWidth: 1.5,
              borderWidth: 1.5,
              borderDash: [4, 2],
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
              backgroundColor: 'rgba(15,23,42,0.9)',
              titleFont: { size: 12 },
              bodyFont: { size: 11 },
              padding: 10,
              cornerRadius: 8,
              callbacks: {
                label: function(ctx) {
                  if (ctx.datasetIndex === 0) return ' 营收: S$' + Number(ctx.parsed.y).toFixed(2);
                  return ' 销量: ' + ctx.parsed.y + ' 件';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(226,232,240,0.5)', drawBorder: false },
              ticks: { font: { size: 10 }, color: '#64748b', maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 15, autoSkipPadding: 10 }
            },
            y: {
              type: 'linear', position: 'left',
              title: { display: true, text: '营收(S$)', font: { size: 10 }, color: '#6366f1' },
              ticks: { font: { size: 10 }, color: '#64748b', callback: v => 'S$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v) },
              grid: { color: 'rgba(226,232,240,0.5)' }
            },
            y1: {
              type: 'linear', position: 'right',
              title: { display: true, text: '销量', font: { size: 10 }, color: '#f59e0b' },
              ticks: { font: { size: 10 }, color: '#64748b' },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    } catch (err) {
      showToast('加载销售趋势失败');
    }
  }

  function openProductModal(product = null) {
    editingProductId = product ? product.id : null;
    document.getElementById('modal-title').textContent = product ? I18n.t('edit_product') : I18n.t('add_product');
    document.getElementById('pm-name').value = product?.name || '';
    document.getElementById('pm-barcode').value = product?.barcode || '';
    document.getElementById('pm-sku').value = product?.sku || '';
    document.getElementById('pm-category').value = product?.category || '未分类';
    document.getElementById('pm-cost').value = product?.cost_price || 0;
    document.getElementById('pm-price').value = product?.sell_price || ''; // 售价可维护，读商品档案
    document.getElementById('pm-stock').value = product?.stock || 0;
    document.getElementById('pm-threshold').value = product?.threshold || 10;
    document.getElementById('pm-stock').disabled = !!product;
    document.getElementById('product-modal').classList.remove('hidden');
  }

  function closeProductModal() {
    document.getElementById('product-modal').classList.add('hidden');
    editingProductId = null;
  }

  async function saveProduct() {
    const data = {
      name: document.getElementById('pm-name').value.trim(),
      barcode: document.getElementById('pm-barcode').value.trim(),
      sku: document.getElementById('pm-sku').value.trim(),
      category: document.getElementById('pm-category').value.trim(),
      costPrice: parseFloat(document.getElementById('pm-cost').value) || 0,
      sellPrice: parseFloat(document.getElementById('pm-price').value) || 0, // 售价可维护
      stock: parseInt(document.getElementById('pm-stock').value) || 0,
      threshold: parseInt(document.getElementById('pm-threshold').value) || 0
    };

    if (!data.name || !data.barcode) {
      showToast('商品名称和条码必填');
      return;
    }

    try {
      if (editingProductId) {
        await api('/api/products/' + editingProductId, { method: 'PUT', body: JSON.stringify(data) });
        showToast('商品已更新');
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(data) });
        showToast('商品已添加');
      }
      closeProductModal();
      loadProducts();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function editProduct(id) {
    const products = await LocalDB.getCachedProducts();
    const product = products.find(p => p.id === id);
    if (product) openProductModal(product);
  }

  async function deleteProduct(id) {
    if (!confirm('确定要删除这个商品吗？此操作不可撤销。')) return;
    try {
      await api('/api/products/' + id, { method: 'DELETE' });
      showToast('商品已删除');
      loadProducts();
    } catch (err) {
      showToast(err.message);
    }
  }

  function handleBatchImport() {
    document.getElementById('csv-file-input').click();
  }

  async function handleCsvFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) { showToast('CSV 文件格式不正确'); return; }
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      const products = [];
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
        products.push({
          name: obj.name || obj['商品名称'] || '',
          barcode: obj.barcode || obj['条码'] || '',
          sku: obj.sku || obj['sku'] || '',
          category: obj.category || obj['分类'] || '未分类',
          costPrice: parseFloat(obj.costprice || obj['进价']) || 0,
          stock: parseInt(obj.stock || obj['库存']) || 0,
          threshold: parseInt(obj.threshold || obj['预警阈值']) || 10
        });
      }
      const result = await api('/api/products/batch', { method: 'POST', body: JSON.stringify({ products }) });
      showToast(`导入完成: 成功${result.success}条, 失败${result.failed}条`);
      loadProducts();
    } catch (err) {
      showToast('导入失败: ' + err.message);
    }
    e.target.value = '';
  }

  // ========== 报表 ==========
  async function generateReport() {
    const startDate = document.getElementById('report-start').value;
    const endDate = document.getElementById('report-end').value;
    const type = document.getElementById('report-type').value;

    try {
      let url = '/api/transactions?limit=10000';
      if (type !== 'all') url += '&type=' + type;
      if (startDate) url += '&startDate=' + startDate;
      if (endDate) url += '&endDate=' + endDate;

      const transactions = await api(url);
      reportData = transactions;

      const summary = {
        count: transactions.length,
        amountBeforeGST: 0, gstAmount: 0, totalAmount: 0,
        inboundQty: 0, outboundQty: 0,
        salesQty: 0, costTotal: 0, discountTotal: 0,
        brandShare: 0, merchantShare: 0
      };
      transactions.forEach(t => {
        summary.amountBeforeGST += Number(t.amount_before_gst) || 0;
        summary.gstAmount += Number(t.gst_amount) || 0;
        summary.totalAmount += Number(t.total_amount) || 0;
        if (t.type === 'inbound') summary.inboundQty += Number(t.quantity) || 0;
        if (t.type === 'sale') {
          summary.outboundQty += Number(t.quantity) || 0;
          summary.salesQty += Number(t.quantity) || 0;
          summary.costTotal += 20 * (Number(t.quantity) || 0);
          summary.discountTotal += Number(t.discount_amount) || 0;
          summary.brandShare += Number(t.brand_share) || 0;
          summary.merchantShare += Number(t.merchant_share) || 0;
        }
      });
      summary.brandGst = summary.gstAmount * 0.7;
      summary.merchantGst = summary.gstAmount * 0.3;

      document.getElementById('report-summary').classList.remove('hidden');
      document.getElementById('rs-count').textContent = summary.count;
      document.getElementById('rs-base').textContent = Finance.format(summary.amountBeforeGST);
      document.getElementById('rs-gst').textContent = Finance.format(summary.gstAmount);
      document.getElementById('rs-total').textContent = Finance.format(summary.totalAmount);
      document.getElementById('rs-inbound-qty').textContent = summary.inboundQty;
      document.getElementById('rs-outbound-qty').textContent = summary.outboundQty;
      document.getElementById('rs-sales-qty').textContent = summary.salesQty;
      document.getElementById('rs-cost').textContent = Finance.format(summary.costTotal);
      document.getElementById('rs-discount').textContent = Finance.format(summary.discountTotal);
      document.getElementById('rs-brand-share').textContent = Finance.format(summary.brandShare);
      document.getElementById('rs-merchant-share').textContent = Finance.format(summary.merchantShare);
      document.getElementById('rs-brand-gst').textContent = Finance.format(summary.brandGst);
      document.getElementById('rs-merchant-gst').textContent = Finance.format(summary.merchantGst);

      // 每日流水汇总
      const dailyMap = {};
      transactions.forEach(t => {
        if (t.type !== 'sale') return;
        const day = (t.server_timestamp || t.client_timestamp || '').slice(0, 10);
        if (!dailyMap[day]) dailyMap[day] = { qty: 0, discount: 0, base: 0, gst: 0, total: 0, brand: 0, merchant: 0 };
        dailyMap[day].qty += Number(t.quantity) || 0;
        dailyMap[day].discount += Number(t.discount_amount) || 0;
        dailyMap[day].base += Number(t.amount_before_gst) || 0;
        dailyMap[day].gst += Number(t.gst_amount) || 0;
        dailyMap[day].total += Number(t.total_amount) || 0;
        dailyMap[day].brand += Number(t.brand_share) || 0;
        dailyMap[day].merchant += Number(t.merchant_share) || 0;
      });
      const dailyRows = Object.keys(dailyMap).sort().map(day => {
        const d = dailyMap[day];
        return `<tr>
          <td>${day}</td><td>${d.qty}</td>
          <td>${d.discount > 0 ? '−S$' + d.discount.toFixed(2) : '-'}</td>
          <td>S$${d.base.toFixed(2)}</td><td>S$${d.gst.toFixed(2)}</td>
          <td>S$${d.total.toFixed(2)}</td><td>S$${d.brand.toFixed(2)}</td><td>S$${d.merchant.toFixed(2)}</td>
        </tr>`;
      }).join('');
      document.getElementById('report-daily-container').classList.remove('hidden');
      document.getElementById('report-daily-tbody').innerHTML = dailyRows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;">暂无销售数据</td></tr>';

      document.getElementById('report-table-container').classList.remove('hidden');
      const tbody = document.getElementById('report-tbody');
      tbody.innerHTML = transactions.map(t => `
        <tr>
          <td>${t.server_timestamp || t.client_timestamp || ''}</td>
          <td class="${t.type === 'inbound' ? 'type-inbound' : 'type-outbound'}">${t.type === 'inbound' ? I18n.t('only_in') : I18n.t('only_out')}</td>
          <td>${escapeHtml(t.product_name)}</td>
          <td>${t.quantity}</td>
          <td>S$${Number(t.unit_price).toFixed(2)}</td>
          <td>${Number(t.discount_amount) > 0 ? '<span class="discount-tag">−S$' + Number(t.discount_amount).toFixed(2) + '</span>' : '-'}</td>
          <td>S$${Number(t.amount_before_gst).toFixed(2)}</td>
          <td>S$${Number(t.gst_amount).toFixed(2)}</td>
          <td>S$${Number(t.total_amount).toFixed(2)}</td>
          <td>${t.type === 'sale' ? 'S$' + Number(t.brand_share || 0).toFixed(2) : '-'}</td>
          <td>${t.type === 'sale' ? 'S$' + Number(t.merchant_share || 0).toFixed(2) : '-'}</td>
          <td>${t.verified ? '<span class="verify-ok">√</span>' : (t.type === 'inbound' ? '<span class="verify-no">×</span>' : '-')}</td>
          <td>${escapeHtml(t.operator_name)}</td>
        </tr>
      `).join('');

      document.getElementById('btn-export-excel').classList.remove('hidden');
      showToast(`报表已生成，共 ${transactions.length} 条记录`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function exportReportExcel() {
    if (reportData.length === 0) { showToast('请先生成报表'); return; }
    const outbound = reportData.filter(t => t.type === 'sale');
    const summary = {
      count: reportData.length,
      amountBeforeGST: reportData.reduce((s, t) => s + (Number(t.amount_before_gst) || 0), 0),
      gstAmount: reportData.reduce((s, t) => s + (Number(t.gst_amount) || 0), 0),
      totalAmount: reportData.reduce((s, t) => s + (Number(t.total_amount) || 0), 0),
      inboundQty: reportData.filter(t => t.type === 'inbound').reduce((s, t) => s + (Number(t.quantity) || 0), 0),
      outboundQty: reportData.filter(t => t.type === 'sale').reduce((s, t) => s + (Number(t.quantity) || 0), 0),
      salesQty: outbound.reduce((s, t) => s + (Number(t.quantity) || 0), 0),
      costTotal: outbound.reduce((s, t) => s + 20 * (Number(t.quantity) || 0), 0),
      discountTotal: outbound.reduce((s, t) => s + (Number(t.discount_amount) || 0), 0),
      brandShare: outbound.reduce((s, t) => s + (Number(t.brand_share) || 0), 0),
      merchantShare: outbound.reduce((s, t) => s + (Number(t.merchant_share) || 0), 0),
      brandGst: 0, merchantGst: 0
    };
    summary.brandGst = summary.gstAmount * 0.7;
    summary.merchantGst = summary.gstAmount * 0.3;
    ExportManager.exportTransactions(reportData, summary);
    showToast('Excel 已下载到浏览器默认下载目录');
  }

  // ========== 操作日志 ==========
  async function loadLogs() {
    try {
      const logs = await api('/api/logs?limit=200');
      const container = document.getElementById('log-list');
      if (logs.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8;">${I18n.t('no_logs')}</div>`;
        return;
      }
      const actionNames = {
        login: '登录', inbound: '入库', outbound: '出库',
        product_create: '新增商品', product_update: '更新商品',
        product_delete: '删除商品', product_import: '批量导入',
        staff_role_change: '角色变更', shop_update: '店铺设置'
      };
      container.innerHTML = logs.map(l => `
        <div class="log-item">
          <div class="log-action">${actionNames[l.action] || l.action}</div>
          <div class="log-detail">${escapeHtml(l.note || '')}</div>
          <div class="log-meta">
            <span>${escapeHtml(l.username)}</span>
            <span>${l.create_at}</span>
          </div>
          <div class="log-hash">${I18n.t('hash')}: ${(l.this_hash || '').substring(0, 32)}...</div>
        </div>
      `).join('');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function verifyLogs() {
    try {
      const result = await api('/api/logs/verify');
      if (result.valid) {
        showToast(`${I18n.t('verify_pass')}，共 ${result.total} 条`);
      } else {
        showToast(`⚠️ ${I18n.t('verify_fail')}，共 ${result.total} 条`);
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 员工管理 ==========
  async function loadStaff() {
    try {
      const staff = await api('/api/staff');
      const container = document.getElementById('staff-list');
      const roleNames = { merchant: I18n.t('role_merchant'), staff: I18n.t('role_staff') };
      container.innerHTML = staff.map(s => `
        <div class="staff-item">
          <div>
            <div class="staff-name">${escapeHtml(s.username)}</div>
            <div class="staff-role">${roleNames[s.role] || s.role} · ${s.created_at}</div>
          </div>
          <div class="staff-actions">
            <select onchange="App.changeStaffRole(${s.id}, this.value)">
              <option value="merchant" ${s.role === 'merchant' ? 'selected' : ''}>${I18n.t('role_merchant')}</option>
              <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>${I18n.t('role_staff')}</option>
            </select>
          </div>
        </div>
      `).join('');
    } catch (err) {
      showToast(err.message);
    }
  }

  async function changeStaffRole(id, role) {
    try {
      await api('/api/staff/' + id + '/role', { method: 'PUT', body: JSON.stringify({ role }) });
      showToast('角色已更新');
      loadStaff();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 发货单（合作商家：查看收货进度，条码不提前暴露） ==========
  function shipStatus(s) {
    return { draft: I18n.t('draft'), shipped: I18n.t('shipped'), received: I18n.t('received') }[s] || s;
  }

  async function loadShipments() {
    const listEl = document.getElementById('shipment-list');
    try {
      const shipments = await api('/api/shipments');
      if (shipments.length === 0) {
        listEl.innerHTML = `<div class="empty-tip">${'暂无发货单'}</div>`;
        return;
      }
      listEl.innerHTML = shipments.map(s => `
        <div class="shipment-card" onclick="App.openShipmentDetail(${s.id})">
          <div class="shipment-card-head">
            <span class="shipment-id">#${s.id}</span>
            <span class="chip chip-${s.status}">${shipStatus(s.status)}</span>
          </div>
          <div class="shipment-card-body">
            <div>${I18n.t('brand_role')}: ${escapeHtml(s.brand_name)}</div>
            <div class="shipment-progress">
              <span>${I18n.t('received')}: ${s.received_qty}/${s.total_qty}</span>
            </div>
          </div>
          <div class="shipment-card-foot">
            <span class="link">${s.remark ? escapeHtml(s.remark) : ''} ${s.created_at}</span>
          </div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  function openShipmentDetail(id) {
    shipmentDetailId = id;
    navigate('shipment-detail');
  }

  async function loadShipmentDetail() {
    const el = document.getElementById('shipment-detail');
    if (!shipmentDetailId) return;
    try {
      const s = await api('/api/shipments/' + shipmentDetailId);
      document.getElementById('shipment-detail-title').textContent = I18n.t('shipments_title') + ' #' + s.id;
      const statusName = shipStatus(s.status);
      // 合作商家：仅状态与收货进度，不暴露条码明细
      const total = s.total_qty || 0;
      const received = s.received_qty || 0;
      el.innerHTML = `
        <div class="section-card">
          <div class="shipment-card-head">
            <span class="shipment-id">#${s.id} · ${escapeHtml(s.brand_name || '')}</span>
            <span class="chip chip-${s.status}">${statusName}</span>
          </div>
          <div class="shipment-progress">
            <span>${I18n.t('received')}: ${received}/${total}</span>
          </div>
          <p class="hint">${s.status === 'shipped' ? '品牌方已发货，请扫码入库核对（√/×）' : (s.status === 'received' ? '已全部收货完成' : '')}</p>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // ========== 设置 ==========
  function loadSettings() {
    document.getElementById('setting-shop-name').value = currentShop.name;
    document.getElementById('setting-account').value = currentUser.username;
    document.getElementById('setting-gst-rate').value = currentShop.gstRate;
    document.getElementById('setting-country').value = currentShop.country || 'SG';
    // 非超管只能修改一次密码
    const pwdBtn = document.getElementById('btn-change-password');
    if (pwdBtn) {
      if (currentShop.passwordChanged) {
        pwdBtn.textContent = '密码已修改（仅可修改一次）';
        pwdBtn.disabled = true;
        pwdBtn.style.opacity = '0.5';
      } else {
        pwdBtn.textContent = I18n.t('change_password');
        pwdBtn.disabled = false;
        pwdBtn.style.opacity = '1';
      }
    }
  }

  // 修改密码
  function openPasswordModal() {
    document.getElementById('pwd-new').value = '';
    document.getElementById('pwd-confirm').value = '';
    document.getElementById('password-modal').classList.remove('hidden');
  }
  function closePasswordModal() {
    document.getElementById('password-modal').classList.add('hidden');
  }
  async function submitPassword() {
    const pw1 = document.getElementById('pwd-new').value.trim();
    const pw2 = document.getElementById('pwd-confirm').value.trim();
    if (!pw1 || !pw2) { showToast('请输入新密码'); return; }
    if (pw1 !== pw2) { showToast(I18n.t('password_mismatch')); return; }
    if (pw1.length < 8 || !/[a-z]/.test(pw1) || !/[A-Z]/.test(pw1) || !/\d/.test(pw1) || !/[^a-zA-Z0-9]/.test(pw1)) {
      showToast(I18n.t('password_rule')); return;
    }
    try {
      await api('/api/shop/password', { method: 'PUT', body: JSON.stringify({ newPassword: pw1 }) });
      currentShop.passwordChanged = true;
      localStorage.setItem('shop', JSON.stringify(currentShop));
      closePasswordModal();
      showToast(I18n.t('password_changed'));
      loadSettings();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 离线提示 ==========
  function updateOfflineBar(pendingCount) {
    const bar = document.getElementById('offline-bar');
    const text = document.getElementById('offline-text');
    if (!bar) return;
    if (!navigator.onLine || pendingCount > 0) {
      bar.classList.remove('hidden');
      if (!navigator.onLine) {
        text.textContent = I18n.t('network_down');
        bar.style.background = '#ef4444';
      } else {
        text.textContent = I18n.t('syncing');
        bar.style.background = '#f59e0b';
      }
    } else {
      bar.classList.add('hidden');
    }
  }

  // ========== 工具函数 ==========
  let _peekTimer = null;
  function peekPassword(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.type = 'text';
    if (btn) btn.style.color = 'var(--primary)';
    if (_peekTimer) clearTimeout(_peekTimer);
    _peekTimer = setTimeout(() => {
      input.type = 'password';
      if (btn) btn.style.color = '';
    }, 1000);
  }
  function showToast(message, duration = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  async function refreshProductsCache() {
    try {
      const products = await api('/api/products?limit=10000');
      await LocalDB.cacheProducts(products);
    } catch (e) { /* 忽略 */ }
  }

  // ========== 事件绑定 ==========
  function bindEvents() {
    // 登录
    document.getElementById('btn-login').addEventListener('click', handleLogin);
    document.getElementById('login-username').addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    document.getElementById('login-password').addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    // 密码小眼睛：按一下可见1秒
    const eyeBtn = document.getElementById('btn-eye-password');
    if (eyeBtn) eyeBtn.addEventListener('click', () => peekPassword('login-password', eyeBtn));

    // 退出
    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    // 扫码
    document.getElementById('btn-start-scan').addEventListener('click', startScan);
    document.getElementById('btn-stop-scan').addEventListener('click', stopScan);
    const captureBtn = document.getElementById('btn-capture-scan');
    if (captureBtn) captureBtn.addEventListener('click', captureScan);
    document.getElementById('btn-manual-scan').addEventListener('click', handleManualScan);
    document.getElementById('manual-barcode').addEventListener('keypress', e => { if (e.key === 'Enter') handleManualScan(); });

    // 扫码确认
    document.getElementById('btn-confirm-submit').addEventListener('click', submitScan);
    document.getElementById('btn-confirm-cancel').addEventListener('click', cancelScan);
    document.getElementById('confirm-quantity').addEventListener('input', updateFinancePreview);
    const discEl = document.getElementById('confirm-discount');
    if (discEl) discEl.addEventListener('change', onDiscountChange);

    // 商品
    document.getElementById('btn-add-product').addEventListener('click', () => openProductModal());
    document.getElementById('pm-cancel').addEventListener('click', closeProductModal);
    document.getElementById('pm-save').addEventListener('click', saveProduct);
    document.getElementById('product-search').addEventListener('input', debounce(loadProducts, 300));
    document.getElementById('product-filter').addEventListener('change', loadProducts);
    const batchBtn = document.getElementById('btn-batch-import');
    if (batchBtn) batchBtn.addEventListener('click', handleBatchImport);
    const csvInput = document.getElementById('csv-file-input');
    if (csvInput) csvInput.addEventListener('change', handleCsvFile);

    // 报表
    document.getElementById('btn-generate-report').addEventListener('click', generateReport);
    document.getElementById('btn-export-excel').addEventListener('click', exportReportExcel);

    // 日志
    document.getElementById('btn-verify-logs').addEventListener('click', verifyLogs);

    // 修改密码
    const pwdBtn = document.getElementById('btn-change-password');
    if (pwdBtn) pwdBtn.addEventListener('click', openPasswordModal);
    const pwdSubmit = document.getElementById('pwd-submit');
    if (pwdSubmit) pwdSubmit.addEventListener('click', submitPassword);

    // 网络状态监听
    window.addEventListener('online', () => updateOfflineBar(0));
    window.addEventListener('offline', () => updateOfflineBar(0));
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ========== 进货申请 ==========
  let purchasePayImg = null;

  async function loadPurchaseView() {
    // 商品下拉（从商品库加载总代授权的可进货商品）
    const sel = document.getElementById('purchase-product');
    if (sel) {
      let catalog = [];
      try { catalog = await api('/api/merchant/catalog'); } catch (e) {}
      if (catalog.length === 0) {
        sel.innerHTML = `<option value="" data-i18n="purchase_noproduct">暂无商品，请等待品牌方授权后再进货</option>`;
      } else {
        sel.innerHTML = `<option value="" data-i18n="purchase_sel_ph">请选择要进货的商品</option>` +
          catalog.map(c => `<option value="catalog_${c.id}" data-name="${escapeHtml(c.name)}" data-price="${c.cost_price}">${escapeHtml(c.name)}（成本 S$${Number(c.cost_price).toFixed(2)} · 售价 S$${Number(c.sell_price).toFixed(2)}）</option>`).join('');
      }
      I18n.apply();
    }
    // 数量变更更新合计
    const qtyInput = document.getElementById('purchase-qty');
    if (qtyInput && !qtyInput.dataset.bound) {
      qtyInput.dataset.bound = '1';
      qtyInput.addEventListener('input', updatePurchaseTotal);
    }
    // 重置
    purchasePayImg = null;
    const payName = document.getElementById('purchase-pay-name');
    if (payName) payName.textContent = I18n.t('tap_to_upload');
    const payPrev = document.getElementById('purchase-pay-preview');
    if (payPrev) payPrev.classList.add('hidden');
    updatePurchaseTotal();
    loadPurchaseList();
  }

  function updatePurchaseTotal() {
    const qty = parseInt(document.getElementById('purchase-qty').value) || 0;
    const total = qty * 20; // 品牌供货价 S$20/个（品牌链路业务规则）
    const el = document.getElementById('purchase-total');
    if (el) el.textContent = 'S$' + total.toFixed(2);
  }

  function clickPurchaseUpload() {
    const input = document.getElementById('purchase-pay-input');
    if (input) input.click();
  }

  async function handlePurchaseUpload(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      purchasePayImg = await compressImage(file);
      const preview = document.getElementById('purchase-pay-preview');
      const nameEl = document.getElementById('purchase-pay-name');
      if (preview) { preview.src = purchasePayImg; preview.classList.remove('hidden'); }
      if (nameEl) nameEl.textContent = '✓ ' + (file.name || I18n.t('uploaded'));
    } catch (err) {
      showToast('图片处理失败: ' + err.message);
    }
  }

  async function submitPurchase() {
    const productVal = document.getElementById('purchase-product').value;
    const qty = parseInt(document.getElementById('purchase-qty').value) || 0;
    if (!productVal) { showToast(I18n.t('purchase_need_product')); return; }
    if (qty <= 0) { showToast(I18n.t('purchase_need_qty')); return; }
    if (!purchasePayImg) { showToast(I18n.t('purchase_need_pay')); return; }
    try {
      const body = { quantity: qty, paymentImg: purchasePayImg };
      if (productVal.startsWith('catalog_')) {
        body.catalogId = parseInt(productVal.replace('catalog_', ''));
      } else {
        body.productId = parseInt(productVal);
      }
      const r = await api('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (r.id) {
        showToast(I18n.t('purchase_submitted'));
        purchasePayImg = null;
        loadPurchaseView();
      } else {
        showToast(r.error || '提交失败');
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  async function loadPurchaseList() {
    const el = document.getElementById('purchase-list');
    if (!el) return;
    try {
      const list = await api('/api/purchase-orders');
      if (list.length === 0) { el.innerHTML = `<div class="empty-tip">${I18n.t('purchase_none')}</div>`; return; }
      const st = {
        pending: { text: I18n.t('po_pending'), cls: 'chip-pending' },
        approved: { text: I18n.t('po_approved'), cls: 'chip-ok' },
        rejected: { text: I18n.t('po_rejected'), cls: 'chip-no' }
      };
      el.innerHTML = list.map(p => `
        <div class="po-row">
          <div class="po-main">
            <span class="po-name">${escapeHtml(p.product_name)} × ${p.quantity}</span>
            <span class="po-meta">${(p.created_at || '').substring(0, 16)}</span>
            ${p.payment_img ? `<img class="po-img" src="${p.payment_img}" onclick="window.open('${p.payment_img}','_blank')">` : ''}
          </div>
          <div class="po-side">
            <span class="po-cost">S$${Number(p.total_cost).toFixed(2)}</span>
            <span class="chip ${st[p.status] ? st[p.status].cls : ''}">${st[p.status] ? st[p.status].text : p.status}</span>
          </div>
        </div>`).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // 公开接口
  return {
    init, navigate, showToast,
    loadProducts, loadCatalogDetail, loadSalesTrend, loadTrendProductOptions,
    editProduct, deleteProduct, changeStaffRole,
    resetScan, refreshProductsCache,
    openShipmentDetail,
    clickUpload, handleUploadFile,
    clickPurchaseUpload, handlePurchaseUpload, submitPurchase,
    openPasswordModal, closePasswordModal, submitPassword,
    captureScan
  };
})();

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
