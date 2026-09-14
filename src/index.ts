/**
 * dsh-compact-provider — 压缩一体化插件（2026-08-21 合并 compact-self）
 *
 * 把自研 AgentCompactEngine（dsh-agent-compact）挂载为 compaction 服务，
 * 替代官方 compaction-basic 三件套。「想压就压」：idle 会话同步压缩，
 * busy 会话把总结指令排进 inbox，下轮输出即摘要。
 *
 * 已吸收 dsh-agent-compact-self（2026-08-21 合并）：本插件同时注册
 * session_compact 工具原语——压缩何时发生由爱丽丝自主决策（框架零强制）。
 *
 * 挂载顺序（主人 2026-08-18 澄清）：先挂载本插件接管 compaction 服务，
 * 验证就绪后再停官方三件套（避免服务空窗 boot 失败）。
 *
 * 注：类型层面做宽松处理——插件与 dsh-agent-compact 各自 node_modules 的
 * cordis/schemastery 版本隔离导致严格类型不兼容；运行时在 web profile 统一，无碍。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentCompactEngine, compactTrace } from 'dsh-agent-compact'
import {
  precheckCompact, successNote, failureDetail, createCheckpointBestEffort,
  agentLabel, requestEntry, rejectedEntry, completedEntry, failedEntry,
} from './policy.ts'

export const name = 'compact-provider'
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'checkpoint'] as const

/** 复用 AgentCompactEngine 的完整配置 schema */
export const Config = AgentCompactEngine.Config as never

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const logger = ctx.logger('dsh-compact-provider')
  // 注册自研压缩引擎为 compaction 服务（覆盖官方 compaction-basic）
  const anyCtx = ctx as unknown as { compaction: unknown }
  anyCtx.compaction = new (AgentCompactEngine as unknown as new (c: unknown, cfg: unknown) => unknown)(ctx, config)
  logger.info('AgentCompactEngine 已接管 compaction 服务（想压就压：idle 同步 / busy 排队摘要）')

  // ── session_compact 工具（原 dsh-agent-compact-self）──
  const compaction = (anyCtx as {
    compaction?: { compactNow: (agent: Agent, signal: AbortSignal, commandId?: string) => Promise<unknown> }
  }).compaction

  ctx.tools.register(defineTool({
    name: 'session_compact',
    description: '自主压缩当前会话（爱丽丝决策）：调用 compaction seam 的 compactNow——注入总结指令后，下一轮爱丽丝输出 <compacted-summary> checkpoint 完成压缩。何时调用由爱丽丝自主判断（如上下文压力提醒后、或判断会话已过长）。框架零强制。',
    parameters: {
      reason: { type: 'string', description: '压缩原因（决策记录，必填以留痕）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason?: string }, exec: { agent?: Agent; signal: AbortSignal }) {
      const agent = exec.agent
      const t0 = Date.now()
      // 请求侧轨迹（2026-09-14）：引擎侧从 begin 起笔，「谁发起 / 为什么 / 判据过没过」在
      // 文件里是空白——那正是 Q2 与 Q3 的前半段。compactTrace 失败返回 false，**一律忽略**
      // （观测绝不反噬主流程；路径/序列化与引擎共用一份实现 = 判据单一真源）。
      if (args.reason) compactTrace(requestEntry(args.reason, agentLabel(agent)))
      const precondition = precheckCompact({
        reason: args.reason,
        hasCompaction: Boolean(compaction),
        hasAgent: Boolean(agent),
      })
      if (!precondition.ok) {
        // 未触 seam ⇒ 引擎侧不会有任何行，这条 rejected 是唯一证据
        compactTrace(rejectedEntry(precondition.error))
        return { ok: false, error: precondition.error }
      }
      // 判据已由 precheckCompact 给出（早退顺序一致）；断言仅为类型收窄，无运行期行为
      const seam = compaction!
      const target = agent!
      const reason = args.reason!
      // 压缩前自动存档（保命优先 2026-09-06）：压缩是上下文整合，先留健康快照防试错损失。
      // best-effort：checkpoint 服务不可用或存档失败不阻塞压缩（压缩本身可重试）。
      await createCheckpointBestEffort(
        () => (ctx as unknown as { checkpoint?: { create(reason: string): Promise<unknown> } }).checkpoint,
        reason,
        logger,
      )
      try {
        logger.info('爱丽丝决策压缩: ' + reason)
        // 关键：不传 exec.signal——工具调用被回合打断（abort）会触发 agent.cancel 导致 whenIdle 永不 resolve；
        // 用独立 controller，压缩事务与工具回合解耦
        await seam.compactNow(target, new AbortController().signal, 'alice-self-compact')
        compactTrace(completedEntry(Date.now() - t0))
        return { ok: true, note: successNote(reason) }
      } catch (err) {
        const { error, stack } = failureDetail(err)
        logger.error('压缩启动失败堆栈: ' + stack)
        compactTrace(failedEntry(error))
        return { ok: false, error }
      }
    },
  }))

  logger.info('dsh-compact-provider 就绪（压缩服务 + session_compact 原语合一）')
}
