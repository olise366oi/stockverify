'use strict';
/**
 * 财务计算模块（服务端）
 * -------------------------------------------------
 * 所有参数（国家 / 货币 / 税种 / 税率 / 分成 / 佣金）优先从数据库 settings 表读取
 * （管理端「系统设置」页可配置），config.json 仅作为缺省默认值。
 * 本模块只被 /api/v1/* 接口使用，不影响原有 /api/transactions/* 算法
 * （原算法仍读 shops 表的店铺级参数）。
 *
 * 支持两种口径（由设置 priceIncludesTax 切换）：
 *   售价含税：不含税基数 = 售价 ÷ (1 + 税率)，税额 = 基数 × 税率，含税总额 = 基数 + 税额
 *   售价不含税：不含税基数 = 售价，税额 = 基数 × 税率，含税总额 = 基数 + 税额
 * 平台/商家分成按不含税基数 × 比例（默认 70% / 30%）
 * 佣金 = 不含税基数 × 佣金率（默认 3%）；佣金附加税 = 佣金 × 税率（可开关）
 */
const fs = require('fs');
const path = require('path');
const { getDb } = require('./database');

let _config = null;

/** 读取 config.json（缓存；文件损坏时抛出明确错误）——仅作缺省默认值 */
function loadConfig() {
  if (_config) return _config;
  _config = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  );
  return _config;
}

/** 四舍五入到 2 位小数（财务金额） */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** 从数据库 settings 表读取系统参数（缺省回落到 config.json） */
async function getSettings() {
  const cfg = loadConfig();
  const db = getDb();
  let rows = [];
  try {
    rows = await db.all('SELECT key, value FROM settings');
  } catch (e) {
    rows = [];
  }
  const map = {};
  for (const r of rows) map[r.key] = r.value;

  const num = (k, fallback) => {
    const v = map[k];
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (k, fallback) => (map[k] === undefined || map[k] === null || map[k] === '' ? fallback : String(map[k]));

  return {
    country: str('country', cfg.finance.country),
    currency: {
      code: str('currency_code', cfg.finance.currencyCode),
      symbol: str('currency_symbol', cfg.finance.currencySymbol)
    },
    tax: {
      name: str('tax_name', cfg.finance.taxName),
      rate: num('tax_rate', cfg.finance.taxRate),
      priceIncludesTax: map.price_includes_tax === undefined
        ? cfg.finance.priceIncludesTax
        : Number(map.price_includes_tax) === 1
    },
    split: {
      platform: num('platform_share_ratio', cfg.finance.platformShareRatio),
      merchant: num('merchant_share_ratio', cfg.finance.merchantShareRatio)
    },
    commission: {
      rate: num('commission_rate', cfg.finance.commissionRate),
      taxRate: num('commission_tax_rate', cfg.finance.commissionTaxRate),
      applyTax: map.commission_apply_tax === undefined
        ? cfg.finance.commissionApplyTax
        : Number(map.commission_apply_tax) === 1
    },
    formulaNote: str('finance_formula_note', ''),
    scan: cfg.scan
  };
}

/**
 * 计算单笔交易的全部财务字段
 * @param {number} quantity   数量
 * @param {number} unitPrice  单价（售价，是否含税由设置 priceIncludesTax 决定）
 * @returns {Promise<object>} 财务字段
 */
async function calculate(quantity, unitPrice) {
  const cfg = await getSettings();
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const taxRate = cfg.tax.rate;
  const includesTax = cfg.tax.priceIncludesTax;

  // 双模式：售价含税 → 倒推不含税基数；售价不含税 → 基数即售价
  const amountBeforeGST = includesTax
    ? round2((qty * price) / (1 + taxRate))
    : round2(qty * price);
  const gstAmount = round2(amountBeforeGST * taxRate);
  const totalAmount = round2(amountBeforeGST + gstAmount);

  // 7/3 分成（按不含税基数）
  const platformShare = round2(amountBeforeGST * cfg.split.platform);
  const merchantShare = round2(amountBeforeGST * cfg.split.merchant);

  // 佣金 + 佣金附加税
  const commission = round2(amountBeforeGST * cfg.commission.rate);
  const commissionGst = cfg.commission.applyTax
    ? round2(commission * cfg.commission.taxRate)
    : 0;

  return {
    amountBeforeGST,
    gstAmount,
    totalAmount,
    platformShare,
    merchantShare,
    commission,
    commissionGst,
    taxRate,
    priceIncludesTax: cfg.tax.priceIncludesTax,
    // 展示用元数据（货币 / 税种，来自系统设置）
    taxName: cfg.tax.name,
    currencyCode: cfg.currency.code,
    currencySymbol: cfg.currency.symbol,
    country: cfg.country
  };
}

/** 管理端「系统设置」页读写用的平铺结构 */
async function getSettingsFlat() {
  const s = await getSettings();
  return {
    country: s.country,
    currencyCode: s.currency.code,
    currencySymbol: s.currency.symbol,
    taxName: s.tax.name,
    taxRate: s.tax.rate,
    priceIncludesTax: s.tax.priceIncludesTax,
    platformShareRatio: s.split.platform,
    merchantShareRatio: s.split.merchant,
    commissionRate: s.commission.rate,
    commissionTaxRate: s.commission.taxRate,
    commissionApplyTax: s.commission.applyTax,
    financeFormulaNote: s.formulaNote
  };
}

module.exports = { calculate, round2, loadConfig, getSettings, getSettingsFlat };
