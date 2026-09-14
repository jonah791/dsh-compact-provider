/**
 * 请求侧轨迹条目构造（provider 侧自证 · 2026-09-14）
 *
 * 目标：引擎侧轨迹从 `begin` 起笔，「谁发起 / 为什么 / 判据过没过」是空白——本层补上。
 * 本套件锁三件事：
 *  ① 纯构造函数的语义（摘要折叠/截断、agent 标识安全取用、各阶段字段）
 *  ② **与引擎共用同一套判据**：provider 构造的条目经引擎的 serialize → parse 往返不丢字段
 *     （判据单一真源 §5.22 规则 4；两套序列化必然漂移）
 *  ③ **观测绝不反噬**（C4）：落盘失败返回 false 且不抛
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeReason, agentLabel, requestEntry, rejectedEntry, completedEntry, failedEntry,
} from '../lib/policy.js'
import { serializeTraceEntry, parseTraceEntries, appendTraceEntry } from 'dsh-agent-compact'

test('summarizeReason：折叠空白 + 超长截断（决策留痕足够，不落全文）', () => {
  assert.equal(summarizeReason('  上下文提醒\n  越阈值  '), '上下文提醒 越阈值')
  assert.equal(summarizeReason('短'), '短')
  assert.equal(summarizeReason('x'.repeat(100), 10), 'x'.repeat(10) + '…')
  assert.equal(summarizeReason(''), '')
})

test('agentLabel：优先 sessionId，取不到即 n/a，任何形状都不抛', () => {
  assert.equal(agentLabel({ sessionId: 'session-abc' }), 'session-abc')
  assert.equal(agentLabel({ id: 'fallback-id' }), 'fallback-id')
  assert.equal(agentLabel({ sessionId: 'session-abc', id: 'x' }), 'session-abc')
  assert.equal(agentLabel(undefined), 'n/a')
  assert.equal(agentLabel(null), 'n/a')
  assert.equal(agentLabel({}), 'n/a')
  assert.equal(agentLabel({ sessionId: '' }), 'n/a')
  assert.equal(agentLabel(42), 'n/a')
  assert.equal(agentLabel('str'), 'n/a')
  // 取属性会抛的对象也不得让摘要构造失败
  const hostile = Object.defineProperty({}, 'sessionId', { get() { throw new Error('boom') } })
  assert.equal(agentLabel(hostile), 'n/a')
})

test('agentLabel：超长标识截断', () => {
  assert.equal(agentLabel({ sessionId: 'x'.repeat(50) }, 8), 'x'.repeat(8))
})

test('requestEntry：requested + side=provider + commandId + 摘要', () => {
  const e = requestEntry('  上下文 提醒  ', 'session-abc')
  assert.equal(e.phase, 'requested')
  assert.equal(e.side, 'provider')
  assert.equal(e.commandId, 'alice-self-compact')
  assert.equal(e.agentId, 'session-abc')
  assert.equal(e.reason, '上下文 提醒')
})

test('rejectedEntry：ok=false + error（未触 seam ⇒ 引擎侧无 begin，这条是唯一证据）', () => {
  const e = rejectedEntry('reason 必填（自主决策留痕）')
  assert.equal(e.phase, 'rejected')
  assert.equal(e.side, 'provider')
  assert.equal(e.ok, false)
  assert.equal(e.error, 'reason 必填（自主决策留痕）')
})

test('completedEntry：ok=true + waitedMs', () => {
  const e = completedEntry(1234)
  assert.equal(e.phase, 'completed')
  assert.equal(e.ok, true)
  assert.equal(e.waitedMs, 1234)
})

test('failedEntry：只取首行 + 截断（堆栈不落盘）', () => {
  const e = failedEntry('压缩启动失败: boom\n    at foo (/x.ts:1:1)\n    at bar')
  assert.equal(e.phase, 'failed')
  assert.equal(e.ok, false)
  assert.equal(e.error, '压缩启动失败: boom')
  assert.ok(!e.error.includes('at foo'), '堆栈不得进入轨迹')
  assert.equal(failedEntry('y'.repeat(500)).error.length, 200)
})

test('判据单一真源：provider 条目经引擎 serialize→parse 往返不丢字段', () => {
  const line = serializeTraceEntry({
    atMs: 1789355521631, build: '0.2.0@1789355000000', ...requestEntry('越阈值压缩', 'session-abc'),
  })
  assert.equal(line.includes('\n'), false, '必须是单行 JSON（便于 tail/grep）')
  const [back] = parseTraceEntries(line + '\n')
  assert.equal(back.phase, 'requested')
  assert.equal(back.side, 'provider')
  assert.equal(back.commandId, 'alice-self-compact')
  assert.equal(back.agentId, 'session-abc')
  assert.equal(back.reason, '越阈值压缩')
  assert.equal(back.build, '0.2.0@1789355000000')
})

test('同文件两写者：provider 行与引擎行可按 atMs join 成一笔事务', () => {
  const rows = [
    { atMs: 1, build: 'b', ...requestEntry('r', 'a') },
    { atMs: 2, build: 'b', phase: 'begin' },
    { atMs: 3, build: 'b', phase: 'captured', chars: 10, markerOk: true },
    { atMs: 4, build: 'b', ...completedEntry(3) },
  ].map(serializeTraceEntry).join('\n') + '\n'
  const parsed = parseTraceEntries(rows)
  assert.deepEqual(parsed.map((r) => r.phase), ['requested', 'begin', 'captured', 'completed'])
  assert.equal(parsed[0].side, 'provider')
  assert.equal(parsed[1].side, undefined, '引擎行不带 side（向后兼容旧行的判据）')
})

test('尸体测试（C4）：不可写路径 → appendTraceEntry 返回 false 且不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trace-corpse-'))
  try {
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'plain file')
    let result
    assert.doesNotThrow(() => {
      result = appendTraceEntry(join(blocker, 'sub', 'trace.jsonl'), {
        atMs: 1, build: 'b', ...requestEntry('r', 'a'),
      })
    })
    assert.equal(result, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
