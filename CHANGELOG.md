# Changelog

## [1.3.3] - 2026-10-21

### Fixed
- **快照深度不足**：`snapshotPyFiles` 的 maxDepth 从 4 提到 8。
  实测 `/root/lab/ctx_test/proj/flowforge/utils/`（深度 5）的文件不在快照里，
  修改被误报为「新增」。修复后 2206 个 .py、202ms。
- **checked=0 时给出诊断**：不再只报「没有检测到变更」，
  而是提示「hand 可能只描述了代码而没有实际写入，请检查路径或重派」。

### Known issue
- hand 会幻觉「write 工具未注册」而拒绝写文件——实测它的工具列表里
  `write`/`edit`/`bash`/`read` 全都在。目前靠验收报告兜底。

## [1.3.2] - 2026-10-21

### Added
- **自主执行约束注入**：brief 里自动加一段「不要调用 ask_user_question，
  没有用户可问，按最合理假设继续，必须实际写入文件」。

### Why
实测 hand 连续调用两次 `ask_user_question` 后停摆，什么都没产出；
另有两次它声称「已用 write 覆盖文件」但文件并不存在。
前者靠提示挡住，后者靠验收报告「没有检测到新增/修改的 .py 文件」兜住。

## [1.3.1] - 2026-10-21

### Fixed
三处误报，实测在真实生产代码（18 个文件）上全部触发：

- **空 `__init__.py`** 被报「文件实质为空」→ 现在跳过（Python 惯例）。
- **docstring 里的 Markdown 示例** 被报「混入围栏」→ 改用 `tokenize`
  标出字符串行范围，只在代码区检测。
- **相对导入** 被报「import 失败」→ 单独 import 子目录时 `from ..x` 必然失败，
  这是检测方式问题，现在跳过（`relative import` / `beyond top-level`）。

### Test
- 9 个单元测试全过（新增/修改、期望符号、空壳、围栏、语法、空实现、import）
- 回归：llm-relay/app(18文件) / proj2(41文件) / ctx_test / brain-hands 全部通过
- 性能：18 文件 0.56s，41 文件 0.55s

## [1.3.0] - 2026-10-21

### Added
- **新增 / 修改区分**：派单前对 `.py` 文件做快照，返回后对比，
  报告里显示「新增 N / 修改 M」。
- 验收报告显示定义总数，便于判断覆盖度是否完整。

### Why
Linux 上 `st_birthtime` 不可用、`ctime` 在修改后也会变，
只能靠派单前快照才能可靠区分新增与修改。

实测场景：brief 要求处理 2011 个文件，hand 只扫了 312 个。
报告里出现「新增 312 / 修改 0」时，brain 一眼能看出覆盖不足。

## [1.2.0] - 2026-10-21

### Added
- **期望符号检查**：从 brief 里自动提取「应该实现」的函数/类名
  （识别 `def xxx`、`实现 xxx(`、`xxx() ->`、`` `xxx(...)` ``），
  传给 `verify.py --expect`，hand 少写一个就报错。
- `verify.py --expect` 参数：逗号分隔的期望定义名。
- 验收报告输出每个文件定义的顶层符号，便于 brain 核对。
- 空壳检测：文件只有 `...` / `pass` / 注释且 < 40 字节时报警。

### Fixed
- 实测 hand 只写 3 字节 `...` 就交差，旧版验收误报通过。

## [1.1.0] - 2026-10-21

### Added
- **共享项目状态注入**：工作目录下存在 `PROJECT_STATE.md` 时，自动把路径注入到
  每个 hand 的 brief。实测 36 次派单省下约 5.3 万 token（¥0.21）。
- **自动产出验收**：hand 返回后自动调用 `verify.py` 检查语法、Markdown 围栏污染、
  空实现、import 失败，并把报告附在回复末尾。
- `verify.py` 可独立运行，支持 `--since` / `--json`。
- `templates/PROJECT_STATE.md` 与 `templates/AGENTS_HAND_BRIEF.md` 模板。
- README 加入三组真实成本对照实验数据。
- `docs/EXPERIMENT.md`：完整实验报告（方法、数据、结论修正过程）。

### Changed
- `package.json` 改为可发布（去掉 `private`，补充 repository / keywords / license）。
- `files` 字段加入 `verify.py` 与 `templates/`。

## [1.0.0]

- 初始版本：brain 模型 + 任意多个 hand，每个 hand 绑定自己的模型与 provider。
