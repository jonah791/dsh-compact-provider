/**
 * dsh-compact-provider — 压缩一体化插件
 * 2026-08-21 合并 compact-self；2026-09-14 新增**直触压缩**（主人定调：省掉「意图请求」）。
 *
 * 三条入口：
 *  ① `session_compact` 工具 —— 爱丽丝轮内自主决策（代价：意图请求 + 摘要请求）
 *  ② **直触压缩** —— 常设授权命中即直接开跑，**两个触发点**：
 *     · `agent/pre-step`（轮内每步之前）⇒ 压缩落在**当前这一轮**（主人 2026-09-14 定调「在当前 turn 就能压缩」）
 *     · `turn/end`（每轮收尾）⇒ 会话空闲也主动压（下一轮的第一笔请求就已看见压缩后的上下文）
 *     代价：只有摘要请求（省掉「意图请求」）
 *  ③ 引擎 `auto` 路径 —— 官方 replay 摘要器（本部署 `auto: false`，未启用）
 *
 * 直触的动机与判据见 `src/direct.ts` 顶部注释与 `docs/semantic.md`；核心事实是
 * `agentSummarize` 用 `agent.send(..., 'next-turn', true)` 会**自己起总结轮**——因此触发点只要
 * 不在「爱丽丝这一轮」里，一次压缩就只需一笔全上下文请求（2026-09-14 实测：工具路径
 * 563,054 + 566,783 = 1.13M，直触省掉前者）。
 *
 * 注：类型层面做宽松处理——插件与 dsh-agent-compact 各自 node_modules 的
 * cordis/schemastery 版本隔离导致严格类型不兼容；运行时在 web profile 统一，无碍。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only：把 tokenMeter 服务注入 Context 类型（与 dsh-agent-compact 同款手法；
// 缺这行 tsc 报 TS2339: Property 'tokenMeter' does not exist on type 'Context'）
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { AgentCompactEngine } from 'dsh-agent-compact'
import {
  DIRECT_COMPACT_COMMAND_ID,
  countTriggeredToday,
  decideDirectCompaction,
  hasOpenCompaction,
  ledgerLine,
  parseDirectPolicy,
  pruneHistory,
} from './direct.ts'

export const name = 'compact-provider'
export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'checkpoint'] as const

/** 复用 AgentCompactEngine 的完整配置 schema */
export const Config = AgentCompactEngine.Config as never

/** 留痕文件体积上限：超过则保留末尾 400 行（防无限增长）。 */
const LEDGER_MAX_BYTES = 512 * 1024

/** 轮内触发点的判定节流：`agent/pre-step` 每步都发，避免每步都读盘。 */
const EVALUATE_THROTTLE_MS = 2_000

/** DSH_HOME（缺省 `~/.dsh`）：授权/状态/留痕的落点。 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const logger = ctx.logger('dsh-compact-provider')
  // 注册自研压缩引擎为 compaction 服务（覆盖官方 compaction-basic）
  const anyCtx = ctx as unknown as { compaction: unknown }
  anyCtx.compaction = new (AgentCompactEngine as unknown as new (c: unknown, cfg: unknown) => unknown)(ctx, config)
  logger.info('AgentCompactEngine 已接管 compaction 服务（想压就压：idle 同步 / busy 排队摘要）')

  const compaction = (anyCtx as {
    compaction?: { compactNow: (agent: Agent, signal: AbortSignal, commandId?: string) => Promise<unknown> }
  }).compaction

  /**
   * 压缩前自动存档（保命优先 2026-09-06）：压缩是上下文整合，先留健康快照防试错损失。
   * best-effort：checkpoint 服务不可用或存档失败不阻塞压缩（压缩本身可重试）。
   * 两条入口（工具 / 直触）共用。
   */
  const archiveBeforeCompaction = async (reason: string): Promise<void> => {
    try {
      const cp = (ctx as unknown as { checkpoint?: { create(reason: string): Promise<unknown> } }).checkpoint
      if (cp !== undefined) {
        await cp.create('压缩前自动存档（' + reason + '）')
        logger.info('压缩前自动存档完成（' + reason + '）')
      }
    } catch (err) {
      logger.warn('压缩前自动存档失败（不阻塞压缩）: ' + String(err))
    }
  }

  // ── 入口 ①：session_compact 工具（原 dsh-agent-compact-self）──
  ctx.tools.register(defineTool({
    name: 'session_compact',
    description: '自主压缩当前会话（爱丽丝决策）：调用 compaction seam 的 compactNow——注入总结指令后，下一轮爱丽丝输出 <compacted-summary> checkpoint 完成压缩。何时调用由爱丽丝自主判断（如上下文压力提醒后、或判断会话已过长）。框架零强制。注意：轮内调用需先付一次全上下文（意图请求）；若已给常设授权（.dsh/compact-direct-policy.json），越阈值时 turn/end 会直接开跑，无需本工具。',
    parameters: {
      reason: { type: 'string', description: '压缩原因（决策记录，必填以留痕）' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string' }, error: { type: 'string' } } }, render: (_a: any, v: any) => [{ type: 'text', text: v.ok ? (v.note ?? 'ok') : (v.error ?? '') }] },
    async execute(args: { reason?: string }, exec: { agent?: Agent; signal: AbortSignal }) {
      if (!args.reason) return { ok: false, error: 'reason 必填（自主决策留痕）' }
      if (!compaction) return { ok: false, error: 'compaction seam 不可用（AgentCompactEngine 未就绪）' }
      const agent = exec.agent
      if (!agent) return { ok: false, error: '当前执行无 agent 上下文' }
      await archiveBeforeCompaction(args.reason)
      try {
        logger.info('爱丽丝决策压缩: ' + args.reason)
        // 关键：不传 exec.signal——工具调用被回合打断（abort）会触发 agent.cancel 导致 whenIdle 永不 resolve；
        // 用独立 controller，压缩事务与工具回合解耦
        await compaction.compactNow(agent, new AbortController().signal, 'alice-self-compact')
        return { ok: true, note: '压缩已启动：' + (args.reason ?? '') + '（压缩前已自动存档）——请输出 <compacted-summary> checkpoint 完成事务' }
      } catch (err) {
        const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err)
        logger.error('压缩启动失败堆栈: ' + stack)
        return { ok: false, error: '压缩启动失败: ' + String(err) + '\n' + stack.slice(0, 2000) }
      }
    },
  }))

  // ── 入口 ②：直触压缩（2026-09-14 主人定调：不为说一句「我要压缩」先付一次全上下文）──
  const home = dshHome()
  const policyPath = join(home, 'compact-direct-policy.json')
  const statePath = join(home, 'compact-direct-state.json')
  const ledgerPath = join(home, 'compact-direct.jsonl')
  /** `session.id → agent`：`turn/end` 只给 session，agent 由 `agent/status` / `agent/pre-step` 记住。 */
  const knownAgents = new Map<string, Agent>()
  /** 轮内触发点的节流表（`session.id → 上次判定时刻`）。 */
  const lastEvaluatedAt = new Map<string, number>()

  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
  }
  const readState = (): { lastTriggeredAtMs: number | null; history: number[] } => {
    const raw = readJson(statePath)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { lastTriggeredAtMs: null, history: [] }
    }
    const record = raw as { lastTriggeredAtMs?: unknown; history?: unknown }
    const last = typeof record.lastTriggeredAtMs === 'number' && Number.isFinite(record.lastTriggeredAtMs)
      ? record.lastTriggeredAtMs
      : null
    const history = Array.isArray(record.history)
      ? record.history.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      : []
    return { lastTriggeredAtMs: last, history }
  }
  /** 状态写盘：失败即当轮不触发（保「至多一次」不变量）。 */
  const writeState = (state: { lastTriggeredAtMs: number | null; history: number[] }): boolean => {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(state, null, 1), 'utf8')
      return true
    } catch (err) {
      logger.warn('直触压缩状态写盘失败（本轮不触发）: ' + String(err))
      return false
    }
  }
  /** 留痕：一次判定一行；超限则保留末尾 400 行。写失败只告警（不影响压缩）。 */
  const appendLedger = (line: string): void => {
    try {
      appendFileSync(ledgerPath, line + '\n', 'utf8')
      if (statSync(ledgerPath).size > LEDGER_MAX_BYTES) {
        const kept = readFileSync(ledgerPath, 'utf8')
          .split('\n')
          .filter((entry) => entry.trim() !== '')
          .slice(-400)
        writeFileSync(ledgerPath, kept.join('\n') + '\n', 'utf8')
      }
    } catch (err) {
      logger.warn('直触留痕写盘失败: ' + String(err))
    }
  }

  /**
   * 判定 → 触发。两个调用点共用：`agent/pre-step`（轮内，压缩落在当前轮）与
   * `session/event` 的 `turn/end`（空闲兜底）。判定本身纯函数、IO 全在本层。
   */
  const evaluateDirectTrigger = async (sessionId: string): Promise<void> => {
    const agent = knownAgents.get(sessionId)
    if (agent === undefined || compaction === undefined) return
    const nowMs = Date.now()
    let tokens = 0
    try {
      const meter: TokenMeter = ctx.tokenMeter
      tokens = meter.measure(agent.session).totalTokens
    } catch (err) {
      logger.warn('直触压缩测量失败（跳过）: ' + String(err))
      return
    }
    const view = agent.session as unknown as {
      seq: number
      eventAt(seq: number): { readonly type?: string } | undefined
    }
    const { policy } = parseDirectPolicy(readJson(policyPath))
    const state = readState()
    const decision = decideDirectCompaction({
      tokens,
      isUserSession: sessionId.startsWith('session-'),
      policy,
      nowMs,
      lastTriggeredAtMs: state.lastTriggeredAtMs,
      triggeredToday: countTriggeredToday(state.history, nowMs),
      compactionActive: hasOpenCompaction(view, view.seq),
    })
    appendLedger(ledgerLine({
      atMs: nowMs,
      sessionId,
      tokens,
      trigger: decision.trigger,
      reason: decision.reason,
      detail: decision.detail,
    }))
    if (!decision.trigger) return
    // 「至多一次」：先落状态，再启动事务——此刻崩溃也不会重复触发
    if (!writeState({
      lastTriggeredAtMs: nowMs,
      history: pruneHistory([...state.history, nowMs], nowMs),
    })) return
    await archiveBeforeCompaction('常设授权直触: ' + decision.reason)
    logger.info('直触压缩触发：' + decision.detail)
    try {
      // 独立 signal：压缩事务与触发它的那一轮解耦（同工具路径的理由）
      void compaction.compactNow(agent, new AbortController().signal, DIRECT_COMPACT_COMMAND_ID)
        .catch((err: unknown) => logger.warn('直触压缩事务失败: ' + String(err)))
    } catch (err) {
      logger.warn('直触压缩启动失败: ' + String(err))
    }
  }

  ctx.on('agent/status', (payload: { agent: Agent }) => {
    knownAgents.set(payload.agent.session.id, payload.agent)
  })

  // ── 触发点 ①：轮内每步之前 ⇒ 压缩落在**当前这一轮**（主人 2026-09-14：「我的意思是在当前 turn 就能压缩」）──
  // 机制：`agentSummarize` 用 `agent.send(instruction, 'next-turn', true)` 投递指令，busy 会话的指令会在
  // **同一轮的下一个 step** 被消费（turn 71 实测：8092 触发 → 8097 checkpoint，同一轮 = 轮内可压）。
  // 纪律：① 本 hook 是 waterfall，**必须 `next()` 放行** ② **不 await**（同步执行会阻塞这一步的请求）
  //       ③ 2 秒节流（每步都发，别每步都读盘） ④ 判定异常一律吞掉，绝不影响这一步。
  ctx.on('agent/pre-step', (payload: { agent: Agent }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    try {
      const agent = payload.agent
      if (agent !== undefined) {
        const sessionId = agent.session.id
        knownAgents.set(sessionId, agent)
        const now = Date.now()
        if (now - (lastEvaluatedAt.get(sessionId) ?? 0) >= EVALUATE_THROTTLE_MS) {
          lastEvaluatedAt.set(sessionId, now)
          void evaluateDirectTrigger(sessionId)
        }
      }
    } catch { /* 判定失败不得影响这一步 */ }
    return next()
  })

  // ── 触发点 ②：每轮收尾 ⇒ 会话空闲也主动压（下一轮的第一笔请求就已看见压缩后的上下文）──
  ctx.on('session/event', (session: { id: string }, event: unknown) => {
    if ((event as { type?: string } | null)?.type !== 'turn/end') return
    // setImmediate：等这一轮真正收尾再判定（reenter 纪律 §5.12 §4：事件回调内不得同步重入）
    setImmediate(() => { void evaluateDirectTrigger(session.id) })
  })

  logger.info('直触压缩已就绪（授权文件 ' + policyPath + '；文件缺失或过期则永不触发）')
  logger.info('dsh-compact-provider 就绪（压缩服务 + session_compact 原语 + 直触压缩）')
}
