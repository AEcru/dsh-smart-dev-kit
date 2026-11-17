# SuperAgent模式

DeepSeek Harness 的单预设本地协作模式，版本 `1.1.0`。在同一个聊天里提问、讨论方案或交办 Git 项目任务。需要执行时，系统自动建立工单，在独立会话与 Git worktree 中处理，把问题和结果送回原会话。

## 从 1.0.0 升级

在 DSH 的 Creator 会话里，用 `plugin_manager` 的 `remove_bundle` 卸载 `dsh-preset-superagent-local`。完全退出并重开 DSH，释放旧版的工单数据库锁。再用 `install_bundle` 安装 `dsh-preset-superagent-local-1.1.0.tgz` 的绝对路径并启用。已有工单继续使用原 SQLite 数据和 worktree，旧执行会话会迁移到合并后的预设。

预设列表只应显示一张本插件卡片 **SuperAgent模式**。可以用 Creator 诊断 `superagent-local-runtime` 和 `preset-superagent-local` 的 `fiberPhase`。新安装可直接安装该 `.tgz`。

## 使用

在 DSH 打开已有提交的 Git 工作区，选择 **SuperAgent模式**，直接输入自然语言。

- 「worktree 和分支有什么区别？」在当前对话中直接回答。
- 「先给我一份修复计划」在当前对话中讨论方案。
- 「检查 README 里的安装命令并报告问题」自动创建只读工单。
- 「修正 README 里的安装步骤，再验证示例命令」自动创建执行工单。
- 「工单 `<ID>` 只检查 Windows 安装步骤」把本轮补充转交指定工单。没有写 ID 时，只有一张未结束工单才可自动转交。

自然语言意图由当前会话模型识别。宿主核对 DSH 记录的本轮用户消息，把原文作为不可变授权范围，同一条消息只进入一个工单操作。工单运行需要已配置模型、可执行 `git`，以及存在 Git HEAD 的工作区。附件请用仓库路径和文字说明交办。

仍可用以下命令明确控制工单。

| 命令 | 用途 |
| --- | --- |
| `/superagent start <任务描述>` | 按用户原文显式建单 |
| `/superagent list` | 列出当前会话最近的工单 |
| `/superagent status <工单 ID>` | 查看授权、进度、工作树和结果 |
| `/superagent reply <工单 ID> <内容>` | 转交补充或按原授权恢复已完成工单 |
| `/superagent retry <工单 ID>` | 重新分配阻塞或投递失败的工单 |
| `/superagent stop <工单 ID>` | 撤回工单授权并停止执行 |

工单以提交时的 HEAD 为基线。原工作区未提交的改动不会出现在工单工作树。交付后可在工单状态中查看工作树路径，自行审阅和合入。DSH 数据目录中的 `superagent-local/<profile>/tickets.sqlite` 保存工单，同级 `worktrees` 保存工作树。

该 bundle 复用 [上游原型 `8c32a9dc`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) 的工单引擎、SQLite Store、Effects、AgentDelivery 和后台任务辅助代码。它面向本地 Git 工单，交付通道是 DSH 会话。上游 GitHub／飞书连接和 Web 面板需要独立部署。
