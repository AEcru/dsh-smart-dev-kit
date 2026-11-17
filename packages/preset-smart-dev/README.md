# dsh-preset-smart-dev

智能开发模式（agent preset id: `smart-dev`）的 bundle 包。装完之后 DSH 的模式选择器里会多出「智能开发模式」，它按任务复杂度自适应执行强度。

这个包不包含任何运行时代码，只有一份 `cordis.patch.yml`，向 DSH 声明预设本身。

## 依赖

预设的工具组里有一行 `superagent-router` 桥接，来自 `dsh-smart-dev-panel`：

```yaml
- id: smartdev-superagent-bridge
  name: dsh-smart-dev-panel/superagent-router
```

所以 **`dsh-smart-dev-panel` 必须先装**，否则组合这份预设时会因为解析不到该入口而失败。两个包分开安装是 DSH bundle 模型的常态：一个 bundle 只声明自己那一层配置，不会替用户启用别的 bundle。

## 安装

```
git+https://github.com/AEcru/dsh-smart-dev-kit.git#<full-commit>&path:/packages/preset-smart-dev
```

装完重启 DSH。

## 预设里有什么

四块东西合在一处：

**分档**。开工前定 L1/L2/L3，档位决定要不要建工单、要不要派子代理、要不要先出方案。执行中范围变大就升档并说明，变小就降档，不为小事走重仪式。

**角色**。主会话是调度员，负责研判、工单、派工、验收、交付；子代理是执行器，只拿原始请求、范围和回报格式。代码写入默认由主会话完成，子代理做探索和只读验证；验收不外包。

**纪律**。一条消息只发一个工具调用（明确压掉并行批量调用，减少格式错误导致的中断）；工具报错简化参数后只重试一次；超出档位预算就收尾汇报，不无限调研。

**红线**。删数据、写生产库、部署、改权限或密钥、大范围重构、未经要求 commit/push，都要先确认；人的暂停就是暂停，CI 和机器人反馈不能解除它。

完整内容直接读 [cordis.patch.yml](cordis.patch.yml) 的 `persona.prefix`，没有隐藏部分。

## 自定义

改这个包里的 `cordis.patch.yml` 即可，改完重启。想保留自己的改动又不想改包，可以把它复制进 profile 的 `cordis.patch.yml` 里作为一个覆盖层——DSH 的 profile 补丁在 bundle 层之后应用，会盖住包内声明。

注意别在 profile 里再声明一个同 id 的预设，那会让 DSH 组合失败。
