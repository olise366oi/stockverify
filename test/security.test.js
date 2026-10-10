'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeRateLimit } = require('../security');

// security.js 的 attempts 是模块级 Map，测试之间必须用唯一 prefix 隔离。
// 每个 test 内部生成独立 prefix（时间戳 + 随机数），互不污染。

function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const s = { statusCode: null, body: null };
  return {
    status(c) { s.statusCode = c; return this; },
    json(b) { s.body = b; return this; },
    _s: s
  };
}

function uniq(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random();
}

test('rateLimit: 同一 IP 20 次全部放行（next 调用 20 次）', () => {
  const limiter = makeRateLimit(uniq('test-pass'));
  const ip = '10.0.0.1';
  let nextCalls = 0;
  for (let i = 0; i < 20; i++) {
    limiter(fakeReq(ip), fakeRes(), () => { nextCalls++; });
  }
  assert.strictEqual(nextCalls, 20);
});

test('rateLimit: 第 21 次返回 429 且不再放行', () => {
  const limiter = makeRateLimit(uniq('test-block'));
  const ip = '10.0.0.2';
  let nextCalls = 0;
  let lastStatus = null;
  for (let i = 0; i < 21; i++) {
    const res = fakeRes();
    limiter(fakeReq(ip), res, () => { nextCalls++; });
    lastStatus = res._s.statusCode;
  }
  assert.strictEqual(nextCalls, 20, '前 20 次放行，第 21 次不应再调 next');
  assert.strictEqual(lastStatus, 429, '第 21 次应返回 429');
});

test('rateLimit: 不同 prefix（接口维度）计数隔离，同一 IP 互不影响', () => {
  const limiterA = makeRateLimit(uniq('test-iso-a'));
  const limiterB = makeRateLimit(uniq('test-iso-b'));
  const ip = '10.0.0.3';

  // A 打满 21 次 → 前 20 次放行，第 21 次 429
  let aNext = 0;
  let aLastStatus = null;
  for (let i = 0; i < 21; i++) {
    const res = fakeRes();
    limiterA(fakeReq(ip), res, () => { aNext++; });
    aLastStatus = res._s.statusCode;
  }
  assert.strictEqual(aNext, 20);
  assert.strictEqual(aLastStatus, 429);

  // B 用同一 IP，应仍放行（独立计数）
  let bNext = 0;
  for (let i = 0; i < 5; i++) {
    limiterB(fakeReq(ip), fakeRes(), () => { bNext++; });
  }
  assert.strictEqual(bNext, 5, 'B 接口不应受 A 的计数影响');
});
