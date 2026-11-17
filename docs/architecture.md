# 三个包怎么协作

这个仓库不是"一个插件 + 一些配置"，而是三个各自独立的 bundle。DSH 的 bundle 模型决定了它们必须分开：一个 bundle 只声明自己那一层配置，装它不会顺带启用别的 bundle。

## 装配顺序

DSH 启动时按 profile 的 `dsh.profile.bundles` 列表逐层叠加 patch：

```
@deepseek-ai/dsh-base          基础层：LLM、会话、文件系统、沙箱
@deepseek-ai/dsh-web-app       Web 层：前端、office-kit、skill-office、各内置预设
dsh-smart-dev-panel            面板层：挂 host 插件、注册 Web client
dsh-preset-smart-dev           预设层：声明 smart-dev 预设
dsh-preset-superagent-local    可选：工单运行时（若已装）
profile 自己的 cordis.patch.yml 最后应用，能覆盖上面任何一层
```

预设层不挂载体，它只是往 agent 预设注册表里加一条记录。所以它单独存在不影响任何东西——直到用户真的选中 `smart-dev` 模式。

## 三者的连接点

```
smart-dev 预设
  └─ plugins[] 里的一行：
       id: smartdev-superagent-bridge
       name: dsh-smart-dev-panel/superagent-router   ← 跨包引用
            │
            ▼
dsh-smart-dev-panel
  ├─ index.js            host 半：采集会话事件、提供面板数据
  ├─ client.js           Web 半：渲染右侧栏（靠 package.json 的 dsh.client 加载）
  └─ superagent-router.js 桥接：把 preset 里的调用转给工单运行时
            │
            ▼
dsh-preset-superagent-local（可选）
  ├─ host.js    工单引擎
  ├─ router.js  意图路由
  ├─ worker.js  执行器
  └─ worktree.js 独立工作树
```

第一处箭头是最脆的点：预设里写的是 `dsh-smart-dev-panel/superagent-router`，靠模块解析找到面板包。面板没装，这行就解析失败，组合整个预设时报错。这就是为什么安装顺序是**先面板后预设**。

工单运行时是可选的下游：没装它，桥接入口仍然存在，只是收到工单请求后无处投递，智能开发模式的其余功能（L1/L2/L3、验收纪律、面板）全部照常。

## 为什么预设里要放这么多提示词

`standard` 预设的 persona 只有一句话，工作法完全交给模型现场发挥。这个预设把约定写死在提示词里，换来的是可预期：同一类任务每次都走同样的档位判断，沟通噪音也稳定在低位。

代价是每轮固定多出约 70 行上下文，以及"一条消息一个工具调用"这条纪律压掉了并行。这两点是有意为之，不是没优化——并行调用正是格式错误导致整轮中断的主要来源。

## 面板为什么读会话事件而不是自己统计

面板是纯消费者：它订阅 DSH 已有的会话事件流（工具调用、子代理生命周期、token 计数），不写入、不改变执行路径。所以面板挂了不会影响任务能不能跑完，最多是看不到数据。

这也决定了它的降级行为：git 不可用时工作区那块自动隐藏，没有子代理时那分区整卡不显示，失败数为零时对应磁贴不可点。
