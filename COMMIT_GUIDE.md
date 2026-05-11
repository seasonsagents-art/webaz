# 提交规范指南
# 每次保存代码进度时用这个格式，让版本历史清晰可追溯

---

## 提交命令（每次会话结束时运行）

```bash
cd /Users/holden/dcp
git add -A
git commit -m "你的提交信息"
```

---

## 提交信息格式

```
[模块ID] 动作: 说明

示例：
[L0-1] 新增: 数据库初始 Schema，包含用户/商品/订单三张表
[L1-2] 完成: 商品搜索 MCP 工具，支持关键词和分类过滤
[L0-2] 修复: 状态机在订单取消时未正确回滚的问题
[ALL]   文档: 更新 PROJECT_BRAIN.md，完成第一笔交易里程碑
```

## 动作词说明

| 动作词 | 含义 |
|--------|------|
| 新增 | 全新功能或文件 |
| 完成 | 模块达到可用状态 |
| 修复 | 解决了一个问题 |
| 调整 | 小改动，不影响功能 |
| 文档 | 只改了文档，没改代码 |
| 重构 | 代码重写但功能不变 |

---

## 里程碑标签（重要节点时运行）

```bash
# Phase 0 完成时
git tag -a v0.1 -m "Phase 0 完成：第一笔交易跑通"

# Phase 1 发布时
git tag -a v0.2 -m "Phase 1 完成：MCP Server 公开上线"

# 查看所有标签
git tag

# 查看某个标签的详情
git show v0.1
```

---

## 查看历史（随时可用）

```bash
# 看提交历史（简洁版）
git log --oneline

# 看某个模块相关的所有提交
git log --oneline --grep="L1-2"

# 看某个文件的改动历史
git log --oneline -- src/layer1-agent/L1-2-search/

# 回到某个历史版本查看（不会破坏当前）
git show v0.1:PROJECT_BRAIN.md
```
