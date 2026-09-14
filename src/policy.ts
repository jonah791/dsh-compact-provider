/**
 * dsh-compact-provider — 纯决策层（零 IO，可离线单测）
 *
 * session_compact 的入口判据（含早退顺序）与全部文案构造、best-effort 存档包装。
 * 判据 = 源码唯一真源：本文件与原 index.ts 闭包内逻辑逐字等价（只搬位置）。
 *
 * 2026-09-14 追加：**请求侧轨迹条目构造**（纯数据，零 IO）。类型取自引擎转出的
 * `TraceEntry`（type-only import，运行期被擦除——不引入对消费方副本的运行期依赖）。
 */
import type { TraceEntry } from 'dsh-agent-compact'

/** 存档失败/跳过时的最小 logger 面（宿主 ctx.logger 天然满足） */
export interface PolicyLogger {
  info(message: string): void
  warn(message: string): void
}

/** 入口判据所需的三个事实（由接线层探测后传入） */
export interface CompactPrecheckInput {
  /** 工具的 reason 参数 */
  reason?: string
  /** compaction seam 是否可用 */
  hasCompaction: boolean
  /** 当前执行是否有 agent 上下文 */
  hasAgent: boolean
}

export type CompactPrecheck = { ok: true } | { ok: false; error: string }

/**
 * session_compact 入口判据（早退顺序即原实现顺序）：
 * ① reason 必填 → ② compaction seam → ③ agent 上下文
 */
export function precheckCompact(input: CompactPrecheckInput): CompactPrecheck {
  if (!input.reason) return { ok: false, error: 'reason 必填（自主决策留痕）' }
  if (!input.hasCompaction) return { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' }
  if (!input.hasAgent) return { ok: false, error: '当前执行无 agent 上下文' }
  return { ok: true }
}

/** 压缩前自动存档的原因串 */
export function checkpointReason(reason: string): string {
  return '压缩前自动存档（' + reason + '）'
}

/** 压缩启动成功的回执（提示输出 checkpoint 完成事务） */
export function successNote(reason: string): string {
  return '压缩已启动：' + reason + '（压缩前已自动存档）——请输出 <compacted-summary> checkpoint 完成事务'
}

/** 失败串（含堆栈前 2000 字符）与堆栈本身（供落日志） */
export function failureDetail(err: unknown): { error: string; stack: string } {
  const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err)
  return { error: '压缩启动失败: ' + String(err) + '\n' + stack.slice(0, 2000), stack }
}

/**
 * 压缩前 best-effort 存档（C4：观测/存档绝不反噬主流程）。
 * 取服务（getter，与原实现「读服务也在 try 内」等价）与调用任一失败都吞错 → 返回 false；
 * seam 不可用 → 跳过并返回 true；任何情况下不抛。
 */
export async function createCheckpointBestEffort(
  resolveCheckpoint: () => { create(reason: string): Promise<unknown> } | undefined,
  reason: string,
  logger?: PolicyLogger,
): Promise<boolean> {
  try {
    const cp = resolveCheckpoint()
    if (cp === undefined) return true
    await cp.create(checkpointReason(reason))
    logger?.info('压缩前自动存档完成（' + reason + '）')
    return true
  } catch (err) {
    logger?.warn('压缩前自动存档失败（不阻塞压缩）: ' + String(err))
    return false
  }
}

// ─────────────── 请求侧轨迹（provider 侧自证 · 2026-09-14）───────────────
//
// 动机：引擎侧轨迹从 `begin` 起笔，于是「**谁发起、什么时候、为什么、前置判据过没过**」
// 在文件里是空白——那正是 Q2 与 Q3 的前半段。本层补 `requested` / `rejected` /
// `completed` / `failed` 四个阶段，写**引擎同一个文件**（`<DSH_HOME>/compaction-trace.jsonl`），
// 用 `side:'provider'` 区分，与引擎侧 `begin/queued/waited/surfaced/captured/abort`
// 按 `atMs` 天然 join 成一笔完整事务。
//
// 纪律：本层只构造**纯数据**（零 IO、零时间）；落盘由接线层调引擎转出的 `compactTrace`
// 完成（判据单一真源——路径解析/序列化/追加实现与引擎共用一份）。
// 观测绝不反噬：`compactTrace` 失败返回 false，调用方一律忽略返回值。

/** 请求侧轨迹条目（去掉由引擎侧补的 atMs/build） */
export type ProviderTraceEntry = Omit<TraceEntry, 'atMs' | 'build'>

/** reason 摘要：折叠空白 + 截断（决策留痕足够，不落全文） */
export function summarizeReason(reason: string, max = 80): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** agent 标识摘要：安全取用，任何形状都不抛（拿不到即 'n/a'） */
export function agentLabel(agent: unknown, max = 16): string {
  try {
    const a = agent as { id?: unknown; sessionId?: unknown } | null | undefined
    const raw = a?.sessionId ?? a?.id
    const s = typeof raw === 'string' && raw !== '' ? raw : 'n/a'
    return s.length > max ? s.slice(0, max) : s
  } catch {
    return 'n/a'
  }
}

/** 工具入口被调用（含 commandId 与 reason 摘要） */
export function requestEntry(reason: string, agent: string): ProviderTraceEntry {
  return {
    phase: 'requested',
    side: 'provider',
    commandId: 'alice-self-compact',
    agentId: agent,
    reason: summarizeReason(reason),
  }
}

/** 前置判据未通过：**未触 seam**（因此引擎侧不会有 begin——这条是唯一证据） */
export function rejectedEntry(error: string): ProviderTraceEntry {
  return { phase: 'rejected', side: 'provider', ok: false, error }
}

/** seam 返回（事务已启动；成败细节看引擎侧后续阶段） */
export function completedEntry(waitedMs: number): ProviderTraceEntry {
  return { phase: 'completed', side: 'provider', ok: true, waitedMs }
}

/** seam 抛错（入口侧视角的失败；引擎侧可能另有 abort） */
export function failedEntry(error: string): ProviderTraceEntry {
  return { phase: 'failed', side: 'provider', ok: false, error: error.split('\n')[0]!.slice(0, 200) }
}
