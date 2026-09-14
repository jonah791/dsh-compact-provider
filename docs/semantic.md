# 语义文档：压缩入口与直触（Compaction Entry & Direct Trigger）

> ⚠ **已回退（2026-09-14，主人「回退压缩插件版本」）**：直触压缩**已下线**——插件回退到 **0.2.0**，只保留 `session_compact` 工具路径（轮内自主决策）。
> 本文保留为**设计记录**：§3/§4 里直触相关的内容（两触发点、授权/状态/留痕三份落盘、I7 轮内可压、I8 失败即重试）在**当前构建中不存在**；引擎侧 `dsh-agent-compact` 也一并回退到 **0.1.3**（撤下 0.1.4 的有界重发，保留在 git `ed4b4e0`）。
> 重新上线前必须：① 引擎侧先解决「指令入队后被消费、随 provider 重试蒸发」的投递丢失（真因见 §9 三次实践）② 再谈直触——它只是入口，救不了投递。

> 版本 v0.2.0（直触版 v0.3.2 已回退）· 2026-09-14 · 作者：爱丽丝 · 状态：**已回退（deprecated）**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-compact-provider/src/{index,direct}.ts`
> 语义主副本：本文；引擎侧契约见 `self-plugins/dsh-agent-compact/docs/semantic.md`（互相指认）

---

## 1 · 定位与反定位

**定位**：本插件是压缩的**入口层**——把自研 `AgentCompactEngine` 挂载为 `compaction` 服务，并提供三条入口：① `session_compact` 工具（爱丽丝轮内自主决策）② **直触压缩**（常设授权命中即直接开跑：`agent/pre-step` 轮内压制 + `turn/end` 空闲兜底）③ 引擎 `auto` 路径（本部署未启用）。同时负责**授权/状态/留痕**三份落盘。

**反定位（本文不管什么）**：
- 不管压缩事务本身（指令投递、捕获、表层换血 → `dsh-agent-compact`）
- 不管提醒（【上下文提醒】/【压缩告警】→ `dsh-agent-context`；压缩提醒 → `dsh-agent-skill-forge`）
- **不是**框架自动压缩：`auto` 保持 `false`；直触执行的是**爱丽丝撰写的常设授权**，不是内置阈值规则

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 意图请求 | 为在轮内调用工具而先发生的正常轮请求（实测 563,054 tok） |
| 摘要请求 | 模型输出 checkpoint 的那笔请求（实测 566,783 tok） |
| 直触 | 不由「爱丽丝先花一轮说我要压缩」触发，而由**轮内 pre-step 或轮末 turn/end** 按授权直接启动压缩事务 |
| 常设授权 | `.dsh/compact-direct-policy.json`，由爱丽丝撰写、可随时改写/删除/到期失效 |
| 飞行中 | 最近一次 `compaction/start` 晚于最近一次 `compaction/end`（事务未落定） |
| 留痕 | `.dsh/compact-direct.jsonl`，**每一次判定**（触发与跳过）一行 |

## 3 · 概念模型

```
两个触发点 ──┬─ agent/pre-step（轮内每步之前，2s 节流）──┐
             └─ session/event turn/end（每轮收尾）────────┤
                                                        ▼
                        evaluateDirectTrigger(sessionId)
                          ├─ 取 agent（agent/status 或 pre-step 记住的）
                          ├─ tokenMeter.measure(session).totalTokens
                          ├─ 读授权 parseDirectPolicy(.dsh/compact-direct-policy.json)
                          ├─ 读状态 readState(.dsh/compact-direct-state.json)
                          ├─ 读事件流：hasOpenCompaction（在飞行）/ latestCompactionOutcome（上次结局）
                          ├─ 纯判定 decideDirectCompaction(...)
                          ├─ 留痕 appendLedger(每行含 tokens/阈值/今日数/上次触发/结论)
                          └─ 命中 → 先写状态（至多一次）→ 压缩前存档 → compactNow(..., 'alice-direct-compact')
```

不变量（invariants）：
1. **I1 决策归爱丽丝**：授权文件缺失/损坏/`authorized≠true` → **永不触发**（fail-closed）
2. **I2 授权会衰减**：`expiresAt` 到期即失效；**不可解析的 `expiresAt` 同样视为已过期**
3. **I3 至多一次**：触发前先落状态（`lastTriggeredAtMs` + 日计数），此刻崩溃也不会重复触发
4. **I4 可追溯**：每次判定（含跳过）落一行 `.jsonl`（tokens/阈值/今日数/理由）
5. **I5 只碰用户会话**：`session-*` 前缀；派生会话（子代理裸 uuid）不直触
6. **I6 不改事务语义**：直触复用引擎 `compactNow`，事件序列与工具路径完全一致
7. **I7 轮内可压**：`agent/pre-step` 触发点让压缩**不需要额外一轮**——指令落在同一轮的下一个 step，checkpoint 与 `compaction/end` 都在触发所在那一轮内完成（`agent/pre-step` 是 waterfall：必须 `next()` 放行、**不 await**、异常一律吞掉）
8. **I8 失败即允许重试**：最近一次 `compaction/end` 带 error ⇒ 跳过冷却立即重试（重试仍受 `maxPerDay` 约束）——失败没缩小上下文，「触发过」≠「已处理」

## 4 · 契约

### 4.1 三份落盘（`DSH_HOME`，不进 git）
- `.dsh/compact-direct-policy.json`：`{authorized, thresholdTokens, maxPerDay, cooldownMs, expiresAt, note}`；缺省字段回退 `DEFAULT_*`（500k / 8 / 600000）
- `.dsh/compact-direct-state.json`：`{lastTriggeredAtMs, history: number[]}`（history 保留 3 天，`pruneHistory`）
- `.dsh/compact-direct.jsonl`：`{at, atMs, session, tokens, action: 'trigger'|'skip', reason, detail}`；超 512KB 保留末尾 400 行

### 4.2 裁决（纯函数优先）
`decideDirectCompaction(input) → {trigger, reason, detail}`：

| 输入状态 | 裁决 | 理由 |
|---------|------|------|
| 非 `session-*` | skip | 派生会话不直触 |
| `policy === null` | skip | 未授权 / 文件损坏（fail-closed） |
| 授权过期或 `expiresAt` 不可解析 | skip | 授权衰减 |
| `compactionActive` | skip | 事务在飞行 |
| 距上次触发 < `cooldownMs` 且**上次未失败** | skip | 冷却 |
| 今日触发 ≥ `maxPerDay` | skip | 日限额 |
| `tokens < thresholdTokens` | skip | 未越阈值 |
| 其余（含「上次失败」） | **trigger** | 越阈值直触 / 失败重试 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts` `ctx.on('agent/status')` | 记住 `session.id → agent`（不新增 inject） |
| 宿主事件 | `src/index.ts` `ctx.on('agent/pre-step')` | **轮内触发点**（waterfall，`next()` 放行） |
| 宿主事件 | `src/index.ts` `ctx.on('session/event')` | `turn/end` 收尾后 `setImmediate` 判定（**空闲兜底触发点**） |
| 工具面 | `src/index.ts` `session_compact` 工具 | 爱丽丝轮内自主决策（代价仍含意图请求） |
| 引擎 | `compaction.compactNow(agent, signal, 'alice-direct-compact')` | 直触实际启动事务 |
| checkpoint 服务 | `ctx.checkpoint.create(...)` | 两条入口压缩前都先存档（保命优先） |

### 4.4 请求侧侧车轨迹 `[MUST]`（2026-09-14 补）

**问题**：引擎侧轨迹（`dsh-agent-compact` 的 `<DSH_HOME>/compaction-trace.jsonl`）从 `begin` 起笔，于是「**谁发起 / 什么时候 / 为什么 / 前置判据过没过**」在文件里是空白——恰恰是 Q2 与 Q3 的前半段。取证只能回头反解会话事件流。

**契约**：本插件把入口侧四个阶段写**同一个文件**（不另开文件——单一落点、按 `atMs` 天然 join）：

| 阶段 | 含义 | 关键字段 |
|------|------|---------|
| `requested` | `session_compact` 工具被调用 | `side:'provider'`, `commandId:'alice-self-compact'`, `agentId`, `reason`（摘要：折叠空白 + 80 字符截断） |
| `rejected` | 前置判据未通过，**未触 seam** | `side:'provider'`, `ok:false`, `error` |
| `completed` | seam 返回 | `side:'provider'`, `ok:true`, `waitedMs` |
| `failed` | seam 抛错（只取首行、截 200 字符，**堆栈不落盘**） | `side:'provider'`, `ok:false`, `error` |

不变量：
- **I9 判据单一真源**：路径解析 / 行序列化 / 追加实现**全部**从引擎转出（`import { compactTrace } from 'dsh-agent-compact'`），本插件**不自己**实现落盘——两套实现必然漂移（§5.22 规则 4）。转出走主入口而非 `package.json` 子路径导出：消费方副本的 `package.json` 由 pnpm 重写，新增子路径导出不会同步（实测），届时 `ERR_PACKAGE_PATH_NOT_EXPORTED` 会让 provider 装载失败 = 压缩路径整体不可用。
- **I10 观测绝不反噬**：`compactTrace` 返回 `bool`，调用方**一律忽略**——它只影响证据，绝不影响压缩是否发生。
- **I11 `rejected` 是未触 seam 的唯一证据**：判据没过时引擎侧一行都不会有。
- **I12 两侧按 `atMs` join**：`requested → begin → queued → waited → surfaced → captured → completed` 即一笔完整事务；引擎行不带 `side`（向后兼容旧行），provider 行带 `side:'provider'`。

## 5 · 边界与信任

- **授权文件是信任边界**：能写该文件者即可让本会话自动压缩；文件在本机 `DSH_HOME`，不进仓库
- 不越界清单：只看 `totalTokens`，不读消息正文；不代替引擎做事务；不在 `auto:false` 时启用引擎的 replay 路径
- 失败面：① 授权读失败 → 判「未授权」并留痕（**响**）② 状态写失败 → **当轮不触发**（保 I3，留 warn）③ 留痕写失败 → 只 warn，不阻塞压缩 ④ 压缩事务失败 → 引擎写 `compaction/end.error`，本插件据此允许重试（I8）

## 6 · 与既有机制的关系

- AGENTS.md **§2.1/§2.4**（决策归爱丽丝 / 禁止框架自动压缩）：直触是**执行已授权决策**，不是自动决策机制；授权可删、可到期
- AGENTS.md **§5.21**（压缩 checkpoint 纪律）：checkpoint 独占一轮；压缩后立刻查存档
- AGENTS.md **§5.11 §6**（重建 ≠ 生效）：判据是「进程启动时间 vs `lib` mtime」
- 与引擎分工：本插件管**入口/授权/留痕**，`dsh-agent-compact` 管**事务/捕获/换血**

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 授权缺失 → skip/未授权且留痕 | 单测 + `.jsonl` 行 | 已实测（单测） |
| A2 | `tokens < 阈值` → skip/未越阈值 | 单测（84,302 < 500,000）+ 真实行 `tokens=316662 threshold=500000` | 已实测 |
| A3 | `tokens ≥ 阈值` 且授权有效 → trigger | 单测（566,783）+ 真实行 `tokens=321155 threshold=250000 …→ 直触` | 已实测 |
| A4 | 冷却 / 日限额 / 飞行中 → skip | 单测各一例 + 真实行 `冷却中（还剩 297893ms）` | 已实测 |
| A5 | **轮内可压（I7）**：`compaction/start.turn` = `compaction/end.turn` = checkpoint 的 turn | 事件流 | **待线上验收** |
| A6 | 直触产物与工具路径同形（`sourceCommandId="alice-direct-compact"`） | 事件流 8673（`turn=77 src=alice-direct-compact`） | 已实测 |
| A7 | 授权到期/不可解析 → skip | 单测 | 已实测（单测） |
| A8 | 上次事务失败 → 跳过冷却立即重试（I8） | 单测 + `.jsonl` 行 | 已实测（单测）/ **待线上验收** |
| A9 | `agent/pre-step` 不阻塞本步请求（`next()` 放行） | 事件流 step 序列连续、无 `turn/end.reason=error` | 已实测（无异常） |
| A10 | 一次直触压缩的全上下文请求数 = 1 | 按 turn 汇总 `assistant/message.usage` | **待线上验收** |
| A11 | 触发前必先落状态（至多一次） | `.jsonl` + state 行时序 | 已实测 |
| A12 | **调用工具即落 `requested`**（含 commandId/agentId/reason 摘要） | `tail -n 5 <DSH_HOME>/compaction-trace.jsonl` 见 `"phase":"requested","side":"provider"` | 已实测（单测 10/10 + 待线上首跑） |
| A13 | **判据未过 ⇒ 落 `rejected` 且引擎侧无 `begin`** | 空 reason 调 `session_compact`；轨迹出现 `rejected` 且无同 `atMs` 区间的 `begin` | 已实测（单测） |
| A14 | provider 与引擎**共用同一套判据**（serialize→parse 往返不丢字段） | `tests/trace-request.test.mjs`「判据单一真源」用例 | 已实测 |
| A15 | 落盘失败 → 返回 `false` 且**不抛**、不影响压缩 | 尸体测试（父路径是普通文件） | 已实测 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（装配、IO、两触发点、`compactNow` 调用）、`src/direct.ts`（全部纯判定）
- 同语义副本：无；消费方契约副本（引擎）见 `dsh-agent-compact/docs/semantic.md`
- 未实现/未验证部分**显式标注**：① A5/A8/A10 待线上验收（需要一次真实成功的直触）② `agent/pre-step` 触发点尚未在「单独越阈值且无其他工作」的会话上实测 ③ 状态文件未做并发写保护（单进程假设）

## 9 · 实践修订记录

- **2026-09-14 五次实践（请求侧自证 · 回退版之上只加观测）**
  - 动机：可维护性补课判本插件 S4 缺（"无落盘证据层"）。但真问题不是"没落盘"，而是**取证要反解会话流**：引擎侧从 `begin` 起笔，「谁发起 / 为什么 / 判据过没过」无处可查。
  - 语义**被补充**：入口侧四阶段 `requested/rejected/completed/failed` 写**引擎同一个文件**（§4.4，I9–I12）。
  - 语义**被确认（关键设计选择）**：**不自己实现落盘**——路径解析/序列化/追加全部 `import { compactTrace } from 'dsh-agent-compact'`。两套实现 = 两套判据，必然漂移。
  - 事故预防（实测两处，均为"动手前先探"救下的）：
    ① 子路径导出（`"./trace"`）在**消费方副本**里不存在——pnpm 重写了副本的 `package.json`（实测 `match './trace'` = **False**），走子路径导入会 `ERR_PACKAGE_PATH_NOT_EXPORTED` ⇒ **provider 装载失败 = 压缩路径整体不可用**。改走主入口转出（`./lib/index.js` 是硬链接，改动即时可见，实测哈希一致）。
    ② 新增**文件**不会进副本（C7），但本次只**改**已有文件（`trace.ts`/`index.ts`）⇒ 实测 `lib/trace.js`、`lib/index.js`、`lib/types/index.d.ts` 三处哈希与源一致，无需补链。
  - 教训：**"改压缩入口"必须先探消费方副本**——磁盘上构建成功 ≠ 运行时能加载。预检（full trial run）是最后一道闸门，本次部署前必须复跑。

## 10 · 未决问题

- **2026-09-14 首次实践（意图请求可省）**
  - 语义**被确认**：`agentSummarize` 用 `agent.send(..., 'next-turn', true)` 会自起总结轮 ⇒ 触发点不在「爱丽丝那一轮」即可省掉意图请求
  - 语义**被补充**：授权/状态/留痕三份落盘 + 纯判定全部可单测（16/16）
- **2026-09-14 二次实践（轮内可压 · v0.3.1）**
  - 语义**被修正**：初版只把触发点放在 `turn/end` ⇒ 压缩落到**下一轮**，与主人「在当前 turn 就能压缩」不符 ⇒ 补 `agent/pre-step` 触发点（I7）
- **2026-09-14 三次实践（失败不缩小上下文 · v0.3.2）**
  - 语义**被补充**：触发成功 ≠ 事务成功——真实事故 01:13:27Z 触发、`compaction/end`(seq 8781) 报 `never reached the model-visible surface`，上下文 321k→345k **毫发未缩**，而冷却把下一次机会挡了 10 分钟 ⇒ **I8 失败即允许重试**（`latestCompactionOutcome`）
  - 教训：留痕必须记录**结局**而不只是**触发**；「触发过」不能当作「已处理」
- **2026-09-14 四次实践（回退 · v0.2.0，主人定调）**
  - 语义**被推翻（本版）**：直触把压缩从「我在轮内明确决定」变成「常设授权驱动的自动起事务」，代价是**失败面成倍**——turn 77/78 两次直触事务失败（指令入队后被消费、随 provider 重试蒸发；引擎侧 0.1.4 重发修复尚未生效就又失败），turn 79 出现**孤儿 checkpoint**（事务已在 `compaction/end` error 结束，指令却在重启后浮到表层、被我照答，无人捕获，上下文 437k→439k 毫发未缩）。主人定调**回退到 0.2.0**。
  - 教训：**入口的自动化弥补不了投递的不可靠**——先在引擎侧把「指令必达」做成可证明的事实，再谈省掉意图请求。

## 10 · 未决问题

- **U1** 直触成功/失败是否需要在会话里可见（当前只落 `.jsonl` 与插件日志，GUI 只见压缩卡与 `sourceCommandId`）
- **U2** 阈值是否随模型上下文窗口比例化（当前固定值，与提醒阈值同源）
- **U3** 多实例（并行会话）共享 `.dsh` 时，state/ledger 是否需要按会话分文件或加锁
- **U4** `<DSH_HOME>/compaction-trace.jsonl` 现在有**两个写者**（provider 与引擎）。JSONL 单行追加在常规文件系统下是原子的（每行远小于 PIPE_BUF），但并发多会话下**行间顺序**不保证全局单调——按 `atMs` join 即可，若将来出现乱序归因困难，再考虑按会话分文件。
