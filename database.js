/**
 * 数据库初始化模块
 * 使用 node‑sqlite3‑wasm，单条执行建表，不允许多条SQL合并到一次run
 */
const { Database } = require('node-sqlite3-wasm');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
// 数据库路径支持环境变量覆盖（生产部署用 DATABASE_PATH 指定位置）
const DB_FILE = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, 'inventory.db');

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    const raw = new Database(DB_FILE);
    // 兼容 better-sqlite3 变长参数调用风格：db.run(sql, p1, p2) 或 db.run(sql, [p1, p2])
    // node-sqlite3-wasm 只接受数组/对象形式的参数，这里做归一化包装，避免多参数只绑定第1个导致 NULL 约束崩溃
    const wrap = (method) => function (sql, ...args) {
      let values;
      if (args.length === 1 && Array.isArray(args[0])) {
        values = args[0];
      } else if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
        values = args[0]; // 命名参数对象
      } else {
        values = args;
      }
      return raw[method](sql, values);
    };
    dbInstance = {
      run: wrap('run'),
      get: wrap('get'),
      all: wrap('all'),
      exec: raw.exec.bind(raw),
      prepare: raw.prepare.bind(raw)
    };
  }
  return dbInstance;
}

async function initDB() {
  const db = getDb();

  // 店铺表
  await db.run(`
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_key TEXT UNIQUE NOT NULL,
  shop_name TEXT,
  gst_rate REAL DEFAULT 0.09,
  platform_share_ratio REAL DEFAULT 0.7,
  merchant_share_ratio REAL DEFAULT 0.3,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)
`);

  // 用户表【修复：username 删除 NOT NULL】
  await db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  is_first_login INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(shop_id) REFERENCES shops(id)
)
`);

  // 商品表
  await db.run(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  sku TEXT,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT DEFAULT '未分类',
  cost_price REAL DEFAULT 0,
  sell_price REAL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  threshold INTEGER DEFAULT 10,
  last_write_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(shop_id) REFERENCES shops(id)
)
`);

  // 交易流水表
  await db.run(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL,
  amount_before_gst REAL,
  gst_amount REAL,
  total_amount REAL,
  platform_share REAL DEFAULT 0,
  merchant_share REAL DEFAULT 0,
  commission_gst REAL DEFAULT 0,
  operator_id INTEGER,
  operator_name TEXT,
  client_timestamp TEXT,
  client_record_id TEXT UNIQUE,
  sync_status TEXT DEFAULT 'synced',
  server_timestamp TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(shop_id) REFERENCES shops(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
)
`);

  // 审计日志表（防篡改链）
  await db.run(`
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target_id INTEGER,
  target_name TEXT,
  note TEXT,
  prev_hash TEXT DEFAULT '',
  this_hash TEXT,
  create_at TEXT DEFAULT (datetime('now','localtime'))
)
`);

  // 索引
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shop_users ON users(shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shop_products ON products(shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shop_trans ON transactions(shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shop_audit ON audit_logs(shop_id)`);

  // 迁移：审计日志加设备信息列（API v1 接口记录设备，不参与哈希链，不影响防篡改）
  const auditCols = db.all(`PRAGMA table_info(audit_logs)`).map(c => c.name);
  if (!auditCols.includes('device_info')) {
    await db.run(`ALTER TABLE audit_logs ADD COLUMN device_info TEXT`);
  }

  // ========== 迁移：用户名+密码登录（v0.2.0） ==========
  // users 表加 bcrypt 密码哈希列（v1 登录用；原登录逻辑不受影响）
  const userCols = db.all(`PRAGMA table_info(users)`).map(c => c.name);
  if (!userCols.includes('password_hash')) {
    await db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }
  // 用户名全局唯一索引（v1 登录按用户名查询的前提；数据已确认无重复）
  try { await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`); } catch (e) { /* 历史重复数据存在时跳过 */ }

  // 财务参数表（管理端可配置；config.json 仅作缺省值）
  await db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 种子默认值（与 config.json 一致；管理端修改后覆盖）
  const defaultSettings = [
    ['gst_rate', '0.09'],
    ['platform_share_ratio', '0.7'],
    ['merchant_share_ratio', '0.3'],
    ['commission_rate', '0.03'],
    ['commission_apply_gst', '1']
  ];
  for (const [k, v] of defaultSettings) {
    const exist = db.get('SELECT key FROM settings WHERE key = ?', k);
    if (!exist) await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, v);
  }

  // 商品库表加 SKU / 分类列（管理端商品管理用）
  const catalogCols = db.all(`PRAGMA table_info(product_catalog)`).map(c => c.name);
  if (!catalogCols.includes('sku')) {
    await db.run(`ALTER TABLE product_catalog ADD COLUMN sku TEXT`);
  }
  if (!catalogCols.includes('category')) {
    await db.run(`ALTER TABLE product_catalog ADD COLUMN category TEXT DEFAULT '未分类'`);
  }

  // ========== 迁移：老库补列（品牌方/合作商家） ==========
  const shopCols = db.all(`PRAGMA table_info(shops)`).map(c => c.name);
  if (!shopCols.includes('type')) {
    await db.run(`ALTER TABLE shops ADD COLUMN type TEXT DEFAULT 'merchant'`);
  }
  if (!shopCols.includes('parent_id')) {
    await db.run(`ALTER TABLE shops ADD COLUMN parent_id INTEGER`);
  }
  if (!shopCols.includes('country')) {
    await db.run(`ALTER TABLE shops ADD COLUMN country TEXT DEFAULT 'SG'`);
  }
  // 历史数据：未设国家的商家默认新加坡（GST 9%）
  const cntryRows = db.all(`SELECT id FROM shops WHERE type='merchant' AND country IS NULL`).map(r => r.id);
  if (cntryRows.length > 0) {
    await db.run(`UPDATE shops SET country='SG' WHERE id IN (${cntryRows.join(',')})`);
  }
  // 历史数据迁移：确保存在一个品牌方（无品牌时把最老店铺设为品牌方）
  const brandCount = db.get(`SELECT COUNT(*) c FROM shops WHERE type='brand'`).c;
  if (brandCount === 0) {
    const first = db.get(`SELECT MIN(id) m FROM shops`).m;
    if (first) await db.run(`UPDATE shops SET type='brand' WHERE id = ?`, first);
  }

  const transCols = db.all(`PRAGMA table_info(transactions)`).map(c => c.name);
  if (!transCols.includes('shipment_id')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN shipment_id INTEGER`);
  }
  if (!transCols.includes('verified')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN verified INTEGER DEFAULT 0`);
  }
  // 活动折扣字段（与中医馆合作：消费凭证-10 / 社媒分享-10）
  if (!transCols.includes('discount_type')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_type TEXT DEFAULT 'none'`);
  }
  if (!transCols.includes('discount_amount')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_amount REAL DEFAULT 0`);
  }
  if (!transCols.includes('discount_medical_img')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_medical_img TEXT`);
  }
  if (!transCols.includes('discount_social_img')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_social_img TEXT`);
  }
  if (!transCols.includes('discount_status')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_status TEXT DEFAULT 'none'`); // none/pending/approved/rejected
  }
  if (!transCols.includes('discount_reviewed_by')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_reviewed_by TEXT`);
  }
  if (!transCols.includes('discount_reviewed_at')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discount_reviewed_at TEXT`);
  }
  if (!transCols.includes('discounted_price')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN discounted_price REAL`);
  }
  // 品牌/商家分成（7:3，按折后金额；折扣先从品牌七成扣，驳回则从商家三成扣还）
  if (!transCols.includes('brand_share')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN brand_share REAL DEFAULT 0`);
  }
  if (!transCols.includes('merchant_share')) {
    await db.run(`ALTER TABLE transactions ADD COLUMN merchant_share REAL DEFAULT 0`);
  }
  // 进货单（合作商家向品牌进货：数量 + 付款截图，进货价 20 SGD/个）
  const poCols = db.all(`PRAGMA table_info(purchase_orders)`).map(c => c.name);
  if (poCols.length === 0) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT NOT NULL,
        barcode TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_cost REAL NOT NULL DEFAULT 20,
        total_cost REAL NOT NULL DEFAULT 0,
        payment_img TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_po_shop ON purchase_orders(shop_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status)`);
  }
  // 上传凭证图片目录
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

  // 发货单表（品牌方寄货 → 合作商家收货）
  await db.run(`
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_shop_id INTEGER NOT NULL,
  merchant_shop_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft 草稿 / shipped 已发货 / received 已收货
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  shipped_at TEXT
)
`);
  // 发货单项（逐件扫码清点）
  await db.run(`
CREATE TABLE IF NOT EXISTS shipment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  barcode TEXT NOT NULL,
  product_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  scanned_count INTEGER NOT NULL DEFAULT 0,   -- 品牌方清点扫码数
  received_qty INTEGER NOT NULL DEFAULT 0     -- 商家已核对收货数
)
`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shipment_brand ON shipments(brand_shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shipment_merchant ON shipments(merchant_shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shipment_items ON shipment_items(shipment_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_shipment_barcode ON shipment_items(barcode)`);

  // 迁移：shops 表加字段（忽略已存在错误）
  try { await db.run(`ALTER TABLE shops ADD COLUMN type TEXT DEFAULT 'merchant'`); } catch(e) {}
  try { await db.run(`ALTER TABLE shops ADD COLUMN parent_id INTEGER`); } catch(e) {}
  try { await db.run(`ALTER TABLE shops ADD COLUMN country TEXT DEFAULT 'SG'`); } catch(e) {}
  try { await db.run(`ALTER TABLE shops ADD COLUMN password_changed INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.run(`ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '[]'`); } catch(e) {}
  // 进货单加分配字段
  try { await db.run(`ALTER TABLE purchase_orders ADD COLUMN assigned_to INTEGER`); } catch(e) {}
  try { await db.run(`ALTER TABLE purchase_orders ADD COLUMN assigned_by INTEGER`); } catch(e) {}
  try { await db.run(`ALTER TABLE purchase_orders ADD COLUMN assigned_at TEXT`); } catch(e) {}
  // 发货单加关联进货单和款名
  try { await db.run(`ALTER TABLE shipments ADD COLUMN purchase_order_id INTEGER`); } catch(e) {}
  try { await db.run(`ALTER TABLE shipments ADD COLUMN product_name TEXT`); } catch(e) {}
  try { await db.run(`ALTER TABLE shipments ADD COLUMN assigned_by INTEGER`); } catch(e) {}
  try { await db.run(`ALTER TABLE purchase_orders ADD COLUMN catalog_id INTEGER`); } catch(e) {}
  // 商品库表加字段（旧表迁移）
  try { await db.run(`ALTER TABLE product_catalog ADD COLUMN promo_image TEXT`); } catch(e) {}
  // 商品库（超管创建的商品模板，逐级授权后商家可进货）
  await db.run(`
    CREATE TABLE IF NOT EXISTS product_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cost_price REAL NOT NULL DEFAULT 20,
      sell_price REAL NOT NULL DEFAULT 188,
      description TEXT,
      promo_image TEXT,
      created_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 商品授权记录（catalog_id → shop_id，逐级授权）
  await db.run(`
    CREATE TABLE IF NOT EXISTS product_catalog_auth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      authorized_by INTEGER,
      level TEXT NOT NULL DEFAULT 'brand',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 总代地区宣传内容（每个总代每个商品一份）
  await db.run(`
    CREATE TABLE IF NOT EXISTS product_catalog_region (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      content TEXT,
      image TEXT,
      updated_by INTEGER,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pca_catalog ON product_catalog_auth(catalog_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pca_shop ON product_catalog_auth(shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pcr_catalog ON product_catalog_region(catalog_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pcr_brand ON product_catalog_region(brand_id)`);

  // 一物一码：商品实例表（每个物理商品一条记录）
  await db.run(`
    CREATE TABLE IF NOT EXISTS product_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL UNIQUE,
      catalog_id INTEGER,
      product_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'agent_stock',
      -- agent_stock 代理库存 / in_transit 在途(已发货未入库) / merchant_stock 商铺库存 / sold 已售
      agent_shop_id INTEGER,
      merchant_shop_id INTEGER,
      shipment_id INTEGER,
      cost_price REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      shipped_at TEXT,
      received_at TEXT,
      sold_at TEXT,
      sold_transaction_id INTEGER
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pi_status ON product_items(status)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pi_agent ON product_items(agent_shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pi_merchant ON product_items(merchant_shop_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pi_shipment ON product_items(shipment_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_pi_catalog ON product_items(catalog_id)`);
}

// 追加审计日志，计算哈希链
// deviceInfo 为可选参数（记录设备信息）；不参与哈希计算，链结构保持不变
// 哈希公式：sha256(shop_id|user_id|username|action|target_id|target_name|note|prev_hash)，追加与校验完全一致
async function appendAuditLog(shopId, userId, username, action, targetId, targetName, note, deviceInfo) {
  const db = getDb();
  const lastRow = await db.get(`SELECT this_hash FROM audit_logs WHERE shop_id = ? ORDER BY id DESC LIMIT 1`, shopId);
  const prevHash = lastRow?.this_hash || '';
  const raw = `${shopId}|${userId}|${username}|${action}|${targetId}|${targetName}|${note}|${prevHash}`;
  const crypto = require('crypto');
  const thisHash = crypto.createHash('sha256').update(raw).digest('hex');
  await db.run(`
INSERT INTO audit_logs(shop_id,user_id,username,action,target_id,target_name,note,prev_hash,this_hash,device_info)
VALUES (?,?,?,?,?,?,?,?,?,?)
`, shopId, userId, username, action, targetId, targetName, note, prevHash, thisHash, deviceInfo || null);
}

// 校验审计链完整性（公式与 appendAuditLog 一致）
async function verifyAuditChain(shopId) {
  const db = getDb();
  const list = await db.all(`SELECT * FROM audit_logs WHERE shop_id = ? ORDER BY id ASC`, shopId);
  let ok = true;
  let lastHash = '';
  for(const row of list){
    if(row.prev_hash !== lastHash){ ok = false; break; }
    const raw = `${row.shop_id}|${row.user_id}|${row.username}|${row.action}|${row.target_id}|${row.target_name}|${row.note}|${row.prev_hash}`;
    const crypto = require('crypto');
    const calc = crypto.createHash('sha256').update(raw).digest('hex');
    if(calc !== row.this_hash){ ok = false; break; }
    lastHash = row.this_hash;
  }
  return { valid: ok, total: list.length };
}

module.exports = {
  initDB,
  getDb,
  appendAuditLog,
  verifyAuditChain
};
