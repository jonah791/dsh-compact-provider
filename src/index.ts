/**
 * dsh-compact-provider — 压缩入口（组合层）
 *
 * 职责两件：① 把自研 `AgentCompactEngine` 挂载为 `compaction` 服务（覆盖官方
 * compaction-basic）② 注册 `session_compact` 工具原语。
 *
 * 0.2.0（标记驱动）后本插件的语义变化：压缩的**主路径**不再是这个工具，而是 agent
 * 在自己输出里写的 checkpoint 块（引擎旁路识别 → 表层换血，零额外请求）。工具保留为
 * **显式入口**：把摘要作为参数直接交给引擎，用于「不想把 checkpoint 写进正文」或
 * 「标记路径需要一个人工可控的对照路径」的场合。旧契约（只传 reason，等引擎投递总结
 * 指令）已删除——它需要一次额外的全上下文请求，且投递不可靠。
 *
 * 挂载顺序（主人 2026-08-18 澄清）：先挂载本插件接管 compaction 服务，
 * 验证就绪后再停官方三件套（避免服务空窗 boot 失败）。
 *
 * 注：类型层面做宽松处理——插件与 dsh-agent-compact 各自 node_modules 的
 * cordis/schemastery 版本隔离导致严格类型不兼容；运行时在 web profile 统一，无碍。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentCompactEngine, compactTrace } from 'dsh-agent-compact'
import {
  precheckCompact, successNote, failureDetail,
  agentLabel, requestEntry, rejectedEntry, completedEntry, failedEntry,
} from './policy.ts'

export const name = 'compact-provider'
export const inject = ['agents', 'tokenMeter', 'sessions', 'tools'] as const

/** 复用 AgentCompactEngine 的完整配置 schema */
export const Config = AgentCompactEngine.Config as never

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const logger = ctx.logger('dsh-compact-provider')
  const engine = new (AgentCompactEngine as unknown as new (c: unknown, cfg: unknown) => {
    compactWithSummary: (
      agent: Agent, summary: string, beforeSeq?: number, sourceCommandId?: string,
    ) => Promise<{ shadowedSeqs: readonly unknown[]; shadowedTokenCount: number } | null>
  })(ctx, config)
  logger.info('AgentCompactEngine 已接管 compaction 服务（标记驱动：agent 输出即压缩请求；无自动路径）')

  ctx.tools.register(defineTool({
    name: 'session_compact',
    description:
      '显式压缩当前会话：把 summary 作为 checkpoint 交给引擎，替换「本条消息之前」的全部历史。'
      + '**主路径不需要这个工具**——在任意一轮输出里直接写 checkpoint 块（首行哨兵 <!-- alice-compact -->，'
      + '紧跟 <compacted-summary> 外壳，正文含全部 8 个 section）即可零额外请求完成压缩。'
      + '本工具用于不想把 checkpoint 写进正文、或需要一个显式可控入口的场合。'
      + '何时压缩由爱丽丝自主判断；框架零强制（无自动压缩路径）。',
    parameters: {
      summary: { type: 'string', description: 'checkpoint 正文（8 个 section 的结构化摘要；引擎原样作为替换体）', required: true },
      reason: { type: 'string', description: '压缩原因（决策记录，留痕用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: { ok: boolean; note?: string; error?: string }) =>
        [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }],
    },
    async execute(args: { summary?: string; reason?: string }, exec: { agent?: Agent; signal: AbortSignal }) {
      const agent = exec.agent
      const t0 = Date.now()
      // 请求侧轨迹（2026-09-14）：引擎侧从「识别到提交」起笔，「谁发起 / 为什么 / 判据过没过」
      // 在文件里是空白。compactTrace 失败返回 false，**一律忽略**（观测绝不反噬主流程）。
      if (args.reason) compactTrace(requestEntry(args.reason, agentLabel(agent), args.summary?.length ?? 0))
      const precondition = precheckCompact({
        summary: args.summary,
        hasCompaction: typeof engine?.compactWithSummary === 'function',
        hasAgent: Boolean(agent),
      })
      if (!precondition.ok) {
        compactTrace(rejectedEntry(precondition.error))
        return { ok: false, error: precondition.error }
      }
      try {
        logger.info('爱丽丝决策压缩: ' + (args.reason ?? '(未给原因)'))
        // 不传 exec.signal：工具回合被打断不该让已经开始的表层替换半途而废
        const result = await engine.compactWithSummary(agent!, args.summary!, undefined, 'alice-self-compact')
        if (result === null) {
          compactTrace(completedEntry(Date.now() - t0, 0))
          return { ok: true, note: '无可压区间（标记位置之前没有可压缩的历史）——会话未改动' }
        }
        compactTrace(completedEntry(Date.now() - t0, result.shadowedSeqs.length))
        return { ok: true, note: successNote(result.shadowedSeqs.length, result.shadowedTokenCount) }
      } catch (err) {
        const { error, stack } = failureDetail(err)
        logger.error('压缩失败堆栈: ' + stack)
        compactTrace(failedEntry(error))
        return { ok: false, error }
      }
    },
  }))

  logger.info('dsh-compact-provider 就绪（压缩服务 + session_compact 显式入口）')
}
