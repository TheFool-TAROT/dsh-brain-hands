# Changelog

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
