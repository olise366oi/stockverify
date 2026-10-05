/**
 * 多国零售 PWA 库存管理系统 - 主服务器
 * 功能：账户登录、商品CRUD、扫码出入库、离线同步、财务计算、报表导出、操作日志
 * 已改造为 sqlite‑wasm 异步数据库，移除better‑sqlite3
 */
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
// 改为异步初始化导出
const { initDB, getDb, appendAuditLog, verifyAuditChain } = require('./database');
// API v1 接口模块（/api/v1/*，新增工程化接口，不影响原有接口）
const routesV1 = require('./routes-v1');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sg-inventory-pwa-secret-key-2024-change-in-production';
// ========== 国家/地区 → GST 税率（开户时品牌方/管理端选定，客户端不可改） ==========
const GST_BY_COUNTRY = {
  SG: 0.09, // 新加坡 Singapore 9%
  MY: 0.00  // 马来西亚 Malaysia（无 GST）
};
const COUNTRY_LABELS = {
  SG: '新加坡 Singapore (GST 9%)',
  MY: '马来西亚 Malaysia (无 GST)'
};
// 登录限流：同一 IP 5 分钟内最多 20 次登录尝试
const loginAttempts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 5 * 60 * 1000; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  if (rec.count > 20) {
    return res.status(429).json({ error: '登录尝试过于频繁，请 5 分钟后再试' });
  }
  next();
}
// ========== 中间件 ==========
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
// API 响应禁止缓存，确保授权/下架等操作后列表实时刷新
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// 上传的凭证图片（静态可访问）
app.use('/uploads', express.static(UPLOADS_DIR));
// HTTPS 强制（生产环境）
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
// ========== 认证中间件 ==========
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录，请先登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}
// 角色权限中间件
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足，需要 ' + roles.join(' 或 ') + ' 角色' });
    }
    next();
  };
}
// ========== 财务计算工具（仅 GST，无佣金） ==========
async function calculateFinance(shopId, quantity, unitPrice, type) {
  const db = getDb();
  const shop = await db.get('SELECT * FROM shops WHERE id = ?', shopId);
  const gstRate = shop?.gst_rate || 0.09;
  const amountBeforeGST = +(quantity * unitPrice).toFixed(2);
  const gstAmount = +(amountBeforeGST * gstRate).toFixed(2);
  const totalAmount = +(amountBeforeGST + gstAmount).toFixed(2);
  return { amountBeforeGST, gstAmount, totalAmount };
}
// ========== 生成唯一开户密钥 ==========
function generateCardKey() {
  return 'VAL-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
// ========== 品牌方统一定价 ==========
const FIXED_SELL_PRICE = 188; // 标价固定 188 新币，合作商家无权定价
// ========== 活动折扣（与中医馆合作） ==========
const DISCOUNT_MAP = {
  none: 0,
  medical: 10, // 中医馆消费凭证
  social: 10,  // 社媒分享截图
  both: 20      // 两项都满足
};
const DISCOUNT_MAX = 20; // 最多折 20 新币 → 折后价最低 168
const PRODUCT_COST = 20; // 商品成本（品牌出厂价/进货价 20 SGD）

// 计算折扣后的财务（GST 按折后金额计算；分成 7:3 按毛利=（售价−成本）×数量，成本读商品档案，缺省用 20）
async function calculateFinanceWithDiscount(shopId, quantity, unitPrice, discountType, costPrice) {
  const db = getDb();
  const shop = await db.get('SELECT * FROM shops WHERE id = ?', shopId);
  const gstRate = shop?.gst_rate || 0.09;
  const discount = DISCOUNT_MAP[discountType] || 0;
  const discountedPrice = Math.max(0, unitPrice - discount);
  const amountBeforeGST = +(quantity * discountedPrice).toFixed(2);
  const gstAmount = +(amountBeforeGST * gstRate).toFixed(2);
  const totalAmount = +(amountBeforeGST + gstAmount).toFixed(2);
  // 分成：利润池=（售价−成本）×数量；品牌七成/商家三成；折扣 D 从品牌七成全额扣
  const productCost = Number(costPrice) > 0 ? Number(costPrice) : PRODUCT_COST;
  const profitBase = +(Math.max(0, unitPrice - productCost) * quantity).toFixed(2);
  const brandShare = Math.max(0, +(0.7 * profitBase - discount * quantity).toFixed(2));
  const merchantShare = +(0.3 * profitBase).toFixed(2);
  return { discount, discountedPrice, amountBeforeGST, gstAmount, totalAmount, brandShare, merchantShare };
}

// 审核驳回时：折扣从商家三成扣还给品牌（品牌拿回满七成毛利，商家承担 D）；成本读商品档案，缺省用 20
function rejectedShares(quantity, unitPrice, discount, costPrice) {
  const productCost = Number(costPrice) > 0 ? Number(costPrice) : PRODUCT_COST;
  const profitBase = Math.max(0, unitPrice - productCost) * quantity;
  const brandShare = +(0.7 * profitBase).toFixed(2);
  const merchantShare = Math.max(0, +(0.3 * profitBase - discount * quantity).toFixed(2));
  return { brandShare, merchantShare };
}

// ========== API 路由 ==========
// --- 账户登录（管理端 / 品牌方 / 合作商家，带限流；密钥大小写不敏感） ---
app.post('/api/auth/login', rateLimit, async (req, res) => {
  const db = getDb();
  const { cardKey, username, role } = req.body;
  const roleType = { brand: 'brand', admin: 'admin', merchant: 'merchant' }[role] || 'merchant';
  // 用户名兜底
  let realUsername = (username || "").trim();
  if (!realUsername) realUsername = roleType === 'admin' ? '管理员' : (roleType === 'brand' ? '品牌管理员' : '合作商家');

  if (!cardKey) {
    return res.status(400).json({ error: '请输入登录信息' });
  }
  const key = cardKey.trim();
  // 不做自助注册：商家账号由品牌方/管理端开通（登录密钥大小写不敏感，支持自定义易记密钥）
  const shop = await db.get('SELECT * FROM shops WHERE card_key = ? COLLATE NOCASE AND type = ?', [key, roleType]);
  if (!shop) {
    return res.status(404).json({
      error: roleType === 'admin' ? '管理端登录信息无效' : (roleType === 'brand' ? '品牌方登录信息无效' : '合作商家登录信息无效，请联系品牌方开通账号')
    });
  }
  // 查找或创建用户
  let user = await db.get('SELECT * FROM users WHERE shop_id = ? AND username = ?', shop.id, realUsername);
  if (!user) {
    const shopUserRow = await db.get('SELECT COUNT(*) as cnt FROM users WHERE shop_id = ?', [shop.id]);
    const shopUserCount = shopUserRow.cnt;
    const newRole = roleType === 'admin' ? 'admin' : (roleType === 'brand' ? 'brand' : (shopUserCount === 0 ? 'merchant' : 'staff'));
    // 总代店铺（brand 且 parent_id IS NULL）的新用户默认有 brand_super 权限
    const defaultPerms = (roleType === 'brand' && shop.parent_id === null) ? '["brand_super"]' : '[]';
    await db.run('INSERT INTO users (shop_id, username, role, permissions, is_first_login) VALUES (?, ?, ?, ?, ?)',
      [shop.id, realUsername, newRole, defaultPerms, shopUserCount === 0 ? 1 : 0]);
    user = await db.get('SELECT * FROM users WHERE shop_id = ? AND username = ?', [shop.id, realUsername]);
  }
  // 解析权限
  let userPerms = [];
  try { userPerms = user.permissions ? JSON.parse(user.permissions) : []; } catch { userPerms = []; }
  // 生成 JWT
  const token = jwt.sign(
    { userId: user.id, shopId: shop.id, username: user.username, role: user.role, permissions: userPerms },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  // 记录登录日志
  await appendAuditLog(shop.id, user.id, user.username, 'login', null, null, `用户 ${user.username} 登录系统，角色: ${user.role}`);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, permissions: userPerms },
    shop: { id: shop.id, name: shop.shop_name, cardKey: shop.card_key, gstRate: shop.gst_rate, country: shop.country || 'SG', type: shop.type, parentId: shop.parent_id, passwordChanged: shop.password_changed === 1 }
  });
});
// ========== 商家范围解析：品牌方/管理端可查看合作商家数据 ==========
async function resolveShopScope(req, merchantId) {
  const db = getDb();
  if (req.user.role === 'admin') {
    if (!merchantId) return null;
    const m = await db.get('SELECT id FROM shops WHERE id = ? AND type = ?', merchantId, 'merchant');
    if (!m) {
      const err = new Error('无权访问该商家');
      err.status = 403;
      throw err;
    }
    return m.id;
  }
  if (req.user.role === 'brand') {
    if (!merchantId) return null; // 品牌自身无业务数据
    const m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', merchantId, 'merchant', req.user.shopId);
    if (!m) {
      const err = new Error('无权访问该商家');
      err.status = 403;
      throw err;
    }
    return m.id;
  }
  return req.user.shopId;
}
// ========== 凭证图片上传（商家端上传折扣凭证） ==========
app.post('/api/upload', authMiddleware, requireRole('merchant', 'staff', 'brand', 'admin'), async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少图片数据' });
  // 只接受 data URL 图片，限制大小约 3MB
  const m = data.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return res.status(400).json({ error: '仅支持 PNG/JPG/WebP/GIF 图片' });
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: '图片过大，请压缩后上传（≤3MB）' });
  const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  const url = '/uploads/' + filename;
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'upload', null, null, `上传凭证图片: ${url}`);
  res.json({ success: true, url });
});

// 将 base64 图片转为 URL（离线同步时调用）
async function ensureImageUrl(img) {
  if (!img || typeof img !== 'string') return null;
  if (img.startsWith('/uploads/')) return img;
  if (img.startsWith('data:image/')) {
    const m = img.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (!m) return null;
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    const filename = crypto.randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    return '/uploads/' + filename;
  }
  return null;
}

// --- 店铺设置更新（品牌方 / 合作商家）---
// 注意：GST 税率与所在国家在开户时由品牌方/管理端确定，客户端不可修改
app.put('/api/shop/settings', authMiddleware, requireRole('merchant', 'brand'), async (req, res) => {
  const db = getDb();
  const { shopName } = req.body;
  // 合作商家（含店员）不可修改店铺名称：名称由品牌方/管理端开户时固定
  if (req.user.role === 'merchant' || req.user.role === 'staff') {
    return res.status(403).json({ error: '店铺名称不可修改（由品牌方固定）' });
  }
  if (!shopName || !shopName.trim()) return res.status(400).json({ error: '请输入店铺名称' });
  await db.run('UPDATE shops SET shop_name = ? WHERE id = ?',
    shopName.trim(), req.user.shopId);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'shop_update', null, null, `更新店铺名称: ${shopName.trim()}`);
  res.json({ success: true });
});
// --- 商品列表（品牌方可传 merchantId 查看指定商家）---
app.get('/api/products', authMiddleware, async (req, res) => {
  const db = getDb();
  const { search, category, lowStock, merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  let sql = 'SELECT * FROM products WHERE shop_id = ?';
  const params = [shopId];
  if (search) {
    sql += ' AND (name LIKE ? OR barcode LIKE ? OR sku LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (lowStock === 'true') {
    sql += ' AND stock <= threshold';
  }
  sql += ' ORDER BY last_write_at DESC';
  const products = await db.all(sql, ...params);
  res.json(products);
});
// 商家端：按类目聚合库存（库存数+在途数）
app.get('/api/merchant/catalog-summary', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  // 从 product_items 按 catalog_id 聚合
  const rows = await db.all(`
    SELECT pi.catalog_id, pi.product_name,
      COALESCE(SUM(CASE WHEN pi.status='merchant_stock' THEN 1 ELSE 0 END),0) as in_stock,
      COALESCE(SUM(CASE WHEN pi.status='in_transit' THEN 1 ELSE 0 END),0) as in_transit
    FROM product_items pi
    WHERE pi.merchant_shop_id = ? AND pi.status IN ('merchant_stock','in_transit')
    GROUP BY pi.catalog_id, pi.product_name
    ORDER BY pi.product_name
  `, [req.user.shopId]);
  // 补充 catalog 信息
  const result = [];
  for (const r of rows) {
    const cat = r.catalog_id ? await db.get('SELECT id, name, description, promo_image, sell_price, cost_price FROM product_catalog WHERE id = ?', [r.catalog_id]) : null;
    result.push({
      catalog_id: r.catalog_id,
      name: cat?.name || r.product_name,
      description: cat?.description || '',
      promo_image: cat?.promo_image || null,
      sell_price: cat?.sell_price || 0,
      cost_price: cat?.cost_price || 0,
      in_stock: r.in_stock,
      in_transit: r.in_transit
    });
  }
  res.json(result);
});
// 商家端：类目详情 - 所有库存条码列表
app.get('/api/merchant/catalog/:id/items', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const catalogId = req.params.id;
  const items = await db.all(`
    SELECT id, barcode, status, received_at, sold_at
    FROM product_items
    WHERE merchant_shop_id = ? AND catalog_id = ? AND status IN ('merchant_stock','sold')
    ORDER BY status, id
  `, [req.user.shopId, catalogId]);
  const cat = await db.get('SELECT id, name, description FROM product_catalog WHERE id = ?', [catalogId]);
  res.json({ catalog: cat, items });
});
// 商家端：销售趋势（今日按小时/本周按天/本月按天/今年按月/全部按月）
app.get('/api/merchant/sales-trend', authMiddleware, async (req, res) => {
  const db = getDb();
  const period = req.query.period || 'month';
  const catalogId = req.query.catalog_id || ''; // 空=全部商品
  const merchantId = req.query.merchantId ? parseInt(req.query.merchantId) : null;

  // 确定shopId：商家端用自己的，管理端传merchantId
  let shopId;
  if (merchantId) {
    // 管理端查看指定商铺：权限校验
    if (req.user.role === 'admin') {
      shopId = merchantId;
    } else if (req.user.role === 'brand') {
      const perms = (req.user.permissions || '[]');
      const permArr = typeof perms === 'string' ? JSON.parse(perms) : perms;
      if (permArr.includes('brand_super')) {
        // 总代只能看自己下属的商铺
        const m = await db.get("SELECT id FROM shops WHERE id=? AND parent_id=?", [merchantId, req.user.shopId]);
        if (!m) return res.status(403).json({ error: '无权查看该商铺' });
        shopId = merchantId;
      } else {
        return res.status(403).json({ error: '无权查看' });
      }
    } else {
      return res.status(403).json({ error: '无权查看' });
    }
  } else {
    if (req.user.role !== 'merchant' && req.user.role !== 'staff') return res.status(403).json({ error: '无权查看' });
    shopId = req.user.shopId;
  }

  // 构建 WHERE 条件
  let where = `shop_id = ? AND type='sale'`;
  let params = [shopId];
  if (catalogId) {
    where += ` AND product_id IN (SELECT id FROM products WHERE shop_id = ? AND barcode = ?)`;
    params.push(shopId, catalogId);
  }

  let sql, labelFmt, fillLabels = [];

  if (period === 'today') {
    // 今日按小时（0-23补零）
    sql = `SELECT strftime('%H', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where} AND date(server_timestamp)=date('now','localtime')
      GROUP BY strftime('%H', server_timestamp) ORDER BY label`;
    labelFmt = 'hour';
    for (let h = 0; h < 24; h++) fillLabels.push(String(h).padStart(2, '0'));
  } else if (period === 'week') {
    // 本周按天（周一到周日补零），标签用周一周二
    const weekStart = new Date();
    const day = weekStart.getDay() || 7; // 周日=7
    weekStart.setDate(weekStart.getDate() - day + 1); // 本周一
    const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      fillLabels.push({ key: d.toISOString().slice(0, 10), label: weekDays[i] });
    }
    sql = `SELECT strftime('%Y-%m-%d', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
        AND date(server_timestamp) >= ?
        AND date(server_timestamp) <= ?
      GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    params.push(fillLabels[0].key, fillLabels[6].key);
    labelFmt = 'weekday';
  } else if (period === 'month') {
    // 本月按天（1-月底补零）
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) fillLabels.push(String(d).padStart(2, '0'));
    sql = `SELECT strftime('%d', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
        AND strftime('%Y-%m', server_timestamp)=strftime('%Y-%m','now','localtime')
      GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    labelFmt = 'day';
  } else if (period === 'month_all') {
    // 每月：按月汇总全部历史
    sql = `SELECT strftime('%Y-%m', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
      GROUP BY strftime('%Y-%m', server_timestamp) ORDER BY label`;
    labelFmt = 'month';
  } else if (period === 'quarter') {
    // 每季度：按季度汇总
    sql = `SELECT (strftime('%Y', server_timestamp) || '-Q' || ((strftime('%m', server_timestamp)-1)/3 + 1)) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
      GROUP BY strftime('%Y', server_timestamp), ((strftime('%m', server_timestamp)-1)/3 + 1) ORDER BY label`;
    labelFmt = 'quarter';
  } else if (period === 'year_all') {
    // 每年：按年汇总
    sql = `SELECT strftime('%Y', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
      GROUP BY strftime('%Y', server_timestamp) ORDER BY label`;
    labelFmt = 'year';
  } else {
    // 全部按日（天天基金风格，精确到每一天）
    sql = `SELECT strftime('%Y-%m-%d', server_timestamp) as label,
        COALESCE(SUM(quantity),0) as qty,
        COALESCE(SUM(total_amount),0) as revenue
      FROM transactions WHERE ${where}
      GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    labelFmt = 'day';
  }

  const rows = await db.all(sql, params);

  // 补零
  let result;
  if (labelFmt === 'weekday') {
    const map = {};
    rows.forEach(r => { map[r.label] = r; });
    result = fillLabels.map(f => ({
      label: f.label,
      qty: map[f.key] ? map[f.key].qty : 0,
      revenue: map[f.key] ? map[f.key].revenue : 0
    }));
  } else if (fillLabels.length > 0) {
    const map = {};
    rows.forEach(r => { map[r.label] = r; });
    result = fillLabels.map(l => ({
      label: l,
      qty: map[l] ? map[l].qty : 0,
      revenue: map[l] ? map[l].revenue : 0
    }));
  } else {
    result = rows;
  }

  res.json({ period, labelFmt, data: result });
});

// --- 管理端销售趋势（超管看全部，总代看自己地区） ---
app.get('/api/admin/sales-trend', authMiddleware, requireRole('admin', 'brand'), async (req, res) => {
  const db = getDb();
  const period = req.query.period || 'month';
  const catalogId = req.query.catalog_id || '';
  const perms = (req.user.permissions || '[]');
  const permArr = typeof perms === 'string' ? JSON.parse(perms) : perms;

  let shopIds = [];
  const brandId = req.query.brandId ? parseInt(req.query.brandId) : null;
  if (brandId) {
    // 指定总代：查该总代下属的所有商铺
    const shops = await db.all("SELECT id FROM shops WHERE type='merchant' AND parent_id=?", [brandId]);
    shopIds = shops.map(s => s.id);
  } else if (req.user.role === 'admin') {
    const shops = await db.all("SELECT id FROM shops WHERE type='merchant'");
    shopIds = shops.map(s => s.id);
  } else if (req.user.role === 'brand' && permArr.includes('brand_super')) {
    const shops = await db.all("SELECT id FROM shops WHERE type='merchant' AND parent_id=?", [req.user.shopId]);
    shopIds = shops.map(s => s.id);
  } else {
    return res.status(403).json({ error: '无权限查看销售趋势' });
  }

  if (shopIds.length === 0) return res.json({ period, labelFmt: 'day', data: [] });

  const placeholders = shopIds.map(() => '?').join(',');
  let where = `shop_id IN (${placeholders}) AND type='sale'`;
  let params = [...shopIds];
  if (catalogId) { where += ` AND product_id IN (SELECT id FROM products WHERE name = ?)`; params.push(catalogId); }

  let sql, labelFmt, fillLabels = [];
  if (period === 'today') {
    sql = `SELECT strftime('%H', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} AND date(server_timestamp)=date('now','localtime') GROUP BY strftime('%H', server_timestamp) ORDER BY label`;
    labelFmt = 'hour'; for (let h = 0; h < 24; h++) fillLabels.push(String(h).padStart(2, '0'));
  } else if (period === 'week') {
    const weekStart = new Date(); const day = weekStart.getDay() || 7; weekStart.setDate(weekStart.getDate() - day + 1);
    const weekDays = ['周一','周二','周三','周四','周五','周六','周日'];
    for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); fillLabels.push({ key: d.toISOString().slice(0,10), label: weekDays[i] }); }
    sql = `SELECT strftime('%Y-%m-%d', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} AND date(server_timestamp) >= ? AND date(server_timestamp) <= ? GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    params.push(fillLabels[0].key, fillLabels[6].key); labelFmt = 'weekday';
  } else if (period === 'month') {
    const now = new Date(); const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) fillLabels.push(String(d).padStart(2,'0'));
    sql = `SELECT strftime('%d', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} AND strftime('%Y-%m', server_timestamp)=strftime('%Y-%m','now','localtime') GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    labelFmt = 'day';
  } else if (period === 'month_all') {
    // 每月：按月汇总全部历史
    sql = `SELECT strftime('%Y-%m', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} GROUP BY strftime('%Y-%m', server_timestamp) ORDER BY label`;
    labelFmt = 'month';
  } else if (period === 'quarter') {
    // 每季度：按季度汇总
    sql = `SELECT (strftime('%Y', server_timestamp) || '-Q' || ((strftime('%m', server_timestamp)-1)/3 + 1)) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} GROUP BY strftime('%Y', server_timestamp), ((strftime('%m', server_timestamp)-1)/3 + 1) ORDER BY label`;
    labelFmt = 'quarter';
  } else if (period === 'year_all') {
    // 每年：按年汇总
    sql = `SELECT strftime('%Y', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} GROUP BY strftime('%Y', server_timestamp) ORDER BY label`;
    labelFmt = 'year';
  } else {
    // 全部按日（天天基金风格，精确到每一天）
    sql = `SELECT strftime('%Y-%m-%d', server_timestamp) as label, COALESCE(SUM(quantity),0) as qty, COALESCE(SUM(total_amount),0) as revenue FROM transactions WHERE ${where} GROUP BY strftime('%Y-%m-%d', server_timestamp) ORDER BY label`;
    labelFmt = 'day';
  }

  const rows = await db.all(sql, params);
  let result;
  if (labelFmt === 'weekday') {
    const map = {}; rows.forEach(r => { map[r.label] = r; });
    result = fillLabels.map(f => ({ label: f.label, qty: map[f.key] ? map[f.key].qty : 0, revenue: map[f.key] ? map[f.key].revenue : 0 }));
  } else if (fillLabels.length > 0) {
    const map = {}; rows.forEach(r => { map[r.label] = r; });
    result = fillLabels.map(l => ({ label: l, qty: map[l] ? map[l].qty : 0, revenue: map[l] ? map[l].revenue : 0 }));
  } else { result = rows; }
  res.json({ period, labelFmt, data: result });
});

// --- 单个商品（按条码查询）---
app.get('/api/products/barcode/:code', authMiddleware, async (req, res) => {
  const db = getDb();
  const product = await db.get('SELECT * FROM products WHERE shop_id = ? AND barcode = ?', req.user.shopId, req.params.code);
  if (!product) return res.status(404).json({ error: '未找到该商品，请先在商品管理中添加' });
  res.json(product);
});
// --- 新增商品（售价/成本按档案填写，未填则用缺省值） ---
app.post('/api/products', authMiddleware, requireRole('merchant', 'admin'), async (req, res) => {
  const db = getDb();
  const { sku, barcode, name, category, costPrice, sellPrice, stock, threshold } = req.body;
  if (!name || !barcode) return res.status(400).json({ error: '商品名称和条码必填' });
  try {
    await db.run(`
      INSERT INTO products (shop_id, sku, barcode, name, category, cost_price, sell_price, stock, threshold, last_write_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `, req.user.shopId, sku || '', barcode, name, category || '未分类', costPrice || 0, sellPrice || FIXED_SELL_PRICE, stock || 0, threshold || 10);
    const newProduct = await db.get('SELECT last_insert_rowid() as id');
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_create', newProduct.id, name, `新增商品: ${name}, 条码: ${barcode}, 初始库存: ${stock || 0}`);
    res.json({ id: newProduct.id, success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '该条码已存在，请使用其他条码' });
    res.status(500).json({ error: e.message });
  }
});
// --- 更新商品（售价/成本按档案维护） ---
app.put('/api/products/:id', authMiddleware, requireRole('merchant', 'admin'), async (req, res) => {
  const db = getDb();
  const { sku, barcode, name, category, costPrice, sellPrice, threshold } = req.body;
  const product = await db.get('SELECT * FROM products WHERE id = ? AND shop_id = ?', req.params.id, req.user.shopId);
  if (!product) return res.status(404).json({ error: '商品不存在' });
  await db.run(`
    UPDATE products SET sku = ?, barcode = ?, name = ?, category = ?, cost_price = ?, sell_price = ?, threshold = ?, last_write_at = datetime('now', 'localtime')
    WHERE id = ? AND shop_id = ?
  `, sku, barcode, name, category, costPrice, sellPrice || FIXED_SELL_PRICE, threshold, req.params.id, req.user.shopId);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_update', product.id, name, `更新商品: ${name}`);
  res.json({ success: true });
});
// --- 删除商品 ---
app.delete('/api/products/:id', authMiddleware, requireRole('merchant', 'admin'), async (req, res) => {
  const db = getDb();
  const product = await db.get('SELECT * FROM products WHERE id = ? AND shop_id = ?', req.params.id, req.user.shopId);
  if (!product) return res.status(404).json({ error: '商品不存在' });
  // 一物一码：已入库的商品不能删除
  if (req.user.role === 'merchant') {
    const inStock = await db.get('SELECT COUNT(*) c FROM product_items WHERE barcode = ? AND merchant_shop_id = ? AND status = ?',
      [product.barcode, req.user.shopId, 'merchant_stock']);
    if (inStock.c > 0) {
      return res.status(400).json({ error: `该商品已有 ${inStock.c} 件入库，不能删除` });
    }
  }
  await db.run('DELETE FROM products WHERE id = ? AND shop_id = ?', req.params.id, req.user.shopId);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_delete', product.id, product.name, `删除商品: ${product.name}`);
  res.json({ success: true });
});
// --- 批量导入商品 ---
app.post('/api/products/batch', authMiddleware, requireRole('merchant', 'admin'), async (req, res) => {
  const db = getDb();
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: '请提供商品数组' });
  }
  let success = 0, failed = 0;
  const errors = [];
  try {
    await db.run('BEGIN');
    for (const p of products) {
      if (!p.name || !p.barcode) { failed++; errors.push(`跳过: 缺少名称或条码 - ${JSON.stringify(p)}`); continue; }
      const result = await db.run(`
        INSERT OR IGNORE INTO products (shop_id, sku, barcode, name, category, cost_price, sell_price, stock, threshold, last_write_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `, req.user.shopId, p.sku || '', p.barcode, p.name, p.category || '未分类', p.costPrice || 0, FIXED_SELL_PRICE, p.stock || 0, p.threshold || 10);
      if (result.changes > 0) success++;
      else { failed++; errors.push(`条码重复: ${p.barcode}`); }
    }
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_import', null, null, `批量导入商品: 成功${success}条, 失败${failed}条`);
  res.json({ success, failed, errors, total: products.length });
});
// --- 扫码入库（合作商家，自动核对品牌方发货单） ---
app.post('/api/transactions/inbound', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const { barcode, quantity, unitPrice, clientTimestamp, clientRecordId } = req.body;
  try {
    await db.run('BEGIN');
    // 防重复：检查 clientRecordId
    if (clientRecordId) {
      const existing = await db.get('SELECT id FROM transactions WHERE client_record_id = ?', clientRecordId);
      if (existing) {
        await db.run('COMMIT');
        return res.json({ success: true, duplicate: true, message: '该记录已同步，跳过' });
      }
    }
    const qty = parseInt(quantity) || 1;

    // ===== 核对品牌方发货单 =====
    // 未发货(已 shipped 未收完)的发货单中查找该条码（直接按商铺匹配，不限制 brand_shop_id）
    const shipmentItem = await db.get(`
      SELECT si.*, s.id as shipment_id, s.status as shipment_status
      FROM shipment_items si
      JOIN shipments s ON s.id = si.shipment_id
      WHERE s.merchant_shop_id = ? AND s.status = 'shipped'
        AND si.barcode = ? AND si.received_qty < si.quantity
      ORDER BY s.id ASC LIMIT 1
    `, [req.user.shopId, barcode]);

    if (!shipmentItem) {
      await db.run('ROLLBACK');
      return res.status(400).json({
        success: false, verified: false,
        error: '该条码不在品牌方发货清单中，请核对（×）',
        code: 'SHIPMENT_MISMATCH'
      });
    }

    // ===== 一物一码：核对商品实例状态 =====
    const productItem = await db.get('SELECT * FROM product_items WHERE barcode = ?', barcode);
    if (!productItem) {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, verified: false, error: '该条码无商品实例记录', code: 'ITEM_NOT_FOUND' });
    }
    if (productItem.status !== 'in_transit') {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, verified: false, error: `该条码状态异常（${productItem.status}），无法入库`, code: 'ITEM_STATUS' });
    }
    if (productItem.merchant_shop_id !== req.user.shopId) {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, verified: false, error: '该条码不属于本商铺', code: 'ITEM_OWNER' });
    }

    // 商品：若不存在则按发货单信息自动建档（标价固定 188）
    let product = await db.get('SELECT * FROM products WHERE shop_id = ? AND barcode = ?', req.user.shopId, barcode);
    if (!product) {
      await db.run(`INSERT INTO products (shop_id, sku, barcode, name, category, cost_price, sell_price, stock, threshold, last_write_at)
        VALUES (?, ?, ?, ?, '待分类', 0, ?, 0, 10, datetime('now','localtime'))`,
        req.user.shopId, '', barcode, shipmentItem.product_name || barcode, FIXED_SELL_PRICE);
      product = await db.get('SELECT * FROM products WHERE shop_id = ? AND barcode = ?', req.user.shopId, barcode);
    }
    const price = product.sell_price || FIXED_SELL_PRICE; // 售价读商品档案（缺省 188）
    const finance = await calculateFinance(req.user.shopId, qty, price, 'inbound');
    await db.run('UPDATE products SET stock = stock + ?, last_write_at = ? WHERE id = ?',
      qty, clientTimestamp || new Date().toISOString(), product.id);
    // 更新商品实例状态：在途→商铺库存
    await db.run(`UPDATE product_items SET status='merchant_stock', received_at=datetime('now','localtime') WHERE id=?`, [productItem.id]);
    // 记录发货单收货进度
    await db.run('UPDATE shipment_items SET received_qty = received_qty + ? WHERE id = ?',
      qty, shipmentItem.id);
    await db.run(`
      INSERT INTO transactions (shop_id, product_id, product_name, type, quantity, unit_price,
        amount_before_gst, gst_amount, total_amount, platform_share, merchant_share, commission_gst,
        operator_id, operator_name, client_timestamp, client_record_id, sync_status, shipment_id, verified)
      VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 'synced', ?, 1)
    `, req.user.shopId, product.id, product.name, qty, price,
      finance.amountBeforeGST, finance.gstAmount, finance.totalAmount,
      req.user.userId, req.user.username, clientTimestamp || new Date().toISOString(), clientRecordId || null,
      shipmentItem.shipment_id);
    // 若该发货单全部收齐 → 完成
    const remaining = await db.get('SELECT COUNT(*) as cnt FROM shipment_items WHERE shipment_id = ? AND received_qty < quantity', shipmentItem.shipment_id);
    if (remaining.cnt === 0) {
      await db.run(`UPDATE shipments SET status='received' WHERE id = ?`, shipmentItem.shipment_id);
    }
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'inbound', product.id, product.name,
      `入库: ${product.name}, 数量: ${qty}, 单价: ${price}, 金额: ${finance.totalAmount}（发货单#${shipmentItem.shipment_id} 核对通过√）`);
    const updatedProduct = await db.get('SELECT * FROM products WHERE id = ?', product.id);
    await db.run('COMMIT');
    res.json({ success: true, verified: true, product: updatedProduct, finance, shipmentId: shipmentItem.shipment_id });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});
// --- 扫码出库（合作商家销售，支持活动折扣） ---
app.post('/api/transactions/outbound', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const { barcode, quantity, unitPrice, clientTimestamp, clientRecordId, discountType, discountMedicalImg, discountSocialImg } = req.body;
  try {
    await db.run('BEGIN');
    if (clientRecordId) {
      const existing = await db.get('SELECT id FROM transactions WHERE client_record_id = ?', clientRecordId);
      if (existing) {
        await db.run('COMMIT');
        return res.json({ success: true, duplicate: true, message: '该记录已同步，跳过' });
      }
    }
    const product = await db.get('SELECT * FROM products WHERE shop_id = ? AND barcode = ?', req.user.shopId, barcode);
    if (!product) {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: '商品不存在' });
    }
    const qty = parseInt(quantity) || 1;
    if (product.stock < qty) {
      await db.run('ROLLBACK');
      return res.status(400).json({ error: `库存不足！当前库存: ${product.stock}, 需要: ${qty}` });
    }
    const price = product.sell_price || FIXED_SELL_PRICE; // 售价读商品档案（缺省 188）
    // 折扣：仅出库销售可享；入库不涉及
    const dtype = DISCOUNT_MAP[discountType] !== undefined ? discountType : 'none';
    const finance = await calculateFinanceWithDiscount(req.user.shopId, qty, price, dtype, product.cost_price);
    const medicalImg = await ensureImageUrl(discountMedicalImg);
    const socialImg = await ensureImageUrl(discountSocialImg);
    // 折扣需上传对应凭证：选了哪项折扣就必须有对应图片
    if ((dtype === 'medical' || dtype === 'both') && !medicalImg) {
      await db.run('ROLLBACK');
      return res.status(400).json({ error: '选择了中医馆消费折扣，请上传消费凭证图片' });
    }
    if ((dtype === 'social' || dtype === 'both') && !socialImg) {
      await db.run('ROLLBACK');
      return res.status(400).json({ error: '选择了社媒分享折扣，请上传分享截图' });
    }
    await db.run('UPDATE products SET stock = stock - ?, last_write_at = ? WHERE id = ?',
      qty, clientTimestamp || new Date().toISOString(), product.id);
    // ===== 一物一码：标记具体商品实例为已售 =====
    const itemsToSell = await db.all(`SELECT id FROM product_items WHERE barcode = ? AND merchant_shop_id = ? AND status = 'merchant_stock' ORDER BY id LIMIT ?`,
      [barcode, req.user.shopId, qty]);
    for (const it of itemsToSell) {
      await db.run(`UPDATE product_items SET status='sold', sold_at=datetime('now','localtime') WHERE id=?`, [it.id]);
    }
    const discountStatus = finance.discount > 0 ? 'pending' : 'none';
    await db.run(`
      INSERT INTO transactions (shop_id, product_id, product_name, type, quantity, unit_price,
        amount_before_gst, gst_amount, total_amount, platform_share, brand_share, merchant_share, commission_gst,
        operator_id, operator_name, client_timestamp, client_record_id, sync_status,
        discount_type, discount_amount, discount_medical_img, discount_social_img, discount_status, discounted_price)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?, ?)
    `, req.user.shopId, product.id, product.name, qty, price,
      finance.amountBeforeGST, finance.gstAmount, finance.totalAmount,
      finance.brandShare, finance.merchantShare,
      req.user.userId, req.user.username, clientTimestamp || new Date().toISOString(), clientRecordId || null,
      dtype, finance.discount, medicalImg, socialImg, discountStatus, finance.discountedPrice);
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'outbound', product.id, product.name,
      `出库: ${product.name}, 数量: ${qty}, 标价: ${price}, 折扣: ${finance.discount > 0 ? '-' + finance.discount + ' SGD(' + dtype + ')' : '无'}, 折后价: ${finance.discountedPrice}, 含税总额: ${finance.totalAmount}, GST: ${finance.gstAmount}`);
    const updatedProduct = await db.get('SELECT * FROM products WHERE id = ?', product.id);
    await db.run('COMMIT');
    res.json({ success: true, product: updatedProduct, finance: { ...finance, gstRate: (await db.get('SELECT gst_rate FROM shops WHERE id=?', req.user.shopId)).gst_rate }, lowStockWarning: updatedProduct.stock <= updatedProduct.threshold });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});
// --- 离线批量同步 ---
app.post('/api/transactions/batch-sync', authMiddleware, async (req, res) => {
  const db = getDb();
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: '记录格式错误' });
  let synced = 0, duplicates = 0, failed = 0;
  const results = [];
  for (const record of records) {
    try {
      await db.run('BEGIN');
      if (record.clientRecordId) {
        const existing = await db.get('SELECT id FROM transactions WHERE client_record_id = ?', record.clientRecordId);
        if (existing) {
          duplicates++;
          results.push({ clientRecordId: record.clientRecordId, status: 'duplicate' });
          await db.run('COMMIT');
          continue;
        }
      }
      const product = await db.get('SELECT * FROM products WHERE shop_id = ? AND barcode = ?', req.user.shopId, record.barcode);
      if (!product) {
        failed++;
        results.push({ clientRecordId: record.clientRecordId, status: 'failed', error: '商品不存在' });
        await db.run('COMMIT');
        continue;
      }
      const qty = parseInt(record.quantity) || 1;
      const price = record.unitPrice !== undefined ? record.unitPrice : (record.type === 'inbound' ? product.cost_price : product.sell_price);
      if (record.type === 'sale' && product.stock < qty) {
        failed++;
        results.push({ clientRecordId: record.clientRecordId, status: 'failed', error: `库存不足: ${product.name}` });
        await db.run('COMMIT');
        continue;
      }
      // 折扣（仅出库销售）——离线记录可能带 base64 图片，先转 URL
      let dtype = 'none';
      if (record.type === 'sale' && DISCOUNT_MAP[record.discountType] !== undefined) dtype = record.discountType;
      let medicalImg = null, socialImg = null;
      if (record.type === 'sale' && dtype !== 'none') {
        medicalImg = await ensureImageUrl(record.discountMedicalImg);
        socialImg = await ensureImageUrl(record.discountSocialImg);
        if ((dtype === 'medical' || dtype === 'both') && !medicalImg) {
          failed++;
          results.push({ clientRecordId: record.clientRecordId, status: 'failed', error: '缺少中医馆消费凭证图片' });
          await db.run('COMMIT');
          continue;
        }
        if ((dtype === 'social' || dtype === 'both') && !socialImg) {
          failed++;
          results.push({ clientRecordId: record.clientRecordId, status: 'failed', error: '缺少社媒分享截图' });
          await db.run('COMMIT');
          continue;
        }
      }
      const finance = dtype !== 'none'
        ? await calculateFinanceWithDiscount(req.user.shopId, qty, price, dtype)
        : await calculateFinance(req.user.shopId, qty, price, record.type);
      // 出库销售算品牌/商家分成（7:3，按毛利=（售价−成本20）×数量；折扣从品牌七成扣）
      let brandShare = 0, merchantShare = 0;
      if (record.type === 'sale') {
        if (dtype !== 'none') {
          brandShare = finance.brandShare; merchantShare = finance.merchantShare;
        } else {
          const profitBase = Math.max(0, price - PRODUCT_COST) * qty;
          brandShare = +(0.7 * profitBase).toFixed(2);
          merchantShare = +(0.3 * profitBase).toFixed(2);
        }
      }
      if (record.type === 'inbound') {
        await db.run('UPDATE products SET stock = stock + ?, last_write_at = ? WHERE id = ?',
          qty, record.clientTimestamp || new Date().toISOString(), product.id);
      } else {
        await db.run('UPDATE products SET stock = stock - ?, last_write_at = ? WHERE id = ?',
          qty, record.clientTimestamp || new Date().toISOString(), product.id);
      }
      await db.run(`
        INSERT INTO transactions (shop_id, product_id, product_name, type, quantity, unit_price,
          amount_before_gst, gst_amount, total_amount, platform_share, brand_share, merchant_share, commission_gst,
          operator_id, operator_name, client_timestamp, client_record_id, sync_status,
          discount_type, discount_amount, discount_medical_img, discount_social_img, discount_status, discounted_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?, ?)
      `, req.user.shopId, product.id, product.name, record.type, qty, price,
        finance.amountBeforeGST, finance.gstAmount, finance.totalAmount,
        brandShare, merchantShare,
        req.user.userId, req.user.username, record.clientTimestamp || new Date().toISOString(), record.clientRecordId || null,
        dtype, finance.discount, medicalImg, socialImg, finance.discount > 0 ? 'pending' : 'none', finance.discountedPrice || null);
      await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, record.type, product.id, product.name,
        `[离线同步] ${record.type === 'inbound' ? '入库' : '出库'}: ${product.name}, 数量: ${qty}`);
      await db.run('COMMIT');
      synced++;
      results.push({ clientRecordId: record.clientRecordId, status: 'synced' });
    } catch (e) {
      await db.run('ROLLBACK');
      failed++;
      results.push({ clientRecordId: record.clientRecordId, status: 'failed', error: e.message });
    }
  }
  res.json({ synced, duplicates, failed, total: records.length, results });
});
// --- 交易记录列表（品牌方可传 merchantId）---
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const db = getDb();
  const { type, startDate, endDate, limit = 200, merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  let sql = 'SELECT * FROM transactions WHERE shop_id = ?';
  const params = [shopId];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (startDate) { sql += ' AND date(server_timestamp) >= date(?)'; params.push(startDate); }
  if (endDate) { sql += ' AND date(server_timestamp) <= date(?)'; params.push(endDate); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(parseInt(limit));
  const transactions = await db.all(sql, ...params);
  res.json(transactions);
});
// --- 操作日志（品牌方可传 merchantId）---
app.get('/api/logs', authMiddleware, requireRole('merchant', 'brand'), async (req, res) => {
  const db = getDb();
  const { limit = 200, action, merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  let sql = 'SELECT * FROM audit_logs WHERE shop_id = ?';
  const params = [shopId];
  if (action) { sql += ' AND action = ?'; params.push(action); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(parseInt(limit));
  const logs = await db.all(sql, ...params);
  res.json(logs);
});
// --- 验证日志完整性 ---
app.get('/api/logs/verify', authMiddleware, requireRole('merchant', 'brand'), async (req, res) => {
  const db = getDb();
  const { merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  const result = await verifyAuditChain(shopId);
  res.json(result);
});
// --- 仪表盘统计（品牌方可传 merchantId 查看指定商家）---
app.get('/api/stats/dashboard', authMiddleware, async (req, res) => {
  const db = getDb();
  const { merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  const today = new Date().toISOString().split('T')[0];
  const totalProductsRow = await db.get('SELECT COUNT(*) as cnt FROM products WHERE shop_id = ?', shopId);
  const totalProducts = totalProductsRow.cnt;
  const lowStockRow = await db.get('SELECT COUNT(*) as cnt FROM products WHERE shop_id = ? AND stock <= threshold', shopId);
  const lowStockCount = lowStockRow.cnt;
  const stockValRow = await db.get('SELECT SUM(stock * cost_price) as val FROM products WHERE shop_id = ?', shopId);
  const totalStockValue = stockValRow.val || 0;
  const todayInbound = await db.get("SELECT COALESCE(SUM(quantity), 0) as qty, COALESCE(SUM(total_amount), 0) as amt FROM transactions WHERE shop_id = ? AND type = 'inbound' AND date(server_timestamp) = date(?)", shopId, today);
  const todayOutbound = await db.get("SELECT COALESCE(SUM(quantity), 0) as qty, COALESCE(SUM(total_amount), 0) as amt, COALESCE(SUM(gst_amount), 0) as gst FROM transactions WHERE shop_id = ? AND type='sale' AND date(server_timestamp) = date(?)", shopId, today);
  const weekly = await db.all(`
    SELECT date(server_timestamp) as date, 
           COALESCE(SUM(CASE WHEN type='sale' THEN total_amount ELSE 0 END), 0) as sales,
           COALESCE(SUM(CASE WHEN type='sale' THEN quantity ELSE 0 END), 0) as qty
    FROM transactions 
    WHERE shop_id = ? AND date(server_timestamp) >= date('now', '-6 days', 'localtime')
    GROUP BY date(server_timestamp) ORDER BY date ASC
  `, shopId);
  res.json({
    totalProducts, lowStockCount, totalStockValue,
    todayInbound, todayOutbound, weekly
  });
});
// --- 员工管理 ---
app.get('/api/staff', authMiddleware, requireRole('merchant', 'brand'), async (req, res) => {
  const db = getDb();
  const { merchantId } = req.query;
  const shopId = await resolveShopScope(req, merchantId);
  if (shopId === null) return res.status(400).json({ error: '请指定要查看的合作商家' });
  const staff = await db.all('SELECT id, username, role, created_at FROM users WHERE shop_id = ? ORDER BY id ASC', shopId);
  res.json(staff);
});
app.put('/api/staff/:id/role', authMiddleware, requireRole('merchant', 'admin'), async (req, res) => {
  const db = getDb();
  const { role } = req.body;
  if (!['merchant', 'staff'].includes(role)) return res.status(400).json({ error: '角色只能是 merchant 或 staff' });
  await db.run('UPDATE users SET role = ? WHERE id = ? AND shop_id = ?', role, req.params.id, req.user.shopId);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'staff_role_change', null, null, `修改员工角色: ID=${req.params.id}, 新角色=${role}`);
  res.json({ success: true });
});
// --- 生成新开户密钥（管理员用）---
app.post('/api/admin/new-card-key', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { shopName } = req.body;
  const cardKey = generateCardKey();
  await db.run('INSERT INTO shops (card_key, shop_name) VALUES (?, ?)', cardKey, shopName || '新店铺');
  res.json({ cardKey, shopName: shopName || '新店铺' });
});
// ========== 品牌方/管理端：合作商家总览 ==========
app.get('/api/brand/merchants', authMiddleware, requireRole('brand', 'admin'), async (req, res) => {
  const db = getDb();
  let scopeBrandId = req.user.shopId;
  if (req.user.role === 'admin') {
    scopeBrandId = parseInt(req.query.brandId) || 0;
    if (!scopeBrandId) return res.status(400).json({ error: '请指定品牌方' });
    const brand = await db.get('SELECT id FROM shops WHERE id = ? AND type = ?', scopeBrandId, 'brand');
    if (!brand) return res.status(403).json({ error: '品牌方不存在' });
  } else {
    // 普通代理：看同品牌（自己的 parent_id）下的所有商家
    const perms = req.user.permissions || [];
    if (!perms.includes('brand_super')) {
      const me = await db.get('SELECT parent_id FROM shops WHERE id = ?', req.user.shopId);
      if (me && me.parent_id) scopeBrandId = me.parent_id;
    }
  }
  const merchants = await db.all(`
    SELECT s.id, s.shop_name, s.card_key, s.gst_rate, s.created_at,
      (SELECT username FROM users WHERE shop_id = s.id ORDER BY id ASC LIMIT 1) AS account,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS product_count,
      (SELECT COALESCE(SUM(p.stock), 0) FROM products p WHERE p.shop_id = s.id) AS total_stock,
      (SELECT COALESCE(SUM(p.stock * p.cost_price), 0) FROM products p WHERE p.shop_id = s.id) AS stock_value,
      (SELECT COALESCE(SUM(t.total_amount), 0) FROM transactions t WHERE t.shop_id = s.id AND t.type='sale' AND date(t.server_timestamp)=date('now','localtime')) AS today_sales,
      (SELECT COUNT(*) FROM transactions t WHERE t.shop_id = s.id AND t.type='sale' AND date(t.server_timestamp)=date('now','localtime')) AS today_count,
      (SELECT COUNT(*) FROM shipments sh WHERE sh.merchant_shop_id = s.id AND sh.status = 'shipped') AS pending_shipments
    FROM shops s
    WHERE s.type='merchant' AND s.parent_id = ?
    ORDER BY s.id ASC
  `, scopeBrandId);
  // 普通代理看不到商铺密码
  if (req.user.role === 'brand') {
    const perms = req.user.permissions || [];
    if (!perms.includes('brand_super')) {
      merchants.forEach(m => { m.card_key = null; });
    }
  }
  res.json(merchants);
});
// 品牌方/管理端：商家详情统计
app.get('/api/brand/merchants/:id/stats', authMiddleware, requireRole('brand', 'admin'), async (req, res) => {
  const db = getDb();
  let m;
  if (req.user.role === 'admin') {
    m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ?', req.params.id, 'merchant');
  } else {
    const perms = req.user.permissions || [];
    if (perms.includes('brand_super')) {
      m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', req.params.id, 'merchant', req.user.shopId);
    } else {
      // 普通代理：同品牌下的商家
      const me = await db.get('SELECT parent_id FROM shops WHERE id = ?', req.user.shopId);
      const brandId = me && me.parent_id ? me.parent_id : req.user.shopId;
      m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', req.params.id, 'merchant', brandId);
    }
  }
  if (!m) return res.status(403).json({ error: '无权访问该商家' });
  // 普通代理看不到商铺密码
  let cardKey = m.card_key;
  if (req.user.role === 'brand') {
    const perms = req.user.permissions || [];
    if (!perms.includes('brand_super')) cardKey = null;
  }
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    merchant: { id: m.id, name: m.shop_name, cardKey: cardKey, account: (await db.get('SELECT username FROM users WHERE shop_id = ? ORDER BY id ASC LIMIT 1', m.id))?.username || null, gstRate: m.gst_rate, createdAt: m.created_at },
    totalProducts: (await db.get('SELECT COUNT(*) as c FROM products WHERE shop_id = ?', m.id)).c,
    totalStock: (await db.get('SELECT COALESCE(SUM(stock),0) as c FROM products WHERE shop_id = ?', m.id)).c,
    stockValue: (await db.get('SELECT COALESCE(SUM(stock*cost_price),0) as c FROM products WHERE shop_id = ?', m.id)).c,
    todayInbound: await db.get("SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total_amount),0) amt FROM transactions WHERE shop_id=? AND type='inbound' AND date(server_timestamp)=date(?)", m.id, today),
    todayOutbound: await db.get("SELECT COALESCE(SUM(quantity),0) qty, COALESCE(SUM(total_amount),0) amt, COALESCE(SUM(gst_amount),0) gst FROM transactions WHERE shop_id=? AND type='sale' AND date(server_timestamp)=date(?)", m.id, today),
    // 累计品牌/商家分成（出库销售，含折扣后调整）
    totalBrandShare: (await db.get("SELECT COALESCE(SUM(brand_share),0) c FROM transactions WHERE shop_id=? AND type='sale'", m.id)).c,
    totalMerchantShare: (await db.get("SELECT COALESCE(SUM(merchant_share),0) c FROM transactions WHERE shop_id=? AND type='sale'", m.id)).c
  };
  res.json(stats);
});
// ========== 品牌方：折扣审核（消费凭证 / 社媒分享截图） ==========
// 待审核列表：品牌方=自己名下商家；管理端=全部（可按 brandId 筛选）
app.get('/api/discounts/pending', authMiddleware, requireRole('brand', 'admin'), async (req, res) => {
  const db = getDb();
  const { brandId } = req.query;
  let params = [];
  let sql = `
    SELECT t.*, s.shop_name AS merchant_name, b.shop_name AS brand_name, s.parent_id AS brand_id
    FROM transactions t
    JOIN shops s ON s.id = t.shop_id
    LEFT JOIN shops b ON b.id = s.parent_id
    WHERE t.discount_status = 'pending' AND t.type='sale'`;
  if (req.user.role === 'brand') {
    sql += ` AND s.parent_id = ?`;
    params.push(req.user.shopId);
  } else if (brandId) {
    sql += ` AND s.parent_id = ?`;
    params.push(parseInt(brandId));
  }
  sql += ` ORDER BY t.id DESC`;
  const list = await db.all(sql, ...params);
  res.json(list);
});

// 通过 / 驳回折扣
app.post('/api/discounts/:id/review', authMiddleware, requireRole('brand', 'admin'), async (req, res) => {
  const db = getDb();
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '操作只能是 approve 或 reject' });
  const t = await db.get(`
    SELECT t.*, s.shop_name AS merchant_name, s.parent_id AS brand_id
    FROM transactions t JOIN shops s ON s.id = t.shop_id
    WHERE t.id = ? AND t.discount_status = 'pending'`, req.params.id);
  if (!t) return res.status(404).json({ error: '该折扣单不存在或已审核' });
  if (req.user.role === 'brand' && t.brand_id !== req.user.shopId) {
    return res.status(403).json({ error: '无权审核该折扣单' });
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  let extra = {};
  if (action === 'reject' && Number(t.discount_amount) > 0) {
    // 驳回：折扣从商家三成扣还给品牌（品牌拿回满 7 成，商家承担 D）
    const rs = rejectedShares(t.quantity, t.unit_price, t.discount_amount, t.product_id ? (await db.get('SELECT cost_price FROM products WHERE id = ?', t.product_id))?.cost_price : null);
    await db.run(`UPDATE transactions SET brand_share = ?, merchant_share = ? WHERE id = ?`,
      rs.brandShare, rs.merchantShare, t.id);
    extra = { brandShare: rs.brandShare, merchantShare: rs.merchantShare };
  }
  await db.run(`UPDATE transactions SET discount_status = ?, discount_reviewed_by = ?, discount_reviewed_at = datetime('now','localtime') WHERE id = ?`,
    status, req.user.username, t.id);
  await appendAuditLog(t.shop_id, req.user.userId, req.user.username, 'discount_review', t.id, t.product_name,
    `${action === 'approve' ? '通过' : '驳回'}折扣单#${t.id}: ${t.product_name} × ${t.quantity}, 折扣 ${t.discount_amount} SGD (${t.merchant_name})${action === 'reject' ? `, 商家承担折扣, 品牌分成 ${extra.brandShare}, 商家分成 ${extra.merchantShare}` : ''}`);
  res.json({ success: true, status, ...extra });
});

// ========== 进货单（合作商家向品牌进货，进货价 20 SGD/个，上传付款截图） ==========
const RESTOCK_COST = 20;

// 商家提交进货申请
app.post('/api/purchase-orders', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const { productId, catalogId, quantity, paymentImg } = req.body;
  const qty = parseInt(quantity) || 0;
  if (qty <= 0 || qty > 9999) return res.status(400).json({ error: '进货数量无效' });
  if (!paymentImg) return res.status(400).json({ error: '请上传付款截图凭证' });
  let product = null;
  let catalog = null;
  if (catalogId) {
    // 从商品库取商品模板
    catalog = await db.get('SELECT * FROM product_catalog WHERE id = ? AND status = ?', catalogId, 'active');
    if (!catalog) return res.status(404).json({ error: '商品不存在或未授权' });
    // 检查商家的总代是否被授权该商品
    const shop = await db.get('SELECT parent_id FROM shops WHERE id = ?', req.user.shopId);
    const auth = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalogId, shop?.parent_id);
    if (!auth) return res.status(403).json({ error: '该商品未授权给您的总代' });
  } else {
    product = productId ? await db.get('SELECT * FROM products WHERE id = ? AND shop_id = ?', productId, req.user.shopId) : null;
    if (!product) return res.status(404).json({ error: '商品不存在' });
  }
  const imgUrl = await ensureImageUrl(paymentImg);
  if (!imgUrl) return res.status(400).json({ error: '付款截图格式不正确' });
  const total = +(qty * RESTOCK_COST).toFixed(2);
  const prodName = catalog ? catalog.name : product.name;
  const prodBarcode = catalog ? catalog.barcode : product.barcode;
  const r = await db.run(`
    INSERT INTO purchase_orders (shop_id, product_id, product_name, barcode, quantity, unit_cost, total_cost, payment_img, status, catalog_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    req.user.shopId, product ? product.id : null, prodName, prodBarcode, qty, RESTOCK_COST, total, imgUrl, catalog ? catalog.id : null);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'purchase_request', product ? product.id : catalog.id, prodName,
    `进货申请: ${prodName} × ${qty}, 进货价 ${RESTOCK_COST} SGD/个, 合计 ${total} SGD${catalog ? ' (商品库)' : ''}`);
  res.json({ success: true, id: r.lastInsertRowid, totalCost: total });
});

// 商家查看自己的进货单；品牌方查看自己名下商家的进货单
app.get('/api/purchase-orders', authMiddleware, requireRole('merchant', 'staff', 'brand', 'admin'), async (req, res) => {
  const db = getDb();
  let sql = `
    SELECT po.*, s.shop_name AS merchant_name, b.shop_name AS brand_name
    FROM purchase_orders po
    JOIN shops s ON s.id = po.shop_id
    LEFT JOIN shops b ON b.id = s.parent_id`;
  const params = [];
  const wheres = [];
  if (req.user.role === 'merchant' || req.user.role === 'staff') {
    wheres.push('po.shop_id = ?'); params.push(req.user.shopId);
  } else if (req.user.role === 'brand') {
    wheres.push('s.parent_id = ?'); params.push(req.user.shopId);
  } else if (req.query.brandId) {
    wheres.push('s.parent_id = ?'); params.push(parseInt(req.query.brandId));
  }
  if (req.query.status) { wheres.push('po.status = ?'); params.push(req.query.status); }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY po.id DESC';
  const list = await db.all(sql, ...params);
  res.json(list);
});

// 品牌方审核进货单（检查付款截图）
app.post('/api/purchase-orders/:id/review', authMiddleware, requireRole('brand', 'admin'), async (req, res) => {
  const db = getDb();
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: '操作只能是 approve 或 reject' });
  const po = await db.get(`
    SELECT po.*, s.parent_id AS brand_id, s.shop_name AS merchant_name
    FROM purchase_orders po JOIN shops s ON s.id = po.shop_id
    WHERE po.id = ? AND po.status = 'pending'`, req.params.id);
  if (!po) return res.status(404).json({ error: '该进货单不存在或已审核' });
  if (req.user.role === 'brand' && po.brand_id !== req.user.shopId) {
    return res.status(403).json({ error: '无权审核该进货单' });
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  await db.run(`UPDATE purchase_orders SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?`,
    status, req.user.username, po.id);
  await appendAuditLog(po.shop_id, req.user.userId, req.user.username, 'purchase_review', po.product_id, po.product_name,
    `${action === 'approve' ? '通过' : '驳回'}进货单#${po.id}: ${po.product_name} × ${po.quantity}, 合计 ${po.total_cost} SGD (${po.merchant_name})`);
  res.json({ success: true, status });
});

// 总代分配进货单给普通代理（同时创建发货单，一个款一个发货单）
app.post('/api/purchase-orders/:id/assign', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: '请选择要分配的代理' });
  // 检查当前用户是否是总代
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.status(403).json({ error: '只有总代可以分配进货单' });
  const po = await db.get(`
    SELECT po.*, s.parent_id AS brand_id, s.shop_name AS merchant_name
    FROM purchase_orders po JOIN shops s ON s.id = po.shop_id
    WHERE po.id = ? AND po.status = 'approved'`, req.params.id);
  if (!po) return res.status(404).json({ error: '该进货单不存在或未审核通过' });
  if (po.brand_id !== req.user.shopId) return res.status(403).json({ error: '无权分配该进货单' });
  // 检查目标代理是否是同品牌下的普通代理
  const agent = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', agentId, 'brand', req.user.shopId);
  if (!agent) return res.status(400).json({ error: '目标代理无效' });
  await db.run('BEGIN');
  try {
    // 创建发货单（一个款一个发货单）
    const r = await db.run(`INSERT INTO shipments (brand_shop_id, merchant_shop_id, status, remark, purchase_order_id, product_name, assigned_by)
      VALUES (?, ?, 'assigned', ?, ?, ?, ?)`,
      agent.id, po.shop_id, `进货单#${po.id}`, po.id, po.product_name, req.user.shopId);
    const shipmentId = r.lastInsertRowid;
    // 添加发货单项（按数量，一物一码，条码待扫码时填入）
    for (let i = 0; i < po.quantity; i++) {
      await db.run(`INSERT INTO shipment_items (shipment_id, barcode, product_name, quantity, scanned_count)
        VALUES (?, ?, ?, 1, 0)`, shipmentId, 'PENDING_' + (i + 1), po.product_name);
    }
    // 更新进货单状态
    await db.run(`UPDATE purchase_orders SET status = 'assigned', assigned_to = ?, assigned_by = ?, assigned_at = datetime('now','localtime') WHERE id = ?`,
      agent.id, req.user.shopId, po.id);
    await db.run('COMMIT');
    await appendAuditLog(po.shop_id, req.user.userId, req.user.username, 'purchase_assign', po.id, po.product_name,
      `分配进货单#${po.id}: ${po.product_name} × ${po.quantity} → 代理 ${agent.shop_name}, 发货单#${shipmentId}`);
    res.json({ success: true, shipmentId });
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
});

// 普通代理查看同品牌下的其他代理列表（用于分配选择）
app.get('/api/brand/agents', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const rows = await db.all(`SELECT id, shop_name, country FROM shops WHERE type = 'brand' AND parent_id = ? AND id != ? ORDER BY id`,
    req.user.shopId, req.user.shopId);
  res.json(rows);
});

// 总代注册普通代理（地区跟随总代）
app.post('/api/brand/register-agent', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.status(403).json({ error: '只有总代可以注册代理' });
  const { shopName, cardKey } = req.body;
  if (!shopName || !shopName.trim()) return res.status(400).json({ error: '请输入代理名称' });
  const dupErr = await checkDuplicateShopName(db, shopName, 'brand');
  if (dupErr) return res.status(400).json({ error: dupErr });
  const mk = await makeCardKey(db, cardKey);
  if (mk.error) return res.status(400).json({ error: mk.error });
  const brand = await db.get('SELECT country, gst_rate FROM shops WHERE id = ?', [req.user.shopId]);
  const c = brand?.country || 'SG';
  const gstRate = brand?.gst_rate || 0.09;
  const r = await db.run(`INSERT INTO shops (card_key, shop_name, type, parent_id, country, gst_rate) VALUES (?, ?, 'brand', ?, ?, ?)`,
    [mk.key, shopName.trim(), req.user.shopId, c, gstRate]);
  const newId = r.lastInsertRowid;
  // 创建普通代理用户记录（无 brand_super 权限），初始密码 = 开户密钥（bcrypt 哈希）
  const newUserHash = await bcrypt.hash(mk.key, 10);
  await db.run(`INSERT INTO users (shop_id, username, role, permissions, password_hash) VALUES (?, ?, 'brand', '[]', ?)`,
    [newId, shopName.trim(), newUserHash]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'register_agent', newId, shopName.trim(),
    `总代开通普通代理: ${shopName.trim()}, 地区: ${COUNTRY_LABELS[c]}, 初始密码: ${mk.key}`);
  res.json({ success: true, id: newId, cardKey: mk.key, shopName: shopName.trim(), country: c });
});

// 管理端：总代详情（代理列表、商家列表、地区销售汇总）
app.get('/api/admin/brands/:id/detail', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const brandId = parseInt(req.params.id);
  const brand = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id IS NULL', brandId, 'brand');
  if (!brand) return res.status(404).json({ error: '总代不存在' });
  // 代理列表（含发货统计）
  const agents = await db.all(`SELECT id, shop_name, card_key, country, created_at FROM shops WHERE type='brand' AND parent_id = ? ORDER BY id`, brandId);
  for (const a of agents) {
    const shipStats = await db.get(`SELECT
        COALESCE(SUM(CASE WHEN status='assigned' THEN 1 ELSE 0 END),0) AS pending_ship,
        COALESCE(SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END),0) AS shipped,
        COALESCE(SUM(CASE WHEN status='received' THEN 1 ELSE 0 END),0) AS received,
        COUNT(*) AS total
      FROM shipments WHERE brand_shop_id = ?`, a.id);
    a.pending_ship = shipStats.pending_ship;
    a.shipped = shipStats.shipped;
    a.received = shipStats.received;
  }
  // 商家列表
  const merchants = await db.all(`SELECT id, shop_name, card_key, country, created_at FROM shops WHERE type='merchant' AND parent_id = ? ORDER BY id`, brandId);
  // 地区销售汇总
  const allShopIds = [brandId, ...agents.map(a => a.id), ...merchants.map(m => m.id)];
  const placeholders = allShopIds.map(() => '?').join(',');
  const sales = await db.get(`SELECT
      COALESCE(SUM(CASE WHEN date(server_timestamp)=date('now','localtime') THEN total_amount ELSE 0 END),0) AS today_sales,
      COALESCE(SUM(CASE WHEN date(server_timestamp)=date('now','localtime') THEN 1 ELSE 0 END),0) AS today_count,
      COALESCE(SUM(total_amount),0) AS total_sales,
      COALESCE(SUM(brand_share),0) AS total_brand_share,
      COALESCE(SUM(merchant_share),0) AS total_merchant_share
    FROM transactions WHERE type='sale' AND shop_id IN (${placeholders})`, allShopIds);
  res.json({ brand, agents, merchants, sales });
});

// 总代下属商铺销量对比（柱状图用，支持时间段、多选商品、自选日期范围）
app.get('/api/admin/brands/:id/merchant-sales', authMiddleware, requireRole('admin', 'brand'), async (req, res) => {
  const db = getDb();
  const brandId = parseInt(req.params.id);
  const period = req.query.period || 'today';
  const startDate = req.query.start_date || '';
  const endDate = req.query.end_date || '';
  const catalogIds = (req.query.catalog_ids || '').split(',').filter(Boolean).map(Number);
  const brand = await db.get('SELECT id, shop_name FROM shops WHERE id = ? AND type = ?', brandId, 'brand');
  if (!brand) return res.status(404).json({ error: '总代不存在' });
  // 权限：超管可看所有；总代只能看自己；普通代理不能看
  if (req.user.role === 'brand') {
    const perms = req.user.permissions || [];
    if (!perms.includes('brand_super')) return res.status(403).json({ error: '无权查看' });
    if (req.user.shopId !== brandId) return res.status(403).json({ error: '无权查看该总代数据' });
  }
  const merchants = await db.all(`SELECT id, shop_name FROM shops WHERE type='merchant' AND parent_id = ? ORDER BY id`, brandId);
  if (merchants.length === 0) return res.json([]);
  const shopIds = merchants.map(m => m.id);
  const placeholders = shopIds.map(() => '?').join(',');
  let dateFilter = '';
  const params = [...shopIds];
  // 自选日期范围优先
  if (startDate && endDate) {
    dateFilter = `AND date(server_timestamp) >= ? AND date(server_timestamp) <= ?`;
    params.push(startDate, endDate);
  } else if (period === 'today') {
    dateFilter = `AND date(server_timestamp)=date('now','localtime')`;
  } else if (period === 'week') {
    dateFilter = `AND server_timestamp >= date('now','localtime','-6 days')`;
  } else if (period === 'month') {
    dateFilter = `AND strftime('%Y-%m', server_timestamp)=strftime('%Y-%m','now','localtime')`;
  } else if (period === 'year') {
    dateFilter = `AND strftime('%Y', server_timestamp)=strftime('%Y','now','localtime')`;
  }
  // 多选商品筛选
  let productFilter = '';
  if (catalogIds.length > 0) {
    // 需要通过product_name关联，因为transactions表存的是product_name不是catalog_id
    const catNames = await db.all(`SELECT name FROM product_catalog WHERE id IN (${catalogIds.map(()=>'?').join(',')})`, catalogIds);
    if (catNames.length > 0) {
      const names = catNames.map(c => c.name);
      productFilter = `AND product_name IN (${names.map(()=>'?').join(',')})`;
      params.push(...names);
    }
  }
  const rows = await db.all(`SELECT shop_id, COUNT(*) AS sales, COALESCE(SUM(total_amount),0) AS revenue, COALESCE(SUM(gst_amount),0) AS gst
    FROM transactions WHERE type='sale' AND shop_id IN (${placeholders}) ${dateFilter} ${productFilter} GROUP BY shop_id`, params);
  const map = {};
  rows.forEach(r => { map[r.shop_id] = r; });
  const result = merchants.map(m => ({
    shopId: m.id,
    shopName: m.shop_name,
    sales: map[m.id]?.sales || 0,
    revenue: Number(map[m.id]?.revenue || 0),
    gst: Number(map[m.id]?.gst || 0)
  }));
  res.json(result);
});

// ========== 管理端：品牌方/商家开户 ==========
// 生成开户密钥（默认随机；可传自定义 cardKey，便于商家记忆）
async function makeCardKey(db, custom) {
  if (custom && custom.trim()) {
    const key = custom.trim();
    const pwErr = validatePasswordStrength(key);
    if (pwErr) return { error: pwErr };
    const dup = await db.get('SELECT id FROM shops WHERE card_key = ?', [key]);
    if (dup) return { error: '该登录凭证已被占用，请换一个' };
    return { key };
  }
  return { key: generateCardKey() };
}

// 检查店铺名称是否重复（同类型内不允许重名）
async function checkDuplicateShopName(db, shopName, type) {
  const dup = await db.get('SELECT id FROM shops WHERE shop_name = ? AND type = ?', [shopName.trim(), type]);
  if (dup) return '该名称已被注册，请换一个';
  return null;
}

// ========== 商品库（超管创建，逐级授权） ==========
// 超管创建商品
app.post('/api/admin/catalog', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '仅超管可上新商品' });
  const { name, costPrice, sellPrice, description, promoImage, sku, category } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入商品名称' });
  const r = await db.run(`INSERT INTO product_catalog (name, sku, category, cost_price, sell_price, description, promo_image, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name.trim(), sku ? String(sku).trim() : null, category ? String(category).trim() : '未分类', costPrice || 0, sellPrice || 0, description || null, promoImage || null, req.user.shopId]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_create', r.lastInsertRowid, name.trim(),
    `商品上新: ${name.trim()}, 成本 ${costPrice || 0}, 售价 ${sellPrice || 0}`);
  res.json({ success: true, id: r.lastInsertRowid });
});

// 超管/普通管理更新商品（宣传图、描述等）
app.put('/api/admin/catalog/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { name, costPrice, sellPrice, description, promoImage, sku, category } = req.body;
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  // 超管可改所有字段，普通管理只能改宣传图和描述
  const isSuper = isSuperAdmin(req);
  const updates = [];
  const params = [];
  if (isSuper && name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (isSuper && sku !== undefined) { updates.push('sku = ?'); params.push(String(sku).trim() || null); }
  if (isSuper && category !== undefined) { updates.push('category = ?'); params.push(String(category).trim() || '未分类'); }
  if (isSuper && costPrice !== undefined) { updates.push('cost_price = ?'); params.push(costPrice); }
  if (isSuper && sellPrice !== undefined) { updates.push('sell_price = ?'); params.push(sellPrice); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (promoImage !== undefined) {
    // 转成上传目录路径（base64 → /uploads/xxx）
    const stored = await ensureImageUrl(promoImage);
    updates.push('promo_image = ?'); params.push(stored);
  }
  if (updates.length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  params.push(req.params.id);
  await db.run(`UPDATE product_catalog SET ${updates.join(', ')} WHERE id = ?`, params);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_update', catalog.id, catalog.name,
    `更新商品: ${catalog.name}`);
  res.json({ success: true });
});

// 总代上传/更新地区宣传内容
app.put('/api/brand/catalog/:id/region-promo', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.status(403).json({ error: '仅总代可上传地区宣传内容' });
  const { content, image } = req.body;
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  const exist = await db.get('SELECT id FROM product_catalog_region WHERE catalog_id = ? AND brand_id = ?', catalog.id, req.user.shopId);
  if (exist) {
    await db.run(`UPDATE product_catalog_region SET content = ?, image = ?, updated_by = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
      [content || null, image || null, req.user.userId, exist.id]);
  } else {
    await db.run(`INSERT INTO product_catalog_region (catalog_id, brand_id, content, image, updated_by) VALUES (?, ?, ?, ?, ?)`,
      [catalog.id, req.user.shopId, content || null, image || null, req.user.userId]);
  }
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_region_promo', catalog.id, catalog.name,
    `更新地区宣传: ${catalog.name}`);
  res.json({ success: true });
});

// 商品详情（含宣传图和地区宣传内容）
app.get('/api/catalog/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  // 如果是总代，带上该总代的地区宣传内容
  let regionPromo = null;
  if (req.user.role === 'brand') {
    regionPromo = await db.get('SELECT * FROM product_catalog_region WHERE catalog_id = ? AND brand_id = ?', catalog.id, req.user.shopId);
  }
  res.json({ ...catalog, regionPromo });
});

// 超管/普通管理查看商品库
app.get('/api/admin/catalog', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const isSuper = isSuperAdmin(req);
  let list;
  if (isSuper) {
    // 超管看所有商品（含下架）
    list = await db.all(`SELECT c.*,
      (SELECT COUNT(*) FROM product_catalog_auth a WHERE a.catalog_id = c.id) AS auth_count,
      (SELECT COUNT(*) FROM product_items pi WHERE pi.catalog_id = c.id AND pi.status = 'merchant_stock') AS in_stock
      FROM product_catalog c ORDER BY c.id DESC`);
  } else {
    // 普通管理只看超管授权给自己的商品（仅上架）
    list = await db.all(`SELECT c.*, a.id AS auth_id,
      (SELECT COUNT(*) FROM product_catalog_auth a2 WHERE a2.catalog_id = c.id) AS auth_count,
      (SELECT COUNT(*) FROM product_items pi WHERE pi.catalog_id = c.id AND pi.status = 'merchant_stock') AS in_stock
      FROM product_catalog c
      JOIN product_catalog_auth a ON a.catalog_id = c.id
      WHERE a.shop_id = ? AND c.status = 'active' ORDER BY c.id DESC`, req.user.shopId);
  }
  res.json(list);
});

// 商品授权链路（谁授权给谁）
app.get('/api/catalog/:id/auths', authMiddleware, async (req, res) => {
  const db = getDb();
  const catalog = await db.get('SELECT id, name FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  const auths = await db.all(`SELECT a.id, a.level, a.created_at,
    s.shop_name AS target_name, s.type AS target_type, s.country AS target_country,
    ab.shop_name AS authorized_by_name
    FROM product_catalog_auth a
    LEFT JOIN shops s ON s.id = a.shop_id
    LEFT JOIN shops ab ON ab.id = a.authorized_by
    WHERE a.catalog_id = ? ORDER BY a.id ASC`, catalog.id);
  res.json({ catalog, auths });
});

// 递归级联删除授权记录（删除某条授权后，其所有下游授权一并删除）
async function cascadeDeleteAuth(db, authId) {
  const auth = await db.get('SELECT * FROM product_catalog_auth WHERE id = ?', authId);
  if (!auth) return 0;
  let count = 1;
  // 找到被授权方作为授权方的所有下游记录
  const children = await db.all('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND authorized_by = ?', auth.catalog_id, auth.shop_id);
  for (const child of children) {
    count += await cascadeDeleteAuth(db, child.id);
  }
  await db.run('DELETE FROM product_catalog_auth WHERE id = ?', authId);
  return count;
}

// 取消授权（级联删除下游）
app.delete('/api/catalog/auth/:authId', authMiddleware, async (req, res) => {
  const db = getDb();
  const auth = await db.get(`SELECT a.*, s.shop_name AS target_name, ab.shop_name AS by_name, c.name AS catalog_name
    FROM product_catalog_auth a
    LEFT JOIN shops s ON s.id = a.shop_id
    LEFT JOIN shops ab ON ab.id = a.authorized_by
    LEFT JOIN product_catalog c ON c.id = a.catalog_id
    WHERE a.id = ?`, req.params.authId);
  if (!auth) return res.status(404).json({ error: '授权记录不存在' });
  // 权限校验：只能取消自己授权出去的记录（或超管可取消任意）
  const isSuper = isSuperAdmin(req);
  if (!isSuper && auth.authorized_by !== req.user.shopId) {
    return res.status(403).json({ error: '无权取消该授权' });
  }
  const deleted = await cascadeDeleteAuth(db, auth.id);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_auth_revoke', auth.catalog_id, auth.catalog_name,
    `取消授权「${auth.catalog_name}」给 ${auth.target_name}，级联删除 ${deleted} 条授权`);
  res.json({ success: true, deleted });
});

// 树形授权链路（含权限过滤）
app.get('/api/catalog/:id/auth-tree', authMiddleware, async (req, res) => {
  const db = getDb();
  const catalog = await db.get('SELECT id, name FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  const allAuths = await db.all(`SELECT a.*, s.shop_name AS target_name, s.type AS target_type, s.country AS target_country,
    ab.shop_name AS authorized_by_name
    FROM product_catalog_auth a
    LEFT JOIN shops s ON s.id = a.shop_id
    LEFT JOIN shops ab ON ab.id = a.authorized_by
    WHERE a.catalog_id = ? ORDER BY a.id ASC`, catalog.id);

  // 权限过滤：确定当前用户能看到的根节点
  const isSuper = isSuperAdmin(req);
  const myShopId = req.user.shopId;
  let visibleIds = new Set();

  if (isSuper) {
    // 超管看全部
    allAuths.forEach(a => visibleIds.add(a.id));
  } else {
    // 非超管：从自己相关的节点开始，只看下游
    // 找到所有以自己为目标或授权方的记录，递归收集下游
    const collect = (authId) => {
      if (visibleIds.has(authId)) return;
      visibleIds.add(authId);
      const a = allAuths.find(x => x.id === authId);
      if (a) {
        allAuths.filter(x => x.authorized_by === a.shop_id).forEach(child => collect(child.id));
      }
    };
    allAuths.filter(a => a.shop_id === myShopId || a.authorized_by === myShopId).forEach(a => collect(a.id));
  }

  // 构建树
  const buildTree = (auth) => {
    const children = allAuths
      .filter(a => a.authorized_by === auth.shop_id && visibleIds.has(a.id))
      .map(buildTree);
    return {
      id: auth.id,
      level: auth.level,
      targetId: auth.shop_id,
      targetName: auth.target_name,
      targetType: auth.target_type,
      targetCountry: auth.target_country,
      authorizedBy: auth.authorized_by,
      authorizedByName: auth.authorized_by_name,
      createdAt: auth.created_at,
      children
    };
  };

  // 根节点
  let roots;
  if (isSuper) {
    // 超管：authorized_by 为超管的记录
    const superShopIds = (await db.all(`SELECT shop_id FROM users WHERE permissions LIKE '%"super"%'`)).map(u => u.shop_id);
    roots = allAuths
      .filter(a => superShopIds.includes(a.authorized_by) && visibleIds.has(a.id))
      .map(buildTree);
  } else {
    // 非超管：根节点是自己作为目标的授权记录，从这里展开下游
    roots = allAuths
      .filter(a => a.shop_id === myShopId && visibleIds.has(a.id))
      .map(buildTree);
  }

  res.json({ catalog, tree: roots });
});

// 授权节点销售情况
app.get('/api/catalog/auth/:authId/sales', authMiddleware, async (req, res) => {
  const db = getDb();
  const auth = await db.get('SELECT * FROM product_catalog_auth WHERE id = ?', req.params.authId);
  if (!auth) return res.status(404).json({ error: '授权记录不存在' });
  const isSuper = isSuperAdmin(req);
  const myShopId = req.user.shopId;
  const perms = req.user.permissions || [];
  const levelMap = { admin: '普通管理', brand_super: '总代', brand: '普通代理', merchant: '商铺' };
  const isNormalAdmin = req.user.role === 'admin' && !isSuper;
  const isNormalAgent = req.user.role === 'brand' && !perms.includes('brand_super');
  // 普通管理和普通代理不显示销售情况
  if (isNormalAdmin || isNormalAgent) {
    return res.json({ level: auth.level, levelLabel: levelMap[auth.level] || auth.level, sales: null, message: '该角色不显示销售情况' });
  }

  // 权限校验
  if (!isSuper) {
    // 只能看自己或自己下游的节点
    const allAuths = await db.all('SELECT * FROM product_catalog_auth WHERE catalog_id = ?', auth.catalog_id);
    const visible = new Set();
    const collect = (aid) => {
      if (visible.has(aid)) return;
      visible.add(aid);
      const a = allAuths.find(x => x.id === aid);
      if (a) allAuths.filter(x => x.authorized_by === a.shop_id).forEach(c => collect(c.id));
    };
    allAuths.filter(a => a.shop_id === myShopId || a.authorized_by === myShopId).forEach(a => collect(a.id));
    if (!visible.has(auth.id)) return res.status(403).json({ error: '无权查看' });
  }

  const targetShop = await db.get('SELECT * FROM shops WHERE id = ?', auth.shop_id);
  if (!targetShop) return res.status(404).json({ error: '目标店铺不存在' });

  let sales = null;
  if (auth.level === 'brand_super') {
    // 总代：下属所有商铺的销售汇总
    const merchantIds = (await db.all("SELECT id FROM shops WHERE type='merchant' AND parent_id = ?", targetShop.id)).map(s => s.id);
    if (merchantIds.length === 0) {
      sales = { totalOrders: 0, totalRevenue: 0, totalGst: 0, merchantCount: 0 };
    } else {
      const placeholders = merchantIds.map(() => '?').join(',');
      const agg = await db.get(`SELECT COUNT(*) as totalOrders, COALESCE(SUM(total_amount),0) as totalRevenue, COALESCE(SUM(gst_amount),0) as totalGst
        FROM transactions WHERE type='sale' AND shop_id IN (${placeholders})`, merchantIds);
      sales = { ...agg, merchantCount: merchantIds.length };
    }
  } else if (auth.level === 'merchant') {
    // 商铺：单店销售
    const agg = await db.get(`SELECT COUNT(*) as totalOrders, COALESCE(SUM(total_amount),0) as totalRevenue, COALESCE(SUM(gst_amount),0) as totalGst
      FROM transactions WHERE type='sale' AND shop_id = ?`, targetShop.id);
    const today = await db.get(`SELECT COUNT(*) as todayOrders, COALESCE(SUM(total_amount),0) as todayRevenue
      FROM transactions WHERE type='sale' AND shop_id = ? AND date(server_timestamp)=date('now','localtime')`, targetShop.id);
    sales = { ...agg, todayOrders: today.todayOrders, todayRevenue: today.todayRevenue };
  } else {
    // 普通管理、普通代理：不显示销售情况
    return res.json({ level: auth.level, levelLabel: levelMap[auth.level], sales: null, message: '该角色不显示销售情况' });
  }

  res.json({ level: auth.level, levelLabel: levelMap[auth.level], targetName: targetShop.shop_name, shopId: targetShop.id, sales });
});

// 超管下架商品
app.put('/api/admin/catalog/:id/offline', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '仅超管可下架商品' });
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  const newStatus = catalog.status === 'inactive' ? 'active' : 'inactive';
  await db.run(`UPDATE product_catalog SET status = ? WHERE id = ?`, [newStatus, req.params.id]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_offline', catalog.id, catalog.name,
    `${newStatus === 'inactive' ? '下架' : '重新上架'}商品: ${catalog.name}`);
  res.json({ success: true, status: newStatus });
});

// 超管删除商品
app.delete('/api/admin/catalog/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '仅超管可删除商品' });
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  await db.run(`DELETE FROM product_catalog WHERE id = ?`, req.params.id);
  await db.run(`DELETE FROM product_catalog_auth WHERE catalog_id = ?`, req.params.id);
  await db.run(`DELETE FROM product_catalog_region WHERE catalog_id = ?`, req.params.id);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_delete', catalog.id, catalog.name,
    `删除商品: ${catalog.name}`);
  res.json({ success: true });
});

// 超管授权商品给普通管理
app.post('/api/admin/catalog/:id/auth', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '仅超管可授权商品' });
  const { adminId } = req.body;
  if (!adminId) return res.status(400).json({ error: '请选择普通管理' });
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ?', req.params.id);
  if (!catalog) return res.status(404).json({ error: '商品不存在' });
  const target = await db.get('SELECT * FROM shops WHERE id = ? AND type = ?', adminId, 'admin');
  if (!target) return res.status(400).json({ error: '目标管理端无效' });
  // 不能授权给超管自己
  const targetUser = await db.get('SELECT permissions FROM users WHERE shop_id = ?', adminId);
  const targetPerms = targetUser ? JSON.parse(targetUser.permissions || '[]') : [];
  if (targetPerms.includes('super')) return res.status(400).json({ error: '不能授权给超管' });
  const exist = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalog.id, adminId);
  if (exist) return res.status(400).json({ error: '已授权过该管理' });
  await db.run(`INSERT INTO product_catalog_auth (catalog_id, shop_id, authorized_by, level) VALUES (?, ?, ?, 'admin')`,
    [catalog.id, adminId, req.user.shopId]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_auth', catalog.id, catalog.name,
    `授权商品「${catalog.name}」给管理 ${target.shop_name}`);
  res.json({ success: true });
});

// 普通管理授权商品给总代
app.post('/api/admin/catalog/:id/auth-brand', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (isSuperAdmin(req)) return res.status(403).json({ error: '超管请使用授权管理接口' });
  const { brandId } = req.body;
  if (!brandId) return res.status(400).json({ error: '请选择总代' });
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ? AND status = ?', req.params.id, 'active');
  if (!catalog) return res.status(404).json({ error: '商品不存在或已下架' });
  // 检查自己是否被授权
  const myAuth = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalog.id, req.user.shopId);
  if (!myAuth) return res.status(403).json({ error: '您未被授权该商品' });
  const brand = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id IS NULL', brandId, 'brand');
  if (!brand) return res.status(400).json({ error: '目标总代无效' });
  const exist = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalog.id, brandId);
  if (exist) return res.status(400).json({ error: '已授权过该总代' });
  await db.run(`INSERT INTO product_catalog_auth (catalog_id, shop_id, authorized_by, level) VALUES (?, ?, ?, 'brand_super')`,
    [catalog.id, brandId, req.user.shopId]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_auth', catalog.id, catalog.name,
    `授权商品「${catalog.name}」给总代 ${brand.shop_name}`);
  res.json({ success: true });
});

// 普通管理可授权的总代列表
app.get('/api/admin/catalog-auth-brands', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (isSuperAdmin(req)) return res.json([]);
  // 普通管理看所有总代（地区代理列表）
  const brands = await db.all(`SELECT id, shop_name, country FROM shops WHERE type = 'brand' AND parent_id IS NULL ORDER BY id`);
  res.json(brands);
});

// 超管可授权的普通管理列表
app.get('/api/admin/catalog-auth-admins', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  if (!isSuperAdmin(req)) return res.json([]);
  // 只返回非超管的管理端
  const admins = await db.all(`SELECT s.id, s.shop_name FROM shops s
    WHERE s.type = 'admin' AND s.id NOT IN (
      SELECT shop_id FROM users WHERE permissions LIKE '%"super"%'
    ) ORDER BY s.id`);
  res.json(admins);
});

// 总代/普通代理查看已授权商品
app.get('/api/brand/catalog', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  let list;
  if (perms.includes('brand_super')) {
    // 总代：看普通管理授权给自己的商品
    list = await db.all(`SELECT c.*, a.id AS auth_id,
      (SELECT COUNT(*) FROM product_catalog_auth a2 WHERE a2.catalog_id = c.id) AS auth_count
      FROM product_catalog c
      JOIN product_catalog_auth a ON a.catalog_id = c.id
      WHERE a.shop_id = ? AND c.status = 'active' ORDER BY c.id DESC`, req.user.shopId);
  } else {
    // 普通代理：看总代授权给自己的商品
    list = await db.all(`SELECT c.*, a.id AS auth_id,
      (SELECT COUNT(*) FROM product_catalog_auth a2 WHERE a2.catalog_id = c.id) AS auth_count
      FROM product_catalog c
      JOIN product_catalog_auth a ON a.catalog_id = c.id
      WHERE a.shop_id = ? AND c.status = 'active' ORDER BY c.id DESC`, req.user.shopId);
  }
  res.json(list);
});

// 总代授权商品给普通代理或商铺
app.post('/api/brand/catalog/:id/auth', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.status(403).json({ error: '仅总代可授权商品' });
  const { targetId, targetType } = req.body; // targetType: 'agent' 或 'merchant'
  if (!targetId) return res.status(400).json({ error: '请选择目标' });
  if (!targetType || !['agent', 'merchant'].includes(targetType)) return res.status(400).json({ error: '请指定授权类型' });
  const catalog = await db.get('SELECT * FROM product_catalog WHERE id = ? AND status = ?', req.params.id, 'active');
  if (!catalog) return res.status(404).json({ error: '商品不存在或已下架' });
  // 检查总代自己是否已被授权
  const myAuth = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalog.id, req.user.shopId);
  if (!myAuth) return res.status(403).json({ error: '您未被授权该商品' });
  let target;
  let level;
  if (targetType === 'agent') {
    target = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', targetId, 'brand', req.user.shopId);
    if (!target) return res.status(400).json({ error: '目标代理无效' });
    level = 'brand';
  } else {
    target = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', targetId, 'merchant', req.user.shopId);
    if (!target) return res.status(400).json({ error: '目标商铺无效' });
    level = 'merchant';
  }
  const exist = await db.get('SELECT id FROM product_catalog_auth WHERE catalog_id = ? AND shop_id = ?', catalog.id, targetId);
  if (exist) return res.status(400).json({ error: '已授权过该目标' });
  await db.run(`INSERT INTO product_catalog_auth (catalog_id, shop_id, authorized_by, level) VALUES (?, ?, ?, ?)`,
    [catalog.id, targetId, req.user.shopId, level]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'catalog_auth', catalog.id, catalog.name,
    `授权商品「${catalog.name}」给${targetType === 'agent' ? '代理' : '商铺'} ${target.shop_name}`);
  res.json({ success: true });
});

// 总代可授权的代理和商铺列表
app.get('/api/brand/catalog-auth-targets', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.json({ agents: [], merchants: [] });
  const agents = await db.all(`SELECT id, shop_name FROM shops WHERE type = 'brand' AND parent_id = ? ORDER BY id`, req.user.shopId);
  const merchants = await db.all(`SELECT id, shop_name FROM shops WHERE type = 'merchant' AND parent_id = ? ORDER BY id`, req.user.shopId);
  res.json({ agents, merchants });
});

// 商家查看可进货的商品（仅总代直接授权给自己的）
app.get('/api/merchant/catalog', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const list = await db.all(`SELECT c.* FROM product_catalog c
    JOIN product_catalog_auth a ON a.catalog_id = c.id
    WHERE a.shop_id = ? AND a.level = 'merchant' AND c.status = 'active' ORDER BY c.id DESC`, req.user.shopId);
  res.json(list);
});

// 管理端：注册品牌方（地区由管理端指定，注册的是总代）
app.post('/api/admin/register-brand', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { shopName, cardKey, country } = req.body;
  if (!shopName || !shopName.trim()) return res.status(400).json({ error: '请输入品牌方名称' });
  const dupErr = await checkDuplicateShopName(db, shopName, 'brand');
  if (dupErr) return res.status(400).json({ error: dupErr });
  const mk = await makeCardKey(db, cardKey);
  if (mk.error) return res.status(400).json({ error: mk.error });
  const c = GST_BY_COUNTRY[country] !== undefined ? country : 'SG';
  const gstRate = GST_BY_COUNTRY[c];
  const r = await db.run(`INSERT INTO shops (card_key, shop_name, type, parent_id, country, gst_rate) VALUES (?, ?, 'brand', NULL, ?, ?)`, [mk.key, shopName.trim(), c, gstRate]);
  const newShopId = r.lastInsertRowid;
  // 同时创建总代用户记录（brand_super 权限），初始密码 = 开户密钥（bcrypt 哈希）
  const newShopHash = await bcrypt.hash(mk.key, 10);
  await db.run(`INSERT INTO users (shop_id, username, role, permissions, password_hash) VALUES (?, ?, 'brand', ?, ?)`,
    [newShopId, shopName.trim(), '["brand_super"]', newShopHash]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'register_brand', newShopId, shopName.trim(),
    `管理端开户总代: ${shopName.trim()}, 地区: ${COUNTRY_LABELS[c]}, 初始密码: ${mk.key}`);
  res.json({ success: true, id: newShopId, cardKey: mk.key, shopName: shopName.trim(), country: c, gstRate });
});
// 管理端：品牌方列表（只显示总代，含地区、代理数、商家数）
app.get('/api/admin/brands', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const brands = await db.all(`
    SELECT s.id, s.shop_name, s.card_key, s.country, s.gst_rate, s.created_at,
      (SELECT COUNT(*) FROM shops a WHERE a.type='brand' AND a.parent_id = s.id) AS agent_count,
      (SELECT COUNT(*) FROM shops m WHERE m.type='merchant' AND m.parent_id = s.id) AS merchant_count
    FROM shops s WHERE s.type='brand' AND s.parent_id IS NULL ORDER BY s.id ASC
  `);
  res.json(brands);
});
// 管理端：所有店铺总览（品牌+商家，管理端全局可见）
app.get('/api/admin/shops', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const brands = await db.all("SELECT id, shop_name, card_key, country, gst_rate, created_at FROM shops WHERE type='brand' ORDER BY id ASC");
  const merchants = await db.all("SELECT id, shop_name, card_key, parent_id, country, gst_rate, created_at FROM shops WHERE type='merchant' ORDER BY parent_id ASC, id ASC");
  res.json({ brands, merchants });
});
// 超管权限检查
function isSuperAdmin(req) {
  return Array.isArray(req.user.permissions) && req.user.permissions.includes('super');
}
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: '无权限，仅超管可执行此操作' });
  next();
}
// 密码复杂度校验工具：至少8位，含大小写+数字+特殊字符
function validatePasswordStrength(pw) {
  if (pw.length < 8) return '密码需至少8位';
  if (!/[a-z]/.test(pw)) return '密码需包含小写字母';
  if (!/[A-Z]/.test(pw)) return '密码需包含大写字母';
  if (!/\d/.test(pw)) return '密码需包含数字';
  if (!/[^a-zA-Z0-9]/.test(pw)) return '密码需包含特殊字符（如 !@#$%^&*）';
  return null;
}
// 修改密码（商家/品牌/管理端都可改自己的密码；非超管只能改一次）
app.put('/api/shop/password', authMiddleware, async (req, res) => {
  const db = getDb();
  const { newPassword } = req.body;
  if (!newPassword || !newPassword.trim()) return res.status(400).json({ error: '请输入新密码' });
  const pw = newPassword.trim();
  const pwErr = validatePasswordStrength(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  // 非超管只能修改一次
  const superAdmin = isSuperAdmin(req);
  if (!superAdmin) {
    const me = await db.get('SELECT password_changed FROM shops WHERE id = ?', [req.user.shopId]);
    if (me && me.password_changed === 1) {
      return res.status(400).json({ error: '密码已修改过一次，如需再次修改请联系超管' });
    }
  }
  const dup = await db.get('SELECT id FROM shops WHERE card_key = ? COLLATE NOCASE AND id != ?', [pw, req.user.shopId]);
  if (dup) return res.status(400).json({ error: '该密码已被其他账户使用' });
  await db.run('UPDATE shops SET card_key = ?, password_changed = 1 WHERE id = ?', [pw, req.user.shopId]);
  // v0.2.0：同步更新本店所有账号的登录密码哈希（用户名+密码登录用）
  const hash = await bcrypt.hash(pw, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE shop_id = ?', [hash, req.user.shopId]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'password_change', null, null, '修改登录密码');
  res.json({ success: true, passwordChanged: true });
});
// 管理端账户列表（超管可见密码，普通管理端不可见）
app.get('/api/admin/admins', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const rows = await db.all(`
    SELECT s.id, s.shop_name, s.card_key, s.created_at,
      u.username, u.permissions
    FROM shops s
    LEFT JOIN users u ON u.shop_id = s.id
    WHERE s.type = 'admin'
    ORDER BY s.id ASC
  `);
  const showKey = isSuperAdmin(req);
  const result = rows.map(r => ({
    id: r.id,
    shopName: r.shop_name,
    username: r.username,
    permissions: r.permissions || '[]',
    isSuper: (r.permissions || '').includes('super'),
    cardKey: showKey ? r.card_key : null,
    createdAt: r.created_at
  }));
  res.json(result);
});
// 管理端：注册新的管理端账户（仅超管）
app.post('/api/admin/register-admin', authMiddleware, requireRole('admin'), requireSuperAdmin, async (req, res) => {
  const db = getDb();
  const { shopName, cardKey } = req.body;
  if (!shopName || !shopName.trim()) return res.status(400).json({ error: '请输入管理端名称' });
  const dupErr = await checkDuplicateShopName(db, shopName, 'admin');
  if (dupErr) return res.status(400).json({ error: dupErr });
  const mk = await makeCardKey(db, cardKey);
  if (mk.error) return res.status(400).json({ error: mk.error });
  const r = await db.run(`INSERT INTO shops (card_key, shop_name, type, parent_id, country) VALUES (?, ?, 'admin', NULL, 'SG')`, mk.key, shopName.trim());
  // v0.2.0：开户即创建管理端账号（初始密码 = 开户密钥，bcrypt 哈希）
  const adminHash = await bcrypt.hash(mk.key, 10);
  const adminUsername = `admin_${String(r.lastInsertRowid).padStart(2, '0')}`;
  await db.run(`INSERT INTO users (shop_id, username, role, permissions, password_hash) VALUES (?, ?, 'admin', '[]', ?)`,
    [r.lastInsertRowid, adminUsername, adminHash]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'register_admin', r.lastInsertRowid, shopName.trim(),
    `管理端开户新管理端: ${shopName.trim()}, 初始密码: ${mk.key}`);
  res.json({ success: true, id: r.lastInsertRowid, cardKey: mk.key, username: adminUsername, shopName: shopName.trim() });
});
// 超管修改指定管理端账户的密码
app.put('/api/admin/admins/:id/password', authMiddleware, requireRole('admin'), requireSuperAdmin, async (req, res) => {
  const db = getDb();
  const targetId = Number(req.params.id);
  const { newPassword } = req.body;
  const target = await db.get('SELECT * FROM shops WHERE id = ? AND type = ?', [targetId, 'admin']);
  if (!target) return res.status(404).json({ error: '管理端账户不存在' });
  if (!newPassword || !newPassword.trim()) return res.status(400).json({ error: '请输入新密码' });
  const pw = newPassword.trim();
  const pwErr = validatePasswordStrength(pw);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const dup = await db.get('SELECT id FROM shops WHERE card_key = ? COLLATE NOCASE AND id != ?', [pw, targetId]);
  if (dup) return res.status(400).json({ error: '该密码已被其他账户使用' });
  await db.run('UPDATE shops SET card_key = ?, password_changed = 1 WHERE id = ?', [pw, targetId]);
  // v0.2.0：同步重置该店所有账号的登录密码哈希
  const hash = await bcrypt.hash(pw, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE shop_id = ?', [hash, targetId]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'admin_password_reset', targetId, target.shop_name,
    `超管重置管理端账户密码: ${target.shop_name}`);
  res.json({ success: true });
});
// 管理端：删除账户（品牌/商家/管理端），级联删除用户与商品，交易历史保留
app.delete('/api/admin/shops/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const target = await db.get('SELECT * FROM shops WHERE id = ?', [Number(req.params.id)]);
  if (!target) return res.status(404).json({ error: '账户不存在' });
  if (target.type === 'admin') {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: '无权限，仅超管可删除管理端账户' });
    if (target.id === req.user.shopId) return res.status(400).json({ error: '不能删除当前登录的管理端账户' });
    const adminCount = (await db.get("SELECT COUNT(*) c FROM shops WHERE type='admin'")).c;
    if (adminCount <= 1) return res.status(400).json({ error: '至少保留一个管理端账户' });
  }
  const idsToDelete = [target.id];
  if (target.type === 'brand') {
    const children = await db.all("SELECT id FROM shops WHERE type='merchant' AND parent_id = ?", [target.id]);
    children.forEach(c => idsToDelete.push(c.id));
  }
  for (const sid of idsToDelete) {
    await db.run('DELETE FROM users WHERE shop_id = ?', [sid]);
    await db.run('DELETE FROM products WHERE shop_id = ?', [sid]);
    await db.run('DELETE FROM product_catalog_auth WHERE shop_id = ?', [sid]);
    await db.run('DELETE FROM product_catalog_auth WHERE authorized_by = ?', [sid]);
  }
  const placeholders = idsToDelete.map(() => '?').join(',');
  await db.run(`DELETE FROM shops WHERE id IN (${placeholders})`, idsToDelete);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'admin_delete_shop', target.id, target.shop_name,
    `管理端删除账户: ${target.shop_name}（类型: ${target.type}, 级联删除 ${idsToDelete.length} 个店铺）`);
  res.json({ success: true, deleted: idsToDelete });
});
// 管理端：为指定品牌方注册合作商家（地区锁定为品牌地区）
app.post('/api/admin/register-merchant', authMiddleware, requireRole('admin'), async (req, res) => {
  const db = getDb();
  const { shopName, brandId, cardKey } = req.body;
  if (!shopName || !shopName.trim()) return res.status(400).json({ error: '请输入商家名称' });
  const dupErr = await checkDuplicateShopName(db, shopName, 'merchant');
  if (dupErr) return res.status(400).json({ error: dupErr });
  const brand = await db.get('SELECT * FROM shops WHERE id = ? AND type = ?', [brandId, 'brand']);
  if (!brand) return res.status(400).json({ error: '请选择有效的品牌方' });
  const mk = await makeCardKey(db, cardKey);
  if (mk.error) return res.status(400).json({ error: mk.error });
  // 地区由品牌决定（品牌地区由管理端开户时设定），商家不可跨地区
  const c = brand.country || 'SG';
  const gstRate = brand.gst_rate != null ? brand.gst_rate : GST_BY_COUNTRY[c];
  const r = await db.run(`INSERT INTO shops (card_key, shop_name, type, parent_id, gst_rate, country) VALUES (?, ?, 'merchant', ?, ?, ?)`,
    [mk.key, shopName.trim(), brand.id, gstRate, c]);
  // v0.2.0：开户即创建店主账号（初始密码 = 开户密钥，bcrypt 哈希）
  const mHash = await bcrypt.hash(mk.key, 10);
  await db.run(`INSERT INTO users (shop_id, username, role, password_hash) VALUES (?, ?, 'merchant', ?)`,
    [r.lastInsertRowid, shopName.trim(), mHash]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'register_merchant', r.lastInsertRowid, shopName.trim(),
    `管理端开户合作商家: ${shopName.trim()}（品牌方: ${brand.shop_name}, 地区: ${COUNTRY_LABELS[c]}, GST: ${gstRate * 100}%）, 初始密码: ${mk.key}`);
  res.json({ success: true, id: r.lastInsertRowid, cardKey: mk.key, username: shopName.trim(), shopName: shopName.trim(), country: c, gstRate });
});
// ========== 发货单管理 ==========
// 创建发货单（品牌方）
app.post('/api/shipments', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const { merchantId, items, remark } = req.body;
  const m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', merchantId, 'merchant', req.user.shopId);
  if (!m) return res.status(403).json({ error: '请选择有效的合作商家' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '请至少添加一项商品' });
  for (const it of items) {
    if (!it.barcode || !it.quantity || it.quantity < 1) return res.status(400).json({ error: '发货单项需包含条码和数量' });
  }
  await db.run('BEGIN');
  try {
    const r = await db.run(`INSERT INTO shipments (brand_shop_id, merchant_shop_id, status, remark)
      VALUES (?, ?, 'draft', ?)`, req.user.shopId, m.id, remark || null);
    const shipmentId = r.lastInsertRowid;
    let pendingIdx = 0;
    for (const it of items) {
      const qty = parseInt(it.quantity) || 1;
      // 一物一码：每件商品一个占位项，扫码时逐个替换
      for (let i = 0; i < qty; i++) {
        pendingIdx++;
        await db.run(`INSERT INTO shipment_items (shipment_id, barcode, product_name, quantity, scanned_count)
          VALUES (?, ?, ?, 1, 0)`, shipmentId, 'PENDING_' + pendingIdx, it.name || it.barcode);
      }
    }
    await db.run('COMMIT');
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'shipment_create', shipmentId, m.shop_name,
      `创建发货单#${shipmentId} → ${m.shop_name}, ${items.length} 项商品`);
    res.json({ success: true, id: shipmentId });
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }
});
// 发货单列表（总代=自己发起的；普通代理=分配给自己的；合作商家=发给自己的）
app.get('/api/shipments', authMiddleware, async (req, res) => {
  const db = getDb();
  let rows;
  if (req.user.role === 'brand') {
    const perms = req.user.permissions || [];
    if (perms.includes('brand_super')) {
      // 总代：看自己品牌下所有发货单
      rows = await db.all(`SELECT s.*, m.shop_name AS merchant_name, a.shop_name AS agent_name,
          (SELECT COALESCE(SUM(si.quantity),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS total_qty,
          (SELECT COALESCE(SUM(si.scanned_count),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS scanned_qty,
          (SELECT COALESCE(SUM(si.received_qty),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS received_qty
        FROM shipments s
        JOIN shops m ON m.id = s.merchant_shop_id
        LEFT JOIN shops a ON a.id = s.brand_shop_id
        WHERE s.assigned_by = ? OR s.brand_shop_id = ? ORDER BY s.id DESC`, req.user.shopId, req.user.shopId);
    } else {
      // 普通代理：看分配给自己的
      rows = await db.all(`SELECT s.*, m.shop_name AS merchant_name,
          (SELECT COALESCE(SUM(si.quantity),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS total_qty,
          (SELECT COALESCE(SUM(si.scanned_count),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS scanned_qty,
          (SELECT COALESCE(SUM(si.received_qty),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS received_qty
        FROM shipments s JOIN shops m ON m.id = s.merchant_shop_id
        WHERE s.brand_shop_id = ? ORDER BY s.id DESC`, req.user.shopId);
    }
  } else {
    rows = await db.all(`SELECT s.*, b.shop_name AS brand_name,
        (SELECT COALESCE(SUM(si.quantity),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS total_qty,
        (SELECT COALESCE(SUM(si.scanned_count),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS scanned_qty,
        (SELECT COALESCE(SUM(si.received_qty),0) FROM shipment_items si WHERE si.shipment_id=s.id) AS received_qty
      FROM shipments s JOIN shops b ON b.id = s.brand_shop_id
      WHERE s.merchant_shop_id = ? ORDER BY s.id DESC`, req.user.shopId);
  }
  res.json(rows);
});
// 发货单详情（品牌方=完整明细；合作商家=不暴露条码明细，只给状态）
app.get('/api/shipments/:id', authMiddleware, async (req, res) => {
  const db = getDb();
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ?', req.params.id);
  if (!shipment) return res.status(404).json({ error: '发货单不存在' });
  const agg = await db.get(`SELECT COALESCE(SUM(quantity),0) AS total_qty,
      COALESCE(SUM(scanned_count),0) AS scanned_qty,
      COALESCE(SUM(received_qty),0) AS received_qty
    FROM shipment_items WHERE shipment_id = ?`, shipment.id);
  if (req.user.role === 'brand') {
    if (shipment.brand_shop_id !== req.user.shopId && shipment.assigned_by !== req.user.shopId) return res.status(403).json({ error: '无权访问' });
    const m = await db.get('SELECT shop_name FROM shops WHERE id = ?', shipment.merchant_shop_id);
    const items = await db.all('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id', shipment.id);
    return res.json({ ...shipment, ...agg, merchant_name: m?.shop_name, items });
  } else {
    if (shipment.merchant_shop_id !== req.user.shopId) return res.status(403).json({ error: '无权访问' });
    const b = await db.get('SELECT shop_name FROM shops WHERE id = ?', shipment.brand_shop_id);
    // 合作商家：隐藏条码明细，仅返回状态与收货进度（不可提前知道编码）
    return res.json({ ...shipment, ...agg, brand_name: b?.shop_name, items: [] });
  }
});
// 代理清点扫码（发货前逐件核对，一物一码）
app.post('/api/shipments/:id/scan', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const { barcode } = req.body;
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ? AND brand_shop_id = ? AND status IN (?, ?)',
    req.params.id, req.user.shopId, 'draft', 'assigned');
  if (!shipment) return res.status(404).json({ error: '发货单不存在或已发货' });
  // 防重复：该条码是否已扫过
  const dup = await db.get('SELECT * FROM shipment_items WHERE shipment_id = ? AND barcode = ? AND barcode NOT LIKE ?',
    shipment.id, barcode, 'PENDING_%');
  if (dup) return res.json({ ok: false, message: `该条码已扫过（${dup.product_name}）` });
  // 找第一个 PENDING 占位项替换
  const pending = await db.get(`SELECT * FROM shipment_items WHERE shipment_id = ? AND barcode LIKE ? ORDER BY id LIMIT 1`,
    shipment.id, 'PENDING_%');
  if (!pending) return res.json({ ok: false, message: '已扫满，无需再扫' });

  // ===== 一物一码：创建/更新商品实例 =====
  const catalog = await db.get('SELECT id FROM product_catalog WHERE name = ? AND status = ?', [pending.product_name, 'active']);
  const catalogId = catalog?.id || null;
  let item = await db.get('SELECT * FROM product_items WHERE barcode = ?', barcode);
  if (!item) {
    // 新商品实例，归入代理库存
    await db.run(`INSERT INTO product_items (barcode, catalog_id, product_name, status, agent_shop_id, shipment_id, merchant_shop_id, cost_price, sell_price)
      VALUES (?, ?, ?, 'in_transit', ?, ?, ?, 20, 188)`,
      [barcode, catalogId, pending.product_name || barcode, req.user.shopId, shipment.id, shipment.merchant_shop_id]);
  } else {
    if (item.status !== 'agent_stock') {
      return res.json({ ok: false, message: `该条码状态异常（${item.status}），无法发货` });
    }
    if (item.agent_shop_id && item.agent_shop_id !== req.user.shopId) {
      return res.json({ ok: false, message: '该条码不属于当前代理' });
    }
    await db.run(`UPDATE product_items SET status='in_transit', shipment_id=?, merchant_shop_id=?, shipped_at=datetime('now','localtime') WHERE id=?`,
      [shipment.id, shipment.merchant_shop_id, item.id]);
  }

  await db.run('UPDATE shipment_items SET barcode = ?, scanned_count = 1 WHERE id = ?', barcode, pending.id);
  const updated = await db.get('SELECT * FROM shipment_items WHERE id = ?', pending.id);
  const progress = await db.get(`SELECT COALESCE(SUM(quantity),0) total, COALESCE(SUM(scanned_count),0) scanned FROM shipment_items WHERE shipment_id = ?`, shipment.id);
  res.json({ ok: true, item: updated, progress });
});
// 总代分配发货单给普通代理
app.post('/api/shipments/:id/assign', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  if (!perms.includes('brand_super')) return res.status(403).json({ error: '仅总代可分配发货单' });
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: '请选择代理' });
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ? AND (brand_shop_id = ? OR assigned_by = ?)',
    req.params.id, req.user.shopId, req.user.shopId);
  if (!shipment) return res.status(404).json({ error: '发货单不存在' });
  if (shipment.status !== 'draft') return res.status(400).json({ error: '该发货单已分配或已发货' });
  const agent = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', agentId, 'brand', req.user.shopId);
  if (!agent) return res.status(400).json({ error: '目标代理无效' });
  await db.run(`UPDATE shipments SET brand_shop_id = ?, assigned_by = ?, status = 'assigned' WHERE id = ?`,
    [agentId, req.user.shopId, shipment.id]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'shipment_assign', shipment.id, agent.shop_name,
    `发货单#${shipment.id} 分配给代理 ${agent.shop_name}`);
  res.json({ success: true });
});
// 确认发货（需所有项扫满）
app.post('/api/shipments/:id/ship', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ? AND brand_shop_id = ? AND status IN (?, ?)',
    req.params.id, req.user.shopId, 'draft', 'assigned');
  if (!shipment) return res.status(404).json({ error: '发货单不存在或已发货' });
  const incomplete = await db.get(`SELECT COUNT(*) c FROM shipment_items WHERE shipment_id = ? AND barcode LIKE ?`, shipment.id, 'PENDING_%');
  if (incomplete.c > 0) {
    return res.status(400).json({ error: `还有 ${incomplete.c} 件未扫码，请先逐件扫码` });
  }
  await db.run(`UPDATE shipments SET status='shipped', shipped_at=datetime('now','localtime') WHERE id = ?`, shipment.id);
  const merchant = await db.get('SELECT shop_name FROM shops WHERE id = ?', shipment.merchant_shop_id);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'shipment_ship', shipment.id, merchant?.shop_name,
    `发货单#${shipment.id} 已发货 → ${merchant?.shop_name}`);
  res.json({ success: true });
});
// 合作商家：待收货发货单数量
app.get('/api/shipments/pending/count', authMiddleware, requireRole('merchant', 'staff'), async (req, res) => {
  const db = getDb();
  const row = await db.get("SELECT COUNT(*) c FROM shipments WHERE merchant_shop_id = ? AND status = 'shipped'", req.user.shopId);
  res.json({ pending: row.c });
});
// 代理/总代：查看在途货物（已发货但商铺未入库的商品实例）
app.get('/api/product-items/in-transit', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const perms = req.user.permissions || [];
  let items;
  if (perms.includes('brand_super')) {
    // 总代：看自己地区所有在途货物
    items = await db.all(`SELECT pi.*, m.shop_name as merchant_name, a.shop_name as agent_name
      FROM product_items pi
      LEFT JOIN shops m ON m.id = pi.merchant_shop_id
      LEFT JOIN shops a ON a.id = pi.agent_shop_id
      WHERE pi.status = 'in_transit' AND pi.merchant_shop_id IN (SELECT id FROM shops WHERE parent_id = ?)
      ORDER BY pi.id DESC`, [req.user.shopId]);
  } else {
    // 普通代理：只看自己发出的在途货物
    items = await db.all(`SELECT pi.*, m.shop_name as merchant_name
      FROM product_items pi
      LEFT JOIN shops m ON m.id = pi.merchant_shop_id
      WHERE pi.status = 'in_transit' AND pi.agent_shop_id = ?
      ORDER BY pi.id DESC`, [req.user.shopId]);
  }
  res.json(items);
});
// ========== 品牌方：为合作商家注册账号（独立注册页使用） ==========
app.post('/api/brand/register-merchant', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const { shopName } = req.body;
  const name = (shopName || '').trim();
  if (!name) return res.status(400).json({ error: '请输入商家名称' });
  const dupErr = await checkDuplicateShopName(db, name, 'merchant');
  if (dupErr) return res.status(400).json({ error: dupErr });
  // 品牌地区固定：商家只能开在品牌所在地区（地区由管理端定）
  const brand = await db.get('SELECT country, gst_rate, shop_name FROM shops WHERE id = ? AND type = ?', req.user.shopId, 'brand');
  const c = brand && brand.country ? brand.country : 'SG';
  const gstRate = brand && brand.gst_rate != null ? brand.gst_rate : GST_BY_COUNTRY[c];
  const cardKey = generateCardKey();
  const r = await db.run(`INSERT INTO shops (card_key, shop_name, type, parent_id, gst_rate, country) VALUES (?, ?, 'merchant', ?, ?, ?)`, cardKey, name, req.user.shopId, gstRate, c);
  // v0.2.0：开户即创建店主账号（初始密码 = 开户密钥，bcrypt 哈希）
  const bHash = await bcrypt.hash(cardKey, 10);
  await db.run(`INSERT INTO users (shop_id, username, role, password_hash) VALUES (?, ?, 'merchant', ?)`,
    [r.lastInsertRowid, name, bHash]);
  await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'merchant_register', null, name,
    `注册合作商家: ${name}（地区: ${COUNTRY_LABELS[c]}, GST: ${gstRate * 100}%）, 初始密码: ${cardKey}`);
  res.json({ success: true, cardKey, username: name, shopName: name, country: c, gstRate });
});
// 品牌方：删除合作商家（仅删除账号，保留数据）
app.delete('/api/brand/merchants/:id', authMiddleware, requireRole('brand'), async (req, res) => {
  const db = getDb();
  const m = await db.get('SELECT * FROM shops WHERE id = ? AND type = ? AND parent_id = ?', req.params.id, 'merchant', req.user.shopId);
  if (!m) return res.status(404).json({ error: '商家不存在' });
  await db.run(`UPDATE shops SET card_key = card_key || '_disabled_' || id WHERE id = ?`, m.id);
  res.json({ success: true });
});
// ========== SPA 路由回退 ==========
// ========== API v1（/api/v1/*）挂载，必须在 catch-all 之前 ==========
app.use('/api/v1', routesV1);
// ========== 兜底路由：所有非 API 请求返回前端页面 ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ========== 启动服务器：先初始化数据库 ==========
async function bootstrap() {
  await initDB();
  console.log('数据库初始化完成');
  // 监听所有网卡（本机 + 局域网设备可访问）；登录有密钥+限流保护
  app.listen(PORT, () => {
    console.log('========================================');
    console.log('  StockVerify 已启动');
    console.log('  本地访问: http://localhost:' + PORT);
    console.log('  局域网访问: http://<本机IP>:' + PORT + '（需防火墙放行 3000 端口）');
    console.log('========================================');
  });
}
bootstrap().catch(err => {
  console.error('服务启动失败：', err);
  process.exit(1);
});

// 优雅退出：确保数据库写入落盘（避免强杀丢数据）
async function gracefulShutdown() {
  console.log('正在安全关闭服务器...');
  try {
    const { getDb } = require('./database');
    const db = getDb();
    if (db) await db.close();
  } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
