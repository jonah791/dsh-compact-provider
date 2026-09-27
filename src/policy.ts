/**
 * dsh-compact-provider — 纯决策层（零 IO，可离线单测）
 *
 * 0.2.0（标记驱动）后本层的职责缩到两件：**入口判据**与**请求侧轨迹条目构造**。
 * 压缩前存档已移交引擎（两条入口共用一处保命网），投递相关的判据随投递链一起删除。
 *
 * 纪律：本层只构造**纯数据**（零 IO、零时间）；落盘由接线层调引擎转出的 `compactTrace`
 * 完成（判据单一真源——路径解析/序列化/追加实现与引擎共用一份）。
 */
import type { TraceEntry } from 'dsh-agent-compact'

/** 入口判据所需的三个事实（由接线层探测后传入） */
export interface CompactPrecheckInput {
  /** 工具调用方给出的 checkpoint 正文 */
  summary?: string
  /** compaction seam 是否可用 */
  hasCompaction: boolean
  /** 当前执行是否有 agent 上下文 */
  hasAgent: boolean
}

export type CompactPrecheck = { ok: true } | { ok: false; error: string }

/**
 * session_compact 入口判据（早退顺序即实现顺序）：
 * ① summary 必填且非空白 → ② compaction seam → ③ agent 上下文
 *
 * 为什么 summary 必填：本工具的语义是「用**这份** checkpoint 替换历史」。旧契约
 * （只给 reason，由引擎投递指令再捕获）已在 0.2.0 删除——它需要一次额外的全上下文
 * 请求，且投递不可靠（三次事故）。缺 summary 时**立即响亮拒绝**，不静默降级。
 * @param input - 三项事实
 * @returns 判据结论
 */
export function precheckCompact(input: CompactPrecheckInput): CompactPrecheck {
  // 形状防御：工具参数来自**模型生成的 JSON**（不是同进程类型可信面）——非字符串
  // 脏值要拒绝而不是抛 TypeError，否则一次畸形调用会把工具错误变成未捕获异常。
  if (typeof input.summary !== 'string' || input.summary.trim() === '') {
    return { ok: false, error: 'summary 必填：把 checkpoint 正文作为参数传入（引擎不再投递总结指令）' }
  }
  if (!input.hasCompaction) return { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' }
  if (!input.hasAgent) return { ok: false, error: '当前执行无 agent 上下文' }
  return { ok: true }
}

/** 成功回执：说清「压了哪一段、少了几节」，而不是一句空 ok */
export function successNote(shadowedNodes: number, shadowedTokens: number): string {
  return '压缩完成：遮蔽 ' + String(shadowedNodes) + ' 个表层节点（约 '
    + String(shadowedTokens) + ' tokens）'
}

/** 失败串（含堆栈前 2000 字符）与堆栈本身（供落日志） */
export function failureDetail(err: unknown): { error: string; stack: string } {
  const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err)
  return { error: '压缩失败: ' + String(err) + '\n' + stack.slice(0, 2000), stack }
}

// ─────────────── 请求侧轨迹（provider 侧自证 · 2026-09-14）───────────────
//
// 动机：引擎侧轨迹从「识别到提交」起笔，于是「**谁发起、什么时候、为什么、前置判据过没过**」
// 在文件里是空白。本层补 `requested` / `rejected` / `completed` / `failed` 四个阶段，
// 写**引擎同一个文件**（`<DSH_HOME>/compaction-trace.jsonl`），用 `side:'provider'` 区分。
//
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

/** 工具入口被调用（含 commandId、reason 摘要与 checkpoint 体量） */
export function requestEntry(reason: string, agent: string, chars: number): ProviderTraceEntry {
  return {
    phase: 'requested',
    side: 'provider',
    commandId: 'alice-self-compact',
    agentId: agent,
    reason: summarizeReason(reason),
    chars,
  }
}

/** 前置判据未通过：**未触 seam**（因此引擎侧不会有任何行——这条是唯一证据） */
export function rejectedEntry(error: string): ProviderTraceEntry {
  return { phase: 'rejected', side: 'provider', ok: false, error }
}

/** seam 返回（事务已完成，成败看 result；`null` = 无可压区间） */
export function completedEntry(waitedMs: number, shadowedNodes: number): ProviderTraceEntry {
  return { phase: 'completed', side: 'provider', ok: true, waitedMs, chars: shadowedNodes }
}

/** seam 抛错（入口侧视角的失败；引擎侧可能另有 abort） */
export function failedEntry(error: string): ProviderTraceEntry {
  return { phase: 'failed', side: 'provider', ok: false, error: error.split('\n')[0]!.slice(0, 200) }
}
