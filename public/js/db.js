/**
 * IndexedDB 本地数据库封装
 * 用于离线模式下存储扫码记录，确保一条记录都不丢
 */
const LocalDB = (() => {
  const DB_NAME = 'sg-inventory-db';
  const DB_VERSION = 1;
  let db = null;

  // 打开数据库
  function open() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const database = e.target.result;
        // 待同步的扫码记录表
        if (!database.objectStoreNames.contains('pending_records')) {
          const store = database.createObjectStore('pending_records', { keyPath: 'clientRecordId' });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        // 本地商品缓存
        if (!database.objectStoreNames.contains('products_cache')) {
          database.createObjectStore('products_cache', { keyPath: 'id' });
        }
        // 扫码防重复记录（最近扫描的条码+时间）
        if (!database.objectStoreNames.contains('scan_history')) {
          const store = database.createObjectStore('scan_history', { keyPath: 'id' });
          store.createIndex('barcode', 'barcode', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      request.onsuccess = (e) => { db = e.target.result; resolve(db); };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // 通用请求包装
  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 添加待同步记录
  async function addPendingRecord(record) {
    await open();
    const tx = db.transaction('pending_records', 'readwrite');
    const store = tx.objectStore('pending_records');
    record.createdAt = record.createdAt || new Date().toISOString();
    record.synced = false;
    await reqToPromise(store.put(record));
    return record;
  }

  // 获取所有待同步记录
  async function getPendingRecords() {
    await open();
    const tx = db.transaction('pending_records', 'readonly');
    const store = tx.objectStore('pending_records');
    return reqToPromise(store.getAll());
  }

  // 获取待同步记录数量
  async function getPendingCount() {
    await open();
    const tx = db.transaction('pending_records', 'readonly');
    const store = tx.objectStore('pending_records');
    return reqToPromise(store.count());
  }

  // 删除已同步记录
  async function removePendingRecord(clientRecordId) {
    await open();
    const tx = db.transaction('pending_records', 'readwrite');
    const store = tx.objectStore('pending_records');
    await reqToPromise(store.delete(clientRecordId));
  }

  // 清空所有待同步记录（调试用）
  async function clearPendingRecords() {
    await open();
    const tx = db.transaction('pending_records', 'readwrite');
    const store = tx.objectStore('pending_records');
    await reqToPromise(store.clear());
  }

  // 商品缓存
  async function cacheProducts(products) {
    await open();
    const tx = db.transaction('products_cache', 'readwrite');
    const store = tx.objectStore('products_cache');
    await reqToPromise(store.clear());
    for (const p of products) { await reqToPromise(store.put(p)); }
  }

  async function getCachedProducts() {
    await open();
    const tx = db.transaction('products_cache', 'readonly');
    const store = tx.objectStore('products_cache');
    return reqToPromise(store.getAll());
  }

  async function getCachedProductByBarcode(barcode) {
    const products = await getCachedProducts();
    return products.find(p => p.barcode === barcode);
  }

  async function updateCachedProduct(product) {
    await open();
    const tx = db.transaction('products_cache', 'readwrite');
    const store = tx.objectStore('products_cache');
    await reqToPromise(store.put(product));
  }

  // 扫码防重复：检查同一条码是否在指定时间内已扫描
  // 窗口与 config.json 的 scan.duplicateWindowMs 保持一致（5000ms = 5 秒）
  async function isDuplicateScan(barcode, type, intervalMs = 5000) {
    await open();
    const tx = db.transaction('scan_history', 'readonly');
    const store = tx.objectStore('scan_history');
    const index = store.index('barcode');
    const records = await reqToPromise(index.getAll(barcode));
    const now = Date.now();
    return records.some(r => r.type === type && (now - r.timestamp) < intervalMs);
  }

  // 记录扫码历史
  async function addScanHistory(barcode, type) {
    await open();
    const tx = db.transaction('scan_history', 'readwrite');
    const store = tx.objectStore('scan_history');
    const record = {
      id: barcode + '_' + type + '_' + Date.now(),
      barcode, type,
      timestamp: Date.now()
    };
    await reqToPromise(store.put(record));
    // 清理1分钟前的旧记录
    const cutoff = Date.now() - 60000;
    const all = await reqToPromise(store.getAll());
    for (const r of all) {
      if (r.timestamp < cutoff) await reqToPromise(store.delete(r.id));
    }
  }

  // 生成唯一客户端记录ID
  function generateClientRecordId() {
    return 'cli_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  return {
    open, addPendingRecord, getPendingRecords, getPendingCount,
    removePendingRecord, clearPendingRecords,
    cacheProducts, getCachedProducts, getCachedProductByBarcode, updateCachedProduct,
    isDuplicateScan, addScanHistory, generateClientRecordId
  };
})();
