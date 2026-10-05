'use strict';
/**
 * 财务计算模块（服务端）
 * -------------------------------------------------
 * 所有税率 / 分成比例 / 佣金参数优先从数据库 settings 表读取（管理端可配置），
 * config.json 仅作为缺省默认值。本模块只被 /api/v1/* 接口使用，
 * 不影响原有 /api/transactions/* 算法（原算法仍读 shops 表的店铺级参数）。
 *
 * 口径：售价含 GST（priceIncludesGst = true）
 *   不含税成交基数 = 售价 ÷ (1 + GST税率)
 *   GST            = 不含税基数 × GST税率
 *   含税总额       = 不含税基数 + GST（应等于售价）
 *   平台分成       = 不含税基数 × 平台比例（默认 70%）
 *   商家分成       = 不含税基数 × 商家比例（默认 30%）
 *   佣金           = 不含税基数 × 佣金率（默认 3%）
 *   佣金附加 GST   = 佣金 × GST税率
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

/** 从数据库 settings 表读取财务参数（缺省回落到 config.json） */
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

  return {
    gst: {
      rate: num('gst_rate', cfg.gst.rate),
      priceIncludesGst: cfg.gst.priceIncludesGst
    },
    split: {
      platform: num('platform_share_ratio', cfg.split.platform),
      merchant: num('merchant_share_ratio', cfg.split.merchant)
    },
    commission: {
      rate: num('commission_rate', cfg.commission.rate),
      applyGst: map.commission_apply_gst === undefined
        ? cfg.commission.applyGst
        : Number(map.commission_apply_gst) === 1
    },
    scan: cfg.scan
  };
}

/**
 * 计算单笔交易的全部财务字段
 * @param {number} quantity   数量
 * @param {number} unitPrice  单价（含 GST，售价）
 * @returns {Promise<object>} 财务字段
 */
async function calculate(quantity, unitPrice) {
  const cfg = await getSettings();
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const gstRate = cfg.gst.rate;

  // 售价含 GST → 倒推不含税基数
  const amountBeforeGST = round2((qty * price) / (1 + gstRate));
  const gstAmount = round2(amountBeforeGST * gstRate);
  const totalAmount = round2(amountBeforeGST + gstAmount);

  // 7/3 分成（按不含税基数）
  const platformShare = round2(amountBeforeGST * cfg.split.platform);
  const merchantShare = round2(amountBeforeGST * cfg.split.merchant);

  // 佣金 + 佣金附加 GST
  const commission = round2(amountBeforeGST * cfg.commission.rate);
  const commissionGst = cfg.commission.applyGst
    ? round2(commission * gstRate)
    : 0;

  return {
    amountBeforeGST,
    gstAmount,
    totalAmount,
    platformShare,
    merchantShare,
    commission,
    commissionGst,
    gstRate,
    priceIncludesGst: cfg.gst.priceIncludesGst
  };
}

/** 管理端「财务设置」页读写用的平铺结构 */
async function getSettingsFlat() {
  const s = await getSettings();
  return {
    gstRate: s.gst.rate,
    priceIncludesGst: s.gst.priceIncludesGst,
    platformShareRatio: s.split.platform,
    merchantShareRatio: s.split.merchant,
    commissionRate: s.commission.rate,
    commissionApplyGst: s.commission.applyGst
  };
}

module.exports = { calculate, round2, loadConfig, getSettings, getSettingsFlat };
