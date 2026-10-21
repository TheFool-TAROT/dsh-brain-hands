# Hand 派单模板

> 复制下面这段作为 `delegate_*` 的 prompt 使用。

```
先读 <项目根>/PROJECT_STATE.md，按其中「本批任务」完成 content。

要求：
- 严格遵守 PROJECT_STATE.md 里的接口约定
- 只写本批任务列出的文件，不要改动其他模块
- 用 write 工具直接写文件，不要在回复里贴代码
- 写完后用 python -m py_compile 自检

完成后只报告：写了哪些文件 + 自检结果。
```
