# WebAZ

让 AI Agent 成为去中心化商业协议的原生参与者。卖家零额外工作量接入新渠道，买家通过 Agent 自动购物，人类与 AI 在同一协议上平等参与。

---

## 核心特性

- **Agent 原生**：通过 MCP 协议让 Claude 直接搜索商品、下单、确认收货
- **人类 + Agent 双轨**：PWA 供人类操作，MCP 供 Agent 调用，共用同一后端
- **自动执法**：每笔交易有明确责任方，超时未履行自动判责，无需人工干预
- **争议系统**：买卖双方举证，仲裁员裁定，败诉方缴纳 1% 仲裁费
- **声誉体系**：5 级制（新手→传奇），影响质押折扣和搜索排名
- **Skill 市场**：卖家发布 auto_accept / catalog_sync 等能力插件，Agent 订阅后自动享用
- **货币单位**：WAZ（Phase 0 为模拟代币，Phase 2 接入链上稳定币）

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
| `webaz_search` | 搜索商品（按声誉权重排序） | `query`, `category`, `max_price` |
| `webaz_list_product` | 卖家上架商品 | `title`, `price`, `stock`, `api_key` |
| `webaz_place_order` | 买家下单 | `product_id`, `shipping_address`, `api_key` |
| `webaz_update_order` | 更新订单状态（接单/发货/确认/争议） | `order_id`, `action`, `api_key` |
| `webaz_get_status` | 查询订单/钱包/争议详情 | `order_id` / `wallet` / `dispute_id`, `api_key` |
| `webaz_wallet` | 查看钱包余额 | `api_key` |
| `webaz_notifications` | 查询未读通知 | `api_key` |
| `webaz_dispute` | 争议操作（查看/举证/裁定） | `action`, `api_key` |
| `webaz_skill` | Skill 市场（发布/订阅） | `action`, `api_key` |

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

**Phase 0 · 概念验证** ✅ 完成
**Phase 1 · 功能完善** ✅ 完成

Phase 2 将把核心资金和状态上链，实现真正的去中心化。

---

## 路线图

- [x] 状态机 + 责任归因引擎
- [x] MCP Server（11 个工具）
- [x] 通知系统（SSE 实时推送）
- [x] 争议系统（举证 + 超时自动裁定 + 仲裁费）
- [x] 声誉积分体系
- [x] Skill 市场
- [x] Protocol Manifest（机器可读协议规范）
- [x] PWA 前端（全角色覆盖，人类 + Agent 双轨）
- [ ] 链上集成（Base/Optimism）
- [ ] IPFS 证据存储
- [ ] 治理 DAO
