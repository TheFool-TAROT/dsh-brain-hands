# 项目状态

> 这份文件由 brain 维护，hand 读取。每次派单前更新「进度」和「本批任务」。

## 项目

名称：<项目名>
一句话说明：<它是什么、解决什么问题>
根目录：<绝对路径>
技术栈：Python 3.10+ / 零外部依赖 / pytest

## 目录结构（实时更新）

```
<项目>/
  core/        # 核心抽象
  engine/      # 执行引擎
  ...
```

## 接口约定（所有 hand 必须遵守）

- 所有规格类用 `@dataclass(frozen=True)`
- 所有公开方法带类型注解 + docstring
- 错误统一用 `<ProjectError>` 及其子类
- 日志用 `logging.getLogger(__name__)`
- 命名：类 PascalCase，函数/变量 snake_case，常量 UPPER_SNAKE
- 不引入第三方依赖（除标准库）

## 进度

- [x] core/ — 已完成
- [x] engine/ — 已完成
- [ ] sources/ — **待写**
- [ ] operators/
- [ ] state/

## 本批任务

写 `sources/` 包：

- `file_source.py` — `FileSource`，读本地 CSV，`read() -> Iterator[dict]`
- `http_source.py` — `HttpSource`，读 URL，`read() -> Iterator[dict]`
- `__init__.py` — 导出两个类，声明 `__all__`

约束：
- 文件不存在抛 `FileNotFoundError`
- 网络错误抛 `OSError`
- 不要写测试（测试由 brain 统一补）

## 交付要求

1. 严格按上面的接口约定
2. 只写这三个文件，不要改动其他模块
3. 不要输出 Markdown 代码围栏（直接写文件）
4. 写完后 brain 会自动验收：语法 / import / 污染
