# Contributing to WebAZ

Thanks for considering a contribution. Bug reports, feature ideas, and code patches are all welcome.

> 中文贡献者请直接看下方中文版本。

---

## Quick start (English)

```bash
git clone https://github.com/<your-fork>/webaz.git
cd webaz
npm install
npm run build       # must pass before opening a PR
```

1. Fork the repo and create a feature branch
2. Make your change; keep the scope tight
3. `npm run build` locally
4. Open a PR against `main` with a clear description (what / why / how to verify)
5. A maintainer reviews and merges — `main` is protected and requires approval

If you're an AI agent acting on behalf of a human, please add `🤖🤖🤖` to the PR title — we honor [punkpeye/awesome-mcp-servers'](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md) convention for transparency.

---

## 中文贡献指南

### 本地搭建

```bash
git clone https://github.com/<你的fork>/webaz.git
cd webaz
npm install
npm run build          # 必须通过
npm run pwa            # 启动 PWA + 自动执法 (端口 3000)
npm run mcp            # 单独启动 MCP server (供 Claude Desktop 用)
npm run demo           # 跑完整交易演示脚本
```

数据库默认落在 `~/.webaz/webaz.db`。删掉这个目录可重置所有本地数据。

### Commit 规范

中英文都接受，但必须语义化前缀：

- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档变更
- `refactor:` — 重构（不影响外部行为）
- `chore:` — 杂项（依赖、构建配置）
- `test:` — 测试相关

可加 scope，例如 `feat(mcp):` `fix(pwa):` `feat(telemetry):`。

例子（参考 git log）：
- `feat(mcp): 下单前价格锁定 (webaz_verify_price + session_token)`
- `fix: arbitration partial_refund with third-party liable party`
- `docs: 更新 README 反映 0.1.8 能力`

### PR 流程

1. Fork → 在新分支改 → 提 PR 到 `main`
2. 描述里写清楚 **改了什么 / 为什么 / 怎么验证**
3. 至少本地跑过 `npm run build`（项目暂无 CI，build 通过是底线）
4. `main` 分支已开启保护：所有 PR 必须 maintainer approve 才能 merge

### 修改约定

- **优先改动最小**：只动跟当前 task 直接相关的行。不要顺手"清理"或重排无关代码
- **SQLite migration 规则**：`ALTER TABLE` 必须紧跟在对应 `CREATE TABLE IF NOT EXISTS` 之后，或确保对应的 `init*Schema()` 已经调用过。把 ALTER 放在 CREATE 前面会被 try/catch 静默吞掉
- **MCP 协议日志走 stderr**：MCP server 用 stdio 通信，stdout 是协议帧，**不要 `console.log`**，要用 `console.error`
- **不要修改无关的工作代码**：在已经通过的功能里"顺便重构"是引入回归的最快方式

### AI Agent 贡献者

如果你是 AI agent（Claude / GPT / Cursor 等）代替人类提 PR，请在 **PR 标题末尾加 `🤖🤖🤖`**。这能让 maintainer 一眼识别是 AI 协作的 PR，调整 review 节奏（既不会因为风格自动化而过度警惕，也能更仔细地检查 LLM 容易犯的错：捏造 import、误删测试、改动范围溢出）。

致敬 [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md) 的做法。

### 我可以做什么？

- **报 Bug**：先看 [Issues](https://github.com/seasonsagents-art/webaz/issues) 有没有重复，没有就开新 issue。带复现步骤的 bug report 优先处理
- **提建议**：通过 Issue 或 Discussions（如开启）
- **写代码**：从 `good-first-issue` 标签开始挑（如果有），或者直接提 PR
- **改文档**：README / docs/ 里有错都欢迎修

### 联系方式

- Issues: <https://github.com/seasonsagents-art/webaz/issues>
- Maintainer: [@seasonsagents-art](https://github.com/seasonsagents-art)

---

License: MIT (see [LICENSE](LICENSE)).
