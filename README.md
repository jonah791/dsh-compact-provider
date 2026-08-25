<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 压缩一体化插件：AgentCompactEngine 挂载 compaction 服务 + session_compact 工具原语（爱丽丝自主决策压缩）
  inject: 'llm','tokenMeter','sessions','tools'
  tools: session_compact
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-compact-provider

独立压缩插件：把自研 AgentCompactEngine 挂载为 compaction 服务（想压就压，busy 会话也可压缩），替代官方 compaction-basic 三件套

## 生态

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）DSH 插件生态——21 个自研插件按生命/认知/感知/行动/通信/治理/呈现七层组织。

