/**
 * 直触压缩判定单测（2026-09-14）
 *
 * 纪律（AGENTS.md §5.9 §2）：防线必须有**尸体测试**——真实事故样本必须触发，良性样本必须不误报。
 * 本文件的数字全部取自事件流实测（turn 71：意图请求 563,054 + 摘要请求 566,783；
 * 压缩后 84,302），不是编造的近似值。
 *
 * 运行：`node --test tests/*.test.mjs`（先 `npm run build` 产出 lib/）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_PER_DAY,
  DEFAULT_THRESHOLD_TOKENS,
  EXPIRED_MS,
  countTriggeredToday,
  decideDirectCompaction,
  hasOpenCompaction,
  ledgerLine,
  parseDirectPolicy,
  pruneHistory,
} from '../lib/direct.js';

/** 有效授权样本（与线上 `.dsh/compact-direct-policy.json` 同形）。 */
function policyOf(overrides = {}) {
  return {
    authorized: true,
    thresholdTokens: 500000,
    maxPerDay: 8,
    cooldownMs: 600000,
    expiresAt: '2026-09-21T00:00:00+08:00',
    note: '常设授权：越阈值即直触压缩',
    ...overrides,
  };
}

/** 判定输入样本：默认「已授权 + 越阈值 + 无历史」。 */
function inputOf(overrides = {}) {
  return {
    tokens: 566783,
    isUserSession: true,
    policy: parseDirectPolicy(policyOf()).policy,
    nowMs: Date.parse('2026-09-14T09:20:00+08:00'),
    lastTriggeredAtMs: null,
    triggeredToday: 0,
    compactionActive: false,
    ...overrides,
  };
}

test('尸体测试：越阈值 + 有效授权 → 触发（今日真实数字 566,783 ≥ 500,000）', () => {
  const decision = decideDirectCompaction(inputOf());
  assert.equal(decision.trigger, true);
  assert.match(decision.reason, /直触/);
  assert.match(decision.detail, /tokens=566783/);
});

test('不误报：压缩后未越阈值 → 跳过（今日真实数字 84,302 < 500,000）', () => {
  const decision = decideDirectCompaction(inputOf({ tokens: 84302 }));
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, '未越阈值');
});

test('fail-closed：授权文件缺失 / 非对象 / authorized 非 true → 一律不触发', () => {
  for (const raw of [null, undefined, 42, [], {}, { authorized: false }, { authorized: 'true' }]) {
    const { policy } = parseDirectPolicy(raw);
    assert.equal(policy, null, `raw=${JSON.stringify(raw)} 必须解析为「未授权」`);
    assert.equal(decideDirectCompaction(inputOf({ policy })).trigger, false);
  }
});

test('授权解析：缺省字段回退默认值；authorized 必须显式 true', () => {
  const { policy } = parseDirectPolicy({ authorized: true });
  assert.notEqual(policy, null);
  assert.equal(policy.thresholdTokens, DEFAULT_THRESHOLD_TOKENS);
  assert.equal(policy.maxPerDay, DEFAULT_MAX_PER_DAY);
  assert.equal(policy.cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(policy.expiresAtMs, null, '缺省 = 不过期');
});

test('授权衰减：expiresAt 过期或不可解析 → 不触发（不可解析按已过期处理）', () => {
  const nowMs = Date.parse('2026-09-14T09:20:00+08:00');
  const expired = parseDirectPolicy(policyOf({ expiresAt: '2026-09-13T00:00:00+08:00' })).policy;
  const expiredDecision = decideDirectCompaction(inputOf({ policy: expired, nowMs }));
  assert.equal(expiredDecision.trigger, false);
  assert.match(expiredDecision.reason, /授权已过期/);

  const broken = parseDirectPolicy(policyOf({ expiresAt: '不是时间' })).policy;
  assert.equal(broken.expiresAtMs, EXPIRED_MS);
  assert.equal(decideDirectCompaction(inputOf({ policy: broken, nowMs })).trigger, false);
});

test('派生会话（子代理裸 uuid）不直触', () => {
  const decision = decideDirectCompaction(inputOf({ isUserSession: false }));
  assert.equal(decision.trigger, false);
  assert.match(decision.reason, /派生会话/);
});

test('冷却：距上次触发不足 cooldownMs → 跳过并报出剩余时间', () => {
  const nowMs = Date.parse('2026-09-14T09:20:00+08:00');
  const decision = decideDirectCompaction(inputOf({
    nowMs,
    lastTriggeredAtMs: nowMs - 60_000,
  }));
  assert.equal(decision.trigger, false);
  assert.match(decision.reason, /冷却中（还剩 540000ms）/);
});

test('冷却边界：正好等于 cooldownMs → 允许触发（>= 即放行）', () => {
  const nowMs = Date.parse('2026-09-14T09:20:00+08:00');
  const decision = decideDirectCompaction(inputOf({
    nowMs,
    lastTriggeredAtMs: nowMs - DEFAULT_COOLDOWN_MS,
  }));
  assert.equal(decision.trigger, true);
});

test('日限额：达上限即停（防「压了又压」）', () => {
  const decision = decideDirectCompaction(inputOf({ triggeredToday: 8 }));
  assert.equal(decision.trigger, false);
  assert.match(decision.reason, /日限额已用尽（8\/8）/);
});

test('在飞行：已有压缩事务 → 跳过（并发保护）', () => {
  const decision = decideDirectCompaction(inputOf({ compactionActive: true }));
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, '已有压缩事务在飞行');
});

test('结构性不可为优先于压力：越阈值但在飞行 → 仍跳过', () => {
  const decision = decideDirectCompaction(inputOf({ tokens: 900000, compactionActive: true }));
  assert.equal(decision.trigger, false);
});

test('日计数：只数同一自然日；坏值不计', () => {
  const nowMs = Date.parse('2026-09-14T09:20:00+08:00');
  const history = [
    Date.parse('2026-09-14T08:00:00+08:00'),
    Date.parse('2026-09-14T09:10:00+08:00'),
    Date.parse('2026-09-13T23:59:00+08:00'),
    Number.NaN,
  ];
  assert.equal(countTriggeredToday(history, nowMs), 2);
});

test('历史修剪：丢弃超过保留期的项与坏值，升序返回', () => {
  const nowMs = Date.parse('2026-09-14T09:20:00+08:00');
  const pruned = pruneHistory([
    nowMs - 5 * 86400000,
    nowMs - 1000,
    nowMs - 2000,
    Number.NaN,
  ], nowMs);
  assert.deepEqual(pruned, [nowMs - 2000, nowMs - 1000]);
});

test('留痕行：单行 JSON，含 action 与数字（可被 jq/脚本消费）', () => {
  const line = ledgerLine({
    atMs: Date.parse('2026-09-14T09:20:00+08:00'),
    sessionId: 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c',
    tokens: 566783,
    trigger: true,
    reason: '越阈值直触（省掉意图请求）',
    detail: 'tokens=566783 threshold=500000 today=0 lastTriggered=never → 直触',
  });
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.action, 'trigger');
  assert.equal(parsed.tokens, 566783);
  assert.equal(parsed.at, '2026-09-14T01:20:00.000Z');
});

test('飞行检测：start 无 end → true；start 后有 end → false', () => {
  const events = new Map([
    [100, { type: 'compaction/start' }],
    [90, { type: 'compaction/end' }],
  ]);
  const view = (map) => ({ seq: 120, eventAt: (seq) => map.get(seq) });
  assert.equal(hasOpenCompaction(view(events), 120), true, 'start 晚于最近 end = 在飞行');

  const closed = new Map([
    [100, { type: 'compaction/start' }],
    [110, { type: 'compaction/end' }],
  ]);
  assert.equal(hasOpenCompaction(view(closed), 120), false);
});

test('飞行检测边界：只有 end / 什么都没有 → false（不得误判为在飞行）', () => {
  const onlyEnd = new Map([[50, { type: 'compaction/end' }]]);
  assert.equal(hasOpenCompaction({ seq: 60, eventAt: (s) => onlyEnd.get(s) }, 60), false);
  assert.equal(hasOpenCompaction({ seq: 60, eventAt: () => undefined }, 60), false);
});
