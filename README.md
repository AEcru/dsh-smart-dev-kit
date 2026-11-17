# 智能开发模式 · Smart Dev Kit

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的一套开发工作流：一个按任务复杂度自适应的 agent 预设，加一块把执行过程摊开在右侧栏的面板。

这不是又一个"提示词模板"。它想解决的是两个具体毛病：小事上过度工程（写一堆计划，最后只改一行），大事上过早收工（没验证就说做完了）。

## 包含什么

| 包 | 作用 | 是否必需 |
| --- | --- | --- |
| `dsh-preset-smart-dev` | 主预设。声明 `smart-dev` 模式，带完整工具组与工作法提示词 | 必需 |
| `dsh-smart-dev-panel` | 右侧栏面板。工单、子代理、工具调用、token 消耗、失败重试、工作区变更 | 必需（预设依赖它的桥接入口） |
| `dsh-preset-superagent-local` | 工单运行时。把手上的重型任务丢进独立 git worktree 执行 | 可选 |

## 它到底怎么工作

预设的提示词要求模型在开工前先定档，档位决定投入：

- **L1**：单文件或单一问题、无高风险 → 直接做，最多两轮工具，一句话给结果。
- **L2**：多文件、需要验证 → 建工单，简短计划，必要时派一个子代理，跑完检查再汇报。
- **L3**：跨模块、改公共接口、高风险或需求模糊 → 先研判给方案，确认后再动手，严格验收。

配套的几条纪律约束了输出噪音：过程保持安静，只在有结果、要决策或做不成时说话；验收不外包给子代理；没验证过的结论要说没验证。

面板把这些过程可视化，所以"停下来汇报"是有据可查的，而不是一句"我做完了"。

## 安装

DSH 版本要求：`>= 0.2.0`。

### 方式一：插件市场（推荐）

DSH 的插件市场读一份你自己托管的索引，不会自动扫描 GitHub。在设置里添加本仓库的索引地址，之后在发现页就能看到这三个插件：

```
https://raw.githubusercontent.com/AEcru/dsh-smart-dev-kit/main/market/index.json
```

国内访问 `raw.githubusercontent.com` 不稳定时可以换 jsDelivr 镜像，两份内容相同：

```
https://cdn.jsdelivr.net/gh/AEcru/dsh-smart-dev-kit@main/market/index.json
```

装的时候先装 `dsh-smart-dev-panel`，再装 `dsh-preset-smart-dev`。顺序反了会因为桥接入口找不到而装不上。

如果设置里找不到添加索引的入口，说明当前 profile 没有启用插件市场组合包。DSH 随附的 profile 默认不启用它，需要先在插件页启用，这一步属于 DSH 自身配置，不在本仓库范围内。

### 方式二：从插件页直接装

在 DSH 侧边栏的插件页选"安装"，粘贴固定到提交的 Git 地址（`<full-commit>` 换成索引里的 40 位提交号）：

```
git+https://github.com/AEcru/dsh-smart-dev-kit.git#<full-commit>&path:/packages/smart-dev-panel
git+https://github.com/AEcru/dsh-smart-dev-kit.git#<full-commit>&path:/packages/preset-smart-dev
```

必须固定到完整提交号，用分支名或标签装上的副本之后无法更新。

### 装完

重启 DSH。新建任务时模式选择器里会出现「智能开发模式」，右侧栏会出现「智能开发」面板，开 `smart-dev` 会话时自动打开。

## 仓库结构

```
packages/
  preset-smart-dev/         # 主预设，纯配置（cordis.patch.yml + package.json）
  smart-dev-panel/          # 面板：host 半 + Web client 半 + superagent 桥接
  preset-superagent-local/  # 工单运行时（可选）
market/
  index.json                # 插件市场索引，由 scripts/build-index.mjs 生成
scripts/
  build-index.mjs           # 重新生成索引（回填当前提交号）
docs/
  architecture.md           # 三个包如何协作
  faq.md                    # 排错
```

## 和内置 `standard` 预设的差异

`standard` 只给了一句 persona，工作法全靠模型自己发挥。这个预设补了分档、工单、验收、沟通四块纪律，代价是每轮固定多出约 70 行提示词，并且明确关掉了并行工具调用（一条消息一个调用），串行会慢一些。

工具组上两者基本对齐：`bash`/`pwsh`、文件读写、搜索、后台任务、定时任务、skill、goal、plan、压缩、子代理、workflow、提问、todo、web、present、Office 三件套、插件管理都在。差别在 `standard` 额外注册了 DSH 自带的 `dsh-doc` 技能目录，这个预设没有；需要的话自己把该技能放进 `~/.dsh/skills/`。

## 已知限制

- 档位和轮次预算写在提示词里，是模型的自律要求，不是运行时硬约束。
- 面板目前只支持 Web / 桌面端的右侧栏，没有做移动端布局。
- 工单通道要求工作区是一个有提交的 Git 仓库；没有 `git` 或没有 HEAD 时只会在原会话里讨论。
- 预设的默认值不会自动改写：装完不会把新会话的默认模式改成 `smart-dev`，需要你自己在设置里改。

## 许可证

MIT。详见 [LICENSE](LICENSE)。

`packages/preset-superagent-local` 里包含派生自 DeepSeek Harness superagent 原型（MIT, Copyright (c) 2026 DeepSeek Harness Team）的代码，原始声明保留在该包的 `LICENSE.upstream`，其捆绑依赖的声明也一并保留。

## 贡献

提 issue 说清楚 DSH 版本、复现步骤和期望行为。改代码前先看 [docs/architecture.md](docs/architecture.md)，三个包之间有依赖，改一个可能影响别的。
