'use strict';
/**
 * v0.2.0 初始账号密码种子脚本（幂等）
 * - 为指定用户名设置 bcrypt 初始密码（仅当该用户尚未设置密码时生效，不覆盖已改过的密码）
 * - 写入 settings 表种子已在 database.js initDB 完成
 * 运行: node tools/rebrand-login16.js
 */
const bcrypt = require('bcryptjs');
const { getDb, initDB, appendAuditLog } = require('../database');

const ACCOUNTS = [
  { username: 'orchard_owner', password: 'Orchard@2024', label: 'Orchard Central 店主' },
  { username: 'jurong_owner', password: 'Jurong@2024', label: 'Jurong Point 店主' },
  { username: 'tampines_owner', password: 'Tampines@2024', label: 'Tampines Mall 店主' },
  { username: 'suntec_owner', password: 'Suntec@2024', label: 'Suntec City 店主' },
  { username: 'admin_01', password: 'Admin@2024', label: '总部管理端（超管）' },
  { username: 'brand_01', password: 'Brand@2024', label: '品牌运营中心（总代）' }
];

(async () => {
  await initDB(); // 确保迁移已执行（password_hash 列 / settings 表 / 唯一索引）
  const db = getDb();
  console.log('=== 初始账号密码种子 ===');
  for (const acc of ACCOUNTS) {
    const user = await db.get('SELECT id, shop_id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE', acc.username);
    if (!user) {
      console.log(`[跳过] 用户不存在: ${acc.username}`);
      continue;
    }
    if (user.password_hash) {
      console.log(`[保持] ${acc.username} 已设置密码，不覆盖`);
      continue;
    }
    const hash = await bcrypt.hash(acc.password, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id);
    await appendAuditLog(user.shop_id, user.id, user.username, 'password_seed', null, null,
      `系统初始化：为 ${acc.label} 设置初始登录密码`);
    console.log(`[设置] ${acc.username} -> ${acc.password}`);
  }
  console.log('=== 验证（只显示哈希前 12 位）===');
  const rows = await db.all('SELECT username, password_hash FROM users WHERE password_hash IS NOT NULL ORDER BY id');
  for (const r of rows) {
    console.log(`${r.username}: ${r.password_hash ? r.password_hash.slice(0, 12) + '...' : '(无)'}`);
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
