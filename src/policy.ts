/**
 * dsh-compact-provider — 纯决策层（零 IO，可离线单测）
 *
 * session_compact 的入口判据（含早退顺序）与全部文案构造、best-effort 存档包装。
 * 判据 = 源码唯一真源：本文件与原 index.ts 闭包内逻辑逐字等价（只搬位置）。
 */

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
