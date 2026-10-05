/**
 * 离线同步模块
 * 网络恢复后自动将本地待同步记录上传到服务器
 * 采用"最后写入胜出"策略（按客户端时间戳）
 */
const SyncManager = (() => {
  let isSyncing = false;
  let syncTimer = null;
  const SYNC_INTERVAL = 5000; // 每5秒检查一次
  let onPendingCountChange = null;

  /**
   * 初始化同步管理器
   * @param {function} pendingCallback - 待同步数量变化回调 (count) => void
   */
  function init(pendingCallback) {
    onPendingCountChange = pendingCallback;

    // 监听网络状态变化
    window.addEventListener('online', () => {
      App.showToast('网络已恢复，正在同步数据...');
      syncAll();
    });

    window.addEventListener('offline', () => {
      App.showToast('网络已断开，扫码记录将保存在本地');
    });

    // 定时检查并同步
    syncTimer = setInterval(() => {
      if (navigator.onLine) syncAll();
    }, SYNC_INTERVAL);

    // 启动时立即同步一次
    if (navigator.onLine) setTimeout(syncAll, 1000);

    updatePendingCount();
  }

  /**
   * 同步所有待同步记录
   */
  async function syncAll() {
    if (isSyncing) return;
    if (!navigator.onLine) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    const pendingRecords = await LocalDB.getPendingRecords();
    if (pendingRecords.length === 0) {
      updatePendingCount();
      return;
    }

    isSyncing = true;
    try {
      const response = await fetch('/api/transactions/batch-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ records: pendingRecords })
      });

      if (!response.ok) throw new Error('同步失败: ' + response.status);

      const result = await response.json();

      // 删除已同步和重复的记录
      for (const r of result.results) {
        if (r.status === 'synced' || r.status === 'duplicate') {
          await LocalDB.removePendingRecord(r.clientRecordId);
        }
      }

      // 同步失败的记录保留，下次重试
      if (result.failed > 0) {
        console.warn(`${result.failed} 条记录同步失败，将在下次重试`);
      }

      if (result.synced > 0) {
        App.showToast(`已同步 ${result.synced} 条记录`);
        // 刷新商品缓存
        App.refreshProductsCache();
      }

      updatePendingCount();
    } catch (err) {
      console.error('同步出错:', err);
    } finally {
      isSyncing = false;
    }
  }

  /**
   * 更新待同步数量显示
   */
  async function updatePendingCount() {
    const count = await LocalDB.getPendingCount();
    if (onPendingCountChange) {
      onPendingCountChange(count);
    }

    // 更新离线提示条
    const pendingBadge = document.getElementById('pending-count');
    const pendingNum = document.getElementById('pending-num');
    if (count > 0) {
      pendingBadge.classList.remove('hidden');
      pendingNum.textContent = count;
    } else {
      pendingBadge.classList.add('hidden');
    }
  }

  /**
   * 手动触发同步
   */
  function triggerSync() {
    if (navigator.onLine) {
      syncAll();
    } else {
      App.showToast('当前离线，数据将在网络恢复后自动上传');
    }
  }

  function destroy() {
    if (syncTimer) clearInterval(syncTimer);
  }

  return { init, syncAll, triggerSync, updatePendingCount, destroy };
})();
