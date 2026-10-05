/**
 * StockVerify SG 品牌管理平台（品牌方 / 管理端）
 * - 管理端：注册品牌方、为品牌开通商家、查看所有品牌/商家销售数据
 * - 品牌方：查看自家合作商家销售数据、开通商家、新建发货单并逐件清点后发货
 */
const Admin = (() => {
  // ========== 状态 ==========
  let currentUser = null;
  let currentShop = null;
  let loginRole = 'brand';       // 登录角色 brand / admin
  let adminBrandId = null;       // 管理端当前选中的品牌方
  let adminBrandName = '';       // 管理端选中品牌方名称
  let currentBrandCountry = 'SG'; // 管理端选中品牌方的地区
  let currentMerchantId = null;  // 正在查看的商家
  let shipmentDetailId = null;   // 正在查看的发货单
  let packingItems = [];

  // 图片压缩（转为 base64，控制尺寸）——admin.html 不加载 app.js，需独立定义
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
  let lastLang = null;
  // 删除确认状态
  let deleteTarget = null; // { id, name, type }
  let deleteStep = 0;
  // 修改密码确认状态
  let resetPwdTarget = null; // { id, name }
  let resetPwdStep = 0;

  // ========== 初始化 ==========
  async function init() {
    I18n.init();
    window.__onLangChange = (lang) => {
      if (lang === lastLang) return;
      lastLang = lang;
      if (currentUser) {
        renderAdminNav();
        // 重新渲染当前视图
        const v = document.querySelector('.admin-view.active');
        if (v) {
          const id = v.id.replace('admin-view-', '');
          if (id === 'merchants') loadMerchants();
          if (id === 'brands') loadBrands();
          if (id === 'merchant-detail') loadMerchantDetail();
          if (id === 'shipments') loadShipments();
          if (id === 'shipment-detail') loadShipmentDetail();
          if (id === 'discounts') loadDiscounts();
          if (id === 'purchase') loadPurchaseOrders();
          if (id === 'admins') loadAdmins();
        }
      }
    };

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        // 强制检查并更新SW，确保拿到最新代码
        reg.update().catch(() => {});
        // 清除旧缓存（除了当前版本）
        caches.keys().then(keys => {
          keys.forEach(k => { if (k !== 'stockverify-v51') caches.delete(k); });
        }).catch(() => {});
      } catch (e) {}
    }

    const token = localStorage.getItem('admin-token');
    const userStr = localStorage.getItem('admin-user');
    const shopStr = localStorage.getItem('admin-shop');
    if (token && userStr && shopStr) {
      currentUser = JSON.parse(userStr);
      currentShop = JSON.parse(shopStr);
      showApp();
      updateSelfPwdBtn();
      loadAdminTrendProducts();
    } else {
      showLogin();
    }
    bindEvents();
  }

  function showLogin() {
    document.getElementById('admin-login').classList.add('active');
    document.getElementById('admin-app').classList.remove('active');
    document.getElementById('admin-login-password').value = '';
    document.getElementById('admin-login-username').value = '';
    loginRole = 'brand';
    setRole('brand');
  }

  function showApp() {
    document.getElementById('admin-login').classList.remove('active');
    document.getElementById('admin-app').classList.add('active');
    const roleName = currentUser.role === 'admin' ? I18n.t('admin_role_admin') : (isBrandSuper() ? '总代' : I18n.t('admin_role_brand'));
    document.getElementById('admin-header-sub').textContent = currentShop.name + ' · ' + roleName + ' · ' + currentUser.username;
    // 普通代理不能开通商家
    const regMerchantBtn = document.getElementById('admin-btn-register-merchant');
    if (regMerchantBtn) regMerchantBtn.style.display = (currentUser.role === 'brand' && !isBrandSuper()) ? 'none' : '';
    // 只有总代能注册代理
    const regAgentBtn = document.getElementById('admin-btn-register-agent');
    if (regAgentBtn) regAgentBtn.style.display = isBrandSuper() ? '' : 'none';
    lastLang = I18n.getLang();
    renderAdminNav();
    if (currentUser.role === 'admin') navigateAdmin('brands');
    else if (isBrandSuper()) navigateAdmin('purchase');
    else navigateAdmin('shipments');
  }

  // ========== 登录角色 ==========
  function setRole(role) {
    loginRole = role;
    const b = document.getElementById('admin-role-brand');
    const a = document.getElementById('admin-role-admin');
    if (b && a) { b.classList.toggle('active', role === 'brand'); a.classList.toggle('active', role === 'admin'); }
  }

  // ========== 登录（用户名 + 密码） ==========
  async function handleLogin() {
    const password = document.getElementById('admin-login-password').value.trim();
    const username = document.getElementById('admin-login-username').value.trim();
    if (!password || !username) { showToast('请输入用户名和密码'); return; }
    try {
      const res = await fetch('/api/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role: loginRole })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败');
      currentUser = data.user;
      currentShop = data.shop;
      localStorage.setItem('admin-token', data.token);
      localStorage.setItem('admin-user', JSON.stringify(data.user));
      localStorage.setItem('admin-shop', JSON.stringify(data.shop));
      showToast(I18n.t('login_success') + ' ' + username);
      showApp();
      updateSelfPwdBtn();
      loadAdminTrendProducts();
    } catch (err) {
      showToast(err.message);
    }
  }

  function handleLogout() {
    Scanner.stop();
    localStorage.removeItem('admin-token');
    localStorage.removeItem('admin-user');
    localStorage.removeItem('admin-shop');
    currentUser = null; currentShop = null; adminBrandId = null; currentMerchantId = null; shipmentDetailId = null;
    showLogin();
    showToast(I18n.t('logout_success'));
  }

  // ========== API ==========
  async function api(url, options = {}) {
    const token = localStorage.getItem('admin-token');
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(url, { ...options, headers, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '请求失败');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function apiWithRetry(fn, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (err.status && err.status < 500) throw err;
        await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  // ========== 权限辅助 ==========
  function isBrandSuper() {
    return currentUser && currentUser.role === 'brand' &&
      Array.isArray(currentUser.permissions) && currentUser.permissions.includes('brand_super');
  }

  // ========== 导航 ==========
  function renderAdminNav() {
    const nav = document.getElementById('admin-bottom-nav');
    if (!nav) return;
    let html = '';
    const item = (view, key) => `<button class="nav-item" data-aview="${view}" onclick="Admin.navigateAdmin('${view}')"><span data-i18n="${key}"></span></button>`;
    if (currentUser.role === 'admin') {
      html += item('brands', 'admin_brands');
      html += `<button class="nav-item" data-aview="catalog" onclick="Admin.navigateAdmin('catalog')"><span>商品库</span></button>`;
      html += `<button class="nav-item" data-aview="settings" onclick="Admin.navigateAdmin('settings')"><span>财务设置</span></button>`;
      if (isSuperAdmin()) html += item('admins', 'admin_accounts');
    } else if (isBrandSuper()) {
      // 总代：商家列表、商品授权、进货单（审核+分配）、折扣审核
      html += item('merchants', 'admin_merchants');
      html += `<button class="nav-item" data-aview="catalog" onclick="Admin.navigateAdmin('catalog')"><span>商品授权</span></button>`;
      html += item('purchase', 'admin_purchase');
      html += item('discounts', 'admin_discounts');
    } else {
      // 普通代理：商家列表（看店铺）、待发货扫码
      html += item('merchants', 'admin_merchants');
      html += item('shipments', 'admin_shipments');
    }
    nav.innerHTML = html;
    I18n.apply();
  }

  function navigateAdmin(view) {
    document.querySelectorAll('.admin-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('admin-view-' + view);
    if (target) target.classList.add('active');
    document.querySelectorAll('[data-aview]').forEach(it => it.classList.toggle('active', it.dataset.aview === view));
    // 离开清点页停止摄像头
    if (view !== 'shipment-detail') { Scanner.stop(); }
    if (view === 'brands') loadBrands();
    if (view === 'catalog') loadCatalog();
    if (view === 'settings') loadAdminSettings();
    if (view === 'catalog-edit') { /* openCatalogEdit 已传参，不自动加载 */ }
    if (view === 'merchants') loadMerchants();
    if (view === 'merchant-detail') loadMerchantDetail();
    if (view === 'shipments') loadShipments();
    if (view === 'shipment-detail') loadShipmentDetail();
    if (view === 'discounts') loadDiscounts();
    if (view === 'purchase') loadPurchaseOrders();
    if (view === 'admins') loadAdmins();
    if (view === 'sales-trend') loadAdminSalesTrend();
  }

  // ========== 品牌方列表（管理端） ==========
  async function loadBrands() {
    const el = document.getElementById('admin-brand-list');
    try {
      const brands = await apiWithRetry(() => api('/api/admin/brands'));
      if (brands.length === 0) { el.innerHTML = `<div class="empty-tip">${I18n.t('admin_no_brands')}</div>`; return; }
      el.innerHTML = brands.map(b => `
        <div class="admin-brand-card" data-shop-id="${b.id}" data-shop-name="${escapeHtml(b.shop_name)}" data-shop-type="brand" onclick="Admin.openBrandDetail(${b.id})" style="cursor:pointer;">
          <div class="admin-brand-card-head">
            <span class="admin-brand-name">${escapeHtml(b.shop_name)}</span>
            <span class="chip chip-pending">代理 ${b.agent_count || 0} · 商铺 ${b.merchant_count || 0}</span>
          </div>
          <div class="admin-brand-meta">${isSuperAdmin() ? '初始密码: ' + escapeHtml(b.card_key) : '<span style="color:#999;font-size:12px;">无权查看密码</span>'} · ${I18n.t('admin_country')}: ${countryLabel(b.country)}${isSuperAdmin() ? ' · <span class="hint">长按删除</span>' : ''}</div>
        </div>
      `).join('');
      if (isSuperAdmin()) bindLongPress(el, (id, name, type) => openDeleteConfirm(id, name, type));
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // 管理端：打开总代详情
  async function openBrandDetail(brandId) {
    adminBrandId = brandId;
    // 直接激活视图，不调用 navigateAdmin（避免递归）
    document.querySelectorAll('.admin-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('admin-view-brand-detail');
    if (target) target.classList.add('active');
    document.querySelectorAll('[data-aview]').forEach(it => it.classList.toggle('active', it.dataset.aview === 'brand-detail'));
    const el = document.getElementById('admin-brand-detail');
    if (!el) return;
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
      const data = await api('/api/admin/brands/' + brandId + '/detail');
      document.getElementById('admin-brand-detail-title').textContent = data.brand.shop_name + ' · 总代详情';
      const s = data.sales || {};
      el.innerHTML = `
        <div class="section-card">
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">普通代理数</div><div class="stat-value">${data.agents.length}</div></div>
            <div class="stat-card"><div class="stat-label">商铺数</div><div class="stat-value">${data.merchants.length}</div></div>
            <div class="stat-card"><div class="stat-label">今日销售额</div><div class="stat-value">S$${Number(s.today_sales || 0).toFixed(2)}</div></div>
            <div class="stat-card"><div class="stat-label">今日订单</div><div class="stat-value">${s.today_count || 0}</div></div>
            <div class="stat-card"><div class="stat-label">累计销售额</div><div class="stat-value">S$${Number(s.total_sales || 0).toFixed(2)}</div></div>
            <div class="stat-card"><div class="stat-label">品牌累计分成</div><div class="stat-value">S$${Number(s.total_brand_share || 0).toFixed(2)}</div></div>
          </div>
        </div>
        <div class="section-card">
          <h3>销售趋势</h3>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <select id="brand-trend-product" style="padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;">
              <option value="">全部商品</option>
            </select>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              <button class="btn btn-secondary brand-trend-btn" data-period="today">本日</button>
              <button class="btn btn-secondary brand-trend-btn" data-period="week">本周</button>
              <button class="btn btn-secondary brand-trend-btn active" data-period="month">本月</button>
              <button class="btn btn-secondary brand-trend-btn" data-period="month_all">每月</button>
              <button class="btn btn-secondary brand-trend-btn" data-period="quarter">每季度</button>
              <button class="btn btn-secondary brand-trend-btn" data-period="year_all">每年</button>
            </div>
          </div>
          <canvas id="brand-sales-trend-chart" style="max-height:300px;height:280px;"></canvas>
        </div>
        <div class="section-card">
          <h3>商铺销量对比</h3>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
              <button class="btn btn-secondary brand-merchant-bar-btn active" data-period="today">今日</button>
              <button class="btn btn-secondary brand-merchant-bar-btn" data-period="week">本周</button>
              <button class="btn btn-secondary brand-merchant-bar-btn" data-period="month">本月</button>
              <button class="btn btn-secondary brand-merchant-bar-btn" data-period="year">今年</button>
              <button class="btn btn-secondary brand-merchant-bar-btn" data-period="all">全部</button>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <div id="brand-merchant-bar-tagbox" style="position:relative;min-width:200px;">
                <div id="brand-merchant-bar-tags" style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;min-height:32px;align-items:center;background:#fff;cursor:text;" onclick="document.getElementById('brand-merchant-bar-search').focus()">
                  <input type="text" id="brand-merchant-bar-search" placeholder="搜索商品..." style="border:none;outline:none;font-size:12px;flex:1;min-width:80px;background:transparent;" oninput="Admin.filterBarProducts(this.value)" onfocus="Admin.showBarProductDropdown()" onblur="setTimeout(()=>Admin.hideBarProductDropdown(),200)">
                </div>
                <div id="brand-merchant-bar-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--border);border-radius:6px;max-height:160px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>
              </div>
              <input type="date" id="brand-merchant-bar-start" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;" title="开始日期">
              <span style="font-size:12px;color:#999;">至</span>
              <input type="date" id="brand-merchant-bar-end" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;" title="结束日期">
              <button class="btn btn-primary" style="padding:4px 12px;font-size:12px;" onclick="Admin.applyBrandMerchantBarFilter()">应用</button>
            </div>
          </div>
          <canvas id="brand-merchant-sales-chart" style="max-height:300px;height:280px;"></canvas>
        </div>
        <div class="section-card">
          <h3>快捷入口</h3>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" onclick="Admin.viewBrandAgents()">查看普通代理 (${data.agents.length})</button>
            <button type="button" class="btn btn-primary" onclick="Admin.viewBrandMerchants()">查看商铺 (${data.merchants.length})</button>
          </div>
        </div>
        <div id="admin-brand-sub-list"></div>
      `;
      window.__brandDetailData = data;
      // 加载销售趋势
      setTimeout(() => { loadBrandSalesTrend(brandId); loadBrandMerchantBarChart(brandId); }, 100);
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // 查看总代下的代理列表（卡片式，含发货情况）
  function viewBrandAgents() {
    const data = window.__brandDetailData;
    if (!data) return;
    const el = document.getElementById('admin-brand-sub-list');
    el.innerHTML = `<div class="section-card"><h3>普通代理列表 (${data.agents.length})</h3>` +
      (data.agents.length === 0 ? '<div class="empty-tip">暂无代理</div>' :
        data.agents.map(a => `
          <div class="admin-brand-card" style="margin-bottom:10px;">
            <div class="admin-brand-card-head">
              <span class="admin-brand-name">${escapeHtml(a.shop_name)}</span>
              <span class="chip chip-pending">待发 ${a.pending_ship || 0}</span>
              <span class="chip chip-ok">已发 ${a.shipped || 0}</span>
            </div>
            <div class="admin-brand-meta">
              ${isSuperAdmin() ? '账号: ' + escapeHtml(a.account || '-') : '<span style="color:#999;font-size:12px;"></span>'} · ${countryLabel(a.country)} · 已收货 ${a.received || 0} · ${(a.created_at || '').substring(0,10)}
            </div>
          </div>`).join('')) +
      `</div>`;
  }

  // 查看总代下的商铺列表（点击可看销售详情）
  function viewBrandMerchants() {
    const data = window.__brandDetailData;
    if (!data) return;
    const el = document.getElementById('admin-brand-sub-list');
    el.innerHTML = `<div class="section-card"><h3>商铺列表 (${data.merchants.length})</h3>` +
      (data.merchants.length === 0 ? '<div class="empty-tip">暂无商铺</div>' :
        `<div class="mini-table">${data.merchants.map(m => `
          <div class="mini-row" style="cursor:pointer;" onclick="Admin.openMerchantDetail(${m.id})">
            <span>${escapeHtml(m.shop_name)}</span>
            <span>${isSuperAdmin() ? '账号: ' + escapeHtml(m.account || '-') : '<span style="color:#999;"></span>'}</span>
            <span>${countryLabel(m.country)}</span>
            <span style="color:#2563eb;">查看销售 →</span>
          </div>`).join('')}</div>`) +
      `</div>`;
  }

  // 地区销售详情
  function viewBrandSales() {
    const data = window.__brandDetailData;
    if (!data) return;
    const s = data.sales || {};
    const el = document.getElementById('admin-brand-sub-list');
    el.innerHTML = `
      <div class="section-card">
        <h3>地区销售详情</h3>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">今日销售额</div><div class="stat-value">S$${Number(s.today_sales || 0).toFixed(2)}</div></div>
          <div class="stat-card"><div class="stat-label">今日订单数</div><div class="stat-value">${s.today_count || 0}</div></div>
          <div class="stat-card"><div class="stat-label">累计销售额</div><div class="stat-value">S$${Number(s.total_sales || 0).toFixed(2)}</div></div>
          <div class="stat-card"><div class="stat-label">品牌累计分成</div><div class="stat-value">S$${Number(s.total_brand_share || 0).toFixed(2)}</div></div>
          <div class="stat-card"><div class="stat-label">商家累计分成</div><div class="stat-value">S$${Number(s.total_merchant_share || 0).toFixed(2)}</div></div>
        </div>
      </div>`;
  }

  // 总代详情页销售趋势图表
  let brandTrendChart = null;
  async function loadBrandSalesTrend(brandId) {
    const canvas = document.getElementById('brand-sales-trend-chart');
    if (!canvas) return;
    try {
      // 加载商品筛选（失败时只显示全部商品）
      try {
        const catalogs = await api('/api/admin/catalog');
        const sel = document.getElementById('brand-trend-product');
        if (sel) {
          const active = catalogs.filter(c => c.status === 'active' || !c.status);
          sel.innerHTML = '<option value="">全部商品</option>' + active.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
          sel.onchange = () => loadBrandTrendData(brandId);
        }
      } catch(e) { /* 商品筛选可选 */ }
      // 绑定时段按钮
      document.querySelectorAll('.brand-trend-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('.brand-trend-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          loadBrandTrendData(brandId);
        };
      });
      loadBrandTrendData(brandId);
    } catch (err) { console.error(err); }
  }

  async function loadBrandTrendData(brandId) {
    const canvas = document.getElementById('brand-sales-trend-chart');
    if (!canvas) return;
    const period = document.querySelector('.brand-trend-btn.active')?.dataset.period || 'all';
    const catalogId = document.getElementById('brand-trend-product')?.value || '';
    const pointR = (period === 'month_all' || period === 'quarter' || period === 'year_all') ? 0 : 3;
    try {
      const data = await api(`/api/admin/sales-trend?brandId=${brandId}&period=${period}${catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`);
      const labels = (data.data || []).map(d => data.labelFmt === 'hour' ? d.label + ':00' : d.label);
      const revenues = (data.data || []).map(d => Number(d.revenue).toFixed(2));
      const qtys = (data.data || []).map(d => d.qty);
      if (brandTrendChart) brandTrendChart.destroy();
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, 260);
      gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
      gradient.addColorStop(1, 'rgba(99,102,241,0.02)');
      brandTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '营收 (S$)', data: revenues, borderColor: '#6366f1', backgroundColor: gradient, fill: true, tension: 0.35, pointRadius: pointR, pointHoverRadius: 6, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 2, borderWidth: 2, yAxisID: 'y' },
            { label: '销量 (件)', data: qtys, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: 0.35, pointRadius: pointR > 0 ? 2 : 0, pointHoverRadius: 5, pointBackgroundColor: '#f59e0b', pointBorderColor: '#fff', pointBorderWidth: 1.5, borderWidth: 1.5, borderDash: [4, 2], yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true } } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 15, autoSkipPadding: 10 }, grid: { display: false } },
            y: { type: 'linear', position: 'left', ticks: { font: { size: 10 }, callback: v => 'S$' + v }, grid: { color: 'rgba(0,0,0,0.05)' } },
            y1: { type: 'linear', position: 'right', ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    } catch (err) { showToast(err.message); }
  }

  // 总代详情页：商铺销量对比柱状图
  let brandMerchantBarChart = null;
  let barSelectedProducts = []; // 已选商品 [{id, name}]
  let barAllProducts = []; // 所有商品列表
  async function loadBrandMerchantBarChart(brandId) {
    const canvas = document.getElementById('brand-merchant-sales-chart');
    if (!canvas) return;
    // 加载商品列表
    try {
      const catalogs = await api('/api/admin/catalog');
      barAllProducts = catalogs.filter(c => c.status === 'active' || !c.status);
      renderBarTags();
    } catch(e) {}
    // 绑定时段按钮
    document.querySelectorAll('.brand-merchant-bar-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.brand-merchant-bar-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const s = document.getElementById('brand-merchant-bar-start');
        const e = document.getElementById('brand-merchant-bar-end');
        if (s) s.value = '';
        if (e) e.value = '';
        loadBrandMerchantBarChart(brandId);
      };
    });
    const period = document.querySelector('.brand-merchant-bar-btn.active')?.dataset.period || 'today';
    const startDate = document.getElementById('brand-merchant-bar-start')?.value || '';
    const endDate = document.getElementById('brand-merchant-bar-end')?.value || '';
    const catalogIds = barSelectedProducts.map(p => p.id).join(',');
    let url = `/api/admin/brands/${brandId}/merchant-sales?period=${period}`;
    if (startDate && endDate) url += `&start_date=${startDate}&end_date=${endDate}`;
    if (catalogIds) url += `&catalog_ids=${catalogIds}`;
    try {
      const data = await api(url);
      const labels = data.map(d => d.shopName);
      const sales = data.map(d => d.sales);
      const revenues = data.map(d => Number(d.revenue).toFixed(2));
      if (brandMerchantBarChart) brandMerchantBarChart.destroy();
      const ctx = canvas.getContext('2d');
      brandMerchantBarChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: '销量 (件)', data: sales, backgroundColor: 'rgba(99,102,241,0.7)', borderColor: '#6366f1', borderWidth: 1, borderRadius: 4, yAxisID: 'y' },
            { label: '营收 (S$)', data: revenues, backgroundColor: 'rgba(245,158,11,0.6)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true } } },
          scales: {
            x: { ticks: { font: { size: 11 } }, grid: { display: false } },
            y: { type: 'linear', position: 'left', beginAtZero: true, ticks: { font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(0,0,0,0.05)' }, title: { display: true, text: '销量', font: { size: 10 } } },
            y1: { type: 'linear', position: 'right', beginAtZero: true, ticks: { font: { size: 10 }, callback: v => 'S$' + v }, grid: { display: false }, title: { display: true, text: '营收', font: { size: 10 } } }
          }
        }
      });
    } catch (err) { showToast(err.message); }
  }

  // 标签选择器：渲染已选标签
  function renderBarTags() {
    const tagsEl = document.getElementById('brand-merchant-bar-tags');
    if (!tagsEl) return;
    const input = document.getElementById('brand-merchant-bar-search');
    // 保留input，重建标签
    tagsEl.querySelectorAll('.bar-tag').forEach(t => t.remove());
    barSelectedProducts.forEach(p => {
      const tag = document.createElement('span');
      tag.className = 'bar-tag';
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#eef2ff;color:#4f46e5;border-radius:12px;font-size:12px;';
      tag.innerHTML = `${escapeHtml(p.name)} <span style="cursor:pointer;font-weight:bold;margin-left:2px;" onclick="Admin.removeBarProduct(${p.id})">×</span>`;
      tagsEl.insertBefore(tag, input);
    });
  }

  // 标签选择器：搜索过滤
  function filterBarProducts(keyword) {
    const dropdown = document.getElementById('brand-merchant-bar-dropdown');
    if (!dropdown) return;
    const kw = (keyword || '').toLowerCase();
    const candidates = barAllProducts.filter(p =>
      !barSelectedProducts.find(s => s.id === p.id) &&
      (p.name || '').toLowerCase().includes(kw)
    );
    if (candidates.length === 0) {
      dropdown.innerHTML = '<div style="padding:8px;font-size:12px;color:#999;">无匹配商品</div>';
    } else {
      dropdown.innerHTML = candidates.map(p =>
        `<div style="padding:6px 10px;font-size:12px;cursor:pointer;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='transparent'" onmousedown="event.preventDefault();Admin.selectBarProduct(${p.id}, '${escapeHtml(p.name)}')">${escapeHtml(p.name)}</div>`
      ).join('');
    }
    dropdown.style.display = 'block';
  }

  function showBarProductDropdown() {
    const input = document.getElementById('brand-merchant-bar-search');
    if (input) filterBarProducts(input.value);
  }

  function hideBarProductDropdown() {
    const dropdown = document.getElementById('brand-merchant-bar-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }

  function selectBarProduct(id, name) {
    if (!barSelectedProducts.find(p => p.id === id)) {
      barSelectedProducts.push({ id, name });
    }
    renderBarTags();
    const input = document.getElementById('brand-merchant-bar-search');
    if (input) { input.value = ''; input.focus(); }
    filterBarProducts('');
  }

  function removeBarProduct(id) {
    barSelectedProducts = barSelectedProducts.filter(p => p.id !== id);
    renderBarTags();
  }

  function applyBrandMerchantBarFilter() {
    const brandId = adminBrandId;
    if (!brandId) return;
    document.querySelectorAll('.brand-merchant-bar-btn').forEach(b => b.classList.remove('active'));
    loadBrandMerchantBarChart(brandId);
  }

  // 商铺详情页销售趋势图表
  let merchantTrendChart = null;
  async function loadMerchantSalesTrend(merchantId) {
    const canvas = document.getElementById('merchant-sales-trend-chart');
    if (!canvas) return;
    try {
      // 加载商品筛选（失败时只显示全部商品）
      try {
        const catalogs = await api('/api/admin/catalog');
        const sel = document.getElementById('merchant-trend-product');
        if (sel) {
          const active = catalogs.filter(c => c.status === 'active' || !c.status);
          sel.innerHTML = '<option value="">全部商品</option>' + active.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
          sel.onchange = () => loadMerchantTrendData(merchantId);
        }
      } catch(e) { /* 商品筛选可选 */ }
      document.querySelectorAll('.merchant-trend-btn').forEach(btn => {
        btn.onclick = () => {
          document.querySelectorAll('.merchant-trend-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          loadMerchantTrendData(merchantId);
        };
      });
      loadMerchantTrendData(merchantId);
    } catch (err) { console.error(err); }
  }

  async function loadMerchantTrendData(merchantId) {
    const canvas = document.getElementById('merchant-sales-trend-chart');
    if (!canvas) return;
    const period = document.querySelector('.merchant-trend-btn.active')?.dataset.period || 'all';
    const catalogId = document.getElementById('merchant-trend-product')?.value || '';
    const pointR = (period === 'month_all' || period === 'quarter' || period === 'year_all') ? 0 : 3;
    try {
      const data = await api(`/api/merchant/sales-trend?merchantId=${merchantId}&period=${period}${catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`);
      const labels = (data.data || []).map(d => data.labelFmt === 'hour' ? d.label + ':00' : d.label);
      const revenues = (data.data || []).map(d => Number(d.revenue).toFixed(2));
      const qtys = (data.data || []).map(d => d.qty);
      if (merchantTrendChart) merchantTrendChart.destroy();
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, 260);
      gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
      gradient.addColorStop(1, 'rgba(99,102,241,0.02)');
      merchantTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '营收 (S$)', data: revenues, borderColor: '#6366f1', backgroundColor: gradient, fill: true, tension: 0.35, pointRadius: pointR, pointHoverRadius: 6, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 2, borderWidth: 2, yAxisID: 'y' },
            { label: '销量 (件)', data: qtys, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: 0.35, pointRadius: pointR > 0 ? 2 : 0, pointHoverRadius: 5, pointBackgroundColor: '#f59e0b', pointBorderColor: '#fff', pointBorderWidth: 1.5, borderWidth: 1.5, borderDash: [4, 2], yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true } } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 15, autoSkipPadding: 10 }, grid: { display: false } },
            y: { type: 'linear', position: 'left', ticks: { font: { size: 10 }, callback: v => 'S$' + v }, grid: { color: 'rgba(0,0,0,0.05)' } },
            y1: { type: 'linear', position: 'right', ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    } catch (err) { showToast(err.message); }
  }

  // ========== 商品库 ==========
  let currentCatalogId = null;

  async function loadCatalog() {
    const el = document.getElementById('admin-catalog-list');
    const addBtn = document.getElementById('admin-btn-catalog-add');
    const title = document.getElementById('admin-catalog-title');
    if (!el) return;
    const perms = currentUser.permissions || [];
    const isAdmin = currentUser.role === 'admin';
    const isSuper = isAdmin && isSuperAdmin();
    const isNormalAdmin = isAdmin && !isSuper;
    const isBrandSuper = perms.includes('brand_super');
    const isAgent = currentUser.role === 'brand' && !isBrandSuper;
    if (addBtn) addBtn.style.display = isSuper ? '' : 'none';
    if (title) title.textContent = isAdmin ? '商品库' : '商品授权';
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
      const url = isAdmin ? '/api/admin/catalog' : '/api/brand/catalog';
      const list = await api(url);
      if (!list || list.length === 0) {
        el.innerHTML = `<div class="empty-tip">${isSuper ? '暂无商品，点击右上角上新' : '暂无授权商品'}</div>`;
        return;
      }
      el.innerHTML = list.map(c => {
        const isOffline = c.status === 'inactive';
        return `
        <div class="admin-brand-card" data-catalog-id="${c.id}" style="cursor:pointer;${isOffline ? 'opacity:0.5;' : ''}">
          <div class="admin-brand-card-head">
            <span class="admin-brand-name">${escapeHtml(c.name)}${isOffline ? ' <span class="chip chip-no">已下架</span>' : ' <span class="chip chip-ok">在售</span>'}</span>
            <span class="chip chip-ok">S$${Number(c.sell_price).toFixed(2)}</span>
          </div>
          <div class="admin-brand-meta">
            ${c.sku ? 'SKU ' + escapeHtml(c.sku) + ' · ' : ''}${escapeHtml(c.category || '未分类')}
            · 库存 ${c.in_stock || 0} 件 · 成本 S$${Number(c.cost_price).toFixed(2)}
          </div>
          <div class="admin-brand-meta">
            已授权 ${c.auth_count || 0} 家
            ${c.promo_image ? ' · 有宣传图' : ''}
            ${c.description ? ' · '+escapeHtml(c.description.substring(0,30)) : ''}
          </div>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="Admin.openCatalogEdit(${c.id})">查看详情</button>
            ${isSuper ? `<button type="button" class="btn btn-primary btn-sm" onclick="Admin.authCatalogToAdmin(${c.id})">授权给管理</button>` : ''}
            ${isSuper ? (isOffline
              ? `<button type="button" class="btn btn-secondary btn-sm" onclick="Admin.setCatalogStatus(${c.id},'active')">上架</button>`
              : `<button type="button" class="btn btn-danger btn-sm" onclick="Admin.setCatalogStatus(${c.id},'inactive')">下架</button>`) : ''}
            ${isNormalAdmin ? `<button type="button" class="btn btn-primary btn-sm" onclick="Admin.authCatalogToBrand(${c.id})">授权给总代</button>` : ''}
            ${isBrandSuper ? `<button type="button" class="btn btn-primary btn-sm" onclick="Admin.authCatalogToTarget(${c.id})">授权</button>` : ''}
          </div>
        </div>`;
      }).join('');
      // 超管：绑定长按事件
      if (isSuper) {
        el.querySelectorAll('.admin-brand-card').forEach(card => {
          let pressTimer = null;
          const cid = parseInt(card.dataset.catalogId);
          const startPress = () => {
            pressTimer = setTimeout(() => showCatalogActionMenu(cid), 600);
          };
          const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
          card.addEventListener('mousedown', startPress);
          card.addEventListener('mouseup', cancelPress);
          card.addEventListener('mouseleave', cancelPress);
          card.addEventListener('touchstart', startPress, { passive: true });
          card.addEventListener('touchend', cancelPress);
          card.addEventListener('touchmove', cancelPress);
        });
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // 通用居中弹窗（替代原生confirm）
  function showActionModal(title, bodyHtml, buttons) {
    const overlay = document.getElementById('admin-action-overlay');
    const titleEl = document.getElementById('admin-action-title');
    const bodyEl = document.getElementById('admin-action-body');
    const actionsEl = document.getElementById('admin-action-actions');
    if (!overlay) return;
    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    actionsEl.innerHTML = '';
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (btn.cls || 'btn-secondary');
      b.textContent = btn.text;
      b.onclick = () => {
        overlay.classList.add('hidden');
        if (btn.onClick) btn.onClick();
      };
      actionsEl.appendChild(b);
    });
    overlay.classList.remove('hidden');
  }
  function closeActionModal() {
    const overlay = document.getElementById('admin-action-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // 通用列表选择弹窗（替代 prompt 输入序号）
  function showSelectModal(title, items, onSelect) {
    const overlay = document.getElementById('admin-action-overlay');
    const titleEl = document.getElementById('admin-action-title');
    const bodyEl = document.getElementById('admin-action-body');
    const actionsEl = document.getElementById('admin-action-actions');
    if (!overlay) return;
    titleEl.textContent = title;
    bodyEl.innerHTML = items.length === 0 ? '<div class="empty-tip">暂无选项</div>' :
      '<div style="max-height:300px;overflow-y:auto;">' +
      items.map((item, i) => `
        <div class="admin-brand-card" style="margin-bottom:6px;padding:12px 14px;cursor:pointer;" data-select-idx="${i}">
          <div style="font-weight:600;">${escapeHtml(item.label)}</div>
          ${item.sub ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(item.sub)}</div>` : ''}
        </div>
      `).join('') + '</div>';
    actionsEl.innerHTML = '<button type="button" class="btn btn-secondary" id="select-modal-cancel">取消</button>';
    overlay.classList.remove('hidden');
    bodyEl.querySelectorAll('[data-select-idx]').forEach(card => {
      card.onclick = () => {
        overlay.classList.add('hidden');
        const idx = parseInt(card.dataset.selectIdx);
        if (onSelect) onSelect(items[idx]);
      };
    });
    document.getElementById('select-modal-cancel').onclick = () => overlay.classList.add('hidden');
  }

  // 加载商品授权链路（树形折叠）
  async function loadCatalogAuthChain(catalogId) {
    const el = document.getElementById('cat-auth-chain-list');
    if (!el) return;
    try {
      const data = await api('/api/catalog/' + catalogId + '/auth-tree');
      const tree = data.tree || [];
      if (tree.length === 0) {
        el.innerHTML = '<div class="empty-tip">暂无授权记录</div>';
        return;
      }
      const expanded = new Set();
      const levelMap = { admin: '普通管理', brand_super: '总代', brand: '普通代理', merchant: '商铺' };
      const levelColor = { admin: 'chip-ok', brand_super: 'chip-ok', brand: 'chip-ok', merchant: '' };

      function renderNode(node, depth) {
        const hasChildren = node.children && node.children.length > 0;
        const isExpanded = expanded.has(node.id);
        const canRevoke = isSuperAdmin() || node.authorizedBy === currentUser.shopId;
        return `
          <div class="auth-tree-node" data-auth-id="${node.id}" style="margin-left:${depth * 16}px;">
            <div class="admin-brand-card" style="margin-bottom:6px;padding:10px 14px;cursor:pointer;" data-node-id="${node.id}">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="display:flex;align-items:center;gap:8px;">
                  ${hasChildren ? `<span class="auth-toggle" data-toggle="${node.id}" style="width:16px;display:inline-block;">${isExpanded ? '▼' : '▶'}</span>` : '<span style="width:16px;display:inline-block;"></span>'}
                  <span style="font-weight:600;">${escapeHtml(node.targetName)}</span>
                  <span class="chip ${levelColor[node.level] || ''}">${levelMap[node.level] || node.level}</span>
                </div>
                <span style="font-size:11px;color:#94a3b8;">${node.authorizedByName} 授权</span>
              </div>
              ${(isSuperAdmin() || isBrandSuper()) && (node.level === 'brand_super' || node.level === 'merchant') ? '<div style="font-size:11px;color:#3b82f6;margin-top:4px;">点击查看销售情况</div>' : ''}
            </div>
            <div class="auth-children" id="auth-children-${node.id}" style="${isExpanded ? '' : 'display:none;'}">
              ${hasChildren ? node.children.map(c => renderNode(c, depth + 1)).join('') : ''}
            </div>
          </div>
        `;
      }

      el.innerHTML = tree.map(n => renderNode(n, 0)).join('');

      // 绑定点击展开/销售
      el.querySelectorAll('[data-node-id]').forEach(card => {
        const authId = parseInt(card.dataset.nodeId);
        let pressTimer = null;
        const startPress = () => { pressTimer = setTimeout(() => {
          if (canRevokeFor(authId)) showRevokeAuthMenu(authId, tree);
        }, 600); };
        const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
        card.addEventListener('mousedown', startPress);
        card.addEventListener('mouseup', cancelPress);
        card.addEventListener('mouseleave', cancelPress);
        card.addEventListener('touchstart', startPress, { passive: true });
        card.addEventListener('touchend', cancelPress);
        card.addEventListener('touchmove', cancelPress);
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('auth-toggle')) {
            e.stopPropagation();
            const id = parseInt(e.target.dataset.toggle);
            if (expanded.has(id)) { expanded.delete(id); e.target.textContent = '▶'; }
            else { expanded.add(id); e.target.textContent = '▼'; }
            document.getElementById('auth-children-' + id).style.display = expanded.has(id) ? '' : 'none';
            return;
          }
          // 点击节点：展开+查看销售（总代/商铺）
          const node = findNode(tree, authId);
          if (node && node.children && node.children.length > 0) {
            if (expanded.has(authId)) { expanded.delete(authId); }
            else { expanded.add(authId); }
            const toggle = card.querySelector('.auth-toggle');
            if (toggle) toggle.textContent = expanded.has(authId) ? '▼' : '▶';
            const childEl = document.getElementById('auth-children-' + authId);
            if (childEl) childEl.style.display = expanded.has(authId) ? '' : 'none';
          }
          // 总代/商铺：弹出销售情况
          if (node && (node.level === 'brand_super' || node.level === 'merchant')) {
            showAuthSales(authId, node.targetName);
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  function findNode(tree, id) {
    for (const n of tree) {
      if (n.id === id) return n;
      if (n.children) { const f = findNode(n.children, id); if (f) return f; }
    }
    return null;
  }

  function canRevokeFor(authId) {
    return isSuperAdmin(); // 简化：超管可取消所有，其他角色暂不支持取消
  }

  // 显示授权节点销售情况 → 跳转完整销售趋势详情页
  async function showAuthSales(authId, targetName) {
    try {
      const data = await api('/api/catalog/auth/' + authId + '/sales');
      if (data.sales === null) {
        showActionModal('销售情况', `<strong>${escapeHtml(targetName)}</strong><br><br>${escapeHtml(data.message || '该角色不显示销售情况')}`, [
          { text: '关闭', cls: 'btn-secondary', onClick: () => {} }
        ]);
        return;
      }
      // 跳转到销售趋势详情页
      openSalesDetail(authId, targetName, data.levelLabel, data.sales, data.level, data.shopId);
    } catch (err) { showToast(err.message); }
  }

  // 销售趋势详情页（完整折线图）
  let salesDetailChart = null;
  let salesDetailContext = null;
  async function openSalesDetail(authId, targetName, levelLabel, salesSummary, level, shopId) {
    salesDetailContext = { authId, targetName, levelLabel, salesSummary, level, shopId };
    document.querySelectorAll('.admin-view').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view-sales-detail').classList.add('active');
    document.querySelectorAll('[data-aview]').forEach(it => it.classList.toggle('active', it.dataset.aview === 'sales-detail'));
    document.getElementById('admin-sales-detail-title').textContent = targetName + ' · 销售趋势';
    const el = document.getElementById('admin-sales-detail');
    const s = salesSummary || {};
    el.innerHTML = `
      <div class="section-card">
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">总订单</div><div class="stat-value">${s.totalOrders || 0}</div></div>
          <div class="stat-card"><div class="stat-label">总营收</div><div class="stat-value">S$${Number(s.totalRevenue || 0).toFixed(2)}</div></div>
          <div class="stat-card"><div class="stat-label">总GST</div><div class="stat-value">S$${Number(s.totalGst || 0).toFixed(2)}</div></div>
          ${s.todayOrders !== undefined ? `<div class="stat-card"><div class="stat-label">今日订单</div><div class="stat-value">${s.todayOrders}</div></div>` : ''}
          ${s.merchantCount !== undefined ? `<div class="stat-card"><div class="stat-label">下属商铺</div><div class="stat-value">${s.merchantCount}</div></div>` : ''}
        </div>
      </div>
      <div class="section-card">
        <h3>销售趋势</h3>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <select id="sales-detail-product" style="padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;">
            <option value="">全部商品</option>
          </select>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn btn-secondary sales-detail-trend-btn" data-period="today">本日</button>
            <button class="btn btn-secondary sales-detail-trend-btn" data-period="week">本周</button>
            <button class="btn btn-secondary sales-detail-trend-btn active" data-period="month">本月</button>
            <button class="btn btn-secondary sales-detail-trend-btn" data-period="month_all">每月</button>
            <button class="btn btn-secondary sales-detail-trend-btn" data-period="quarter">每季度</button>
            <button class="btn btn-secondary sales-detail-trend-btn" data-period="year_all">每年</button>
          </div>
        </div>
        <canvas id="sales-detail-trend-chart" style="max-height:360px;height:340px;"></canvas>
      </div>
    `;
    // 加载商品筛选
    try {
      const catalogs = await api('/api/admin/catalog');
      const sel = document.getElementById('sales-detail-product');
      if (sel) {
        const active = catalogs.filter(c => c.status === 'active' || !c.status);
        sel.innerHTML = '<option value="">全部商品</option>' + active.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
        sel.onchange = () => loadSalesDetailTrendData();
      }
    } catch(e) {}
    // 绑定时段按钮
    document.querySelectorAll('.sales-detail-trend-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.sales-detail-trend-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadSalesDetailTrendData();
      };
    });
    setTimeout(() => loadSalesDetailTrendData(), 100);
  }

  async function loadSalesDetailTrendData() {
    const canvas = document.getElementById('sales-detail-trend-chart');
    if (!canvas || !salesDetailContext) return;
    const period = document.querySelector('.sales-detail-trend-btn.active')?.dataset.period || 'all';
    const catalogId = document.getElementById('sales-detail-product')?.value || '';
    const pointR = (period === 'month_all' || period === 'quarter' || period === 'year_all') ? 0 : 3;
    const { level, shopId } = salesDetailContext;
    try {
      // 根据level调用不同API
      let url;
      if (level === 'brand_super') {
        url = `/api/admin/sales-trend?brandId=${shopId}&period=${period}${catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`;
      } else {
        url = `/api/merchant/sales-trend?merchantId=${shopId}&period=${period}${catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`;
      }
      const data = await api(url);
      const labels = (data.data || []).map(d => data.labelFmt === 'hour' ? d.label + ':00' : d.label);
      const revenues = (data.data || []).map(d => Number(d.revenue).toFixed(2));
      const qtys = (data.data || []).map(d => d.qty);
      if (salesDetailChart) salesDetailChart.destroy();
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, 320);
      gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
      gradient.addColorStop(1, 'rgba(99,102,241,0.02)');
      salesDetailChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '营收 (S$)', data: revenues, borderColor: '#6366f1', backgroundColor: gradient, fill: true, tension: 0.35, pointRadius: pointR, pointHoverRadius: 6, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 2, borderWidth: 2, yAxisID: 'y' },
            { label: '销量 (件)', data: qtys, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: 0.35, pointRadius: pointR > 0 ? 2 : 0, pointHoverRadius: 5, pointBackgroundColor: '#f59e0b', pointBorderColor: '#fff', pointBorderWidth: 1.5, borderWidth: 1.5, borderDash: [4, 2], yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true } } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 15, autoSkipPadding: 10 }, grid: { display: false } },
            y: { type: 'linear', position: 'left', ticks: { font: { size: 10 }, callback: v => 'S$' + v }, grid: { color: 'rgba(0,0,0,0.05)' } },
            y1: { type: 'linear', position: 'right', ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    } catch (err) { showToast(err.message); }
  }

  function backFromSalesDetail() {
    // 返回上一个视图（商品库授权链路）
    navigateAdmin('catalog');
  }

  // 长按取消授权菜单
  function showRevokeAuthMenu(authId, tree) {
    const node = findNode(tree, authId);
    if (!node) return;
    showActionModal('取消授权', `取消对「${escapeHtml(node.targetName)}」的授权？<br><span style="color:#dc2626;font-size:12px;">取消后该节点及所有下游授权将全部清除。</span>`, [
      { text: '取消授权', cls: 'btn-danger', onClick: () => {
        showActionModal('确认取消 (1/3)', `确定取消「${escapeHtml(node.targetName)}」的授权？`, [
          { text: '返回', cls: 'btn-secondary', onClick: () => {} },
          { text: '下一步', cls: 'btn-danger', onClick: () => {
            showActionModal('确认取消 (2/3)', `此操作将级联删除所有下游授权。`, [
              { text: '返回', cls: 'btn-secondary', onClick: () => {} },
              { text: '下一步', cls: 'btn-danger', onClick: () => {
                showActionModal('确认取消 (3/3)', `最后确认：取消「${escapeHtml(node.targetName)}」的授权？`, [
                  { text: '返回', cls: 'btn-secondary', onClick: () => {} },
                  { text: '确认取消', cls: 'btn-danger', onClick: () => {
                    api('/api/catalog/auth/' + authId, { method: 'DELETE' })
                      .then(r => { showToast(`已取消授权，级联删除 ${r.deleted} 条`); loadCatalogAuthChain(currentCatalogId); })
                      .catch(e => showToast(e.message));
                  }}
                ]);
              }}
            ]);
          }}
        ]);
      }},
      { text: '关闭', cls: 'btn-secondary', onClick: () => {} }
    ]);
  }

  // 超管长按商品弹出操作菜单（居中弹窗）
  function showCatalogActionMenu(catalogId) {
    const card = document.querySelector(`.admin-brand-card[data-catalog-id="${catalogId}"]`);
    const name = card?.querySelector('.admin-brand-name')?.textContent?.trim() || '商品';
    const isOffline = card?.querySelector('.chip-no') !== null;
    showActionModal('商品操作', `商品：<strong>${escapeHtml(name)}</strong>`, [
      { text: isOffline ? '重新上架' : '下架', cls: 'btn-primary', onClick: () => {
        if (isOffline) {
          showActionModal('确认上架 (1/3)', `确认重新上架「${escapeHtml(name)}」？`, [
            { text: '取消', cls: 'btn-secondary', onClick: () => {} },
            { text: '下一步', cls: 'btn-primary', onClick: () => {
              showActionModal('确认上架 (2/3)', `确定要重新上架「${escapeHtml(name)}」？`, [
                { text: '取消', cls: 'btn-secondary', onClick: () => {} },
                { text: '下一步', cls: 'btn-primary', onClick: () => {
                  showActionModal('确认上架 (3/3)', `最后确认：重新上架「${escapeHtml(name)}」？`, [
                    { text: '取消', cls: 'btn-secondary', onClick: () => {} },
                    { text: '确认上架', cls: 'btn-primary', onClick: () => {
                      api('/api/admin/catalog/' + catalogId + '/offline', { method: 'PUT' })
                        .then(() => { showToast('已上架'); loadCatalog(); })
                        .catch(e => showToast(e.message));
                    }}
                  ]);
                }}
              ]);
            }}
          ]);
        } else {
          showActionModal('确认下架 (1/3)', `确认下架「${escapeHtml(name)}」？<br><span style="color:#64748b;font-size:12px;">下架后下游将看不到该商品，数据保留。</span>`, [
            { text: '取消', cls: 'btn-secondary', onClick: () => {} },
            { text: '下一步', cls: 'btn-primary', onClick: () => {
              showActionModal('确认下架 (2/3)', `确定要下架「${escapeHtml(name)}」？`, [
                { text: '取消', cls: 'btn-secondary', onClick: () => {} },
                { text: '下一步', cls: 'btn-primary', onClick: () => {
                  showActionModal('确认下架 (3/3)', `最后确认：下架「${escapeHtml(name)}」？`, [
                    { text: '取消', cls: 'btn-secondary', onClick: () => {} },
                    { text: '确认下架', cls: 'btn-danger', onClick: () => {
                      api('/api/admin/catalog/' + catalogId + '/offline', { method: 'PUT' })
                        .then(() => { showToast('已下架'); loadCatalog(); })
                        .catch(e => showToast(e.message));
                    }}
                  ]);
                }}
              ]);
            }}
          ]);
        }
      }},
      { text: '删除', cls: 'btn-danger', onClick: () => {
        showActionModal('确认删除 (1/3)', `确认删除「${escapeHtml(name)}」？<br><span style="color:#dc2626;font-size:12px;">删除后不可恢复，授权记录一并清除。</span>`, [
          { text: '取消', cls: 'btn-secondary', onClick: () => {} },
          { text: '下一步', cls: 'btn-danger', onClick: () => {
            showActionModal('确认删除 (2/3)', `确定要删除「${escapeHtml(name)}」？`, [
              { text: '取消', cls: 'btn-secondary', onClick: () => {} },
              { text: '下一步', cls: 'btn-danger', onClick: () => {
                showActionModal('确认删除 (3/3)', `最后确认：删除「${escapeHtml(name)}」？此操作不可撤销！`, [
                  { text: '取消', cls: 'btn-secondary', onClick: () => {} },
                  { text: '确认删除', cls: 'btn-danger', onClick: () => {
                    api('/api/admin/catalog/' + catalogId, { method: 'DELETE' })
                      .then(() => { showToast('已删除'); loadCatalog(); })
                      .catch(e => showToast(e.message));
                  }}
                ]);
              }}
            ]);
          }}
        ]);
      }},
      { text: '取消', cls: 'btn-secondary', onClick: () => {} }
    ]);
  }

  // 打开商品编辑页（上新或编辑）
  async function openCatalogEdit(catalogId) {
    currentCatalogId = catalogId || null;
    navigateAdmin('catalog-edit');
    const el = document.getElementById('admin-catalog-edit-content');
    const title = document.getElementById('admin-catalog-edit-title');
    const perms = currentUser.permissions || [];
    const isAdmin = currentUser.role === 'admin';
    const isSuper = isAdmin && isSuperAdmin();
    const isBrandSuper = perms.includes('brand_super');
    if (title) title.textContent = catalogId ? '商品详情' : '上新商品';
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    let catalog = { name: '', cost_price: 0, sell_price: 0, description: '', promo_image: null };
    let regionPromo = null;
    if (catalogId) {
      try {
        const data = await api('/api/catalog/' + catalogId);
        catalog = data;
        regionPromo = data.regionPromo;
      } catch (err) {
        el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    // 渲染表单
    // 渲染表单（按角色区分：超管基础信息 / 普通管理描述+宣传图 / 总代地区宣传）
    const isNormalAdmin = isAdmin && !isSuper; // 普通管理（无 super 权限的管理端）
    el.innerHTML = `
      ${isSuper ? `
      <div class="section-card">
        <h3>基础信息</h3>
        <div class="form-group">
          <label>商品名称</label>
          <input type="text" id="cat-edit-name" value="${escapeHtml(catalog.name)}">
        </div>
        <div style="display:flex;gap:12px;">
          <div class="form-group" style="flex:1;">
            <label>SKU</label>
            <input type="text" id="cat-edit-sku" value="${escapeHtml(catalog.sku || '')}" placeholder="如 SV-TIG-001">
          </div>
          <div class="form-group" style="flex:1;">
            <label>分类</label>
            <input type="text" id="cat-edit-category" value="${escapeHtml(catalog.category || '未分类')}" placeholder="如 药品 / 食品 / 日用品">
          </div>
        </div>
        <div style="display:flex;gap:12px;">
          <div class="form-group" style="flex:1;">
            <label>成本价（新币）</label>
            <input type="number" id="cat-edit-cost" value="${catalog.cost_price}" step="0.01">
          </div>
          <div class="form-group" style="flex:1;">
            <label>售价（新币）</label>
            <input type="number" id="cat-edit-sell" value="${catalog.sell_price}" step="0.01">
          </div>
        </div>
      </div>
      ${catalogId ? `
      <div class="section-card">
        <h3>商品描述与宣传图</h3>
        <div class="admin-brand-meta" style="margin-bottom:10px;">${escapeHtml(catalog.description || '待负责人上传')}</div>
        ${catalog.promo_image ? `<img src="${catalog.promo_image}" style="max-width:100%;max-height:250px;border-radius:8px;">` : '<div class="empty-tip">待负责人上传</div>'}
      </div>
      ` : ''}
      ` : `
      <div class="section-card">
        <h3>商品</h3>
        <div class="admin-brand-meta">
          商品名称：${escapeHtml(catalog.name)} · 成本 S$${Number(catalog.cost_price).toFixed(2)} · 售价 S$${Number(catalog.sell_price).toFixed(2)}
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label>商品描述</label>
          <textarea id="cat-edit-desc" rows="3">${escapeHtml(catalog.description || '')}</textarea>
        </div>
        <div style="margin-top:12px;">
          <h3>商品宣传图</h3>
          <div id="cat-promo-preview" style="margin-bottom:10px;">
            ${catalog.promo_image ? `<img src="${catalog.promo_image}" style="max-width:100%;max-height:200px;border-radius:8px;">` : '<div class="empty-tip">暂无宣传图</div>'}
          </div>
          <input type="file" id="cat-promo-input" accept="image/*" style="display:none;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('cat-promo-input').click()">上传宣传图</button>
        </div>
      </div>
      `}
      ${isBrandSuper ? `
      <div class="section-card">
        <h3>地区宣传内容（总代）</h3>
        <div class="form-group">
          <label>地区宣传文案</label>
          <textarea id="cat-region-content" rows="3">${escapeHtml(regionPromo?.content || '')}</textarea>
        </div>
        <div id="cat-region-preview" style="margin-bottom:10px;">
          ${regionPromo?.image ? `<img src="${regionPromo.image}" style="max-width:100%;max-height:200px;border-radius:8px;">` : '<div class="empty-tip">暂无地区宣传图</div>'}
        </div>
        <input type="file" id="cat-region-input" accept="image/*" style="display:none;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('cat-region-input').click()">上传地区宣传图</button>
      </div>
      ` : ''}
      ${catalogId ? `
      <div class="section-card" id="cat-auth-chain-section">
        <h3>授权链路</h3>
        <div id="cat-auth-chain-list"><div class="empty-tip">加载中...</div></div>
      </div>
      ` : ''}
      <div style="padding:16px;display:flex;gap:12px;">
        <button type="button" class="btn btn-primary" onclick="Admin.saveCatalog()">保存</button>
        <button type="button" class="btn btn-secondary" onclick="Admin.backToCatalog()">取消</button>
      </div>
    `;
    // 所有角色加载授权链路（服务端做权限过滤，只返回自己相关的分支）
    if (currentCatalogId) {
      loadCatalogAuthChain(currentCatalogId);
    }
    // 绑定图片上传
    let promoImgData = catalog.promo_image;
    let regionImgData = regionPromo?.image || null;
    const promoInput = document.getElementById('cat-promo-input');
    if (promoInput) {
      promoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          promoImgData = await compressImage(file);
          document.getElementById('cat-promo-preview').innerHTML = `<img src="${promoImgData}" style="max-width:100%;max-height:200px;border-radius:8px;">`;
        } catch (err) { showToast('图片处理失败: ' + err.message); }
      });
    }
    const regionInput = document.getElementById('cat-region-input');
    if (regionInput) {
      regionInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          regionImgData = await compressImage(file);
          document.getElementById('cat-region-preview').innerHTML = `<img src="${regionImgData}" style="max-width:100%;max-height:200px;border-radius:8px;">`;
        } catch (err) { showToast('图片处理失败: ' + err.message); }
      });
    }
    // 保存函数闭包
    // 保存函数闭包
    window.__catSave = async () => {
      const isNormalAdmin = isAdmin && !isSuper;
      try {
        if (currentCatalogId) {
          // 更新商品：超管提交基础信息，普通管理提交描述+宣传图
          const body = {};
          if (isSuper) {
            const name = document.getElementById('cat-edit-name').value.trim();
            if (!name) { showToast('请输入商品名称'); return; }
            body.name = name;
            body.sku = document.getElementById('cat-edit-sku') ? document.getElementById('cat-edit-sku').value.trim() : undefined;
            body.category = document.getElementById('cat-edit-category') ? document.getElementById('cat-edit-category').value.trim() : undefined;
            body.costPrice = parseFloat(document.getElementById('cat-edit-cost').value) || 0;
            body.sellPrice = parseFloat(document.getElementById('cat-edit-sell').value) || 0;
          }
          if (isNormalAdmin || isSuper) {
            const descEl = document.getElementById('cat-edit-desc');
            if (descEl) body.description = descEl.value;
          }
          if (isNormalAdmin && promoImgData !== undefined) body.promoImage = promoImgData;
          await api('/api/admin/catalog/' + currentCatalogId, {
            method: 'PUT',
            body: JSON.stringify(body)
          });
          // 总代保存地区宣传
          if (isBrandSuper) {
            const regionContent = document.getElementById('cat-region-content')?.value || '';
            await api('/api/brand/catalog/' + currentCatalogId + '/region-promo', {
              method: 'PUT',
              body: JSON.stringify({ content: regionContent, image: regionImgData })
            });
          }
          showToast('保存成功');
        } else {
          // 新建商品（仅超管）
          const name = document.getElementById('cat-edit-name').value.trim();
          if (!name) { showToast('请输入商品名称'); return; }
          const costPrice = parseFloat(document.getElementById('cat-edit-cost').value) || 0;
          const sellPrice = parseFloat(document.getElementById('cat-edit-sell').value) || 0;
          const sku = document.getElementById('cat-edit-sku') ? document.getElementById('cat-edit-sku').value.trim() : '';
          const category = document.getElementById('cat-edit-category') ? document.getElementById('cat-edit-category').value.trim() : '未分类';
          const r = await api('/api/admin/catalog', {
            method: 'POST',
            body: JSON.stringify({ name, costPrice, sellPrice, sku, category })
          });
          currentCatalogId = r.id;
          showToast('商品上新成功');
        }
        backToCatalog();
      } catch (err) { showToast(err.message); }
    };
  }

  function saveCatalog() {
    if (window.__catSave) window.__catSave();
  }

  function backToCatalog() {
    currentCatalogId = null;
    navigateAdmin('catalog');
  }

  // 上架 / 下架商品（仅超管）
  async function setCatalogStatus(catalogId, status) {
    try {
      await api('/api/v1/admin/products/' + catalogId + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      showToast(status === 'active' ? '商品已上架' : '商品已下架');
      loadCatalog();
    } catch (err) { showToast(err.message); }
  }

  // ========== 财务设置（管理端可配置） ==========
  async function loadAdminSettings() {
    const el = document.getElementById('admin-settings-content');
    if (!el) return;
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
      const data = await api('/api/v1/admin/settings');
      const s = data.settings;
      const num = (v) => Number(v).toFixed(2);
      el.innerHTML = `
        <div class="section-card" style="margin:12px;">
          <h3>财务参数（对 /api/v1 核销口径生效；原有交易算法不受影响）</h3>
          <p class="hint" style="margin-bottom:12px;">口径：售价含 GST。不含税基数 = 售价 ÷ (1 + GST税率)；GST = 不含税基数 × 税率；平台/商家分成按不含税基数 × 比例；佣金附加 GST = 佣金 × 税率。</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <div class="form-group" style="flex:1;min-width:200px;">
              <label>GST 税率（0–1，0.09 = 9%）</label>
              <input type="number" id="set-gst-rate" value="${num(s.gstRate)}" step="0.01" min="0" max="1">
            </div>
            <div class="form-group" style="flex:1;min-width:200px;">
              <label>平台分成比例（0–1，0.7 = 70%）</label>
              <input type="number" id="set-platform" value="${num(s.platformShareRatio)}" step="0.01" min="0" max="1">
            </div>
            <div class="form-group" style="flex:1;min-width:200px;">
              <label>商家分成比例（0–1，0.3 = 30%）</label>
              <input type="number" id="set-merchant" value="${num(s.merchantShareRatio)}" step="0.01" min="0" max="1">
            </div>
            <div class="form-group" style="flex:1;min-width:200px;">
              <label>佣金率（0–1，0.03 = 3%）</label>
              <input type="number" id="set-commission" value="${num(s.commissionRate)}" step="0.01" min="0" max="1">
            </div>
            <div class="form-group" style="flex:1;min-width:200px;">
              <label>佣金附加 GST</label>
              <select id="set-commission-gst">
                <option value="1" ${s.commissionApplyGst ? 'selected' : ''}>是</option>
                <option value="0" ${!s.commissionApplyGst ? 'selected' : ''}>否</option>
              </select>
            </div>
          </div>
          <div style="margin-top:16px;">
            <button type="button" class="btn btn-primary" onclick="Admin.saveAdminSettings()">保存财务设置</button>
            <span class="hint" id="set-save-msg"></span>
          </div>
        </div>`;
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  async function saveAdminSettings() {
    try {
      const body = {
        gstRate: parseFloat(document.getElementById('set-gst-rate').value),
        platformShareRatio: parseFloat(document.getElementById('set-platform').value),
        merchantShareRatio: parseFloat(document.getElementById('set-merchant').value),
        commissionRate: parseFloat(document.getElementById('set-commission').value),
        commissionApplyGst: document.getElementById('set-commission-gst').value === '1'
      };
      const data = await api('/api/v1/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      document.getElementById('set-save-msg').textContent = '已保存（更新于 ' + new Date().toLocaleTimeString('zh-CN') + '）';
      showToast('财务设置已保存');
    } catch (err) { showToast(err.message); }
  }

  // 超管授权商品给普通管理
  async function authCatalogToAdmin(catalogId) {
    try {
      const admins = await api('/api/admin/catalog-auth-admins');
      if (!admins || admins.length === 0) { showToast('暂无普通管理'); return; }
      showSelectModal('选择要授权的普通管理', admins.map(a => ({ label: a.shop_name, sub: '管理端账户', id: a.id })), async (selected) => {
        try {
          await api('/api/admin/catalog/' + catalogId + '/auth', {
            method: 'POST',
            body: JSON.stringify({ adminId: selected.id })
          });
          showToast('授权成功');
          loadCatalog();
        } catch (e) { showToast(e.message); }
      });
    } catch (err) { showToast(err.message); }
  }

  // 普通管理授权商品给总代
  async function authCatalogToBrand(catalogId) {
    try {
      const brands = await api('/api/admin/catalog-auth-brands');
      if (!brands || brands.length === 0) { showToast('暂无总代'); return; }
      showSelectModal('选择要授权的总代', brands.map(b => ({ label: b.shop_name, sub: countryLabel(b.country), id: b.id })), async (selected) => {
        try {
          await api('/api/admin/catalog/' + catalogId + '/auth-brand', {
            method: 'POST',
            body: JSON.stringify({ brandId: selected.id })
          });
          showToast('授权成功');
          loadCatalog();
        } catch (e) { showToast(e.message); }
      });
    } catch (err) { showToast(err.message); }
  }

  // 总代授权商品给普通代理或商铺
  async function authCatalogToTarget(catalogId) {
    try {
      const targets = await api('/api/brand/catalog-auth-targets');
      const agents = targets.agents || [];
      const merchants = targets.merchants || [];
      if (agents.length === 0 && merchants.length === 0) { showToast('暂无代理或商铺'); return; }
      showSelectModal('选择授权目标类型', [
        { label: '普通代理', sub: `${agents.length} 个可选`, id: 'agent' },
        { label: '商铺', sub: `${merchants.length} 个可选`, id: 'merchant' }
      ], (typeSel) => {
        const list = typeSel.id === 'agent' ? agents : merchants;
        if (list.length === 0) { showToast(typeSel.id === 'agent' ? '暂无普通代理' : '暂无商铺'); return; }
        showSelectModal(`选择要授权的${typeSel.id === 'agent' ? '代理' : '商铺'}`,
          list.map(x => ({ label: x.shop_name, sub: typeSel.id === 'agent' ? '普通代理' : '合作商家', id: x.id })),
          async (selected) => {
            try {
              await api('/api/brand/catalog/' + catalogId + '/auth', {
                method: 'POST',
                body: JSON.stringify({ targetId: selected.id, targetType: typeSel.id })
              });
              showToast('授权成功');
              loadCatalog();
            } catch (e) { showToast(e.message); }
          });
      });
    } catch (err) { showToast(err.message); }
  }

  function selectBrand(id, name, country) {
    adminBrandId = id;
    adminBrandName = decodeURIComponent(name);
    currentBrandCountry = country || 'SG';
    navigateAdmin('merchants');
  }

  function backToBrands() {
    adminBrandId = null;
    adminBrandName = '';
    navigateAdmin('brands');
  }

  // ========== 合作商家列表 ==========
  async function loadMerchants() {
    const el = document.getElementById('admin-merchant-list');
    const backBtn = document.getElementById('admin-back-brands');
    const badge = document.getElementById('admin-brand-badge');
    // 管理端不负责开通商家，隐藏按钮
    const regBtn = document.getElementById('admin-btn-register-merchant');
    if (regBtn) regBtn.classList.toggle('hidden', currentUser.role === 'admin');
    try {
      let url = '/api/brand/merchants';
      if (currentUser.role === 'admin') {
        if (!adminBrandId) {
          if (backBtn) backBtn.classList.add('hidden');
          if (badge) badge.textContent = '';
          el.innerHTML = `<div class="empty-tip">${I18n.t('admin_need_brand')}</div>`;
          return;
        }
        url += '?brandId=' + adminBrandId;
        if (badge) badge.textContent = I18n.t('admin_merchants') + ' · ' + (adminBrandName || '');
        if (backBtn) backBtn.classList.remove('hidden');
      } else {
        if (badge) badge.textContent = '';
        if (backBtn) backBtn.classList.add('hidden');
      }
      const merchants = await apiWithRetry(() => api(url));
      if (merchants.length === 0) { el.innerHTML = `<div class="empty-tip">${I18n.t('admin_no_merchants')}</div>`; return; }
      el.innerHTML = merchants.map(m => `
        <div class="admin-merchant-row" data-shop-id="${m.id}" data-shop-name="${escapeHtml(m.shop_name)}" data-shop-type="merchant">
          <div onclick="Admin.openMerchantDetail(${m.id})">
            <div class="admin-merchant-name">${escapeHtml(m.shop_name)}</div>
            <div class="admin-merchant-sub">${I18n.t('admin_products')}: ${m.product_count} · ${I18n.t('admin_stock')}: ${m.total_stock} · ${I18n.t('admin_pending_ship')}: ${m.pending_shipments} · ${I18n.t('admin_country')}: ${countryLabel(m.country)}</div>
          </div>
          <div class="admin-merchant-right">
            <div>${I18n.t('admin_sales')}: ${Finance.format(m.today_sales)}</div>
            <div>${m.account ? '账号: ' + escapeHtml(m.account) : ''}</div>
          </div>
        </div>
      `).join('');
      if (currentUser.role === 'admin') bindLongPress(el, (id, name, type) => openDeleteConfirm(id, name, type));
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  function openMerchantDetail(id) {
    currentMerchantId = id;
    navigateAdmin('merchant-detail');
  }

  function backToMerchants() {
    currentMerchantId = null;
    navigateAdmin('merchants');
  }

  // ========== 商家详情（销售数据） ==========
  async function loadMerchantDetail() {
    const el = document.getElementById('admin-merchant-detail');
    if (!currentMerchantId) { navigateAdmin('merchants'); return; }
    try {
      const stats = await apiWithRetry(() => api('/api/brand/merchants/' + currentMerchantId + '/stats'));
      document.getElementById('admin-merchant-detail-title').textContent = stats.merchant.name;
      el.innerHTML = `
        <div class="section-card">
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">${I18n.t('admin_products')}</div><div class="stat-value">${stats.totalProducts}</div></div>
            <div class="stat-card"><div class="stat-label">${I18n.t('admin_stock')}</div><div class="stat-value">${stats.totalStock}</div></div>
            <div class="stat-card"><div class="stat-label">${I18n.t('admin_sales')}</div><div class="stat-value">${Finance.format(stats.todayOutbound.amt)}</div></div>
            <div class="stat-card"><div class="stat-label">GST</div><div class="stat-value">${Finance.format(stats.todayOutbound.gst)}</div></div>
            <div class="stat-card"><div class="stat-label">${I18n.t('brand_share')}</div><div class="stat-value">${Finance.format(stats.totalBrandShare)}</div></div>
            <div class="stat-card"><div class="stat-label">${I18n.t('merchant_share')}</div><div class="stat-value">${Finance.format(stats.totalMerchantShare)}</div></div>
          </div>
          <div class="admin-brand-meta">${I18n.t('username')}: ${stats.merchant.account || '<span style="color:#999;">—</span>'} · ${I18n.t('admin_created_at')}: ${(stats.merchant.createdAt || '').substring(0, 16)}</div>
        </div>
        <div class="section-card">
          <h3>销售趋势</h3>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <select id="merchant-trend-product" style="padding:6px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;">
              <option value="">全部商品</option>
            </select>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              <button class="btn btn-secondary merchant-trend-btn" data-period="today">本日</button>
              <button class="btn btn-secondary merchant-trend-btn" data-period="week">本周</button>
              <button class="btn btn-secondary merchant-trend-btn active" data-period="month">本月</button>
              <button class="btn btn-secondary merchant-trend-btn" data-period="month_all">每月</button>
              <button class="btn btn-secondary merchant-trend-btn" data-period="quarter">每季度</button>
              <button class="btn btn-secondary merchant-trend-btn" data-period="year_all">每年</button>
            </div>
          </div>
          <canvas id="merchant-sales-trend-chart" style="max-height:300px;height:280px;"></canvas>
        </div>
        <div class="section-card">
          <h3>${I18n.t('admin_products')} (${stats.totalProducts})</h3>
          <div id="admin-d-products"></div>
        </div>
        <div class="section-card">
          <h3>${I18n.t('admin_trans')}</h3>
          <div id="admin-d-trans"></div>
        </div>`;
      const products = await api('/api/products?merchantId=' + currentMerchantId);
      document.getElementById('admin-d-products').innerHTML = products.length === 0
        ? `<div class="empty-tip">${I18n.t('no_products')}</div>`
        : `<div class="mini-table">${products.map(p => `
            <div class="mini-row"><span>${escapeHtml(p.name)}</span><span>库存 ${p.stock} · S$${Number(p.sell_price).toFixed(2)}</span></div>`).join('')}</div>`;
      const trans = await api('/api/transactions?merchantId=' + currentMerchantId + '&limit=30');
      document.getElementById('admin-d-trans').innerHTML = trans.length === 0
        ? `<div class="empty-tip">${'暂无交易'}</div>`
        : `<div class="mini-table">${trans.map(t => `
            <div class="mini-row">
              <span class="${t.type === 'inbound' ? 'type-inbound' : 'type-outbound'}">${t.type === 'inbound' ? '入库' : '出库'}</span>
              <span>${escapeHtml(t.product_name)}</span>
              <span>${t.quantity} × S$${Number(t.unit_price).toFixed(2)}${Number(t.discount_amount) > 0 ? ' <span class="discount-tag">−S$' + Number(t.discount_amount).toFixed(2) + '</span>' : ''}</span>
              <span>${t.verified ? '<span class="verify-ok">√</span>' : (t.type === 'inbound' ? '<span class="verify-no">×</span>' : '-')}</span>
              <span>${(t.server_timestamp || '').substring(0, 16)}</span>
            </div>`).join('')}</div>`;
      // 加载销售趋势
      setTimeout(() => loadMerchantSalesTrend(currentMerchantId), 100);
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // ========== 折扣审核（品牌方 / 管理端） ==========
  async function loadDiscounts() {
    const el = document.getElementById('admin-discount-list');
    if (!el) return;
    try {
      let url = '/api/discounts/pending';
      if (currentUser.role === 'admin' && adminBrandId) url += '?brandId=' + adminBrandId;
      const list = await apiWithRetry(() => api(url));
      if (list.length === 0) {
        el.innerHTML = `<div class="empty-tip">${I18n.t('admin_no_discounts')}</div>`;
        return;
      }
      const dname = { medical: '中医馆 −10', social: '社媒 −10', both: '两项 −20' };
      el.innerHTML = list.map(d => `
        <div class="admin-discount-card">
          <div class="admin-discount-head">
            <span class="admin-discount-shop">${escapeHtml(d.merchant_name || '')}${currentUser.role === 'admin' ? ' · ' + escapeHtml(d.brand_name || '') : ''}</span>
            <span class="chip chip-pending">${dname[d.discount_type] || d.discount_type} · S$${Number(d.discount_amount).toFixed(2)}</span>
          </div>
          <div class="admin-discount-body">
            <div class="admin-discount-meta">${escapeHtml(d.product_name)} × ${d.quantity} · ${(d.server_timestamp || '').substring(0, 16)} · ${escapeHtml(d.operator_name || '')}</div>
            <div class="admin-discount-imgs">
              ${d.discount_medical_img ? `<img class="discount-img" src="${d.discount_medical_img}" onclick="window.open('${d.discount_medical_img}','_blank')" title="${I18n.t('discount_medical_img')}">` : ''}
              ${d.discount_social_img ? `<img class="discount-img" src="${d.discount_social_img}" onclick="window.open('${d.discount_social_img}','_blank')" title="${I18n.t('discount_social_img')}">` : ''}
            </div>
            <div class="admin-discount-finance">
              <span>${I18n.t('base_amount')}: S$${Number(d.amount_before_gst).toFixed(2)}</span>
              <span>GST: S$${Number(d.gst_amount).toFixed(2)}</span>
              <span>${I18n.t('total_amount')}: S$${Number(d.total_amount).toFixed(2)}</span>
            </div>
          </div>
          <div class="admin-discount-actions">
            <button class="btn btn-success" onclick="Admin.reviewDiscount(${d.id}, 'approve')">${I18n.t('admin_approve')}</button>
            <button class="btn btn-danger" onclick="Admin.reviewDiscount(${d.id}, 'reject')">${I18n.t('admin_reject')}</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  async function reviewDiscount(id, action) {
    if (action === 'reject' && !confirm(I18n.t('admin_reject_confirm'))) return;
    try {
      await api('/api/discounts/' + id + '/review', { method: 'POST', body: JSON.stringify({ action }) });
      showToast(action === 'approve' ? I18n.t('admin_approved') : I18n.t('admin_rejected'));
      loadDiscounts();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 进货审核（品牌方 / 管理端） ==========
  async function loadPurchaseOrders() {
    const el = document.getElementById('admin-purchase-list');
    if (!el) return;
    try {
      let url = '/api/purchase-orders';
      if (currentUser.role === 'admin' && adminBrandId) url += '?brandId=' + adminBrandId;
      const list = await apiWithRetry(() => api(url));
      if (list.length === 0) {
        el.innerHTML = `<div class="empty-tip">${I18n.t('admin_no_purchase')}</div>`;
        return;
      }
      const st = {
        pending: { text: I18n.t('po_pending'), cls: 'chip-pending' },
        approved: { text: I18n.t('po_approved'), cls: 'chip-ok' },
        rejected: { text: I18n.t('po_rejected'), cls: 'chip-no' },
        assigned: { text: '已分配', cls: 'chip-ok' }
      };
      el.innerHTML = list.map(p => `
        <div class="admin-discount-card">
          <div class="admin-discount-head">
            <span class="admin-discount-shop">${escapeHtml(p.merchant_name || '')}${currentUser.role === 'admin' ? ' · ' + escapeHtml(p.brand_name || '') : ''}</span>
            <span class="chip ${st[p.status] ? st[p.status].cls : ''}">${st[p.status] ? st[p.status].text : p.status}</span>
          </div>
          <div class="admin-discount-body">
            <div class="admin-discount-meta">${escapeHtml(p.product_name)} × ${p.quantity} · ${(p.created_at || '').substring(0, 16)}</div>
            ${p.payment_img ? `<div class="admin-discount-imgs"><img class="discount-img" src="${p.payment_img}" onclick="window.open('${p.payment_img}','_blank')" title="${I18n.t('purchase_pay_img')}"></div>` : ''}
            <div class="admin-discount-finance">
              <span>${I18n.t('purchase_cost')}: S$${Number(p.unit_cost).toFixed(2)} × ${p.quantity} = <b>S$${Number(p.total_cost).toFixed(2)}</b></span>
            </div>
          </div>
          ${p.status === 'pending' ? `<div class="admin-discount-actions">
            <button class="btn btn-success" onclick="Admin.reviewPurchaseOrder(${p.id}, 'approve')">${I18n.t('admin_approve')}</button>
            <button class="btn btn-danger" onclick="Admin.reviewPurchaseOrder(${p.id}, 'reject')">${I18n.t('admin_reject')}</button>
          </div>` : ''}
          ${p.status === 'approved' && isBrandSuper() ? `<div class="admin-discount-actions">
            <button class="btn btn-primary" onclick="Admin.assignPurchaseOrder(${p.id})">分配给代理</button>
          </div>` : ''}
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  async function reviewPurchaseOrder(id, action) {
    if (action === 'reject' && !confirm(I18n.t('admin_po_reject_confirm'))) return;
    try {
      await api('/api/purchase-orders/' + id + '/review', { method: 'POST', body: JSON.stringify({ action }) });
      showToast(action === 'approve' ? I18n.t('admin_po_approved') : I18n.t('admin_po_rejected'));
      loadPurchaseOrders();
    } catch (err) {
      showToast(err.message);
    }
  }

  // 总代分配进货单给普通代理
  async function assignPurchaseOrder(poId) {
    try {
      const agents = await api('/api/brand/agents');
      if (!agents || agents.length === 0) {
        showToast('暂无可用代理，请先在管理端开通代理账号');
        return;
      }
      const names = agents.map((a, i) => `${i + 1}. ${a.shop_name}`).join('\n');
      const idx = prompt('选择要分配的代理（输入序号）：\n' + names);
      if (idx === null) return;
      const n = parseInt(idx);
      if (!n || n < 1 || n > agents.length) { showToast('无效选择'); return; }
      const agent = agents[n - 1];
      if (!confirm(`确认分配给代理「${agent.shop_name}」？将自动创建发货单。`)) return;
      const r = await api('/api/purchase-orders/' + poId + '/assign', {
        method: 'POST', body: JSON.stringify({ agentId: agent.id })
      });
      showToast('已分配，发货单#' + r.shipmentId);
      loadPurchaseOrders();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 开户/新建弹窗 ==========
  let modalMode = 'brand'; // brand / merchant / shipment
  let modalData = {};      // 开户成功后的初始密码等
  function openModal(mode) {
    modalMode = mode;
    modalData = {};
    document.getElementById('admin-modal-title').textContent =
      mode === 'brand' ? I18n.t('admin_register_brand')
      : mode === 'agent' ? '注册普通代理'
      : mode === 'merchant' ? I18n.t('admin_register_merchant')
      : I18n.t('admin_new_shipment');
    document.getElementById('admin-modal-confirm').textContent =
      mode === 'shipment' ? I18n.t('save') : I18n.t('admin_generate');
    document.getElementById('admin-modal-confirm').classList.remove('hidden');
    const body = document.getElementById('admin-modal-body');
    if (mode === 'shipment') {
      renderShipmentModalBody();
    } else if (mode === 'agent') {
      const brandCountry = (currentShop && currentShop.country) || 'SG';
      body.innerHTML = `
        <div class="form-group">
          <label>代理名称</label>
          <input type="text" id="admin-modal-name" placeholder="输入代理名称">
        </div>
        <div class="form-group">
          <label>${I18n.t('admin_country')}</label>
          <input type="text" value="${countryLabel(brandCountry)}" readonly>
          <div class="fixed-hint">地区跟随总代，不可修改</div>
        </div>`;
    } else if (mode === 'merchant') {
      const label = I18n.t('admin_new_merchant_name');
      // 地区跟随品牌（品牌方=自己的地区；管理端=当前选中品牌的地区），不可修改
      const brandCountry = currentUser.role === 'brand'
        ? (currentShop && currentShop.country) || 'SG'
        : (currentBrandCountry || 'SG');
      body.innerHTML = `
        <div class="form-group">
          <label>${label}</label>
          <input type="text" id="admin-modal-name" placeholder="">
        </div>
        <div class="form-group">
          <label>${I18n.t('admin_country')}</label>
          <input type="text" value="${countryLabel(brandCountry)}" readonly>
          <div class="fixed-hint">${I18n.t('admin_country_locked_hint')}</div>
        </div>`;
    } else {
      const label = I18n.t('admin_new_brand_name');
      body.innerHTML = `
        <div class="form-group">
          <label>${label}</label>
          <input type="text" id="admin-modal-name" placeholder="">
        </div>
        <div class="form-group">
          <label>${I18n.t('admin_country')}</label>
          <select id="admin-modal-country">
            <option value="SG" selected>${I18n.t('admin_country_sg')}</option>
            <option value="MY">${I18n.t('admin_country_my')}</option>
            <option value="CN">${I18n.t('admin_country_cn')}</option>
          </select>
          <div class="fixed-hint">${I18n.t('admin_brand_country_hint')}</div>
        </div>`;
    }
    document.getElementById('admin-modal-overlay').classList.remove('hidden');
  }

  function renderShipmentModalBody() {
    const body = document.getElementById('admin-modal-body');
    api('/api/brand/merchants').then(merchants => {
      const opts = merchants.map(m => `<option value="${m.id}">${escapeHtml(m.shop_name)}</option>`).join('');
      body.innerHTML = `
        <div class="form-group"><label>${I18n.t('admin_select_merchant')}</label>
          <select id="new-ship-merchant">${merchants.length ? opts : '<option value="">暂无合作商家</option>'}</select>
        </div>
        <div class="form-group"><label>备注</label><input id="new-ship-remark" placeholder=""></div>
        <div class="admin-pack-box" style="border-top:none;padding-top:0;"><h3>${I18n.t('items')} · <span class="hint">扫码或手动填写条码</span></h3>
          <div id="ship-scan-area" class="ship-scan-area hidden">
            <div id="ship-scan-reader" class="scanner-reader small"></div>
            <button id="ship-capture-btn" class="btn btn-success btn-block" style="margin-bottom:8px;">拍照识别</button>
            <button class="btn btn-secondary btn-block" onclick="Admin.stopShipScan()">${I18n.t('stop_camera')}</button>
          </div>
          <div id="new-ship-items"></div>
          <button class="btn btn-secondary btn-block" onclick="Admin.addShipItem()">${I18n.t('admin_add_item')}</button>
        </div>`;
      addShipItem();
    }).catch(err => { body.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`; });
  }

  function closeModal() {
    document.getElementById('admin-modal-overlay').classList.add('hidden');
    document.getElementById('admin-modal-body').innerHTML = '';
    modalData = {};
  }

  function showCardKeyResult(cardKey, username) {
    const body = document.getElementById('admin-modal-body');
    body.innerHTML = `
      <div class="card-key-box">
        <div class="card-key-hint">开户成功，初始登录密码（请妥善保管）</div>
        ${username ? `<div class="card-key-value" style="font-size:15px;margin-bottom:4px;">账号: ${escapeHtml(username)}</div>` : ''}
        <div class="card-key-value">${cardKey}</div>
        <button id="admin-modal-copy" class="btn-copy-key">${I18n.t('admin_copy')}</button>
      </div>`;
    document.getElementById('admin-modal-confirm').classList.add('hidden');
    document.getElementById('admin-modal-copy').addEventListener('click', () => {
      const ta = document.createElement('textarea');
      ta.value = cardKey; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); showToast(I18n.t('admin_copied')); }
      catch (e) { showToast(I18n.t('admin_copy')); }
      document.body.removeChild(ta);
    });
    showToast(I18n.t('admin_card_generated'));
  }

  async function confirmModal() {
    if (modalMode === 'shipment') { confirmShipment(); return; }
    const name = document.getElementById('admin-modal-name').value.trim();
    if (!name) { showToast(I18n.t('admin_need_name')); return; }
    let res;
    try {
      if (modalMode === 'brand') {
        const countryEl = document.getElementById('admin-modal-country');
        const country = countryEl ? countryEl.value : 'SG';
        res = await api('/api/admin/register-brand', { method: 'POST', body: JSON.stringify({ shopName: name, country }) });
      } else if (modalMode === 'agent') {
        res = await api('/api/brand/register-agent', { method: 'POST', body: JSON.stringify({ shopName: name }) });
      } else {
        if (currentUser.role === 'admin') {
          if (!adminBrandId) { showToast(I18n.t('admin_need_brand')); return; }
          res = await api('/api/admin/register-merchant', { method: 'POST', body: JSON.stringify({ shopName: name, brandId: adminBrandId }) });
        } else {
          res = await api('/api/brand/register-merchant', { method: 'POST', body: JSON.stringify({ shopName: name }) });
        }
      }
      showCardKeyResult(res.cardKey, res.username);
      // 注册成功后立即刷新对应列表
      if (modalMode === 'brand') loadBrands();
      else if (modalMode === 'agent') loadBrands();
      else if (modalMode === 'merchant') {
        if (currentUser.role === 'admin') loadMerchants();
        else loadMerchants();
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 发货单（品牌方） ==========
  function shipStatus(s) {
    return { draft: I18n.t('admin_draft'), shipped: I18n.t('admin_shipped'), received: I18n.t('admin_received_status') }[s] || s;
  }

  async function loadShipments() {
    const el = document.getElementById('admin-shipment-list');
    try {
      const shipments = await apiWithRetry(() => api('/api/shipments'));
      if (shipments.length === 0) { el.innerHTML = `<div class="empty-tip">${I18n.t('admin_no_shipments')}</div>`; return; }
      el.innerHTML = shipments.map(s => `
        <div class="admin-ship-card" onclick="Admin.openShipmentDetail(${s.id})">
          <div class="admin-ship-card-head">
            <span class="shipment-id">#${s.id} → ${escapeHtml(s.merchant_name || '')}</span>
            <span class="chip chip-${s.status}">${shipStatus(s.status)}</span>
          </div>
          <div class="admin-ship-card-body">${I18n.t('admin_scanned')}: ${s.scanned_qty}/${s.total_qty} · ${I18n.t('admin_received')}: ${s.received_qty}/${s.total_qty} · ${s.created_at}</div>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  function openShipmentDetail(id) {
    shipmentDetailId = id;
    navigateAdmin('shipment-detail');
  }

  function backToShipments() {
    shipmentDetailId = null;
    navigateAdmin('shipments');
  }

  async function loadShipmentDetail() {
    const el = document.getElementById('admin-shipment-detail');
    if (!shipmentDetailId) return;
    try {
      const s = await apiWithRetry(() => api('/api/shipments/' + shipmentDetailId));
      document.getElementById('admin-shipment-detail-title').textContent = I18n.t('admin_shipments') + ' #' + s.id;
      const statusName = shipStatus(s.status);
      const total = (s.items || []).reduce((a, i) => a + (i.quantity || 0), 0);
      const scanned = (s.items || []).reduce((a, i) => a + (i.scanned_count || 0), 0);
      const received = (s.items || []).reduce((a, i) => a + (i.received_qty || 0), 0);
      el.innerHTML = `
        <div class="section-card">
          <div class="shipment-card-head">
            <span class="shipment-id">#${s.id} → ${escapeHtml(s.merchant_name || '')}</span>
            <span class="chip chip-${s.status}">${statusName}</span>
          </div>
          <div class="shipment-progress">${I18n.t('admin_scanned')}: ${scanned}/${total} · ${I18n.t('admin_received')}: ${received}/${total}</div>
          ${(s.status === 'draft' || s.status === 'assigned') ? `
            <div class="admin-pack-box">
              <h3>${I18n.t('admin_packing_scan')}</h3>
              <p class="hint">${s.product_name ? '款名：' + escapeHtml(s.product_name) + ' · ' : ''}${I18n.t('admin_ship_hint')}</p>
              <div id="admin-pack-reader" class="scanner-reader small"></div>
              <div class="scan-actions">
                <button id="admin-pack-start" class="btn btn-primary btn-block" onclick="Admin.startPackingScan()">${I18n.t('start_camera')}</button>
                <button id="admin-pack-capture" class="btn btn-primary btn-block hidden" onclick="Admin.capturePackingScan()">拍照识别</button>
                <button id="admin-pack-stop" class="btn btn-secondary btn-block hidden" onclick="Admin.stopPackingScan()">${I18n.t('stop_camera')}</button>
              </div>
              <div id="admin-pack-progress" class="admin-progress-label" style="margin-top:12px;"></div>
              <div class="admin-progress-bar"><div class="admin-progress-fill" id="admin-pack-fill" style="width:0%"></div></div>
              <div id="admin-pack-items"></div>
              <button id="admin-ship-confirm" class="btn btn-success btn-block ${scanned === total ? '' : 'hidden'}" onclick="Admin.shipShipment()">${I18n.t('admin_confirm_ship')}</button>
            </div>` : ''}
        </div>
        <div class="section-card">
          <h3>${I18n.t('items')} (${(s.items || []).length})</h3>
          <div class="mini-table">${(s.items || []).map(i => `
            <div class="mini-row">
              <span>${escapeHtml(i.product_name)}</span>
              <span>${i.barcode}</span>
              <span>${i.quantity}件</span>
              <span>${I18n.t('admin_scanned')}:${i.scanned_count} / ${I18n.t('admin_received')}:${i.received_qty}</span>
            </div>`).join('')}</div>
        </div>`;
      packingItems = s.items || [];
      renderPackingProgress();
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderPackingProgress() {
    let total = 0, scanned = 0;
    packingItems.forEach(i => { total += i.quantity || 0; scanned += i.scanned_count || 0; });
    document.getElementById('admin-pack-progress').textContent = I18n.t('admin_scanned') + ': ' + scanned + ' / ' + total;
    document.getElementById('admin-pack-fill').style.width = total ? (scanned / total * 100) + '%' : '0%';
    document.getElementById('admin-pack-items').innerHTML = packingItems.map(i => `
      <div class="admin-pack-item ${i.scanned_count >= i.quantity ? 'done' : ''}">
        <span>${escapeHtml(i.product_name)}</span>
        <span>${i.scanned_count}/${i.quantity} ${i.scanned_count >= i.quantity ? '✓' : ''}</span>
      </div>`).join('');
    const btn = document.getElementById('admin-ship-confirm');
    if (btn) btn.classList.toggle('hidden', scanned !== total);
  }

  async function startPackingScan() {
    try {
      document.getElementById('admin-pack-start').classList.add('hidden');
      document.getElementById('admin-pack-capture').classList.remove('hidden');
      document.getElementById('admin-pack-stop').classList.remove('hidden');
      await Scanner.startPreview('admin-pack-reader');
    } catch (err) {
      showToast(err.message);
      document.getElementById('admin-pack-start').classList.remove('hidden');
      document.getElementById('admin-pack-capture').classList.add('hidden');
      document.getElementById('admin-pack-stop').classList.add('hidden');
    }
  }
  async function capturePackingScan() {
    try {
      const barcode = await Scanner.captureAndRecognize();
      if (barcode) {
        await handlePackingScan(barcode);
      } else {
        showToast('未识别到条码，请对准后重试');
      }
    } catch (err) { showToast(err.message); }
  }
  async function stopPackingScan() {
    await Scanner.stopPreview();
    document.getElementById('admin-pack-start').classList.remove('hidden');
    document.getElementById('admin-pack-capture').classList.add('hidden');
    document.getElementById('admin-pack-stop').classList.add('hidden');
  }
  async function handlePackingScan(barcode) {
    try {
      const r = await api('/api/shipments/' + shipmentDetailId + '/scan', { method: 'POST', body: JSON.stringify({ barcode }) });
      if (!r.ok) { showToast(r.message || '该条码不在发货单中'); }
      else {
        const idx = packingItems.findIndex(i => i.id === r.item.id);
        if (idx >= 0) packingItems[idx] = r.item;
        renderPackingProgress();
      }
    } catch (err) { showToast(err.message); }
  }
  async function shipShipment() {
    try {
      await api('/api/shipments/' + shipmentDetailId + '/ship', { method: 'POST', body: '{}' });
      await Scanner.stop();
      showToast(I18n.t('admin_ship_ok'));
      loadShipments();
      navigateAdmin('shipments');
    } catch (err) { showToast(err.message); }
  }

  // ========== 新建发货单 ==========
  function addShipItem() {
    const box = document.getElementById('new-ship-items');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'admin-item-row';
    row.innerHTML = `
      <input class="si-barcode" placeholder="${I18n.t('item_barcode')}">
      <button class="btn-scan-item" type="button" onclick="Admin.scanShipItem(this)" title="扫码添加">扫码</button>
      <input class="si-name" placeholder="${I18n.t('item_name')}">
      <input class="si-qty" type="number" placeholder="${I18n.t('item_qty')}" value="1" min="1">
      <button class="btn-del" onclick="this.parentElement.remove()">×</button>`;
    box.appendChild(row);
    row.querySelector('.si-barcode').focus();
  }

  // 扫码添加发货商品：预览模式，拍照识别后填入条码
  async function scanShipItem(btn) {
    const row = btn.closest('.admin-item-row');
    const merchantId = document.getElementById('new-ship-merchant').value;
    if (!merchantId) { showToast(I18n.t('admin_select_merchant')); return; }
    try {
      await Scanner.stopPreview();
      document.getElementById('ship-scan-area').classList.remove('hidden');
      window.__shipScanTarget = row;
      window.__shipScanMerchant = merchantId;
      await Scanner.startPreview('ship-scan-reader');
      // 绑定拍照识别按钮
      const capBtn = document.getElementById('ship-capture-btn');
      if (capBtn) {
        capBtn.onclick = async () => {
          const result = await Scanner.captureAndRecognize();
          if (result) {
            await handleShipScanResult(result.trim());
          } else {
            showToast('未识别到条码，请对准后重试');
          }
        };
      }
      showToast('对准条码后按"拍照识别"');
    } catch (err) {
      showToast(err.message);
      stopShipScan();
    }
  }

  async function handleShipScanResult(barcode) {
    const b = (barcode || '').trim();
    if (!b) return;
    const target = window.__shipScanTarget;
    const merchantId = window.__shipScanMerchant;
    if (!target) return;
    target.querySelector('.si-barcode').value = b;
    try {
      const products = await api('/api/products?merchantId=' + merchantId);
      const p = products.find(x => (x.barcode || '').toUpperCase() === b.toUpperCase());
      if (p && !target.querySelector('.si-name').value) {
        target.querySelector('.si-name').value = p.name;
      }
    } catch (e) {}
    stopShipScan();
    showToast('已添加：' + (target.querySelector('.si-name').value || b));
  }

  async function stopShipScan() {
    try { await Scanner.stopPreview(); } catch (e) {}
    const area = document.getElementById('ship-scan-area');
    if (area) area.classList.add('hidden');
    window.__shipScanTarget = null;
    window.__shipScanMerchant = null;
  }

  async function confirmShipment() {
    const merchantId = document.getElementById('new-ship-merchant').value;
    const remark = document.getElementById('new-ship-remark').value.trim();
    if (!merchantId) { showToast(I18n.t('admin_select_merchant')); return; }
    const items = [];
    document.querySelectorAll('#new-ship-items .admin-item-row').forEach(row => {
      const barcode = row.querySelector('.si-barcode').value.trim();
      const name = row.querySelector('.si-name').value.trim();
      const qty = parseInt(row.querySelector('.si-qty').value) || 0;
      if (barcode && qty > 0) items.push({ barcode, name: name || barcode, quantity: qty });
    });
    if (items.length === 0) { showToast('请至少添加一件商品'); return; }
    try {
      const r = await api('/api/shipments', { method: 'POST', body: JSON.stringify({ merchantId: parseInt(merchantId), items, remark }) });
      closeModal();
      showToast('发货单已创建，请开始清点扫码');
      navigateAdmin('shipments');
      openShipmentDetail(r.id);
    } catch (err) { showToast(err.message); }
  }

  // ========== 工具 ==========
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
  function countryLabel(code) {
    return { SG: '新加坡', MY: '马来西亚' }[code] || code || '—';
  }

  // 长按检测（600ms），触发后阻止随后的 click
  function bindLongPress(container, callback) {
    let timer = null;
    let longPressed = false;
    const start = (e) => {
      const card = e.target.closest('[data-shop-id]');
      if (!card) return;
      longPressed = false;
      timer = setTimeout(() => {
        longPressed = true;
        if (navigator.vibrate) navigator.vibrate(50);
        callback(card.dataset.shopId, card.dataset.shopName, card.dataset.shopType);
      }, 600);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    container.addEventListener('pointerdown', start);
    container.addEventListener('pointerup', cancel);
    container.addEventListener('pointerleave', cancel);
    container.addEventListener('pointercancel', cancel);
    container.addEventListener('click', (e) => {
      if (longPressed) { e.stopPropagation(); e.preventDefault(); longPressed = false; }
    }, true);
  }

  // ========== 删除账户（管理端，三次确认防误删） ==========
  function openDeleteConfirm(id, name, type) {
    deleteTarget = { id, name, type };
    deleteStep = 0;
    const typeLabel = type === 'brand' ? '品牌方' : (type === 'merchant' ? '合作商家' : '账户');
    const body = document.getElementById('admin-delete-body');
    body.innerHTML = `
      <p>即将删除 <b>${escapeHtml(name)}</b>（${typeLabel}）</p>
      <p class="hint">${type === 'brand' ? '该品牌下的所有商家账户也会一并删除；交易历史保留。' : '该商家的商品与登录用户会被删除；交易历史保留。'}</p>
      <p class="admin-delete-warn">此操作不可恢复，请连续点击 3 次确认删除。</p>`;
    updateDeleteButton();
    document.getElementById('admin-delete-overlay').classList.remove('hidden');
  }

  function updateDeleteButton() {
    const btn = document.getElementById('admin-delete-confirm');
    const remain = 3 - deleteStep;
    btn.textContent = remain > 1 ? `确认删除 (${deleteStep + 1}/3)` : '永久删除 (最后一次)';
    btn.classList.toggle('btn-danger-final', deleteStep >= 2);
  }

  async function onDeleteConfirm() {
    deleteStep++;
    if (deleteStep < 3) {
      updateDeleteButton();
      return;
    }
    // 第三次：真正删除
    const btn = document.getElementById('admin-delete-confirm');
    btn.disabled = true;
    btn.textContent = '删除中...';
    try {
      await api('/api/admin/shops/' + deleteTarget.id, { method: 'DELETE' });
      showToast('已删除: ' + deleteTarget.name);
      closeDeleteConfirm();
      // 刷新当前视图
      if (deleteTarget.type === 'brand') {
        adminBrandId = null; adminBrandName = '';
        navigateAdmin('brands');
      } else if (deleteTarget.type === 'admin') {
        loadAdmins();
      } else {
        loadMerchants();
      }
    } catch (err) {
      showToast(err.message);
      btn.disabled = false;
      deleteStep = 0;
      updateDeleteButton();
    }
  }

  function closeDeleteConfirm() {
    deleteTarget = null;
    deleteStep = 0;
    document.getElementById('admin-delete-overlay').classList.add('hidden');
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

  // ========== 超管权限 ==========
  function isSuperAdmin() {
    return currentUser && Array.isArray(currentUser.permissions) && currentUser.permissions.includes('super');
  }

  // ========== 管理端账户列表 ==========
  async function loadAdmins() {
    const el = document.getElementById('admin-admin-list');
    if (!el) return;
    const regBtn = document.getElementById('admin-btn-register-admin');
    if (regBtn) regBtn.classList.toggle('hidden', !isSuperAdmin());
    // 加载前清空，防止上一账户（超管）的密码短暂残留
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
      const list = await apiWithRetry(() => api('/api/admin/admins'));
      if (list.length === 0) { el.innerHTML = `<div class="empty-tip">暂无管理端账户</div>`; return; }
      const superFlag = isSuperAdmin();
      el.innerHTML = list.map(a => `
        <div class="admin-brand-card" data-shop-id="${a.id}" data-shop-name="${escapeHtml(a.shopName)}" data-shop-type="admin">
          <div class="admin-brand-card-head">
            <span class="admin-brand-name">${escapeHtml(a.shopName)}</span>
            <span class="chip ${a.isSuper ? 'chip-pending' : ''}">${a.isSuper ? I18n.t('admin_super') : I18n.t('admin_normal')}</span>
          </div>
          <div class="admin-brand-meta">
            ${I18n.t('username')}: ${escapeHtml(a.username || '-')} ·
            ${superFlag ? '初始密码: ' + escapeHtml(a.cardKey) : I18n.t('admin_password_hidden')}
            ${superFlag && a.id !== currentShop.id ? ' · <span class="hint" style="color:#2563eb;cursor:pointer;" onclick="Admin.openResetPwdModal(' + a.id + ',\'' + encodeURIComponent(a.shopName) + '\')">修改密码</span>' : ''}
            ${superFlag ? ' · <span class="hint">长按删除</span>' : ''}
          </div>
        </div>
      `).join('');
      // 长按删除（仅超管有效，无权限跳提示）
      el.querySelectorAll('.admin-brand-card').forEach(card => {
        let timer = null;
        card.addEventListener('mousedown', () => {
          timer = setTimeout(() => {
            const id = Number(card.dataset.shopId);
            const name = card.dataset.shopName;
            if (!isSuperAdmin()) {
              showToast(I18n.t('admin_no_permission'));
              return;
            }
            if (id === currentShop.id) { showToast('不能删除当前登录账户'); return; }
            openDeleteConfirm(id, name, 'admin');
          }, 600);
        });
        card.addEventListener('mouseup', () => { if (timer) clearTimeout(timer); });
        card.addEventListener('mouseleave', () => { if (timer) clearTimeout(timer); });
        // 触屏
        card.addEventListener('touchstart', () => {
          timer = setTimeout(() => {
            const id = Number(card.dataset.shopId);
            const name = card.dataset.shopName;
            if (!isSuperAdmin()) { showToast(I18n.t('admin_no_permission')); return; }
            if (id === currentShop.id) { showToast('不能删除当前登录账户'); return; }
            openDeleteConfirm(id, name, 'admin');
          }, 600);
        });
        card.addEventListener('touchend', () => { if (timer) clearTimeout(timer); });
      });
    } catch (err) {
      el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    }
  }

  // 注册管理端（仅超管）
  function openRegisterAdminModal() {
    if (!isSuperAdmin()) { showToast(I18n.t('admin_no_permission')); return; }
    document.getElementById('admin-register-admin-name').value = '';
    document.getElementById('admin-register-admin-key').value = '';
    document.getElementById('admin-register-admin-modal').classList.remove('hidden');
  }
  function closeRegisterAdminModal() {
    document.getElementById('admin-register-admin-modal').classList.add('hidden');
  }
  async function submitRegisterAdmin() {
    const name = document.getElementById('admin-register-admin-name').value.trim();
    const key = document.getElementById('admin-register-admin-key').value.trim();
    if (!name) { showToast(I18n.t('admin_need_name')); return; }
    if (key && (key.length < 8 || !/[a-z]/.test(key) || !/[A-Z]/.test(key) || !/\d/.test(key) || !/[^a-zA-Z0-9]/.test(key))) {
      showToast(I18n.t('password_rule')); return;
    }
    try {
      const r = await api('/api/admin/register-admin', { method: 'POST', body: JSON.stringify({ shopName: name, cardKey: key || undefined }) });
      closeRegisterAdminModal();
      showToast(I18n.t('admin_card_generated') + ' ' + r.cardKey);
      loadAdmins();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 销售趋势（超管/总代） ==========
  let adminTrendChart = null;
  async function loadAdminSalesTrend() {
    const activeBtn = document.querySelector('.admin-trend-btn.active');
    const period = activeBtn ? activeBtn.dataset.period : 'month';
    const productSelect = document.getElementById('admin-trend-product');
    const catalogId = productSelect ? productSelect.value : '';
    const pointR = (period === 'month_all' || period === 'quarter' || period === 'year_all') ? 0 : 3;

    try {
      const url = '/api/admin/sales-trend?period=' + period + (catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : '');
      const data = await api(url);
      const labels = data.data.map(d => data.labelFmt === 'hour' ? d.label + ':00' : d.label);
      const revenues = data.data.map(d => Number(d.revenue).toFixed(2));
      const qtys = data.data.map(d => d.qty);

      const canvas = document.getElementById('admin-sales-trend-chart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (adminTrendChart) adminTrendChart.destroy();

      const gradient = ctx.createLinearGradient(0, 0, 0, 280);
      gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
      gradient.addColorStop(1, 'rgba(99,102,241,0.02)');

      adminTrendChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '营收 (S$)', data: revenues, borderColor: '#6366f1', backgroundColor: gradient, fill: true, tension: 0.35, pointRadius: pointR, pointHoverRadius: 6, pointBackgroundColor: '#6366f1', pointBorderColor: '#fff', pointBorderWidth: 2, borderWidth: 2, yAxisID: 'y' },
            { label: '销量 (件)', data: qtys, borderColor: '#f59e0b', backgroundColor: 'transparent', fill: false, tension: 0.35, pointRadius: pointR > 0 ? 2 : 0, pointHoverRadius: 5, pointBackgroundColor: '#f59e0b', pointBorderColor: '#fff', pointBorderWidth: 1.5, borderWidth: 1.5, borderDash: [4, 2], yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 }, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: { backgroundColor: 'rgba(15,23,42,0.9)', titleFont: { size: 12 }, bodyFont: { size: 11 }, padding: 10, cornerRadius: 8 } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0, autoSkip: true, maxTicksLimit: 15, autoSkipPadding: 10 }, grid: { display: false } },
            y: { type: 'linear', position: 'left', ticks: { font: { size: 10 }, callback: v => 'S$' + v }, grid: { color: 'rgba(0,0,0,0.05)' } },
            y1: { type: 'linear', position: 'right', ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    } catch (err) {
      showToast(err.message);
    }
  }

  // 加载销售趋势商品筛选选项
  async function loadAdminTrendProducts() {
    const sel = document.getElementById('admin-trend-product');
    if (!sel) return;
    try {
      const catalogs = await api('/api/admin/catalog');
      const active = catalogs.filter(c => c.status === 'active' || !c.status);
      sel.innerHTML = '<option value="">全部商品</option>' + active.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
    } catch (e) { /* 忽略 */ }
  }

  // ========== 超管修改管理端密码（三次确认） ==========
  function openResetPwdModal(id, nameEncoded) {
    if (!isSuperAdmin()) { showToast(I18n.t('admin_no_permission')); return; }
    resetPwdTarget = { id, name: decodeURIComponent(nameEncoded) };
    resetPwdStep = 0;
    document.getElementById('reset-pwd-target').textContent = '账户：' + resetPwdTarget.name;
    document.getElementById('reset-pwd-new').value = '';
    updateResetPwdBtn();
    document.getElementById('admin-reset-pwd-modal').classList.remove('hidden');
  }
  function closeResetPwdModal() {
    document.getElementById('admin-reset-pwd-modal').classList.add('hidden');
    resetPwdTarget = null;
    resetPwdStep = 0;
  }
  function updateResetPwdBtn() {
    const btn = document.getElementById('reset-pwd-confirm');
    const labels = ['确认修改 (1/3)', '再次确认 (2/3)', '永久修改 (3/3)'];
    btn.textContent = labels[resetPwdStep] || labels[0];
    btn.classList.toggle('btn-danger-final', resetPwdStep === 2);
  }
  async function onResetPwdConfirm() {
    if (!resetPwdTarget) return;
    const pw = document.getElementById('reset-pwd-new').value.trim();
    if (resetPwdStep === 0) {
      if (!pw) { showToast('请输入新密码'); return; }
      if (pw.length < 8 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^a-zA-Z0-9]/.test(pw)) {
        showToast(I18n.t('password_rule')); return;
      }
      resetPwdStep = 1;
      updateResetPwdBtn();
      return;
    }
    if (resetPwdStep === 1) {
      resetPwdStep = 2;
      updateResetPwdBtn();
      return;
    }
    // 第三次：真正提交
    try {
      await api('/api/admin/admins/' + resetPwdTarget.id + '/password', { method: 'PUT', body: JSON.stringify({ newPassword: pw }) });
      showToast('密码修改成功');
      closeResetPwdModal();
      loadAdmins();
    } catch (err) {
      showToast(err.message);
    }
  }

  // ========== 修改自己密码（地区代理/普通管理端，仅一次；超管不限） ==========
  function openSelfPwdModal() {
    if (currentShop && currentShop.passwordChanged && !isSuperAdmin()) {
      showToast('密码已修改过一次，如需再次修改请联系超管');
      return;
    }
    document.getElementById('admin-self-pwd-new').value = '';
    document.getElementById('admin-self-pwd-confirm').value = '';
    // 超管不受次数限制，隐藏"仅可修改一次"提示
    const onetimeHint = document.getElementById('admin-self-pwd-onetime');
    if (onetimeHint) onetimeHint.style.display = isSuperAdmin() ? 'none' : 'block';
    document.getElementById('admin-self-pwd-modal').classList.remove('hidden');
  }
  function closeSelfPwdModal() {
    document.getElementById('admin-self-pwd-modal').classList.add('hidden');
  }
  async function submitSelfPwd() {
    const pw1 = document.getElementById('admin-self-pwd-new').value.trim();
    const pw2 = document.getElementById('admin-self-pwd-confirm').value.trim();
    if (!pw1 || !pw2) { showToast('请输入新密码'); return; }
    if (pw1 !== pw2) { showToast(I18n.t('password_mismatch')); return; }
    if (pw1.length < 8 || !/[a-z]/.test(pw1) || !/[A-Z]/.test(pw1) || !/\d/.test(pw1) || !/[^a-zA-Z0-9]/.test(pw1)) {
      showToast(I18n.t('password_rule')); return;
    }
    try {
      await api('/api/shop/password', { method: 'PUT', body: JSON.stringify({ newPassword: pw1 }) });
      currentShop.passwordChanged = true;
      localStorage.setItem('shop', JSON.stringify(currentShop));
      closeSelfPwdModal();
      showToast(I18n.t('password_changed'));
      updateSelfPwdBtn();
    } catch (err) {
      showToast(err.message);
    }
  }
  function updateSelfPwdBtn() {
    const btn = document.getElementById('admin-btn-change-pwd');
    if (!btn) return;
    if (currentShop && currentShop.passwordChanged && !isSuperAdmin()) {
      btn.textContent = '密码已改';
      btn.disabled = true;
      btn.style.opacity = '0.5';
    } else {
      btn.textContent = '修改密码';
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  }

  // ========== 事件 ==========
  function bindEvents() {
    document.getElementById('admin-btn-login').addEventListener('click', handleLogin);
    document.getElementById('admin-login-username').addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    document.getElementById('admin-login-password').addEventListener('keypress', e => { if (e.key === 'Enter') handleLogin(); });
    // 密码小眼睛：按一下可见1秒
    const adminEye = document.getElementById('admin-btn-eye-password');
    if (adminEye) adminEye.addEventListener('click', () => peekPassword('admin-login-password', adminEye));
    document.getElementById('admin-btn-logout').addEventListener('click', handleLogout);

    document.getElementById('admin-btn-register-brand').addEventListener('click', () => openModal('brand'));
    const regAgentBtn = document.getElementById('admin-btn-register-agent');
    if (regAgentBtn) regAgentBtn.addEventListener('click', () => openModal('agent'));
    const catalogAddBtn = document.getElementById('admin-btn-catalog-add');
    if (catalogAddBtn) catalogAddBtn.addEventListener('click', () => openCatalogEdit(null));
    document.getElementById('admin-btn-register-merchant').addEventListener('click', () => openModal('merchant'));
    document.getElementById('admin-btn-new-shipment').addEventListener('click', () => openModal('shipment'));
    // 管理端账户
    const regAdminBtn = document.getElementById('admin-btn-register-admin');
    if (regAdminBtn) regAdminBtn.addEventListener('click', openRegisterAdminModal);
    const regAdminClose = document.getElementById('admin-register-admin-close');
    if (regAdminClose) regAdminClose.addEventListener('click', closeRegisterAdminModal);
    const regAdminSubmit = document.getElementById('admin-register-admin-submit');
    if (regAdminSubmit) regAdminSubmit.addEventListener('click', submitRegisterAdmin);
    // 修改管理端密码
    const rpCancel = document.getElementById('reset-pwd-cancel');
    if (rpCancel) rpCancel.addEventListener('click', closeResetPwdModal);
    const rpConfirm = document.getElementById('reset-pwd-confirm');
    if (rpConfirm) rpConfirm.addEventListener('click', onResetPwdConfirm);
    // 修改自己密码
    const selfPwdBtn = document.getElementById('admin-btn-change-pwd');
    if (selfPwdBtn) selfPwdBtn.addEventListener('click', openSelfPwdModal);
    const selfPwdCancel = document.getElementById('admin-self-pwd-cancel');
    if (selfPwdCancel) selfPwdCancel.addEventListener('click', closeSelfPwdModal);
    const selfPwdSubmit = document.getElementById('admin-self-pwd-submit');
    if (selfPwdSubmit) selfPwdSubmit.addEventListener('click', submitSelfPwd);
    // 销售趋势按钮
    document.querySelectorAll('.admin-trend-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-trend-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadAdminSalesTrend();
      });
    });
    const adminTrendProduct = document.getElementById('admin-trend-product');
    if (adminTrendProduct) adminTrendProduct.addEventListener('change', loadAdminSalesTrend);

    document.getElementById('admin-modal-close').addEventListener('click', closeModal);
    document.getElementById('admin-modal-confirm').addEventListener('click', confirmModal);
    document.getElementById('admin-back-brands').addEventListener('click', backToBrands);
    // 删除确认弹窗
    document.getElementById('admin-delete-cancel').addEventListener('click', closeDeleteConfirm);
    document.getElementById('admin-delete-confirm').addEventListener('click', onDeleteConfirm);
  }

  return {
    init, setRole, navigateAdmin, openMerchantDetail, backToMerchants,
    selectBrand, backToBrands, openBrandDetail, viewBrandAgents, viewBrandMerchants, viewBrandSales,
    openShipmentDetail, backToShipments,
    startPackingScan, capturePackingScan, stopPackingScan, shipShipment, addShipItem,
    scanShipItem, stopShipScan, reviewDiscount, reviewPurchaseOrder, assignPurchaseOrder,
    closeRegisterAdminModal, openResetPwdModal, closeResetPwdModal,
    openSelfPwdModal, closeSelfPwdModal, updateSelfPwdBtn,
    loadCatalog, openCatalogEdit, saveCatalog, backToCatalog,
    authCatalogToAdmin, authCatalogToBrand, authCatalogToTarget, showCatalogActionMenu,
    showActionModal, closeActionModal, showSelectModal, loadCatalogAuthChain,
    showAuthSales, showRevokeAuthMenu,
    openSalesDetail, backFromSalesDetail, loadBrandMerchantBarChart, applyBrandMerchantBarFilter,
    filterBarProducts, showBarProductDropdown, hideBarProductDropdown, selectBarProduct, removeBarProduct,
    loadAdminSalesTrend, loadAdminTrendProducts
  };
})();

document.addEventListener('DOMContentLoaded', () => Admin.init());
