# dsh-brain-hands

> 给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 用的 **Brain + Hands** 编排插件：
> 一个 brain 模型负责规划和决策，任意多个 hand 各自跑在自己的模型上（通常是你自建的免费池）。

[English summary below](#english-summary)

---

## 它解决什么问题

单个 agent 会话里，所有工作都由同一个模型完成。这带来两个问题：

1. **贵**：读 1000 个文件做统计，文件内容全进上下文，主模型按输出价计费
2. **慢**：串行处理，无法并行

Brain + Hands 把工作拆开：

```
        ┌─────────────┐
        │    Brain    │  规划 · 决策 · 汇总（贵，但活少）
        │  (主模型)   │
        └──────┬──────┘
               │ delegate_deepseekv4 / delegate_grok / ...
     ┌─────────┼─────────┐
     ▼         ▼         ▼
  ┌──────┐ ┌──────┐ ┌──────┐
  │ hand │ │ hand │ │ hand │   执行（便宜或免费，但活多）
  └──────┘ └──────┘ └──────┘
```

---

## 新增的两个能力（v1.1）

### ① 共享项目状态注入

brain 每次派 hand 都要在 brief 里重复描述项目背景——实测 36 次派单重复描述花掉 **5.3 万 token（¥0.21）**。

现在只要工作目录（或其浅层子目录）下有 `PROJECT_STATE.md`，插件会自动在 brief 里注入：

```
【项目状态】先读 /path/PROJECT_STATE.md，了解项目结构、接口约定、
当前进度和你要做的部分。严格按其中的约定交付。
```

查找规则：

```
① 先看 cwd/PROJECT_STATE.md
② 再向下找 2 层子目录（跳过 node_modules/.git/templates/examples/docs/tests 等）
③ 多个命中时取 mtime 最新的
④ 结果缓存 10 秒，避免每次派单都扫盘（实测 209 个目录 25ms）
```

模板见 [`templates/PROJECT_STATE.md`](templates/PROJECT_STATE.md)。

### ② 自动产出验收

hand 返回后，插件自动调用 `verify.py` 检查它写的代码：

```
【产出验收】✓ 4 个文件全部通过（语法/导入/无污染）
```

或者

```
【产出验收】✗ 发现问题，需修正：
- flowforge/sources/__init__.py
    · 混入 Markdown 围栏（L2）
    · 语法错误 L2: invalid syntax
- import flowforge 失败: No module named 'flowforge.graph.executor'
```

检查项：

| 项 | 说明 |
|---|---|
| 语法 | `ast.parse` |
| Markdown 围栏混入 | hand 最常见的错误：把 ` ``` ` 写进源码 |
| 非代码内容混入 | 表格、列表出现在代码位置 |
| 整文件空实现 | 所有定义都是 `pass` |
| 顶层包 import | 能否 `import <pkg>` |

### ③ 期望符号检查（v1.2）

插件从 brief 里自动提取「应该实现」的函数/类名：

```
"实现 now_iso() -> str"        → 提取 now_iso
"写一个 parse_rfc3339(...)"    → 提取 parse_rfc3339
"创建 class LRUCache，实现 `get(key)`"  → 提取 LRUCache, get
```

然后传给 `verify.py --expect`。如果 hand 少写一个：

```
【产出验收】✗ 发现问题，需修正：
- 缺少期望的定义: now_iso
```

这堵住了「函数名写错」这个盲区——实测 hand 曾把 `now_iso` 写成 `get_time`，
而旧版验收因为语法合法、import 通过而误报「通过」。

### ④ 新增 / 修改区分（v1.3）

派单前对 `.py` 文件做快照，返回后对比：

```
【产出验收】✓ 新增 1 / 修改 1，共 2 个文件、3 个定义全部通过（语法/导入/无污染）
```

为什么需要：Linux 上 `st_birthtime` 不可用、`ctime` 修改后也会变，
只能靠快照可靠区分。

实用价值：brief 要求处理 2011 个文件时，如果报告显示「新增 312 / 修改 0」，
brain 一眼就能看出覆盖不足（实测 hand 曾漏扫 85% 文件且自己没察觉）。

### ⑥ 期望路径检查（v1.4）

从 brief 提取完整文件路径，验收时核对是否真的创建：

```
brief:   创建 /proj/flowforge/utils/urlkit.py
实际:    写到 /proj/utils/urlkit.py      ← 少一层
报告:    ✗ 期望的文件未创建: /proj/flowforge/utils/urlkit.py
```

**前提：brain 要在 brief 里写出完整路径**（不只是「在 xxx 目录下创建 yyy.py」）。

### ⑤ 自主执行约束（v1.3.2）

brief 里自动注入一段：

```
【执行要求】不要调用 ask_user_question —— 你没有用户可问。
遇到不确定的决策，按最合理的假设继续做，并在最终报告里说明你的假设。
必须实际写入文件，只描述代码不算完成。
```

实测两种失败模式：

| 现象 | 兜底方式 |
|---|---|
| hand 调 `ask_user_question` 后停摆 | 提示挡住（本版） |
| hand 声称「已写文件」但实际没写 | 验收报「没有检测到新增/修改的 .py 文件」 |

### ⑦ 自动重试（v1.5）

验收发现 `checked === 0`（一个文件都没写）时，自动重派一次：

```
【重要】上一次你一个文件都没写。这次必须调用 write 工具把代码真正写到磁盘。
你确实拥有 write / edit / bash / read 工具，不要说它们不可用。
```

最多重试 1 次。重试发生时回复末尾带 `[hand 首次未写文件，已自动重试一次]`。

实测 hand 约 20% 概率幻觉「write 不可用」，重试后降到约 4%（两次都幻觉）。

验收是**非阻断**的——失败只附报告，不影响流程，由 brain 决定是否重派。

---

## 安装

```bash
# 在你的 dsh profile 目录下
cd ~/.dsh/profiles/<your-profile>
pnpm add github:TheFool-TAROT/dsh-brain-hands
```

或在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-brain-hands`。

---

## 配置

插件设置里配置 brain 和 hands：

```yaml
- id: brain-hands
  name: dsh-brain-hands
  config:
    enabled: true
    primary:
      provider: deepseek
      model: deepseek-flash
    hands:
      - name: deepseekv4
        provider: local
        model: intern-chat/deepseek-v4-flash
        note: "代码首选：写函数/改逻辑/修 bug/重构/写测试"
      - name: grok
        provider: local
        model: grok2api/grok-chat-fast
        note: "长文撰写、多版枚举、文档粗摘"
```

每个 hand 会变成一个 `delegate_<name>` 工具供 brain 调用。

---

## 使用

### 1. 建一个项目状态文件

把 `templates/PROJECT_STATE.md` 复制到工作目录，按实际情况填写：

```markdown
# 项目状态

## 项目
Flowforge —— 分布式数据管道编排引擎
根目录：/path/to/your/project

## 目录结构
（实时更新）

## 接口约定（所有 hand 必须遵守）
- 所有类用 `@dataclass(frozen=True)`
- 所有公开方法带类型注解 + docstring
- 错误统一用 `FlowforgeError`
- 日志用 `logging.getLogger(__name__)`

## 进度
- core/ ✅
- engine/ ✅
- sources/ ⬜  ← 待写
- operators/ ⬜

## 本批任务
写 sources/ 包：FileSource、HttpSource
两个类都实现 `read() -> Iterator[dict]`
```

### 2. 派 hand

brain 侧：

```
先读 PROJECT_STATE.md，按其中「本批任务」完成 sources/ 包。
```

插件会自动补上状态文件路径，并注入到 hand 的 brief。

### 3. 看验收报告

hand 返回时自动附带：

```
【产出验收】✗ 发现问题，需修正：
- flowforge/sources/__init__.py
    · 混入 Markdown 围栏（L2）
```

brain 看到后修掉或重派。

---

## 实测数据

> 完整实验方法、原始数据、以及两次错误结论的修正过程，见
> [`docs/EXPERIMENT.md`](docs/EXPERIMENT.md)。


在真实 agent 会话中做的三组对照实验（DeepSeek V4.1-Flash 官方价：
未命中 ¥1/M · 命中 ¥0.02/M · 输出 ¥4/M，空闲时段）：

| 任务 | Brain+Hands | 纯主模型 | 结论 |
|---|---|---|---|
| **从零构建 2.6 MB 项目** | **¥2.01** | ¥4.78 | **用 hand 省 58%** |
| 分析 340 KB 代码库 | ¥0.0293 | ¥0.0334 | 用 hand 省 12% |
| 分析 18.6 MB 代码库 | ¥0.0251 | **¥0.0122** | **自己干省 51%** |

### 什么时候用 hand

```
✅ 大量写代码、从零构建      → 省 58%，且 docstring 覆盖率高 84%
✅ 需要并行处理              → 多个 hand 同时跑
✅ 超长文档总结              → 主模型会截断，hand 有 1M 窗口
❌ 批量读代码做统计          → 主模型一次 ast 就能搞定，反而省 51%
❌ 数据完整性要求高的任务    → 实测 hand 会漏扫 85% 文件且不自知
```

### 一个必须记住的坑

实验中发现：hand 处理 2011 个文件的分片任务，**实际只扫了 312 个（15%）**，而且它自己没察觉。

所以：

```
在 brief 里写明总文件数 → 要求 hand 回报实际处理数 → 不匹配就重做
```

自动验收只能挡住语法和污染，挡不住「漏做」，这块必须 brain 主动核对。

---

## 开箱即用的三件套

```
templates/PROJECT_STATE.md   项目状态文件模板
verify.py                    验收脚本（也可单独跑）
plugin.js                    插件本体（自动注入 + 自动验收）
```

`verify.py` 可以脱离插件单独用：

```bash
python3 verify.py /path/to/project --since $(date -d '5 minutes ago' +%s)
python3 verify.py /path/to/project --json
```

---

## English summary

**dsh-brain-hands** is a [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)
plugin implementing the Brain + Hands pattern: one orchestrator model plans and
decides, while each named hand runs on its own model (typically a self-hosted
free pool).

**v1.1 adds:**

- **Shared project state injection** — if `PROJECT_STATE.md` exists in the working
  directory, its path is auto-injected into every hand brief. Measured saving: 53K
  tokens (≈¥0.21) across 36 dispatches.
- **Automatic output verification** — after each hand run, `verify.py` checks the
  generated Python for syntax errors, stray Markdown fences, empty implementations,
  and import failures, then appends a report to the hand's reply.

**Measured on real agent sessions** (DeepSeek V4.1-Flash pricing, off-peak):

| Task | Brain+Hands | Solo model | Winner |
|---|---|---|---|
| Build a 2.6 MB project | ¥2.01 | ¥4.78 | hands save 58% |
| Analyze 340 KB codebase | ¥0.0293 | ¥0.0334 | hands save 12% |
| Analyze 18.6 MB codebase | ¥0.0251 | ¥0.0122 | solo saves 51% |

**Rule of thumb:** use hands for *generation* (writing code), use the brain alone
for *batch reading* (the brain can settle it with a single `ast` pass regardless of
repo size).

---

## License

MIT