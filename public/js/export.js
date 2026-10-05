/**
 * Excel 报表导出模块
 * 基于 SheetJS (xlsx) 库
 */
const ExportManager = (() => {

  /**
   * 导出交易记录为 Excel
   * @param {Array} transactions - 交易记录数组
   * @param {object} summary - 汇总统计
   * @param {string} filename - 文件名
   */
  function exportTransactions(transactions, summary, filename) {
    if (typeof XLSX === 'undefined') {
      App.showToast('Excel 库加载失败，请检查网络');
      return;
    }

    // 工作表1：交易明细
    const detailData = transactions.map(t => ({
      '交易时间': t.server_timestamp || t.client_timestamp || '',
      '交易类型': t.type === 'inbound' ? '入库' : '出库',
      '商品ID': t.product_id,
      '商品名称': t.product_name,
      '数量': t.quantity,
      '单价(SGD)': t.unit_price,
      '活动折扣(SGD)': t.discount_amount || 0,
      '折后价(SGD)': t.discounted_price !== null && t.discounted_price !== undefined ? t.discounted_price : t.unit_price,
      '不含税成交基数(SGD)': t.amount_before_gst,
      'GST 9%(SGD)': t.gst_amount,
      '含税总额(SGD)': t.total_amount,
      '品牌方分成(SGD)': t.type === 'outbound' ? (t.brand_share || 0) : '-',
      '商铺分成(SGD)': t.type === 'outbound' ? (t.merchant_share || 0) : '-',
      '折扣状态': t.discount_status && t.discount_status !== 'none' ? (t.discount_status === 'approved' ? '√ 已通过' : (t.discount_status === 'rejected' ? '× 已驳回' : '待审核')) : '-',
      '核对状态': t.verified ? '√ 通过' : (t.type === 'inbound' ? '× 未通过' : '-'),
      '发货单ID': t.shipment_id || '',
      '操作人ID': t.operator_id || '',
      '操作人': t.operator_name,
      '客户端时间戳': t.client_timestamp || '',
      '同步状态': t.sync_status || 'synced',
      '客户端记录ID': t.client_record_id || ''
    }));

    const wsDetail = XLSX.utils.json_to_sheet(detailData);

    // 设置列宽
    wsDetail['!cols'] = [
      { wch: 20 }, { wch: 8 }, { wch: 8 }, { wch: 20 }, { wch: 6 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 10 }, { wch: 12 },
      { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
      { wch: 10 }, { wch: 20 }, { wch: 10 }, { wch: 24 }
    ];

    // 工作表2：汇总统计
    const summaryData = [
      { '项目': '交易笔数', '数值': summary.count || 0 },
      { '项目': '不含税总额(SGD)', '数值': summary.amountBeforeGST || 0 },
      { '项目': 'GST总额 9%(SGD)', '数值': summary.gstAmount || 0 },
      { '项目': '含税总额(SGD)', '数值': summary.totalAmount || 0 },
      { '项目': '入库总数量', '数值': summary.inboundQty || 0 },
      { '项目': '出库总数量', '数值': summary.outboundQty || 0 },
      { '项目': '', '数值': '' },
      { '项目': '分成明细', '数值': '' },
      { '项目': '销售件数', '数值': summary.salesQty || 0 },
      { '项目': '成本总额', '数值': summary.costTotal || 0 },
      { '项目': '折扣总额', '数值': summary.discountTotal || 0 },
      { '项目': '品牌方分成', '数值': summary.brandShare || 0 },
      { '项目': '商铺分成', '数值': summary.merchantShare || 0 },
      { '项目': '回款品牌方GST', '数值': summary.brandGst || 0 },
      { '项目': '商铺自交GST', '数值': summary.merchantGst || 0 },
      { '项目': '', '数值': '' },
      { '项目': '报表生成时间', '数值': new Date().toLocaleString('zh-CN') }
    ];
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 28 }, { wch: 24 }];

    // 工作表3：每日流水汇总
    const dailyMap = {};
    transactions.forEach(t => {
      if (t.type !== 'outbound') return;
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
    const dailyData = Object.keys(dailyMap).sort().map(day => ({
      '日期': day,
      '销售件数': dailyMap[day].qty,
      '折扣(SGD)': dailyMap[day].discount,
      '不含税(SGD)': dailyMap[day].base.toFixed(2),
      'GST(SGD)': dailyMap[day].gst.toFixed(2),
      '含税总额(SGD)': dailyMap[day].total.toFixed(2),
      '品牌方分成(SGD)': dailyMap[day].brand.toFixed(2),
      '商铺分成(SGD)': dailyMap[day].merchant.toFixed(2)
    }));
    const wsDaily = XLSX.utils.json_to_sheet(dailyData);
    wsDaily['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];

    // 创建工作簿
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, '汇总统计');
    XLSX.utils.book_append_sheet(wb, wsDaily, '每日流水汇总');
    XLSX.utils.book_append_sheet(wb, wsDetail, '交易明细');

    // 导出文件
    const exportName = filename || `库存对账报表_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, exportName);

    App.showToast('Excel 报表已导出');
  }

  /**
   * 导出商品列表
   */
  function exportProducts(products, filename) {
    if (typeof XLSX === 'undefined') {
      App.showToast('Excel 库加载失败');
      return;
    }
    const data = products.map(p => ({
      '商品ID': p.id,
      'SKU': p.sku || '',
      '条码': p.barcode,
      '商品名称': p.name,
      '分类': p.category || '',
      '进价(SGD)': p.cost_price,
      '售价(SGD)': p.sell_price,
      '当前库存': p.stock,
      '预警阈值': p.threshold,
      '库存状态': p.stock <= p.threshold ? '低库存' : '正常',
      '最后更新': p.last_write_at
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '商品列表');
    XLSX.writeFile(wb, filename || `商品列表_${new Date().toISOString().split('T')[0]}.xlsx`);
    App.showToast('商品列表已导出');
  }

  /**
   * 导出操作日志
   */
  function exportLogs(logs, filename) {
    if (typeof XLSX === 'undefined') {
      App.showToast('Excel 库加载失败');
      return;
    }
    const data = logs.map(l => ({
      '日志ID': l.id,
      '时间': l.create_at || l.timestamp,
      '操作人': l.username,
      '操作类型': l.action,
      '商品ID': l.product_id || '',
      '商品名称': l.product_name || '',
      '详情': l.note || l.detail || '',
      '前哈希': l.prev_hash || '',
      '当前哈希': l.this_hash || l.curr_hash || ''
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 12 }, { wch: 16 }, { wch: 8 }, { wch: 16 }, { wch: 40 }, { wch: 64 }, { wch: 64 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '操作日志');
    XLSX.writeFile(wb, filename || `操作日志_${new Date().toISOString().split('T')[0]}.xlsx`);
    App.showToast('操作日志已导出');
  }

  return { exportTransactions, exportProducts, exportLogs };
})();
