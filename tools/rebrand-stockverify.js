'use strict';
/**
 * StockVerify SG 商业化改造 · 数据迁移脚本
 * -------------------------------------------------
 * 只改「命名 / 数据 / 包装」，不改业务逻辑；可重复执行（以新卡密/新商品 SKU 是否已存在判断幂等）。
 * 处理范围：
 *   1. 全部店铺改名 + 换卡密（去测试化，中性化）
 *   2. 3 家合作商铺卡密（Orchard Central / Jurong Point / Tampines Mall）
 *   3. 商品真实化：products（36 个新加坡零售品类）、product_catalog（5 个）、product_items 名称
 *   4. 交易流水商品名同步、审计日志商品名同步 + 哈希链按统一公式重算（修复原校验不一致问题）
 * 运行：node tools/rebrand-stockverify.js
 */
const crypto = require('crypto');
const { getDb } = require('../database');
const db = getDb();

function log(...args) { console.log('[迁移]', ...args); }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ==================== 1. 店铺改名 + 换卡密 ====================
const SHOP_RENAMES = [
  { id: 42, name: '总部管理端',   key: 'SV-ADM-8Q4Z-2MN6' },
  { id: 43, name: '运营管理端',   key: 'SV-ADM-1B7C-3DF9' },
  { id: 44, name: '财务管理端',   key: 'SV-ADM-5G2H-8JK1' },
  { id: 45, name: '数据管理端',   key: 'SV-ADM-4M9N-7PQ2' },
  { id: 57, name: '区域管理端',   key: 'SV-ADM-6RT3-0UV4' },
  { id: 46, name: '品牌运营中心', key: 'SV-BRD-2WX5-8YZ6' },
  { id: 54, name: '区域代理中心', key: 'SV-BRD-9ABC-4DEF' },
  { id: 56, name: '品牌合作中心', key: 'SV-BRD-7GHI-1JKL' },
  { id: 58, name: '品牌管理部',   key: 'SV-BRD-3MNO-5PQR' },
  { id: 60, name: 'Suntec City', key: 'SV-SG-4X6M-8KP2' },
  { id: 47, name: 'Orchard Central', key: 'SV-SG-7K2M-9QX4' }
];

// 每家店铺的用户改名规则（首个用户用店主名，其余按序加后缀）
function userNamesForShop(shopNameKey) {
  const base = {
    'Orchard Central': 'orchard_owner',
    'Suntec City': 'suntec_owner',
    '总部管理端': 'admin_01', '运营管理端': 'admin_02', '财务管理端': 'admin_03',
    '数据管理端': 'admin_04', '区域管理端': 'admin_05',
    '品牌运营中心': 'brand_01', '区域代理中心': 'brand_02', '品牌合作中心': 'brand_03', '品牌管理部': 'brand_04'
  };
  return base[shopNameKey] || 'user';
}

// 新增合作商铺（卡密由用户指定）
const NEW_SHOPS = [
  { name: 'Jurong Point',  key: 'SV-SG-3P8N-5RT2', user: 'jurong_owner' },
  { name: 'Tampines Mall', key: 'SV-SG-9W4H-6YB7', user: 'tampines_owner' }
];

// ==================== 2. 商品真实化数据 ====================
// 字段：name / sku / category / cost / sell / stock / threshold
const P_ORCHARD = [
  ['虎标万金油 30g', 'SV-TIG-001', '药品', 3.90, 6.50, 120, 20],
  ['白花油 20ml', 'SV-WFL-001', '药品', 5.40, 8.90, 85, 15],
  ['三脚标清热水 500ml', 'SV-TRL-001', '药品', 6.20, 10.80, 60, 15],
  ['斧标驱风油 56ml', 'SV-AXE-001', '药品', 4.30, 7.50, 95, 20],
  ['余仁生保婴丹', 'SV-EYS-001', '药品', 9.50, 15.90, 40, 10],
  ['黄道益活络油 50ml', 'SV-HDY-001', '药品', 7.20, 12.50, 55, 10],
  ['鳄鱼油修护霜 50g', 'SV-CRO-001', '药品', 9.80, 16.80, 45, 10],
  ['美禄 400g', 'SV-MIL-001', '食品', 5.30, 9.50, 140, 25],
  ['咖椰酱 240g', 'SV-KAY-001', '食品', 2.60, 4.80, 200, 30],
  ['肉骨茶料包 2包装', 'SV-BKT-001', '食品', 4.20, 7.90, 110, 20],
  ['白咖啡 3合1 15包', 'SV-OLD-001', '食品', 3.80, 6.90, 160, 25],
  ['辣椒螃蟹酱 200g', 'SV-CRB-001', '食品', 5.00, 8.90, 75, 15],
  ['叻沙酱 180g', 'SV-LKS-001', '食品', 3.30, 5.90, 90, 15],
  ['100PLUS 325ml×6', 'SV-PLS-001', '食品', 3.60, 6.50, 130, 20],
  ['鱼尾狮造型巧克力 100g', 'SV-CHC-001', '食品', 7.40, 12.90, 50, 10],
  ['新加坡鱼尾狮钥匙扣', 'SV-SVN-001', '日用品', 2.50, 4.50, 180, 25],
  ['藤编收纳篮 中号', 'SV-BSK-001', '日用品', 10.50, 18.00, 35, 8],
  ['薏米水 250ml×6', 'SV-BRW-001', '日用品', 3.20, 5.50, 120, 20],
  ['新加坡地图明信片套装', 'SV-PST-001', '日用品', 2.80, 5.20, 150, 20]
];
const P_SUNTEC = [
  ['虎标镇痛膏布 10片', 'SV-TIG-002', '药品', 6.80, 11.50, 70, 12],
  ['无花果夹心饼 300g', 'SV-FIG-001', '食品', 3.10, 5.80, 100, 15],
  ['娘惹糕礼盒 500g', 'SV-NYA-001', '食品', 8.90, 15.50, 40, 8],
  ['驱蚊喷雾 100ml', 'SV-MOS-001', '日用品', 4.40, 7.80, 85, 12],
  ['手信帆布袋', 'SV-BAG-001', '日用品', 5.60, 9.90, 65, 10]
];
const P_JURONG = [
  ['虎标万金油 18g 便携装', 'SV-TIG-003', '药品', 2.20, 3.80, 150, 20],
  ['金骏眉茶包 25包', 'SV-TEA-001', '食品', 7.80, 13.50, 55, 10],
  ['咖喱鱼头酱 200g', 'SV-CUR-001', '食品', 4.60, 7.90, 70, 12],
  ['黑胡椒酱 200g', 'SV-PEP-001', '食品', 3.90, 6.80, 80, 12],
  ['钥匙扣套装 鱼尾狮×3', 'SV-SVN-002', '日用品', 4.20, 7.50, 90, 15],
  ['冷萃咖啡 250ml×4', 'SV-COF-001', '食品', 5.90, 10.20, 60, 10]
];
const P_TAMPINES = [
  ['白花油 10ml 便携装', 'SV-WFL-002', '药品', 3.40, 5.90, 110, 15],
  ['椰糖 200g', 'SV-GUL-001', '食品', 3.00, 5.50, 95, 15],
  ['鱼皮零食 麻辣味 80g', 'SV-FSK-001', '食品', 2.90, 5.20, 130, 20],
  ['燕麦饼干 400g', 'SV-OAT-001', '食品', 4.10, 7.20, 85, 12],
  ['新加坡纪念 T 恤 L', 'SV-TSH-001', '日用品', 9.00, 15.90, 45, 8],
  ['冰箱贴套装 4件', 'SV-MAG-001', '日用品', 3.60, 6.50, 100, 15]
];

// 商品模板（product_catalog，驱动商家端库存列表）
const CATALOG_MAP = [
  { id: 12, name: '虎标万金油 30g', cost: 3.90, sell: 6.50 },
  { id: 13, name: '美禄 400g', cost: 5.30, sell: 9.50 },
  { id: 14, name: '咖椰酱 240g', cost: 2.60, sell: 4.80 },
  { id: 15, name: '白花油 20ml', cost: 5.40, sell: 8.90 },
  { id: 16, name: '新加坡鱼尾狮钥匙扣', cost: 2.50, sell: 4.50 }
];

// ==================== 执行 ====================
(async () => {
  // ---- 1. 店铺改名 ----
  for (const s of SHOP_RENAMES) {
    const existing = db.get('SELECT id FROM shops WHERE card_key = ?', s.key);
    if (existing) { log(`跳过（卡密已存在）: ${s.name}`); continue; }
    const shop = db.get('SELECT * FROM shops WHERE id = ?', s.id);
    if (!shop) { log(`跳过（店铺不存在 id=${s.id}）`); continue; }
    db.run('UPDATE shops SET card_key = ?, shop_name = ?, type = ?, country = ? WHERE id = ?',
      s.key, s.name, shop.type || 'merchant', shop.country || 'SG', s.id);
    // 用户改名
    const users = db.all('SELECT * FROM users WHERE shop_id = ? ORDER BY id ASC', s.id);
    const baseName = userNamesForShop(s.name);
    users.forEach((u, i) => {
      const newName = i === 0 ? baseName : `${baseName}_staff_${i}`;
      if (u.username !== newName) {
        db.run('UPDATE users SET username = ? WHERE id = ?', newName, u.id);
        db.run('UPDATE audit_logs SET username = ? WHERE user_id = ?', newName, u.id);
        db.run('UPDATE transactions SET operator_name = ? WHERE operator_id = ?', newName, u.id);
      }
    });
    log(`店铺改名: ${shop.shop_name} → ${s.name}（卡密 ${s.key}）`);
  }

  // ---- 2. 新增合作商铺 ----
  for (const ns of NEW_SHOPS) {
    const existing = db.get('SELECT id FROM shops WHERE card_key = ?', ns.key);
    if (existing) { log(`跳过（卡密已存在）: ${ns.name}`); continue; }
    const r = db.run(`INSERT INTO shops (card_key, shop_name, gst_rate, platform_share_ratio, merchant_share_ratio, type, country, parent_id, created_at)
      VALUES (?, ?, 0.09, 0.7, 0.3, 'merchant', 'SG', 46, datetime('now','localtime'))`, ns.key, ns.name);
    const shopId = db.get('SELECT id FROM shops WHERE card_key = ?', ns.key).id;
    db.run(`INSERT INTO users (shop_id, username, role, permissions, is_first_login) VALUES (?, ?, 'merchant', '[]', 1)`, shopId, ns.user);
    log(`新建店铺: ${ns.name}（卡密 ${ns.key}, shop_id=${shopId}, 用户 ${ns.user}）`);
  }

  // ---- 3. 商品真实化 ----
  // 3.1 捕获旧商品名（用于日志/流水同步）
  const oldProducts = db.all('SELECT id, shop_id, name FROM products');

  function applyProducts(shopId, list) {
    const rows = db.all('SELECT id FROM products WHERE shop_id = ? ORDER BY id ASC', shopId);
    if (rows.length !== list.length) {
      log(`警告: 店铺 ${shopId} 商品数 ${rows.length} ≠ 计划 ${list.length}，跳过该店商品更新`);
      return;
    }
    rows.forEach((r, i) => {
      const [name, sku, category, cost, sell, stock, threshold] = list[i];
      db.run(`UPDATE products SET name = ?, sku = ?, barcode = ?, category = ?, cost_price = ?, sell_price = ?, stock = ?, threshold = ? WHERE id = ?`,
        name, sku, sku, category, cost, sell, stock, threshold, r.id);
    });
    log(`商品更新: 店铺 ${shopId} × ${list.length}`);
  }

  applyProducts(47, P_ORCHARD);
  applyProducts(60, P_SUNTEC);

  // 给两家新店补商品（按实际 shop id）
  const jurongShop = db.get('SELECT id FROM shops WHERE card_key = ?', 'SV-SG-3P8N-5RT2');
  const tampinesShop = db.get('SELECT id FROM shops WHERE card_key = ?', 'SV-SG-9W4H-6YB7');
  if (jurongShop) {
    for (const [name, sku, category, cost, sell, stock, threshold] of P_JURONG) {
      db.run(`INSERT INTO products (shop_id, sku, barcode, name, category, cost_price, sell_price, stock, threshold, last_write_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
        jurongShop.id, sku, sku, name, category, cost, sell, stock, threshold);
    }
    log(`Jurong Point 新增商品 × ${P_JURONG.length}`);
  }
  if (tampinesShop) {
    for (const [name, sku, category, cost, sell, stock, threshold] of P_TAMPINES) {
      db.run(`INSERT INTO products (shop_id, sku, barcode, name, category, cost_price, sell_price, stock, threshold, last_write_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
        tampinesShop.id, sku, sku, name, category, cost, sell, stock, threshold);
    }
    log(`Tampines Mall 新增商品 × ${P_TAMPINES.length}`);
  }

  // 3.2 商品模板改名
  for (const c of CATALOG_MAP) {
    const cat = db.get('SELECT id FROM product_catalog WHERE id = ?', c.id);
    if (!cat) { log(`跳过（模板不存在 id=${c.id}）`); continue; }
    db.run('UPDATE product_catalog SET name = ?, cost_price = ?, sell_price = ? WHERE id = ?', c.name, c.cost, c.sell, c.id);
    log(`商品模板: #${c.id} → ${c.name}`);
  }
  // 3.3 一物一码实例名称同步（按模板）
  for (const c of CATALOG_MAP) {
    db.run('UPDATE product_items SET product_name = ? WHERE catalog_id = ?', c.name, c.id);
  }
  log('product_items 名称已按模板同步');

  // 3.4 交易流水商品名同步（与 products 表一致）
  db.run(`
    UPDATE transactions SET product_name = (
      SELECT p.name FROM products p WHERE p.id = transactions.product_id AND p.shop_id = transactions.shop_id
    ) WHERE EXISTS (
      SELECT 1 FROM products p2 WHERE p2.id = transactions.product_id AND p2.shop_id = transactions.shop_id
    )
  `);
  log('transactions.product_name 已同步');

  // ---- 4. 审计日志：商品名同步 + 哈希链重算 ----
  // 4.1 更新日志里的商品名（target_name 与 note 中的旧名）
  const newProducts = db.all('SELECT id, shop_id, name FROM products');
  const oldNameById = {};
  for (const p of oldProducts) oldNameById[p.id] = p.name;
  const newNameById = {};
  for (const p of newProducts) newNameById[p.id] = p.name;

  const auditRows = db.all('SELECT * FROM audit_logs');
  for (const row of auditRows) {
    const oldName = oldNameById[row.target_id];
    const newName = newNameById[row.target_id];
    if (!oldName || !newName || oldName === newName) continue;
    let targetName = row.target_name;
    let note = row.note;
    if (targetName === oldName) targetName = newName;
    if (note && note.includes(oldName)) note = note.split(oldName).join(newName);
    db.run('UPDATE audit_logs SET target_name = ?, note = ? WHERE id = ?', targetName, note, row.id);
  }
  log('audit_logs 商品名已同步');

  // 4.2 哈希链按统一公式重算（修复追加/校验公式不一致的问题）
  // 统一公式：sha256(shop_id|user_id|username|action|target_id|target_name|note|prev_hash)
  const shops = db.all('SELECT DISTINCT shop_id FROM audit_logs ORDER BY shop_id');
  for (const { shop_id } of shops) {
    const rows = db.all('SELECT * FROM audit_logs WHERE shop_id = ? ORDER BY id ASC', shop_id);
    let prevHash = '';
    for (const r of rows) {
      const raw = `${r.shop_id}|${r.user_id}|${r.username}|${r.action}|${r.target_id}|${r.target_name}|${r.note}|${prevHash}`;
      const thisHash = crypto.createHash('sha256').update(raw).digest('hex');
      db.run('UPDATE audit_logs SET prev_hash = ?, this_hash = ? WHERE id = ?', prevHash, thisHash, r.id);
      prevHash = thisHash;
    }
  }
  log('audit_logs 哈希链已按统一公式重算');

  // ---- 5. 汇总 ----
  log('==================== 完成 ====================');
  log('合作商铺（卡密登录）:');
  log('  Orchard Central  → SV-SG-7K2M-9QX4');
  log('  Jurong Point      → SV-SG-3P8N-5RT2');
  log('  Tampines Mall     → SV-SG-9W4H-6YB7');
  log('  Suntec City       → SV-SG-4X6M-8KP2（原测试店中性化）');
  log('商品总数: ' + db.get('SELECT COUNT(*) c FROM products').c);
  log('日志校验: /api/logs/verify 应返回 valid:true');
})().catch(err => { console.error('迁移失败:', err); process.exit(1); });
