# 示例

## mini-project —— 最小可运行示例

一个只有两个包的小项目，用来演示 Brain + Hands 的完整流程：

```
mini-project/
├── PROJECT_STATE.md     ← brain 维护，hand 读取
├── calc/
│   └── __init__.py      ← 已完成
└── utils/               ← 待 hand 写
```

### 试跑

1. 在 `mini-project/` 目录下启动 dsh
2. 派一个 hand：

```
先读 PROJECT_STATE.md，按「本批任务」完成 utils/ 包。
```

3. 观察两处：

- hand 的 brief 里会出现 `【项目状态】先读 .../PROJECT_STATE.md`
- hand 返回后自动附带 `【产出验收】...` 报告
