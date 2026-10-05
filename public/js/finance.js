/**
 * 财务计算模块
 * 新加坡 GST 9%（销售额的9%），无佣金
 */
const Finance = (() => {
  const DEFAULT_GST_RATE = 0.09;

  let config = {
    gstRate: DEFAULT_GST_RATE
  };

  function setConfig(cfg) {
    config = { ...config, ...cfg };
  }

  function getConfig() {
    return { ...config };
  }

  /**
   * 计算单笔交易的所有财务字段
   * @param {number} quantity - 数量
   * @param {number} unitPrice - 单价
   * @param {string} type - inbound(入库) / outbound(出库)
   * @returns {object} 财务字段（仅 GST，无佣金）
   */
  function calculate(quantity, unitPrice, type) {
    const qty = Number(quantity) || 0;
    const price = Number(unitPrice) || 0;

    // 不含税成交基数
    const amountBeforeGST = round2(qty * price);
    // 9% GST（销售额的9%）
    const gstAmount = round2(amountBeforeGST * config.gstRate);
    // 含税总额
    const totalAmount = round2(amountBeforeGST + gstAmount);

    return {
      amountBeforeGST,
      gstAmount,
      totalAmount
    };
  }

  // 四舍五入到2位小数
  function round2(num) {
    return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
  }

  // 格式化货币
  function format(amount) {
    return '$' + Number(amount || 0).toFixed(2);
  }

  return { setConfig, getConfig, calculate, round2, format };
})();
