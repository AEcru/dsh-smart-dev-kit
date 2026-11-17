#!/usr/bin/env node
// Regenerates market/index.json from the package manifests and the current commit.
// The index pins each package to one exact commit, so run this after every commit
// that changes anything under packages/, then commit the regenerated index.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repositoryUrl() {
  const remote = git('remote', 'get-url', 'origin');
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return remote.replace(/\.git$/, '');
}

const commit = git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`not a full 40-character commit: ${commit}`);
  process.exit(1);
}
const published = Number(git('log', '-1', '--format=%ct'));
const repoUrl = repositoryUrl();

// Marketing metadata per package. Descriptions are duplicated in package.json
// (zh) as well, because DSH's plugin pages read the manifest, not this index.
const entries = [
  {
    dir: 'packages/preset-smart-dev',
    title: { en: 'Smart Dev preset', zh: '智能开发模式' },
    description: {
      en: 'An agent preset that scales its own intensity: direct for one-file fixes, ticket and verify for multi-file work, plan-first for cross-module changes.',
      zh: '按任务复杂度自适应的 agent 预设：单文件直做，多文件建单验证，跨模块先出方案。',
    },
    category: 'preset',
    labels: [],
    keywords: ['agent-preset', 'workflow', 'ticket'],
  },
  {
    dir: 'packages/smart-dev-panel',
    title: { en: 'Smart Dev sidebar panel', zh: '智能开发侧边栏面板' },
    description: {
      en: 'Right-sidebar panel for the smart-dev preset: tickets, subagents, tool calls, token and context usage, retries and workspace changes.',
      zh: '智能开发模式伴侣面板：工单、子代理、工具调用、token 与上下文消耗、失败重试、工作区变更。',
    },
    category: 'panel',
    labels: [],
    keywords: ['sidebar', 'panel', 'observability'],
  },
  {
    dir: 'packages/preset-superagent-local',
    title: { en: 'Superagent ticket runtime', zh: '工单运行时' },
    description: {
      en: 'Optional runtime behind the heavy-ticket channel: runs Git tasks in an isolated session and worktree, then hands the result back.',
      zh: '重型工单通道的可选运行时：在独立会话与 worktree 中执行 Git 任务，再把结果送回原会话。',
    },
    category: 'runtime',
    labels: [],
    keywords: ['ticket', 'worktree', 'git'],
  },
];

const plugins = entries.map((entry) => {
  const manifest = JSON.parse(readFileSync(join(root, entry.dir, 'package.json'), 'utf8'));
  const pkgDirectory = entry.dir.replace(/\\/g, '/');
  return {
    name: manifest.name,
    title: entry.title,
    description: entry.description,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: { url: repoUrl, directory: pkgDirectory },
    metadata: {
      category: entry.category,
      keywords: [...new Set([...(manifest.keywords ?? []), ...entry.keywords])],
      labels: entry.labels,
      sortKeys: {},
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: published,
        source: { type: 'git', url: repoUrl, commit, path: pkgDirectory },
        engines: manifest.engines ?? {},
      },
    ],
  };
});

const index = {
  format: 1,
  title: { en: 'Smart Dev Kit for DeepSeek Harness', zh: 'DSH 智能开发模式' },
  description: {
    en: 'An agent preset that adapts to task size, with its sidebar panel and an optional ticket runtime.',
    zh: '按任务复杂度自适应的 agent 预设，配套侧边栏面板与可选工单运行时。',
  },
  metadata: {
    categories: {
      preset: { title: { en: 'Agent presets', zh: 'Agent 预设' } },
      panel: { title: { en: 'UI panels', zh: '界面面板' } },
      runtime: { title: { en: 'Runtimes', zh: '运行时' } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins,
};

const outDir = join(root, 'market');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`market/index.json: ${plugins.length} plugins @ ${commit.slice(0, 7)} (${repoUrl})`);
