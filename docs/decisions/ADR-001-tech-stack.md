# ADR-001 · 技术栈选择
# ADR = Architecture Decision Record（架构决策记录）
# 每个重大决策都在这里留档，记录"为什么这样选"

日期：2026-05-11
状态：已确认
决策人：项目负责人

---

## 决策内容

| 技术方向 | 选择 | 备选方案 | 放弃原因 |
|----------|------|----------|----------|
| 运行环境 | Node.js 25.x | Python, Go | MCP SDK 原生 JS，生态更直接 |
| 语言 | TypeScript | JavaScript | 类型安全，模块多时减少出错 |
| 数据库 | SQLite（起步） | PostgreSQL, MongoDB | 零配置，单文件，验证逻辑阶段够用 |
| Agent 接口 | MCP Server | 自定义 REST API | Anthropic 官方标准，Claude 原生支持 |
| 前端 | PWA | React Native App | 无需安装，手机浏览器直接用 |
| 证据存储 | 本地文件（起步） | IPFS | Phase 0 先跑通逻辑 |
| 区块链 | 暂缓 | Base / Optimism | Phase 2 再决定，避免过早复杂化 |

## 影响范围

这些决策影响 Layer 0–2 的所有模块实现方式。
如需修改，需要同步更新 L0-1 至 L2-6 的实现。

## 下次评估时间

Phase 0 完成后（第一笔交易跑通后）重新评估数据库选型。
