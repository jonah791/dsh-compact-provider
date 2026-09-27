<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 压缩入口插件：挂载 AgentCompactEngine 为宿主 compaction 服务 + session_compact 显式入口工具（爱丽丝自主决策压缩）
  inject: 'agents','tokenMeter','sessions','tools'
  tools: session_compact
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 只做「入口约束 + 留痕」；「什么时候压」由 agent 自主决策（框架零强制），压缩前存档归引擎
  compat: cordis ^4.0.1 / dsh-agent ^0.1.2-rc.1
-->
# dsh-compact-provider — 压缩入口（挂载 + 显式工具）

<p align="center">
  <a href="https://github.com/jonah791/dsh-compact-provider"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/tests-29%20passed-brightgreen" alt="tests">
</p>

**一句话**：把自研压缩引擎（[dsh-agent-compact](https://github.com/jonah791/dsh-agent-compact)）挂成宿主 `compaction` 服务，并注册 `session_compact` 工具——**压缩何时发生由 agent 自主决策，框架零强制**。

**为什么值得用**：引擎是压缩事务的执行者，本插件是它的**入口与门房**——管前置判据、管决策留痕。**主路径其实不需要这个工具**：在任意一轮输出里直接写 checkpoint 块即可（零额外请求）；工具是「不想把 checkpoint 写进正文」或「需要显式可控入口」时的第二入口。

> ⚠ 本插件与引擎是**回退对**（provider 0.3.0 ↔ 引擎 0.2.1），同进同退，禁止单侧回退。

## 定位与反定位

- **管**：入口约束（summary 必填 → compaction seam 在位 → agent 上下文在位）、显式入口、请求侧留痕。
- **不管**：压缩事务（识别/换血/幂等 → 引擎）；压缩前存档（→ 引擎，2026-09-27 移交）；「什么时候压」的决策（→ agent 自主，本插件只提供原语）。
- **不是**自动压缩：本插件无任何定时器/阈值触发。

## 能力

| 面 | 内容 |
|----|------|
| 工具 | `session_compact`——参数 `summary`（**必填**，checkpoint 正文）、`reason`（决策留痕）。与标记路径共用同一事务 |
| 服务 | 挂载 `AgentCompactEngine` 为宿主 `ctx.compaction` |
| 留痕 | 请求侧四阶段写 `<DSH_HOME>/compaction-trace.jsonl`（与引擎共用一个文件） |

## 快速开始

```yaml
# 预设行（与引擎成对挂载）
- id: compact-provider
  name: dsh-compact-provider
  config:
    enabled: true
    minCheckpointChars: 200
```

安装走 `self-plugins/` link 依赖 + 预设行（详见生态中心仓）。**必须与 `dsh-agent-compact` 同挂同停**——provider 单独拉起会在 seam 缺失时报错。

## 配置

**复用引擎的 `CompactConfig` schema**（只有两项：`enabled` 与 `minCheckpointChars`，全表见引擎 README 与 `docs/semantic.md` §4.1）。本插件自身**无独立配置**——这是刻意的：入口与引擎共享同一批裁决参数，不存在两处漂移。

> ⚠ 引擎 0.2.0 起**旧策略键已全部删除**（`thresholdRatio` / `retainRatio` / `auto` / `modelPolicies` …）。组合里留着旧键会**装载失败**——升级时先清 config。

## 落盘与自证

每次 `session_compact` 调用，**请求侧**落这些阶段（与引擎侧 `detected→committed` / `rejected` / `abort` 按 `atMs` 天然 join 成一笔）：

| 阶段 | 含义 | 关键字段 |
|------|------|---------|
| `requested` | 工具被调用 | `side:'provider'`, `commandId`, `agentId`, `reason`（折叠空白 + 80 字符截断） |
| `rejected` | 前置判据未过，**未触 seam**（引擎侧因此无任何行——这条是唯一证据） | `side:'provider'`, `ok:false`, `error` |
| `completed` | seam 返回 | `side:'provider'`, `ok:true`, `chars` |
| `failed` | seam 抛错（只取首行、截 200 字符，**堆栈不落盘**） | `side:'provider'`, `ok:false`, `error` |

```bash
grep '"side":"provider"' "$DSH_HOME/compaction-trace.jsonl" | tail -3
# ② 谁发起 → agentId + commandId + reason
# ③ 断在哪 → rejected（判据没过）vs failed（seam 抛错）vs completed（往下看引擎阶段）
# ④ 结果质量 → chars
```

判据单一真源：路径解析/序列化/追加实现**全部**从引擎转出（`import { compactTrace } from 'dsh-agent-compact'`），本插件不自己实现第二套。

## 生效判据与回退

**生效判据**：
1. 调一次 `session_compact {}`（缺 summary 即触发 `rejected`）→ `grep '"phase":"rejected"' "$DSH_HOME/compaction-trace.jsonl"` 应出现该行；
2. `plugin_boot_status` 的 `liveNow` 含本插件；
3. 行为级：真压缩一次 `compaction/end` 无 error + 上下文 token 实际下降。

> **重新构建 ≠ 生效**；且注意 C7：新增源文件（如引擎的 `src/marker.ts`）不会自动出现在本插件 `node_modules` 里对引擎的 pnpm hardlink 副本中——改了引擎新增文件后必须**先查消费方副本文件集再重启**（预检会替你拦）。

**回退**：
- 源码级：`git revert <commit>` → 重建 → `preflight_check`（full）→ 重启；
- 组合级：`disabled: true`（引擎同步停）；
- 版本级：与引擎是回退对（0.3.0 ↔ 0.2.1），不可只回退一侧。

## 测试

```bash
npm test        # node --test "tests/*.test.mjs"
```

**29 例离线测试**：`policy.test.mjs`（前置判据 / **非字符串 summary 的形状防御**——模型给 JSON 不得抛错 / 文案构造）+ `trace-request.test.mjs`（阶段条目构造、reason 摘要、agent 标识安全取用、**serialize→parse 往返证明与引擎判据同源**、两写者按 atMs join、**尸体测试**——父路径是普通文件时 `appendTraceEntry` 返回 `false` 且不抛）。

## 设计要点

- **summary 必填**：本工具的语义是「用**这份** checkpoint 替换历史」——旧契约「调用后等下轮输出」需要指令投递链，那条链已整体删除。缺参会得到明确的 `rejected` 而不是静默无事发生。
- **不传 exec.signal**：工具回合被打断（abort）会触发 agent 取消导致 seam 永不 resolve——用独立 controller 让压缩事务与工具回合解耦。
- **观测绝不反噬**：`compactTrace` 返回 `bool`，一律忽略——它只影响证据，绝不影响压缩是否发生。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：不变量（判据单一真源/观测不反噬/rejected 唯一证据/两侧 join）、验收清单、§9 事故预防记录（子路径导出不会同步到 pnpm 副本——**走主入口转出**） |
| [dsh-agent-compact](https://github.com/jonah791/dsh-agent-compact) | 引擎侧主副本（识别与事务契约），两文档互相指认 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 生态中心 |

## License

MIT © jonah791

---

本插件属于爱丽丝 DSH 自研插件生态（见 [alice-digital-life](https://github.com/jonah791/alice-digital-life)）。
