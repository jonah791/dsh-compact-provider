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
import { AgentCompactEngine } from 'dsh-agent-compact'

export const name = 'compact-provider'
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools'] as const

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
      if (!args.reason) return { ok: false, error: 'reason 必填（自主决策留痕）' }
      if (!compaction) return { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' }
      const agent = exec.agent
      if (!agent) return { ok: false, error: '当前执行无 agent 上下文' }
      try {
        logger.info('爱丽丝决策压缩: ' + args.reason)
        // 关键：不传 exec.signal——工具调用被回合打断（abort）会触发 agent.cancel 导致 whenIdle 永不 resolve；
        // 用独立 controller，压缩事务与工具回合解耦
        await compaction.compactNow(agent, new AbortController().signal, 'alice-self-compact')
        return { ok: true, note: '压缩已启动：' + (args.reason ?? '') + '——请输出 <compacted-summary> checkpoint 完成事务' }
      } catch (err) {
        return { ok: false, error: '压缩启动失败: ' + String(err) }
      }
    },
  }))

  logger.info('dsh-compact-provider 就绪（压缩服务 + session_compact 原语合一）')
}
