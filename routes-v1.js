'use strict';
/**
 * API v1 接口模块（/api/v1/*）
 * -------------------------------------------------
 * 工程化接口，只做"补齐"，不改动任何原有接口。
 * - 数据读写复用现有 SQLite（data/inventory.db）
 * - 登录：用户名 + 密码（bcrypt 哈希校验），返回 JWT token
 * - 财务参数：数据库 settings 表（管理端可配置），config.json 仅作缺省
 * - 财务口径：支持「售价含税 / 售价不含税」两种模式（见 finance.js），参数含国家/货币/税种/税率
 * - 防重复扫码：服务端按 config.json 的 scan.duplicateWindowMs（默认 5000ms）拦截
 * - 操作日志：复用 appendAuditLog（哈希链防篡改），额外写入 device_info 字段
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb, appendAuditLog } = require('./database');
const finance = require('./finance');

const router = express.Router();
const { JWT_SECRET } = require('./config');

// ---------- API v1 认证中间件（token 由 /api/v1/login 签发） ----------
function v1Auth(req, res, next) {
  const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : '';
  if (!token) return res.status(401).json({ error: '未登录，请先调用 POST /api/v1/login 获取 token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// 管理员权限中间件（仅 role=admin 可访问）
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理端权限' });
  }
  next();
}

// 生成与 SQLite datetime('now','localtime') 一致的本地时间字符串
function localDt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 服务端防重复扫码：同店铺 + 同商品 + 同类型 + 同操作人，窗口内拦截 ----------
async function checkDuplicateScan(db, shopId, productId, type, operatorId) {
  const s = await finance.getSettings();
  const winMs = s.scan.duplicateWindowMs || 5000;
  const cutoff = localDt(Date.now() - winMs);
  const row = await db.get(
    `SELECT id FROM transactions
     WHERE shop_id = ? AND product_id = ? AND type = ? AND operator_id = ?
       AND server_timestamp >= ? ORDER BY id DESC LIMIT 1`,
    [shopId, productId, type, operatorId, cutoff]
  );
  return row ? { id: row.id, windowMs: winMs } : null;
}

// 通用：扫码落库（入库 / 出库共用）
async function applyScan(req, res, type) {
  const db = getDb();
  const { productId, qty, deviceInfo } = req.body || {};
  const pid = parseInt(productId, 10);
  const q = parseInt(qty, 10) || 1;
  if (!pid) return res.status(400).json({ error: '缺少或非法的 productId' });
  if (q <= 0) return res.status(400).json({ error: '数量必须大于 0' });

  const device = typeof deviceInfo === 'string' && deviceInfo.trim() ? deviceInfo.trim() : (req.headers['user-agent'] || '').slice(0, 200);

  try {
    await db.run('BEGIN');
    const product = await db.get('SELECT * FROM products WHERE id = ? AND shop_id = ?', pid, req.user.shopId);
    if (!product) {
      await db.run('ROLLBACK');
      return res.status(404).json({ error: '商品不存在（或不属于当前店铺）' });
    }

    // 服务端防重复扫码（窗口见 config.json）
    const dup = await checkDuplicateScan(db, req.user.shopId, pid, type, req.user.userId);
    if (dup) {
      await db.run('ROLLBACK');
      return res.status(429).json({
        success: false, duplicate: true,
        error: `请勿在 ${Math.round(dup.windowMs / 1000)} 秒内重复扫码（服务端防重窗口 ${dup.windowMs}ms）`
      });
    }

    // 出库需校验库存
    if (type === 'outbound' && product.stock < q) {
      await db.run('ROLLBACK');
      return res.status(400).json({ error: `库存不足！当前库存: ${product.stock}, 需要: ${q}` });
    }

    // 财务计算（售价含 GST 口径；参数来自数据库 settings 表）
    const f = await finance.calculate(q, product.sell_price || 0);

    // 更新库存
    const sign = type === 'inbound' ? '+' : '-';
    await db.run(`UPDATE products SET stock = stock ${sign} ?, last_write_at = ? WHERE id = ?`,
      q, new Date().toISOString(), pid);

    // 交易流水 type 与 dashboard 统计口径一致：出库写 'sale'（审计日志 action 仍为 outbound，页面显示"出库"）
    const txType = type === 'outbound' ? 'sale' : type;
    // 写入交易流水（与原表结构一致，使用含税口径计算字段）
    await db.run(`
      INSERT INTO transactions (shop_id, product_id, product_name, type, quantity, unit_price,
        amount_before_gst, gst_amount, total_amount, platform_share, merchant_share, commission_gst,
        operator_id, operator_name, client_timestamp, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
    `, req.user.shopId, product.id, product.name, txType, q, product.sell_price || 0,
      f.amountBeforeGST, f.gstAmount, f.totalAmount,
      f.platformShare, f.merchantShare, f.commissionGst,
      req.user.userId, req.user.username, new Date().toISOString());

    // 操作日志（哈希链不变，新增设备信息字段）
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, type, product.id, product.name,
      `${type === 'inbound' ? '入库' : '出库'}: ${product.name}, 数量: ${q}, 单价(${f.priceIncludesTax ? '含' : '不含'}${f.taxName}): ${product.sell_price}, 不含税: ${f.amountBeforeGST}, ${f.taxName}: ${f.gstAmount}`,
      device);

    const updated = await db.get('SELECT * FROM products WHERE id = ?', pid);
    await db.run('COMMIT');
    res.json({ success: true, type, product: updated, finance: f });
  } catch (err) {
    try { await db.run('ROLLBACK'); } catch (e) { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
}

// 写入 settings（key-value upsert）
async function setSetting(key, value, updatedBy) {
  const db = getDb();
  try {
    await db.run(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      key, String(value), updatedBy || null
    );
  } catch (e) {
    const exist = await db.get('SELECT key FROM settings WHERE key = ?', key);
    if (exist) {
      await db.run('UPDATE settings SET value = ?, updated_by = ?, updated_at = datetime(\'now\',\'localtime\') WHERE key = ?',
        String(value), updatedBy || null, key);
    } else {
      await db.run('INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)', key, String(value), updatedBy || null);
    }
  }
}

// ==================== API v1 ====================

// GET /api/v1/hello — 健康检查
router.get('/hello', (req, res) => {
  res.json({ message: '后端服务器运行正常！', time: new Date().toISOString(), v1: true });
});

// POST /api/v1/login — 用户名 + 密码登录（bcrypt 校验），返回 token
router.post('/login', async (req, res) => {
  const db = getDb();
  const { username, password, role } = req.body || {};
  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  try {
    const user = await db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', username.trim());
    // 用户不存在或未设置密码：统一返回同一错误，避免暴露账号是否存在
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });

    if (role && user.role !== role) {
      return res.status(401).json({ error: '该账号不是所选身份' });
    }

    const shop = await db.get('SELECT * FROM shops WHERE id = ?', user.shop_id);
    const permissions = user.permissions ? (typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions) : [];

    const token = jwt.sign(
      { userId: user.id, username: user.username, shopId: shop.id, role: user.role, permissions, v1: true },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      token,
      shop: {
        id: shop.id, name: shop.shop_name, gstRate: shop.gst_rate,
        country: shop.country || 'SG', type: shop.type, parentId: shop.parent_id,
        passwordChanged: shop.password_changed === 1
      },
      user: { id: user.id, username: user.username, role: user.role, permissions }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/products — 商品列表（当前店铺）
router.get('/products', v1Auth, async (req, res) => {
  const db = getDb();
  try {
    const products = await db.all('SELECT * FROM products WHERE shop_id = ? ORDER BY id DESC LIMIT 200', req.user.shopId);
    res.json({ success: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/scan/in — 入库扫码
router.post('/scan/in', v1Auth, (req, res) => applyScan(req, res, 'inbound'));

// POST /api/v1/scan/out — 出库扫码
router.post('/scan/out', v1Auth, (req, res) => applyScan(req, res, 'outbound'));

// POST /api/v1/sync — 接收离线补传记录数组，逐条写库
router.post('/sync', v1Auth, async (req, res) => {
  const db = getDb();
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records 必须是非空数组' });
  }
  let synced = 0, duplicates = 0, failed = 0;
  const results = [];
  for (const r of records) {
    const pid = parseInt(r.productId, 10);
    const q = parseInt(r.qty, 10) || 1;
    const rawType = String(r.type || '').toLowerCase();
    const type = rawType === 'in' || rawType === 'inbound' ? 'inbound'
      : (rawType === 'out' || rawType === 'outbound') ? 'outbound' : null;
    const device = typeof r.deviceInfo === 'string' && r.deviceInfo.trim() ? r.deviceInfo.trim() : '离线补传';
    try {
      if (!pid || !type) {
        failed++;
        results.push({ clientRecordId: r.clientRecordId || null, status: 'failed', error: '记录缺少 productId 或 type 不合法' });
        continue;
      }
      await db.run('BEGIN');
      // 按 clientRecordId 防重
      if (r.clientRecordId) {
        const existing = await db.get('SELECT id FROM transactions WHERE client_record_id = ?', r.clientRecordId);
        if (existing) {
          await db.run('COMMIT');
          duplicates++;
          results.push({ clientRecordId: r.clientRecordId, status: 'duplicate' });
          continue;
        }
      }
      const product = await db.get('SELECT * FROM products WHERE id = ? AND shop_id = ?', pid, req.user.shopId);
      if (!product) {
        await db.run('ROLLBACK');
        failed++;
        results.push({ clientRecordId: r.clientRecordId || null, status: 'failed', error: '商品不存在' });
        continue;
      }
      if (type === 'outbound' && product.stock < q) {
        await db.run('ROLLBACK');
        failed++;
        results.push({ clientRecordId: r.clientRecordId || null, status: 'failed', error: '库存不足' });
        continue;
      }
      const f = await finance.calculate(q, product.sell_price || 0);
      const sign = type === 'inbound' ? '+' : '-';
      await db.run(`UPDATE products SET stock = stock ${sign} ?, last_write_at = ? WHERE id = ?`,
        q, r.clientTimestamp || new Date().toISOString(), pid);
      const txType = type === 'outbound' ? 'sale' : type; // 出库 type 与 dashboard 口径一致；审计 action 保持 outbound
      await db.run(`
        INSERT INTO transactions (shop_id, product_id, product_name, type, quantity, unit_price,
          amount_before_gst, gst_amount, total_amount, platform_share, merchant_share, commission_gst,
          operator_id, operator_name, client_timestamp, client_record_id, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
      `, req.user.shopId, product.id, product.name, txType, q, product.sell_price || 0,
        f.amountBeforeGST, f.gstAmount, f.totalAmount,
        f.platformShare, f.merchantShare, f.commissionGst,
        req.user.userId, req.user.username, r.clientTimestamp || new Date().toISOString(), r.clientRecordId || null);
      await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, type, product.id, product.name,
        `离线补传(${type}): ${product.name}, 数量: ${q}`, device);
      await db.run('COMMIT');
      synced++;
      results.push({ clientRecordId: r.clientRecordId || null, status: 'synced' });
    } catch (err) {
      try { await db.run('ROLLBACK'); } catch (e) { /* ignore */ }
      failed++;
      results.push({ clientRecordId: r.clientRecordId || null, status: 'failed', error: err.message });
    }
  }
  res.json({ synced, duplicates, failed, total: records.length, results });
});

// GET /api/v1/logs — 操作日志（最近 200 条，含设备信息）
// 注意：本接口按 req.user.shopId 严格隔离，admin 也只能看自己店铺的日志。
// admin 若需跨店查看，应另行设计 superadmin 角色 + 独立接口，不走此路由。
router.get('/logs', v1Auth, requireRole('merchant', 'brand', 'admin'), async (req, res) => {
  const db = getDb();
  try {
    // 按当前用户的 shopId 过滤（修复跨租户越权）
    const logs = await db.all(`
      SELECT l.id, l.shop_id, s.shop_name, l.user_id, l.username, l.action, l.target_id, l.target_name,
             l.note, l.device_info, l.create_at, l.prev_hash, l.this_hash
      FROM audit_logs l LEFT JOIN shops s ON s.id = l.shop_id
      WHERE l.shop_id = ?
      ORDER BY l.id DESC LIMIT 200
    `, req.user.shopId);
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/export/excel — 服务端生成 Excel 对账报表（exceljs）
router.get('/export/excel', v1Auth, requireRole('merchant', 'brand', 'admin'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const db = getDb();
    const shopId = req.user.shopId;
    const s = await finance.getSettings();

    const shop = await db.get('SELECT * FROM shops WHERE id = ?', shopId);
    const rows = await db.all(`
      SELECT t.* FROM transactions t
      WHERE t.shop_id = ? ORDER BY t.id DESC LIMIT 1000
    `, shopId);

    const sum = (arr, key) => arr.reduce((a, r) => a + (Number(r[key]) || 0), 0);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'StockVerify';
    const CUR = s.currency.symbol;   // 货币符号（来自系统设置）
    const TAX = s.tax.name;          // 税种名称（来自系统设置）

    // ---- Sheet1 汇总统计 ----
    const ws1 = wb.addWorksheet('汇总统计');
    ws1.columns = [{ header: '项目', key: 'item', width: 30 }, { header: '数值', key: 'value', width: 26 }];
    ws1.addRow({ item: '店铺', value: shop.shop_name });
    ws1.addRow({ item: '国家/地区', value: s.country });
    ws1.addRow({ item: '货币', value: `${s.currency.code} (${CUR})` });
    ws1.addRow({ item: `${TAX} 税率`, value: s.tax.rate });
    ws1.addRow({ item: '口径', value: s.tax.priceIncludesTax ? `售价含${TAX}（不含税基数=售价÷${(1 + s.tax.rate).toFixed(2)}）` : `售价不含${TAX}` });
    ws1.addRow({ item: '平台分成比例', value: s.split.platform });
    ws1.addRow({ item: '商家分成比例', value: s.split.merchant });
    ws1.addRow({ item: '佣金率', value: s.commission.rate });
    ws1.addRow({ item: `佣金附加${TAX}`, value: s.commission.applyTax ? '是' : '否' });
    ws1.addRow({ item: '交易笔数', value: rows.length });
    ws1.addRow({ item: '入库笔数', value: rows.filter(r => r.type === 'inbound').length });
    ws1.addRow({ item: '出库笔数', value: rows.filter(r => r.type === 'outbound' || r.type === 'sale').length });
    ws1.addRow({ item: `不含税总额(${s.currency.code})`, value: Number(sum(rows, 'amount_before_gst').toFixed(2)) });
    ws1.addRow({ item: `${TAX} 总额(${s.currency.code})`, value: Number(sum(rows, 'gst_amount').toFixed(2)) });
    ws1.addRow({ item: `含税总额(${s.currency.code})`, value: Number(sum(rows, 'total_amount').toFixed(2)) });
    ws1.addRow({ item: `平台分成(${s.currency.code})`, value: Number(sum(rows, 'platform_share').toFixed(2)) });
    ws1.addRow({ item: `商家分成(${s.currency.code})`, value: Number(sum(rows, 'merchant_share').toFixed(2)) });
    const commissionGstTotal = Number(sum(rows, 'commission_gst').toFixed(2));
    const commissionTotal = s.tax.rate > 0 ? Number((commissionGstTotal / s.tax.rate).toFixed(2)) : 0;
    ws1.addRow({ item: `佣金(${s.currency.code})（=佣金附加税÷税率）`, value: commissionTotal });
    ws1.addRow({ item: `佣金附加${TAX}(${s.currency.code})`, value: commissionGstTotal });
    ws1.addRow({ item: '防重扫码窗口(ms)', value: s.scan.duplicateWindowMs });
    ws1.addRow({ item: '生成时间', value: new Date().toLocaleString('zh-CN') });

    // ---- Sheet2 交易明细 ----
    const ws2 = wb.addWorksheet('交易明细');
    ws2.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: '时间', key: 'ts', width: 22 },
      { header: '类型', key: 'type', width: 10 },
      { header: '商品ID', key: 'pid', width: 8 },
      { header: '商品名称', key: 'name', width: 20 },
      { header: '数量', key: 'qty', width: 6 },
      { header: `单价${s.tax.priceIncludesTax ? '含' : '不含'}${TAX}(${s.currency.code})`, key: 'price', width: 16 },
      { header: `不含税基数(${s.currency.code})`, key: 'base', width: 16 },
      { header: `${TAX}(${s.currency.code})`, key: 'gst', width: 12 },
      { header: `含税总额(${s.currency.code})`, key: 'total', width: 16 },
      { header: `平台分成(${s.currency.code})`, key: 'pf', width: 16 },
      { header: `商家分成(${s.currency.code})`, key: 'mf', width: 16 },
      { header: `佣金${TAX}(${s.currency.code})`, key: 'cg', width: 14 },
      { header: '操作人', key: 'op', width: 12 },
      { header: '同步状态', key: 'sync', width: 10 }
    ];
    for (const r of rows) {
      ws2.addRow({
        id: r.id,
        ts: r.server_timestamp || r.client_timestamp,
        type: r.type === 'inbound' ? '入库' : '出库',
        pid: r.product_id,
        name: r.product_name,
        qty: r.quantity,
        price: r.unit_price,
        base: r.amount_before_gst,
        gst: r.gst_amount,
        total: r.total_amount,
        pf: (r.type === 'outbound' || r.type === 'sale') ? r.platform_share : '-',
        mf: (r.type === 'outbound' || r.type === 'sale') ? r.merchant_share : '-',
        cg: r.commission_gst || 0,
        op: r.operator_name,
        sync: r.sync_status
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="stockverify-report-${dateStr}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

// GET /api/v1/config — 返回当前配置（含数据库 settings，供对接核对）
router.get('/config', async (req, res) => {
  const settings = await finance.getSettingsFlat();
  res.json({ success: true, settings });
});

// ==================== 管理端接口（需 admin 权限） ====================

// GET /api/v1/admin/settings — 财务参数
router.get('/admin/settings', v1Auth, requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, settings: await finance.getSettingsFlat() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/admin/settings — 修改系统参数（国家/货币/税种/税率/分成/佣金/含税开关/公式说明）
router.put('/admin/settings', v1Auth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const taxRate = num(b.taxRate);
    const platform = num(b.platformShareRatio);
    const merchant = num(b.merchantShareRatio);
    const commissionRate = num(b.commissionRate);
    const commissionTaxRate = num(b.commissionTaxRate);

    if (taxRate === null || taxRate < 0 || taxRate > 1) return res.status(400).json({ error: '税率必须是 0–1 之间的数字' });
    if (platform === null || platform < 0 || platform > 1) return res.status(400).json({ error: '平台分成比例必须是 0–1 之间的数字' });
    if (merchant === null || merchant < 0 || merchant > 1) return res.status(400).json({ error: '商家分成比例必须是 0–1 之间的数字' });
    if (commissionRate === null || commissionRate < 0 || commissionRate > 1) return res.status(400).json({ error: '佣金率必须是 0–1 之间的数字' });
    if (commissionTaxRate === null || commissionTaxRate < 0 || commissionTaxRate > 1) return res.status(400).json({ error: '佣金附加税率必须是 0–1 之间的数字' });
    const applyTax = b.commissionApplyTax === undefined ? true : Boolean(b.commissionApplyTax);
    const includesTax = b.priceIncludesTax === undefined ? true : Boolean(b.priceIncludesTax);
    const str = (v, fb) => (v === undefined || v === null || String(v).trim() === '' ? fb : String(v).trim());
    const country = str(b.country, 'Singapore');
    const currencyCode = str(b.currencyCode, 'SGD');
    const currencySymbol = str(b.currencySymbol, 'S$');
    const taxName = str(b.taxName, 'GST');
    const formulaNote = b.financeFormulaNote === undefined ? '' : String(b.financeFormulaNote).trim();

    await setSetting('country', country, req.user.username);
    await setSetting('currency_code', currencyCode, req.user.username);
    await setSetting('currency_symbol', currencySymbol, req.user.username);
    await setSetting('tax_name', taxName, req.user.username);
    await setSetting('tax_rate', taxRate, req.user.username);
    await setSetting('price_includes_tax', includesTax ? 1 : 0, req.user.username);
    await setSetting('platform_share_ratio', platform, req.user.username);
    await setSetting('merchant_share_ratio', merchant, req.user.username);
    await setSetting('commission_rate', commissionRate, req.user.username);
    await setSetting('commission_tax_rate', commissionTaxRate, req.user.username);
    await setSetting('commission_apply_tax', applyTax ? 1 : 0, req.user.username);
    await setSetting('finance_formula_note', formulaNote, req.user.username);
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'settings_update', null, '系统设置',
      `${country}/${currencyCode}/${taxName} 税率=${taxRate}, 含税=${includesTax ? '是' : '否'}, 平台分成=${platform}, 商家分成=${merchant}, 佣金率=${commissionRate}, 佣金附加税率=${commissionTaxRate}`);

    res.json({ success: true, settings: await finance.getSettingsFlat() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/admin/products — 商品列表（含库存与状态）
router.get('/admin/products', v1Auth, requireAdmin, async (req, res) => {
  const db = getDb();
  try {
    const list = await db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM product_items pi WHERE pi.catalog_id = c.id AND pi.status = 'merchant_stock') AS in_stock
      FROM product_catalog c ORDER BY c.id DESC
    `);
    res.json({ success: true, count: list.length, products: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/admin/products — 新增商品（商品库）
router.post('/admin/products', v1Auth, requireAdmin, async (req, res) => {
  const db = getDb();
  const { sku, name, category, costPrice, sellPrice, description } = req.body || {};
  const nm = String(name || '').trim();
  if (!nm) return res.status(400).json({ error: '商品名称不能为空' });
  const cost = Number(costPrice) || 0;
  const sell = Number(sellPrice) || 0;
  try {
    const r = await db.run(`
      INSERT INTO product_catalog (sku, name, category, cost_price, sell_price, description, created_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `, (sku || '').trim() || null, nm, (category || '').trim() || '未分类', cost, sell, (description || '').trim() || null, req.user.userId);
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_create', r.lastInsertRowid, nm,
      `新增商品: ${nm}, SKU: ${sku || '-'}, 分类: ${category || '未分类'}, 售价: ${sell}`);
    const created = await db.get('SELECT * FROM product_catalog WHERE id = ?', r.lastInsertRowid);
    res.json({ success: true, product: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/admin/products/:id — 编辑商品
router.put('/admin/products/:id', v1Auth, requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const b = req.body || {};
  try {
    const exist = await db.get('SELECT * FROM product_catalog WHERE id = ?', id);
    if (!exist) return res.status(404).json({ error: '商品不存在' });
    const name = b.name !== undefined ? String(b.name).trim() : exist.name;
    if (!name) return res.status(400).json({ error: '商品名称不能为空' });
    const sku = b.sku !== undefined ? (String(b.sku).trim() || null) : exist.sku;
    const category = b.category !== undefined ? (String(b.category).trim() || '未分类') : (exist.category || '未分类');
    const cost = b.costPrice !== undefined ? (Number(b.costPrice) || 0) : exist.cost_price;
    const sell = b.sellPrice !== undefined ? (Number(b.sellPrice) || 0) : exist.sell_price;
    const description = b.description !== undefined ? (String(b.description).trim() || null) : exist.description;
    await db.run('UPDATE product_catalog SET sku = ?, name = ?, category = ?, cost_price = ?, sell_price = ?, description = ? WHERE id = ?',
      sku, name, category, cost, sell, description, id);
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_update', id, name,
      `编辑商品: ${name}, 售价: ${sell}, 分类: ${category}`);
    const updated = await db.get('SELECT * FROM product_catalog WHERE id = ?', id);
    res.json({ success: true, product: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/products/:id/status — 上架 / 下架
router.patch('/admin/products/:id/status', v1Auth, requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (status !== 'active' && status !== 'inactive') {
    return res.status(400).json({ error: 'status 只能是 active 或 inactive' });
  }
  try {
    const exist = await db.get('SELECT * FROM product_catalog WHERE id = ?', id);
    if (!exist) return res.status(404).json({ error: '商品不存在' });
    await db.run('UPDATE product_catalog SET status = ? WHERE id = ?', status, id);
    await appendAuditLog(req.user.shopId, req.user.userId, req.user.username, 'product_status', id, exist.name,
      `${status === 'active' ? '上架' : '下架'}商品: ${exist.name}`);
    res.json({ success: true, product: { id, status } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
