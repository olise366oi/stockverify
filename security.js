/**
 * 共享安全工具：登录限流
 * 注意：按接口维度隔离计数（prefix），避免 v1 与原接口互相影响
 */
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 20;

function makeRateLimit(prefix) {
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = prefix + ':' + ip;
    const now = Date.now();
    const rec = attempts.get(key) || { count: 0, resetAt: now + WINDOW_MS };
    if (now > rec.resetAt) {
      rec.count = 0;
      rec.resetAt = now + WINDOW_MS;
    }
    rec.count += 1;
    attempts.set(key, rec);
    if (rec.count > MAX_ATTEMPTS) {
      return res.status(429).json({ error: '登录尝试过于频繁，请 5 分钟后再试' });
    }
    next();
  };
}

// 定期清理过期记录，防止内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) {
    if (now > v.resetAt) attempts.delete(k);
  }
}, 10 * 60 * 1000).unref();

module.exports = { makeRateLimit };
