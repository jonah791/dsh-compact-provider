/**
 * dsh-compact-provider — policy.ts 回归测试（跑 lib 产物，与运行时同源）
 * 运行：node --test tests/policy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  precheckCompact, checkpointReason, successNote, failureDetail, createCheckpointBestEffort,
} from '../lib/policy.js'

// ---------- precheckCompact：主路径 ----------

test('precheck：三条件齐备 → ok', () => {
  assert.deepEqual(
    precheckCompact({ reason: '上下文 514k，主动压缩', hasCompaction: true, hasAgent: true }),
    { ok: true },
  )
})

test('precheck：reason 缺失 → 报「reason 必填」', () => {
  assert.deepEqual(
    precheckCompact({ reason: undefined, hasCompaction: true, hasAgent: true }),
    { ok: false, error: 'reason 必填（自主决策留痕）' },
  )
})

test('precheck：compaction seam 缺失 → 报「不可用」', () => {
  assert.deepEqual(
    precheckCompact({ reason: 'r', hasCompaction: false, hasAgent: true }),
    { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' },
  )
})

test('precheck：无 agent 上下文 → 报「无 agent 上下文」', () => {
  assert.deepEqual(
    precheckCompact({ reason: 'r', hasCompaction: true, hasAgent: false }),
    { ok: false, error: '当前执行无 agent 上下文' },
  )
})

test('precheck：早退顺序不变——reason 优先于 compaction 与 agent', () => {
  const r = precheckCompact({ reason: '', hasCompaction: false, hasAgent: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'reason 必填（自主决策留痕）')
})

test('precheck：早退顺序不变——compaction 优先于 agent', () => {
  const r = precheckCompact({ reason: 'r', hasCompaction: false, hasAgent: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'compaction seam 不可用（AgentCompactEngine 未就绪）')
})

// ---------- precheckCompact：退化/边界输入必须不抛 ----------

test('退化：空串 reason → 按缺失处理（不抛，返回错误而非异常）', () => {
  const r = precheckCompact({ reason: '', hasCompaction: true, hasAgent: true })
  assert.deepEqual(r, { ok: false, error: 'reason 必填（自主决策留痕）' })
})

test('退化：纯空白 reason → 视为已提供（保守沿用原判据：非空即通过）', () => {
  assert.deepEqual(
    precheckCompact({ reason: '   ', hasCompaction: true, hasAgent: true }),
    { ok: true },
  )
})

test('退化：reason 传 falsy 非字符串（0/null/false/NaN）→ 不抛且保守拒绝', () => {
  for (const bad of [0, null, false, NaN]) {
    const r = precheckCompact({ reason: bad, hasCompaction: true, hasAgent: true })
    assert.equal(r.ok, false, `reason=${String(bad)} 应被拒绝`)
    assert.equal(r.error, 'reason 必填（自主决策留痕）')
  }
})

test('退化：reason 传对象/数组（truthy 脏数据）→ 不抛，沿用原判据（非空即通过）', () => {
  // 逐字等价约束：原实现是 `if (!args.reason)`，truthy 即通过——此处锁定该判据而非「修正」它
  for (const odd of [{}, [], '0']) {
    assert.deepEqual(precheckCompact({ reason: odd, hasCompaction: true, hasAgent: true }), { ok: true })
  }
})

test('退化：整个入参缺字段（脏调用）→ 不抛且保守拒绝', () => {
  const r = precheckCompact({})
  assert.deepEqual(r, { ok: false, error: 'reason 必填（自主决策留痕）' })
})

// ---------- 文案构造（真实常数逐字锁定） ----------

test('checkpointReason：逐字构造存档原因', () => {
  assert.equal(checkpointReason('上下文压力'), '压缩前自动存档（上下文压力）')
})

test('successNote：逐字构造成功回执', () => {
  assert.equal(
    successNote('上下文压力'),
    '压缩已启动：上下文压力（压缩前已自动存档）——请输出 <compacted-summary> checkpoint 完成事务',
  )
})

// ---------- failureDetail ----------

test('failureDetail：Error → 错误串含 message 与堆栈', () => {
  const err = new Error('seam 抖动')
  const { error, stack } = failureDetail(err)
  assert.ok(error.startsWith('压缩启动失败: Error: seam 抖动\n'))
  assert.equal(stack, err.stack)
  assert.ok(error.includes(String(err.stack).slice(0, 50)))
})

test('failureDetail：堆栈超长 → 截断到 2000 字符（前缀保留）', () => {
  const err = new Error('boom')
  err.stack = 'x'.repeat(5000)
  const { error } = failureDetail(err)
  assert.equal(error, '压缩启动失败: Error: boom\n' + 'x'.repeat(2000))
  assert.equal(error.length, '压缩启动失败: Error: boom\n'.length + 2000)
})

test('failureDetail：Error 无 stack → 回退 String(err)', () => {
  const err = new Error('nostack')
  err.stack = undefined
  const { error, stack } = failureDetail(err)
  assert.equal(stack, 'Error: nostack')
  assert.equal(error, '压缩启动失败: Error: nostack\nError: nostack')
})

test('退化：failureDetail 喂非 Error / null / undefined → 不抛且给出可读串', () => {
  assert.equal(failureDetail('plain string').error, '压缩启动失败: plain string\nplain string')
  assert.equal(failureDetail(null).error, '压缩启动失败: null\nnull')
  assert.equal(failureDetail(undefined).error, '压缩启动失败: undefined\nundefined')
  assert.equal(failureDetail({ a: 1 }).error, '压缩启动失败: [object Object]\n[object Object]')
})

// ---------- createCheckpointBestEffort：主路径 + 失败不反噬 ----------

test('best-effort 存档：seam 不可用 → 跳过并返回 true', async () => {
  assert.equal(await createCheckpointBestEffort(() => undefined, 'r'), true)
})

test('best-effort 存档：成功 → true 且信息写进 logger', async () => {
  const seen = []
  const ok = await createCheckpointBestEffort(
    () => ({ create: async (reason) => { seen.push(reason); return {} } }),
    '上下文压力',
    { info: (m) => seen.push('info:' + m), warn: (m) => seen.push('warn:' + m) },
  )
  assert.equal(ok, true)
  assert.deepEqual(seen, [
    '压缩前自动存档（上下文压力）',
    'info:压缩前自动存档完成（上下文压力）',
  ])
})

test('写/存失败不抛：create reject → 返回 false（吞错，不阻塞压缩）', async () => {
  const warns = []
  const ok = await createCheckpointBestEffort(
    () => ({ create: async () => { throw new Error('磁盘满') } }),
    'r',
    { info: () => {}, warn: (m) => warns.push(m) },
  )
  assert.equal(ok, false)
  assert.deepEqual(warns, ['压缩前自动存档失败（不阻塞压缩）: Error: 磁盘满'])
})

test('写/存失败不抛：create 同步抛 → 返回 false', async () => {
  const ok = await createCheckpointBestEffort(
    () => ({ create: () => { throw new Error('sync boom') } }),
    'r',
  )
  assert.equal(ok, false)
})

test('写/存失败不抛：取服务本身抛（cordis 代理拒绝）→ 返回 false', async () => {
  const ok = await createCheckpointBestEffort(() => { throw new Error('cannot get property checkpoint without inject') }, 'r')
  assert.equal(ok, false)
})

test('退化：未传 logger → 失败路径仍不抛', async () => {
  const ok = await createCheckpointBestEffort(
    () => ({ create: async () => { throw new Error('x') } }),
    'r',
  )
  assert.equal(ok, false)
})
