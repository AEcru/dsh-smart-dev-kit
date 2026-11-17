# 仓库说明（给在此仓库工作的 agent）

这个仓库是 DSH（DeepSeek Harness）的一套开发工作流，由三个独立 bundle 包、一份插件市场索引和一个生成脚本组成。

## 结构

```
packages/preset-smart-dev/         agent 预设，纯配置：cordis.patch.yml + package.json
packages/smart-dev-panel/          面板：host 半（index.js）、web 半（client.js）、桥接（superagent-router.js）
packages/preset-superagent-local/  工单运行时（可选），含上游 MIT 代码
market/index.json                  市场索引，**生成产物，不要手改**
scripts/build-index.mjs            索引生成器
docs/                              架构与排错
```

## 硬约束

1. **三个包不能合并**。`packages/preset-smart-dev/cordis.patch.yml` 里有一行 `name: dsh-smart-dev-panel/superagent-router`，靠模块解析跨包引用。合并会破坏包名与导出路径。
2. **安装顺序是 面板 → 预设 → 运行时**。预设引用面板的入口，反序会让组合失败。
3. **改完 `packages/` 下任何文件，必须重跑 `node scripts/build-index.mjs`**。索引里的每个版本都固定到提交号，不重跑就等于对外发布旧代码。
4. **`market/index.json` 是生成物**。要改描述文案，改 `scripts/build-index.mjs` 里的 `entries` 数组，不要直接编辑 JSON。
5. **README 中英双版必须同步改**。`README.md` 与 `README.en.md` 结构一一对应，只改一边会造成维护分叉。
6. **Git 依赖必须固定到完整 40 位提交**。分支名、标签、短提交号都不被 DSH 接受。

## 索引生成的机制

`build-index.mjs` 把版本固定到**最后一次修改 `packages/` 的提交**，而不是 HEAD。这不是随手写的：索引自己也是独立提交，用 HEAD 会导致每生成一次就指向一个新的提交号，永远收敛不了。

因此正常的发布顺序是：

```bash
# 1. 改代码并提交
git add packages/... && git commit

# 2. 重新生成索引（会读到上一步的提交号）
node scripts/build-index.mjs

# 3. 索引单独提交
git add market/index.json && git commit

# 4. 推送
git push
```

只提交 `packages/` 而不重跑脚本，市场里看到的还是旧版本；只改索引而不改包，索引会指向一个内容相同的提交（无害但没意义）。

## 验证

提交前至少做这三件事：

```bash
node --check scripts/build-index.mjs
node scripts/build-index.mjs            # 幂等：连续跑两次，第二次不应产生 diff
git diff --stat market/index.json       # 确认改动符合预期
```

包清单的合法性可以这样查：

```bash
node -e "for (const d of ['preset-smart-dev','smart-dev-panel','preset-superagent-local']) { const p=require('./packages/'+d+'/package.json'); console.log(d, p.version, p.dsh?.bundle ? 'bundle ok' : 'MISSING dsh.bundle') }"
```

## 改包内容时

- `packages/preset-smart-dev/cordis.patch.yml` 是预设的唯一真源。改提示词、工具组、档位都改这里。
- 预设里引用的 `@deepseek-ai/*` 插件由 DSH 自身提供，不要加进 `dependencies`。
- 面板的 Web 半靠 `package.json` 的 `dsh.client` 声明加载，`inject` 列表里的客户端包同样由 DSH 提供。
- 版本号变更要同步 `CHANGELOG.md`，并保证 `market/index.json` 里的 `version` 与包清单一致（脚本会自动读，不用手填）。

## 风格

- 缩进：JSON / YAML 都是 2 空格，patch 条目的属性用 6 空格延续。
- 注释写英文，因为这个仓库面向公开社区。
- README 面向人，用中文讲清楚取舍和代价；不要写成营销文案，也不要把"没验证"说成"已验证"。

## 不要做

- 不要在 `packages/` 之外复制一份配置片段当第二真源。
- 不要为了让索引好看而手改提交号或伪造 `publishTimestamp`。
- 不要在没有用户明确要求时提交、打标签或发布。
