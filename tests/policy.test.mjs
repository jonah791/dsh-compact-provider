/**
 * dsh-compact-provider — policy.ts 回归测试（跑 lib 产物，与运行时同源）
 *
 * 0.2.0（标记驱动）后判据变了：**summary 必填**。旧契约「只给 reason，等引擎投递总结
 * 指令」已删除——那条路要一次额外的全上下文请求，且投递不可靠（三次事故）。
 * 本文件用尸体样本锁住新判据，并保留仍适用的退化输入纪律（脏调用不抛）。
 *
 * 运行：node --test tests/policy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  precheckCompact, successNote, failureDetail, summarizeReason, agentLabel,
  requestEntry, rejectedEntry, completedEntry, failedEntry,
} from '../lib/policy.js'

const SUMMARY = '## Primary Request and Intent\n- x'

// ---------- precheckCompact：主路径 ----------

test('precheck：三条件齐备 → ok', () => {
  assert.deepEqual(
    precheckCompact({ summary: SUMMARY, hasCompaction: true, hasAgent: true }),
    { ok: true },
  )
})

test('尸体样本：只给 reason 不给 summary（旧契约形状）→ 立即响亮拒绝，不静默降级', () => {
  const r = precheckCompact({ summary: undefined, hasCompaction: true, hasAgent: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /summary 必填/)
})

test('precheck：compaction seam 缺失 → 报「不可用」', () => {
  assert.deepEqual(
    precheckCompact({ summary: SUMMARY, hasCompaction: false, hasAgent: true }),
    { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' },
  )
})

test('precheck：无 agent 上下文 → 报「无 agent 上下文」', () => {
  assert.deepEqual(
    precheckCompact({ summary: SUMMARY, hasCompaction: true, hasAgent: false }),
    { ok: false, error: '当前执行无 agent 上下文' },
  )
})

// ---------- precheckCompact：边界与脏输入必须不抛 ----------

test('退化：空串 / 纯空白 summary → 按缺失处理（不抛，返回错误而非异常）', () => {
  for (const bad of ['', '   ', '\n\t ']) {
    const r = precheckCompact({ summary: bad, hasCompaction: true, hasAgent: true })
    assert.equal(r.ok, false, `summary=${JSON.stringify(bad)} 应被拒绝`)
    assert.match(r.error, /summary 必填/)
  }
})

test('早退顺序：summary 优先于 compaction 与 agent', () => {
  const r = precheckCompact({ summary: '', hasCompaction: false, hasAgent: false })
  assert.equal(r.error, 'summary 必填：把 checkpoint 正文作为参数传入（引擎不再投递总结指令）')
})

test('早退顺序：compaction 优先于 agent', () => {
  const r = precheckCompact({ summary: SUMMARY, hasCompaction: false, hasAgent: false })
  assert.equal(r.error, 'compaction seam 不可用（AgentCompactEngine 未就绪）')
})

test('退化：整个入参缺字段（脏调用）→ 不抛且保守拒绝', () => {
  assert.equal(precheckCompact({}).ok, false)
})

test('退化：summary 传非字符串 truthy 脏数据 → 不抛', () => {
  for (const odd of [{}, [], 0, null]) {
    assert.doesNotThrow(() => precheckCompact({ summary: odd, hasCompaction: true, hasAgent: true }))
  }
})

// ---------- 文案构造 ----------

test('successNote：说清压了几节、省了多少 token（不是一句空 ok）', () => {
  assert.equal(successNote(12, 34567), '压缩完成：遮蔽 12 个表层节点（约 34567 tokens）')
})

test('failureDetail：Error → 错误串含 message 与堆栈', () => {
  const err = new Error('seam 抖动')
  const { error, stack } = failureDetail(err)
  assert.ok(error.startsWith('压缩失败: Error: seam 抖动\n'))
  assert.equal(stack, err.stack)
})

test('failureDetail：堆栈超长 → 截断到 2000 字符（前缀保留）', () => {
  const err = new Error('boom')
  err.stack = 'x'.repeat(5000)
  const { error } = failureDetail(err)
  assert.equal(error, '压缩失败: Error: boom\n' + 'x'.repeat(2000))
})

test('退化：failureDetail 喂非 Error / null / undefined → 不抛且给出可读串', () => {
  assert.equal(failureDetail('plain string').error, '压缩失败: plain string\nplain string')
  assert.equal(failureDetail(null).error, '压缩失败: null\nnull')
  assert.equal(failureDetail(undefined).error, '压缩失败: undefined\nundefined')
  assert.equal(failureDetail({ a: 1 }).error, '压缩失败: [object Object]\n[object Object]')
})

// ---------- 请求侧轨迹条目（纯数据，判据单一真源） ----------

test('requestEntry：含 commandId / agent / reason 摘要 / checkpoint 体量', () => {
  const entry = requestEntry('上下文 514k，主动压缩', 'session-1234', 4321)
  assert.deepEqual(entry, {
    phase: 'requested', side: 'provider', commandId: 'alice-self-compact',
    agentId: 'session-1234', reason: '上下文 514k，主动压缩', chars: 4321,
  })
})

test('rejectedEntry 是「未触 seam」的唯一证据：ok=false + error', () => {
  assert.deepEqual(rejectedEntry('summary 必填'), {
    phase: 'rejected', side: 'provider', ok: false, error: 'summary 必填',
  })
})

test('completedEntry：ok=true + 耗时 + 遮蔽节点数（0 = 无可压区间）', () => {
  assert.deepEqual(completedEntry(1500, 9), {
    phase: 'completed', side: 'provider', ok: true, waitedMs: 1500, chars: 9,
  })
})

test('failedEntry：只留首行且截断 200 字符（堆栈不落盘）', () => {
  const entry = failedEntry('第一行\n第二行\n堆栈')
  assert.equal(entry.ok, false)
  assert.equal(entry.error, '第一行')
  assert.equal(failedEntry('x'.repeat(500)).error.length, 200)
})

test('summarizeReason：折叠空白 + 截断', () => {
  assert.equal(summarizeReason('  多个\n\n空白   折叠  '), '多个 空白 折叠')
  assert.equal(summarizeReason('长'.repeat(100), 10), '长'.repeat(10) + '…')
})

test('agentLabel：安全取用，任何形状都不抛（拿不到即 n/a）', () => {
  assert.equal(agentLabel({ sessionId: 'session-abcdef' }, 16), 'session-abcdef')
  assert.equal(agentLabel(undefined), 'n/a')
  assert.equal(agentLabel({ id: 42 }), 'n/a')
  assert.equal(agentLabel('字符串不是对象'), 'n/a')
  assert.doesNotThrow(() => agentLabel(null))
})
