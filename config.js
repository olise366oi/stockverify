/**
 * 集中配置：环境变量读取与生产环境强制校验
 * 加载顺序：require 时立即读取 .env（若存在）→ process.env
 */
require('dotenv').config();

let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ 生产环境必须设置 JWT_SECRET 环境变量（>= 32 字符随机字符串）');
    console.error('   生成方式：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
  }
  // 开发环境：生成临时随机密钥，避免硬编码泄漏
  JWT_SECRET = 'DEV_ONLY_' + require('crypto').randomBytes(32).toString('hex');
  console.warn('⚠️  未设置 JWT_SECRET，使用临时开发密钥（重启后所有 token 失效）');
  console.warn('⚠️  部署生产前请参考 .env.example 设置 JWT_SECRET');
} else if (JWT_SECRET.length < 32) {
  console.warn('⚠️  JWT_SECRET 长度 < 32 字符，建议使用更长的随机字符串');
}

module.exports = { JWT_SECRET };
