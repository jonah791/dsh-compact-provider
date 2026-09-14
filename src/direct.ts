/**
 * 直触压缩（direct trigger · 2026-09-14 主人定调）
 *
 * ## 代价事实（2026-09-14 实测）
 * 一次压缩要花**两笔全上下文请求**：
 *   ① 触发那一拍的正常轮请求 —— turn 71 实测 `563,054 tok`，只为在轮内调 `session_compact`
 *      说一句「我要压缩」（意图请求）；
 *   ② 摘要请求 —— `566,783 tok`，与 `compaction/summary.usage` 逐字相同。
 * 摘要请求是本质（总结必须看见全文），**能省的是 ①**。
 *
 * ## 为什么能省（机制事实）
 * `agentSummarize` 用 `agent.send(instruction, 'next-turn', true)` 投递总结指令——它会**自己起一个
 * 总结轮**。因此只要触发点不在「爱丽丝这一轮」里，压缩就能直接开跑：事件流里
 * `compaction/start → 指令入队 → 模型输出 checkpoint → summary → end`，全程只有一次全上下文请求。
 *
 * ## 决策归谁（AGENTS.md §2.1 / §2.4）
 * 本条**不是**「框架自动压缩」：不启用 `auto`（官方 replay 路径），实现的是**常设授权**——
 * 授权文件（`.dsh/compact-direct-policy.json`）由爱丽丝撰写（阈值/日限额/冷却/到期时间/理由），
 * 插件只执行她已记录的决策，并把**每一次判定**（触发或跳过）落盘留痕（`.dsh/compact-direct.jsonl`）。
 * 文件缺失 = 未授权 = 永不直触（fail-closed）；`expiresAt` 到期即失效（授权自动衰减，逼我重新裁决）。
 *
 * ## 契约形态
 * 本模块**纯函数**：无 IO、无时间、无宿主类型耦合——IO 与调度留在 `index.ts`，判定全部可单测。
 */

/** 默认阈值：与 `dsh-agent-context` 的提醒阈值一致（500k）。 */
export const DEFAULT_THRESHOLD_TOKENS = 500_000
/** 默认日限额：一天最多直触几次（防「压了又压」）。 */
export const DEFAULT_MAX_PER_DAY = 8
/** 默认冷却：两次直触之间至少间隔（防同轮/连续轮反复触发）。 */
export const DEFAULT_COOLDOWN_MS = 600_000
/** 默认回溯窗口：足够覆盖一次到数轮对话内的压缩事件（事件流有界回溯，不扫全库）。 */
export const DEFAULT_LOOKBACK = 400
/** 直触压缩的 `sourceCommandId`：事件流与 GUI 里可辨认「这次不是爱丽丝轮内触发的」。 */
export const DIRECT_COMPACT_COMMAND_ID = 'alice-direct-compact'
/** `expiresAt` 不可解析时的落值：视为**已过期**（fail-closed，宁可不压也不越权）。 */
export const EXPIRED_MS = -1

/** 常设授权（爱丽丝撰写，插件执行）。 */
export interface DirectPolicy {
  /** 必须显式为 `true` 才生效（缺省/其它值 = 未授权）。 */
  readonly authorized: boolean
  /** 触发阈值：`totalTokens` 达到该值才直触。 */
  readonly thresholdTokens: number
  /** 日限额：自然日内最多触发次数。 */
  readonly maxPerDay: number
  /** 冷却：距上次触发至少间隔多少 ms。 */
  readonly cooldownMs: number
  /** 授权到期时刻（ms epoch）；`null` = 不过期。 */
  readonly expiresAtMs: number | null
  /** 授权理由（人读，写进留痕）。 */
  readonly note: string
}

/** 正整数/非负整数取字段，坏值回退默认。 */
function positiveInt(value: unknown, fallback: number, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floor = Math.floor(value)
  if (allowZero ? floor < 0 : floor <= 0) return fallback
  return floor
}

/** 解析到期时刻：ISO 字符串或 ms 数字；缺失 = 不过期；给了但不可解析 = 已过期。 */
function parseExpiryMs(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? EXPIRED_MS : parsed
  }
  return EXPIRED_MS
}

/**
 * 解析授权文件内容。任何形状问题都返回 `policy: null`（调用方据此跳过直触并留痕）——
 * 坏数据不得被解读成「授权」。
 * @param raw - 文件 JSON 解析后的值（`null` = 文件不存在或不可解析）
 * @returns 策略与解析结论（`reason` 用于留痕）
 */
export function parseDirectPolicy(raw: unknown): { policy: DirectPolicy | null; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: null, reason: '未授权：授权文件缺失或不是对象' }
  }
  const record = raw as Record<string, unknown>
  if (record.authorized !== true) {
    return { policy: null, reason: '未授权：authorized 不是 true' }
  }
  const note = typeof record.note === 'string' ? record.note : ''
  return {
    policy: {
      authorized: true,
      thresholdTokens: positiveInt(record.thresholdTokens, DEFAULT_THRESHOLD_TOKENS),
      maxPerDay: positiveInt(record.maxPerDay, DEFAULT_MAX_PER_DAY, true),
      cooldownMs: positiveInt(record.cooldownMs, DEFAULT_COOLDOWN_MS, true),
      expiresAtMs: parseExpiryMs(record.expiresAt),
      note,
    },
    reason: '授权有效（' + (note === '' ? '无备注' : note) + '）',
  }
}

/** 判定输入（全部显式传入：无隐式状态依赖）。 */
export interface DirectDecisionInput {
  /** 当前上下文测量值（`tokenMeter.measure().totalTokens`）。 */
  readonly tokens: number
  /** 是否用户会话（`session-*`）；派生会话（子代理裸 uuid）不直触。 */
  readonly isUserSession: boolean
  /** 常设授权（`null` = 未授权）。 */
  readonly policy: DirectPolicy | null
  /** 判定时刻。 */
  readonly nowMs: number
  /** 上次直触时刻（`null` = 从未）。 */
  readonly lastTriggeredAtMs: number | null
  /** 自然日内已触发次数。 */
  readonly triggeredToday: number
  /** 该会话是否已有压缩事务在飞行。 */
  readonly compactionActive: boolean
  /**
   * 上一次直触是否**失败**（最近一次 `compaction/end` 带 error）。
   * 2026-09-14 二次事故：直触事务失败时上下文毫发未缩，而冷却（10min）会把下一次机会挡在门外
   * ——「触发过」被误当成「已处理」。失败 ⇒ 跳过冷却立即重试（重试次数仍受 maxPerDay 约束）。
   */
  readonly lastTriggerFailed: boolean
}

/** 判定结论：`reason` = 人读结论，`detail` = 带数字的证据行。 */
export interface DirectDecision {
  readonly trigger: boolean
  readonly reason: string
  readonly detail: string
}

/**
 * 直触压缩判定（fail-closed，顺序固定、每条都有名字）。
 *
 * 顺序：派生会话 → 未授权 → 授权过期 → 在飞行 → 冷却 → 日限额 → 未越阈值 → 触发。
 * 「在飞行/冷却/日限额」在前是因为它们与「该不该压」无关——**先排除结构性不可为，再看压力**。
 * @param input - 判定输入
 * @returns 是否触发 + 理由
 */
export function decideDirectCompaction(input: DirectDecisionInput): DirectDecision {
  const { tokens, policy, nowMs, lastTriggeredAtMs, triggeredToday, compactionActive } = input
  const detail = 'tokens=' + String(tokens)
    + ' threshold=' + String(policy?.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS)
    + ' today=' + String(triggeredToday)
    + ' lastTriggered=' + (lastTriggeredAtMs === null ? 'never' : new Date(lastTriggeredAtMs).toISOString())
  if (!input.isUserSession) {
    return { trigger: false, reason: '派生会话（子代理）不直触', detail }
  }
  if (policy === null) {
    return { trigger: false, reason: '无常设授权（爱丽丝未授权或文件损坏）', detail }
  }
  if (!policy.authorized) {
    return { trigger: false, reason: '授权为 false', detail }
  }
  if (policy.expiresAtMs !== null && policy.expiresAtMs <= nowMs) {
    return {
      trigger: false,
      reason: '授权已过期（expiresAt='
        + (policy.expiresAtMs === EXPIRED_MS ? '不可解析' : new Date(policy.expiresAtMs).toISOString())
        + '）',
      detail,
    }
  }
  if (compactionActive) {
    return { trigger: false, reason: '已有压缩事务在飞行', detail }
  }
  // 失败即允许立即重试（跳过冷却）：失败的事务没缩小上下文，「触发过」≠「已处理」
  if (lastTriggeredAtMs !== null && !input.lastTriggerFailed && nowMs - lastTriggeredAtMs < policy.cooldownMs) {
    return {
      trigger: false,
      reason: '冷却中（还剩 ' + String(policy.cooldownMs - (nowMs - lastTriggeredAtMs)) + 'ms）',
      detail,
    }
  }
  if (triggeredToday >= policy.maxPerDay) {
    return { trigger: false, reason: '日限额已用尽（' + String(triggeredToday) + '/' + String(policy.maxPerDay) + '）', detail }
  }
  if (tokens < policy.thresholdTokens) {
    return { trigger: false, reason: '未越阈值', detail }
  }
  return {
    trigger: true,
    reason: input.lastTriggerFailed
      ? '上次直触事务失败 → 跳过冷却立即重试'
      : '越阈值直触（省掉意图请求）',
    detail: detail + (input.lastTriggerFailed ? ' lastOutcome=error → 重试' : ' → 直触'),
  }
}

/** 同日（本地时区）判定。 */
function sameLocalDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

/**
 * 数「自然日内已触发次数」。
 * @param history - 历史触发时刻（ms）
 * @param nowMs - 当前时刻
 * @returns 同日次数
 */
export function countTriggeredToday(history: readonly number[], nowMs: number): number {
  let count = 0
  for (const at of history) if (Number.isFinite(at) && sameLocalDay(at, nowMs)) count += 1
  return count
}

/**
 * 修剪历史（保留最近 keepDays 天 + 过滤坏值）——状态文件不得无限增长。
 * @param history - 历史触发时刻（ms）
 * @param nowMs - 当前时刻
 * @param keepDays - 保留天数
 * @returns 修剪后的历史（升序）
 */
export function pruneHistory(history: readonly number[], nowMs: number, keepDays = 3): number[] {
  const floor = nowMs - keepDays * 24 * 60 * 60 * 1000
  return history
    .filter((at): at is number => typeof at === 'number' && Number.isFinite(at) && at >= floor)
    .sort((a, b) => a - b)
}

/** 留痕行（一次判定一行，含数字与结论）。 */
export interface DirectLedgerEntry {
  readonly atMs: number
  readonly sessionId: string
  readonly tokens: number
  readonly trigger: boolean
  readonly reason: string
  readonly detail: string
}

/**
 * 序列化留痕行（纯函数：便于断言格式稳定）。
 * @param entry - 判定记录
 * @returns 单行 JSON（不含换行）
 */
export function ledgerLine(entry: DirectLedgerEntry): string {
  return JSON.stringify({
    at: new Date(entry.atMs).toISOString(),
    atMs: entry.atMs,
    session: entry.sessionId,
    tokens: entry.tokens,
    action: entry.trigger ? 'trigger' : 'skip',
    reason: entry.reason,
    detail: entry.detail,
  })
}

/** 会话事件视图（与引擎内部同形：`seq` + `eventAt`）。 */
export interface CompactionEventView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
}

/**
 * 最近一次压缩事务的结局（成功/失败）。
 *
 * 用途（2026-09-14 二次事故）：直触的事务可能失败（`compaction/end.error`），而失败**不缩小上下文**；
 * 判定必须据此跳过冷却允许重试——否则「触发过」被误当成「已处理」。
 * @param view - 会话事件视图
 * @param fromSeq - 起点（通常是 `session.seq`）
 * @param lookback - 最多向前回溯多少 seq
 * @returns 最近一次 `compaction/end` 的 seq 与错误（无错则 error=null）；窗口内没有则 null
 */
export function latestCompactionOutcome(
  view: CompactionEventView,
  fromSeq: number,
  lookback = DEFAULT_LOOKBACK,
): { readonly seq: number; readonly error: string | null } | null {
  const floor = Math.max(0, fromSeq - lookback)
  for (let seq = fromSeq; seq >= floor; seq -= 1) {
    const event = view.eventAt(seq)
    if (event === null || event === undefined || typeof event !== 'object') continue
    if (event.type !== 'compaction/end') continue
    const data = event.data
    const raw = data !== null && typeof data === 'object'
      ? (data as { error?: unknown }).error
      : undefined
    return { seq, error: typeof raw === 'string' && raw.length > 0 ? raw : null }
  }
  return null
}

/**
 * 是否有压缩事务在飞行（最近一次 `compaction/start` 晚于最近一次 `compaction/end`）。
 *
 * 不依赖引擎私有状态（`AgentCompactEngine.active` 不可读、`inspectCompactionEntryState`
 * 未从包根导出）——直接读事件流，与 `dsh-agent-context` 的取证形状一致（有界回溯，不扫全库）。
 * @param view - 会话事件视图
 * @param fromSeq - 起点（通常是 `session.seq`）
 * @param lookback - 最多向前回溯多少 seq
 * @returns 在飞行 → true
 */
export function hasOpenCompaction(
  view: CompactionEventView,
  fromSeq: number,
  lookback = DEFAULT_LOOKBACK,
): boolean {
  const floor = Math.max(0, fromSeq - lookback)
  let startSeq: number | null = null
  let endSeq: number | null = null
  for (let seq = fromSeq; seq >= floor; seq -= 1) {
    const event = view.eventAt(seq)
    if (event === null || event === undefined || typeof event !== 'object') continue
    if (event.type === 'compaction/end' && endSeq === null) endSeq = seq
    else if (event.type === 'compaction/start' && startSeq === null) startSeq = seq
    if (endSeq !== null && startSeq !== null) break
  }
  return startSeq !== null && startSeq > (endSeq ?? -1)
}
