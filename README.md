# WebAZ

[![npm](https://img.shields.io/npm/v/@seasonkoh/webaz.svg)](https://www.npmjs.com/package/@seasonkoh/webaz)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=webaz)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

让 AI Agent 成为去中心化商业协议的原生参与者。卖家零额外工作量接入新渠道，买家通过 Agent 自动购物，人类与 AI 在同一协议上平等参与。

> **试一下**：`npx -y @seasonkoh/webaz`，或在 Claude Desktop 加入 MCP 配置（见下）。
> **PWA 演示**：[webaz.xyz](https://webaz.xyz)

---

## 核心特性

- **Agent 原生**：MCP 协议下，Claude 直接搜索、锁价、下单、举证、确认
- **人类 + Agent 双轨**：PWA 给人类，MCP 给 Agent，共用同一后端
- **结构化商品 + agent_summary**：规格 / 物流 / 售后字段拼成一句话决策摘要，Agent 比价无歧义
- **下单前价格锁定**：`webaz_verify_price` 返回 `session_token`，避免决策与下单之间价格漂移
- **链上托管（Phase 1 live）**：USDC on Base Sepolia，充值地址按用户派生，自动扫归集 + 自动执行提现
- **链接认领验证**：卖家关联外部链接需通过众包验证码核验，防止他人冒用商品主权
- **智能导入**：贴链接，Claude Haiku 自动解析商品字段（10/天免费配额，可 BYO API Key）
- **自动执法**：状态机责任归因，超时自动判责
- **争议系统**：双方举证 → 仲裁员裁定 → 败诉方缴 1% 仲裁费（含超时自动判）
- **声誉 5 级**（新手 → 传奇）：影响质押折扣 + 搜索排名
- **Skill 市场**：catalog_sync / auto_accept / instant_ship 等插件，Agent 订阅自动享用

---

## 快速开始

### 方式一：Claude MCP 接入（Agent 原生体验）

**1. 添加到 Claude Desktop 配置**

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "webaz": {
      "command": "npx",
      "args": ["-y", "@seasonkoh/webaz"]
    }
  }
}
```

重启 Claude Desktop。无需手动安装，`npx` 会自动下载运行。

**3. 开始使用**

在 Claude 对话里说：

> "帮我在 WebAZ 注册一个买家账号，然后搜索一下有什么商品"

Claude 会自动调用 `webaz_register` 和 `webaz_search` 完成操作。

---

### 方式二：PWA 浏览器界面

```bash
cd webaz
npm run pwa
# 打开 http://localhost:3000
# 手机访问：http://<本机IP>:3000
```

注册账号后即可使用完整功能。

---

## MCP 工具清单

| 工具 | 说明 | 主要参数 |
|------|------|----------|
| `webaz_info` | 获取协议概览和实时统计 | — |
| `webaz_register` | 注册账号，获取 api_key | `name`, `role` |
| `webaz_search` | 搜索商品（结构化字段 + agent_summary + 声誉加权） | `query`, `category`, `max_price`, `min_return_days`, `max_handling_hours` |
| `webaz_verify_price` | 下单前锁价 10 分钟，拿到 `session_token` | `product_id`, `quantity`, `api_key` |
| `webaz_list_product` | 卖家上架商品（含品牌/规格/物流/售后字段） | `title`, `price`, `specs`, `handling_hours`, `return_days`, `api_key` |
| `webaz_place_order` | 买家下单（可传 `session_token` 防价格漂移） | `product_id`, `shipping_address`, `session_token`, `api_key` |
| `webaz_update_order` | 更新订单状态（接单/发货/确认/争议） | `order_id`, `action`, `api_key` |
| `webaz_get_status` | 查询订单/钱包/争议详情 | `order_id` / `wallet` / `dispute_id`, `api_key` |
| `webaz_wallet` | 钱包余额 + 链上充值地址 + 提现 | `action`, `api_key` |
| `webaz_notifications` | 查询未读通知 | `api_key` |
| `webaz_dispute` | 争议操作（查看/举证/裁定） | `action`, `api_key` |
| `webaz_skill` | Skill 市场（发布/订阅） | `action`, `api_key` |
| `webaz_profile` | 个人资料 + 多角色管理 | `action`, `api_key` |
| `webaz_mykey` | api_key 恢复（已注册用户重新获取密钥） | `name`, `recovery_code` |

完整协议规范（状态机/经济模型/争议规则）可通过 MCP Resource 读取：

```
webaz://protocol/manifest
```

---

## 角色说明

| 角色 | 可以是人类或 Agent | 职责 |
|------|-------------------|------|
| `buyer` 买家 | ✅ 两者均可 | 浏览商品、下单、确认收货或发起争议 |
| `seller` 卖家 | ✅ 两者均可 | 上架商品、接单、发货，可发布 Skill |
| `logistics` 物流 | ✅ 两者均可 | 揽收、运输、投递，回传快递单号 |
| `arbitrator` 仲裁员 | ✅ 两者均可 | 审查争议证据、做出裁定 |

---

## 交易流程

```
买家下单（paid）
  → 卖家接单（accepted）      ← 超时 24h：fault_seller
  → 卖家发货（shipped）       ← 超时 72h：fault_seller（需选择物流公司）
  → 物流揽收（picked_up）     ← 超时 48h：fault_logistics（回传快递单号）
  → 运输中（in_transit）
  → 投递完成（delivered）     ← 超时 48h：fault_logistics
  → 买家确认（confirmed）     ← 超时 72h：自动确认
  → 完成结算（completed）

买家在 delivered 阶段可发起争议：
  → 被告 48h 内举证 → 仲裁员 120h 内裁定
  → 超时不回应：自动判发起方胜诉
  → 败诉方缴纳订单金额 1% 仲裁费（最低 1 WAZ）
  → 裁定结果：全额退款 / 释放给卖家 / 部分退款 / 责任分配
```

---

## 资金分配

每笔成交按以下比例自动分配：

| 接收方 | 比例 |
|--------|------|
| 卖家 | ~93%（扣除各项费用后） |
| 物流方 | 5% |
| 协议费 | 2% |
| 推荐人（如有） | 3% |

卖家上架需质押 15% 作为保证金（声誉越高折扣越大，最低 5%）。

---

## 开发命令

```bash
npm run pwa          # 启动 WebAZ 服务（含自动执法，端口 3000）
npm run mcp          # 单独启动 MCP Server（供 Claude Desktop 调用）
npm run demo         # 跑完整交易演示脚本
npm run test-dispute # 测试争议系统（三场景）
npm run test-skill   # 测试 Skill 市场
npm run test-rep     # 测试声誉系统
npm run test-manifest# 测试协议 Manifest
```

---

## 技术栈

| 方向 | 选择 |
|------|------|
| 运行时 | Node.js + TypeScript |
| Agent 接口 | MCP (Model Context Protocol) |
| 数据库 | SQLite（Phase 0），PostgreSQL（Phase 1+） |
| 前端 | PWA — 手机浏览器直接访问，无需安装 |
| 链（Phase 2） | 待定：Base / Optimism |

---

## 当前阶段

**Phase 0 · 概念验证** ✅
**Phase 1 · 功能完善 + 链上 testnet 闭环** ✅
- 14 个 MCP 工具 / 全角色 PWA / 通知 / 争议 / 声誉 / Skill 市场 / Manifest
- USDC on Base Sepolia：派生充值地址、自动监听入账、热钱包扫归集、自动执行提现
- 链接认领验证（众包验证码 + 主权流转）
- Agent 决策三件套（结构化字段 / agent_summary / verify_price 锁价）
- MCP 工具调用遥测（默认开，可关）

**Phase 2 · 主网 + 真正去中心化**（下一步）

---

## 路线图

- [x] 状态机 + 责任归因引擎
- [x] MCP Server（14 个工具）
- [x] 通知系统（SSE 实时推送）
- [x] 争议系统（举证 + 超时自动裁定 + 仲裁费）
- [x] 声誉积分体系（5 级）
- [x] Skill 市场
- [x] Protocol Manifest（机器可读协议规范）
- [x] PWA 前端（全角色覆盖，人类 + Agent 双轨）
- [x] 智能商品导入（贴链接自动提取）
- [x] 链接认领验证（卖家主权 + 众包核验）
- [x] 链上 USDC testnet 闭环（Base Sepolia）
- [x] 下单前价格锁定（verify_price + session_token）
- [x] 结构化商品规格 + agent_summary 决策摘要
- [x] 遥测看板（/api/admin/usage）
- [ ] 链上 USDC 主网（Base）
- [ ] IPFS 证据存储
- [ ] 评价系统（结构化 1-5 星，反哺声誉）
- [ ] 证据上传通道（争议附图）
- [ ] 治理 DAO
