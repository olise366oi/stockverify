'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { round2 } = require('../finance');

// round2 实现（finance.js L32-34）：
//   function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
// 断言值全部来自本机实测输出，非臆测。

test('round2: 整数', () => {
  assert.strictEqual(round2(5), 5);
  assert.strictEqual(round2(0), 0);
});

test('round2: 正常两位小数', () => {
  assert.strictEqual(round2(1.23), 1.23);
  assert.strictEqual(round2(1.234), 1.23);
});

test('round2: 需要进位（含浮点噪声修正）', () => {
  assert.strictEqual(round2(1.235), 1.24);
  assert.strictEqual(round2(1.236), 1.24);
  assert.strictEqual(round2(1.005), 1.01);
  assert.strictEqual(round2(2.675), 2.68);
});

test('round2: 浮点噪声典型值 0.1 + 0.2', () => {
  assert.strictEqual(round2(0.1 + 0.2), 0.3);
});

test('round2: 负数（Math.round 向正无穷舍入，-x.5 行为）', () => {
  assert.strictEqual(round2(-1.235), -1.23);
  assert.strictEqual(round2(-1.236), -1.24);
});

test('round2: 大数', () => {
  assert.strictEqual(round2(1234567.891), 1234567.89);
});

test('round2: 微小值归零', () => {
  assert.strictEqual(round2(0.0001), 0);
});
