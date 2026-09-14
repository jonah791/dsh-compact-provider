# dsh-compact-provider · 语义文档

## 1 元信息
- id: `compact-provider-direct-trigger`
- 版本: v0.3.0（2026-09-14）
- owner: 爱丽丝（alice）
- 主副本: 本文件（`self-plugins/dsh-compact-provider/docs/semantic.md`）
- 实现落点: `src/index.ts`（装配 + IO + 调度）、`src/direct.ts`（纯判定）
- 测试: `tests/direct.test.mjs`（纯函数，`node --test`）

## 2 定位与反定位
**定位**：本插件把自研 `AgentCompactEngine` 挂载为 `compaction` 服务，并提供三条压缩入口：
1. `session_compact` 工具（爱丽丝轮内自主决策，代价 = 意图请求 + 摘要请求）；
2. **直触压缩**（`turn/end` 处按常设授权直接开跑，代价 = 摘要请求一笔）——本版新增；
3. 引擎自身的 `auto` 路径（官方 replay 摘要器，本部署 `auto: false`，未启用）。

**反定位**：
- 不是「框架自动压缩」：不读阈值自动压，而是执行**爱丽丝撰写的常设授权**（见 §4 不变量 I2）。
- 不替代官方 `/compact` 命令路径；不改引擎的 summary/replace 事务字节格式（与官方 compaction-basic 可互换）。
- 不负责「何时该压」的价值观判断——那是爱丽丝的决策，本模块只执行已授权的策略并留痕。

## 3 术语
- **意图请求**：为在轮内调用 `session_compact` 而先发生的正常轮模型请求（实测 563,054 tok）。
- **摘要请求**：模型看见全文并输出 `<compacted-summary>` 的那次请求（实测 566,783 tok）。
- **直触**：在 `turn/end` 边界直接启动压缩事务，不经过「爱丽丝先花一轮说要压缩」。
- **常设授权**：`.dsh/compact-direct-policy.json`，由爱丽丝撰写、可随时改写或删除的策略文件。
- **飞行中**：最近一次 `compaction/start` 晚于最近一次 `compaction/end`（事务未落定）。

## 4 概念模型与不变量
模型（两个触发点共用同一判定）：`agent/pre-step`（轮内每步前）或 `turn/end`（每轮收尾）→ 取该会话的 agent → `tokenMeter.measure` → 读授权 + 状态 → **纯函数判定** → 触发/跳过 → 留痕。

- **I1 决策归爱丽丝**：触发只能来自她撰写的授权文件；文件缺失/损坏 → 永不触发（fail-closed）。
- **I2 授权会衰减**：`expiresAt` 到期即失效（不可解析的 `expiresAt` 同样视为过期）。
- **I3 至多一次**：每次触发前先写状态（`lastTriggeredAtMs` + 日计数），崩溃不会导致重复触发。
- **I4 可追溯**：每一次判定（含跳过）落一行 `.dsh/compact-direct.jsonl`（数字 + 结论）。
- **I5 只碰用户会话**：`session-*` 前缀；派生会话（子代理裸 uuid）不直触。
- **I6 不改事务语义**：直触复用引擎 `compactNow`，事件序列与工具路径完全一致。
- **I7 轮内可压（2026-09-14 主人定调）**：触发点之一在 `agent/pre-step`（轮内每一步之前），压缩**不需要额外一轮**——总结指令落在**同一轮的下一个 step**，checkpoint 与 `compaction/end` 都在触发所在的那一轮内完成（与 turn 71 实测同形：8092 触发 → 8097 checkpoint，同一轮）。`agent/pre-step` 是 waterfall：必须 `next()` 放行、**不 await**、2 秒节流、异常一律吞掉。

## 5 契约（含调用点清单）
### 5.1 授权文件 `.dsh/compact-direct-policy.json`
```json
{
  "authorized": true,
  "thresholdTokens": 500000,
  "maxPerDay": 8,
  "cooldownMs": 600000,
  "expiresAt": "2026-09-21T00:00:00+08:00",
  "note": "常设授权：越阈值即直触压缩（省掉意图请求）"
}
```
字段语义：`authorized` 必须为 `true`；其余缺省回退 `DEFAULT_*`；`expiresAt` 省略 = 不过期。

### 5.2 状态与留痕（本插件写）
- `.dsh/compact-direct-state.json`：`{ lastTriggeredAtMs, history: number[] }`（history 保留 3 天，`pruneHistory`）。
- `.dsh/compact-direct.jsonl`：每次判定一行 `{at, atMs, session, tokens, action: trigger|skip, reason, detail}`。

### 5.3 触发产生的事件（复用引擎，形状不变）
`compaction/start{sourceCommandId:"alice-direct-compact"}` → `agent/inbox/spliced`（指令入队）→ 模型输出 checkpoint → `compaction/summary` → `user/message`（替换表层）→ `compaction/end`。

### 5.4 调用点清单
| 调用点 | 位置 | 作用 |
|---|---|---|
| `ctx.on('agent/status')` | `src/index.ts` | 记住 `session.id → agent`（`turn/end` 时按 id 取回；不依赖新 inject） |
| `ctx.on('agent/pre-step')` | `src/index.ts` | **轮内触发点**（waterfall：`next()` 放行、不 await、2 秒节流）⇒ 压缩落在当前轮（I7） |
| `ctx.on('session/event')` `turn/end` | `src/index.ts` | **空闲兜底触发点**（`setImmediate` 让 turn 真正收尾） |
| `parseDirectPolicy` / `decideDirectCompaction` | `src/direct.ts` | 纯判定（无 IO） |
| `hasOpenCompaction` | `src/direct.ts` | 飞行检测（读事件流，有界回溯） |
| `compaction.compactNow(agent, signal, DIRECT_COMPACT_COMMAND_ID)` | `src/index.ts` | 引擎入口（与工具路径同一函数） |
| `session_compact` 工具 | `src/index.ts` | 爱丽丝轮内路径（不变；代价仍含意图请求） |

## 6 边界与信任
- **授权文件是信任边界**：能写该文件者即可让本会话自动压缩；文件在 `DSH_HOME`（本机、非仓库），不进 git。
- **读失败 = 不触发**（fail-closed）：JSON 坏、权限错、路径不存在一律走「未授权」分支并留痕。
- **写失败不阻塞压缩**：留痕/状态写盘失败只 `logger.warn`；但**状态写失败则当轮不触发**（保 I3）。
- **不越权扩范围**：只看 `totalTokens`，不看内容、不读消息正文。

## 7 可证伪验收
| # | 断言 | 判据 | 状态 |
|---|---|---|---|
| A1 | 授权缺失 → 不触发且留痕 `skip/未授权` | 单测 + `.dsh/compact-direct.jsonl` 行 | 待线上验收 |
| A2 | `tokens < threshold` → skip/未越阈值 | 单测（84,302 < 500,000） | 待线上验收 |
| A3 | `tokens ≥ threshold` 且授权有效 → trigger | 单测（566,783 ≥ 500,000） | 待线上验收 |
| A4 | 冷却/日限额/飞行中 → skip | 单测各一例 | 待线上验收 |
| A5 | 一次直触压缩的全上下文请求数 = **1**（今日工具路径为 2：563,054 + 566,783） | 事件流 `assistant/message.usage` 按 turn 汇总 | 待线上验收 |
| A6 | 直触产物与工具路径同形（`compaction/start|summary|end` + `sourceCommandId="alice-direct-compact"`） | 事件流 | 待线上验收 |
| A7 | 授权到期/不可解析 → 不触发 | 单测 | 待线上验收 |
| A8 | **轮内可压（I7）**：直触的 checkpoint 与 `compaction/end` 落在**触发所在的那一轮**（不需要额外一轮） | 事件流：`compaction/start.turn` = `compaction/end.turn` = checkpoint 的 `assistant/message.turn` | 待线上验收 |
| A9 | 轮内触发点不阻塞这一步：`agent/pre-step` 后本步请求正常发生 | 事件流 step 序列连续 + 无 `turn/end.reason=error` | 待线上验收 |

## 8 与实现关系
- 纯函数（可单测）：`parseDirectPolicy`、`decideDirectCompaction`、`countTriggeredToday`、`pruneHistory`、`ledgerLine`、`hasOpenCompaction`。
- 有 IO（装配层）：`readPolicy`、`readState`、`writeState`、`appendLedger`、调度与 `compactNow` 调用——全部在 `src/index.ts`，不参与单测。

## 9 实践修订记录
- 2026-09-14（本版缘起）：主人指出「现在完成① 触发那一拍的正常请求（563k，只为说出『我要压缩』），就可以直接进行压缩」。取证：turn 71 两笔请求 563,054 + 566,783 = `1.13M`（GUI「用量 1.1M tok」逐字吻合），确认①为可省项；`agentSummarize` 的 `agent.send(..., 'next-turn', true)` 证明直触能自起总结轮。
- 2026-09-14（同日二次回修 · v0.3.1）：初版把触发点只放在 `turn/end`，主人的意图是**「在当前 turn 就能压缩」**——于是补 `agent/pre-step` 触发点（I7）：指令落在同一轮的下一个 step，压缩**不需要额外一轮**；`turn/end` 保留为「会话空闲时主动压」的兜底。两个触发点共用同一判定与留痕，飞行检测（`hasOpenCompaction`）保证不重复触发。

## 10 未决问题
1. 直触压缩与「爱丽丝轮内 `session_compact`」是否需要一个显式互斥说明？（当前靠引擎 `active` + `hasOpenCompaction` 双保险）
2. 直触后是否需要向会话投递一条「本次压缩由常设授权触发」的可见提醒？（当前只落 `.jsonl` 与插件日志）
3. 阈值是否应随模型上下文窗口比例化（当前固定 500k，与提醒阈值一致）。
