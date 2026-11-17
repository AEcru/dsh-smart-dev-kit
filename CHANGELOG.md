# 变更记录

## 1.0.0 — 2026-11-17

首次开源发布。

- `dsh-preset-smart-dev@1.0.0`：`smart-dev` agent 预设，按 L1/L2/L3 复杂度自适应执行强度，包含调度员/执行器分工、验收纪律与红线条款。
- `dsh-smart-dev-panel@0.1.0`：右侧栏面板，展示工单、子代理、工具调用、token 与上下文消耗、失败重试、工作区变更；含 `superagent-router` 桥接入口。
- `dsh-preset-superagent-local@1.1.0`：可选工单运行时，在独立会话与 git worktree 中执行重型任务。
- `market/index.json`：插件市场索引，把三个包固定到发布提交。
