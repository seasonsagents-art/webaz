/**
 * L1-1 · MCP Server 核心
 * 把 DCP 协议暴露给所有支持 MCP 的 AI Agent（Claude、GPT 等）
 *
 * 包含工具：
 *   dcp_info          L1-2 协议说明（任何 Agent 可调用，了解这是什么）
 *   dcp_register      注册账户，获取 api_key
 *   dcp_search        L1-2 搜索商品
 *   dcp_list_product  L1-5 卖家上架商品
 *   dcp_place_order   L1-3 买家下单
 *   dcp_update_order  L1-6 更新订单状态（发货/揽收/投递/确认/争议）
 *   dcp_get_status    L1-4 查询订单状态和历史
 *   dcp_wallet        查看钱包余额
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'

import { initDatabase, generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import {
  transition,
  getOrderStatus,
  initSystemUser,
} from '../../layer0-foundation/L0-2-state-machine/engine.js'
import {
  initDisputeSchema,
  createDispute,
  respondToDispute,
  arbitrateDispute,
  getDisputeDetails,
  getOrderDispute,
  getOpenDisputes,
} from '../../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import {
  initNotificationSchema,
  notifyTransition,
  getNotifications,
  getUnreadCount,
  markRead,
} from '../../layer2-business/L2-6-notifications/notification-engine.js'
import {
  initSkillSchema,
  publishSkill,
  listSkills,
  getMySkills,
  subscribeSkill,
  unsubscribeSkill,
  getMySubscriptions,
  formatSkillForAgent,
  SKILL_TYPE_META,
  type SkillType,
} from '../../layer4-economics/L4-4-skill-market/skill-engine.js'
import { requireAuth } from './auth.js'

// ─── 初始化 ──────────────────────────────────────────────────

const db: Database.Database = initDatabase()
initSystemUser(db)
initDisputeSchema(db)
initNotificationSchema(db)
initSkillSchema(db)

// ─── 工具定义（Agent 读这些来理解如何使用协议）────────────────

const TOOLS = [
  {
    name: 'dcp_info',
    description: `获取 DCP（去中心化商业协议）的说明和使用指南。
这是新 Agent 接入协议时应该调用的第一个工具。
返回：协议简介、所有可用工具、每个角色的职责和操作流程。
无需任何参数，无需身份验证。`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dcp_register',
    description: `在 DCP 协议中注册新账户。
注册后获得唯一的 api_key，后续所有操作都需要这个 key。
请将 api_key 安全保存，它代表你在协议中的身份。

角色说明：
- buyer（买家）：浏览商品、下单、确认收货
- seller（卖家）：上架商品、接单、发货
- logistics（物流）：揽收包裹、更新运输状态、确认投递
- reviewer（测评员）：对商品进行结构化测评
- arbitrator（仲裁员）：处理争议，做出裁定`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '你的名字或店铺名称' },
        role: {
          type: 'string',
          enum: ['buyer', 'seller', 'logistics', 'reviewer', 'arbitrator'],
          description: '你在协议中的角色',
        },
        initial_balance: {
          type: 'number',
          description: '初始模拟余额（测试用，默认 1000 DCP）',
        },
      },
      required: ['name', 'role'],
    },
  },
  {
    name: 'dcp_search',
    description: `搜索 DCP 协议中的在售商品。
无需登录即可搜索，买家或 Agent 可以自由浏览。
返回匹配的商品列表，包含价格、卖家信息、库存数量。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（商品名称或描述）' },
        category: { type: 'string', description: '商品分类过滤（可选）' },
        max_price: { type: 'number', description: '最高价格过滤（可选）' },
        limit: { type: 'number', description: '返回数量上限，默认 10' },
      },
    },
  },
  {
    name: 'dcp_list_product',
    description: `卖家上架新商品到 DCP 协议。
需要卖家角色的 api_key。
上架时系统会自动计算建议质押金额（商品价格的 15%），用于保障买家权益。
商品上架后买家可以搜索到并下单。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '卖家的 api_key' },
        title: { type: 'string', description: '商品名称' },
        description: { type: 'string', description: '商品详细描述' },
        price: { type: 'number', description: '商品价格（DCP）' },
        stock: { type: 'number', description: '库存数量，默认 1' },
        category: { type: 'string', description: '商品分类（可选）' },
      },
      required: ['api_key', 'title', 'description', 'price'],
    },
  },
  {
    name: 'dcp_place_order',
    description: `买家下单购买商品。
需要买家角色的 api_key。
下单后资金自动进入协议托管，卖家需在 24 小时内接单。
如卖家超时不接单，协议自动退款并记录违约。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '买家的 api_key' },
        product_id: { type: 'string', description: '要购买的商品 ID（从 dcp_search 获得）' },
        quantity: { type: 'number', description: '购买数量，默认 1' },
        shipping_address: { type: 'string', description: '收货地址' },
        notes: { type: 'string', description: '给卖家的备注（可选）' },
        promoter_api_key: {
          type: 'string',
          description: '推荐人的 api_key（可选，如果是通过推荐链接来的）',
        },
      },
      required: ['api_key', 'product_id', 'shipping_address'],
    },
  },
  {
    name: 'dcp_update_order',
    description: `更新订单状态（每个角色只能执行自己的操作）。

卖家可执行的 action：
- accept：接受订单（付款后 24h 内必须执行）
- ship：确认发货（需要物流单号，接单后按承诺时间内执行）

物流方可执行的 action：
- pickup：确认揽收包裹（发货后 48h 内）
- transit：更新为运输中
- deliver：确认投递完成（需要投递证明描述）

买家可执行的 action：
- confirm：确认收货，触发资金结算
- dispute：发起争议（需要说明原因，会冻结资金等待仲裁）

超过截止时间未操作，协议会自动判定该方违约。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '操作者的 api_key' },
        order_id: { type: 'string', description: '订单 ID' },
        action: {
          type: 'string',
          enum: ['accept', 'ship', 'pickup', 'transit', 'deliver', 'confirm', 'dispute'],
          description: '要执行的操作',
        },
        notes: { type: 'string', description: '操作说明（如物流单号、争议原因等）' },
        evidence_description: {
          type: 'string',
          description: '证据描述（发货/揽收/投递时建议提供，争议时必须提供）',
        },
      },
      required: ['api_key', 'order_id', 'action'],
    },
  },
  {
    name: 'dcp_get_status',
    description: `查询订单的当前状态、完整历史记录和当前责任方。
需要参与该订单的 api_key（买家、卖家或物流方均可查询）。
返回：当前状态、状态历史（谁在什么时候做了什么）、当前应该由谁操作、截止时间。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '查询者的 api_key' },
        order_id: { type: 'string', description: '订单 ID' },
      },
      required: ['api_key', 'order_id'],
    },
  },
  {
    name: 'dcp_wallet',
    description: `查看自己的钱包余额和收益统计。
返回：可用余额、质押中金额、托管中金额、累计总收益。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '你的 api_key' },
      },
      required: ['api_key'],
    },
  },
  {
    name: 'dcp_notifications',
    description: `查询当前用户的通知消息（L2-6 通知系统）。
Agent 应定期调用此工具检查是否有待处理的订单事件。
每次有状态变更（新订单/发货/争议等），相关参与方都会收到通知。`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key:    { type: 'string', description: '你的 api_key' },
        unread:     { type: 'boolean', description: '只返回未读通知（默认 false）' },
        mark_read:  { type: 'boolean', description: '调用后自动标为已读（默认 false）' },
      },
      required: ['api_key'],
    },
  },
  {
    name: 'dcp_dispute',
    description: `管理争议流程（L3 争议系统）。

当买家认为货不对版、货损、卖家欺诈时，可通过 dcp_update_order action=dispute 发起争议，
然后用本工具进行后续操作。

协议保障机制（无需人工干预）：
- 被诉方有 48 小时提交反驳证据，否则协议自动判发起方胜诉
- 仲裁员有 120 小时做出裁定，否则协议默认退款给买家
- 裁定一旦执行，资金立即自动分配，无法撤销

action 说明：
- view：查看争议详情（任何参与方可调用）
- list_open：查看所有待处理争议（仅仲裁员）
- respond：被诉方提交反驳证据（必须在 48h 截止时间前）
- arbitrate：仲裁员做出裁定并执行资金处置

ruling 裁定选项（arbitrate 时使用）：
- refund_buyer：全额退款给买家，扣押卖家部分保证金
- release_seller：资金释放给卖家（卖家胜诉）
- partial_refund：部分退款（需指定 refund_amount）`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '操作者的 api_key' },
        action: {
          type: 'string',
          enum: ['view', 'list_open', 'respond', 'arbitrate'],
          description: '要执行的操作',
        },
        dispute_id: { type: 'string', description: '争议 ID（respond/arbitrate 时必填，view 时与 order_id 二选一）' },
        order_id: { type: 'string', description: '订单 ID（view 时可替代 dispute_id）' },
        notes: { type: 'string', description: '回应说明 / 反驳理由（respond 时填写）' },
        evidence_description: { type: 'string', description: '证据描述（respond 时建议填写）' },
        ruling: {
          type: 'string',
          enum: ['refund_buyer', 'release_seller', 'partial_refund'],
          description: '裁定结果（arbitrate 时必填）',
        },
        refund_amount: { type: 'number', description: '部分退款金额，仅 ruling=partial_refund 时使用' },
        ruling_reason: { type: 'string', description: '裁定理由（arbitrate 时必填，将永久记录在链上）' },
      },
      required: ['api_key', 'action'],
    },
  },
  {
    name: 'dcp_skill',
    description: `L4-4 Skill 市场——让卖家发布可复用的 Agent 能力插件，买家 Agent 一键订阅。

Skill 是解决冷启动的核心机制：现有 Amazon/Shopify 卖家零成本接入 DCP，
买家 Agent 订阅后可自动发现、优先呈现这些卖家的商品，成交后 Skill 发布者获得推荐佣金。

Skill 类型（skill_type）：
- catalog_sync      目录同步：将外部店铺（Amazon/Shopify/自定义）接入 DCP 搜索，买家订阅后优先看到
- auto_accept       自动接单：买家下单后立即接受，无需等待（config: min_amount, max_amount, max_daily_orders）
- price_negotiation 价格协商：允许 Agent 在限定范围内议价（config: max_discount_pct, min_quantity）
- quality_guarantee 质量承诺：额外质押保证金，问题可额外赔偿（config: guarantee_amount, coverage_days）
- instant_ship      极速发货：承诺 24h 内发货（config: ship_within_hours）

action 说明：
- list        浏览 Skill 市场（无需登录）
- publish     发布新 Skill（仅卖家）
- subscribe   订阅 Skill（买家订阅后可获得额外好处）
- unsubscribe 取消订阅
- my_skills   查看自己发布的 Skill（卖家）
- my_subs     查看自己订阅的 Skill（买家）`,
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: '你的 api_key（list 时可省略）' },
        action: {
          type: 'string',
          enum: ['list', 'publish', 'subscribe', 'unsubscribe', 'my_skills', 'my_subs'],
          description: '要执行的操作',
        },
        // list 过滤参数
        skill_type: {
          type: 'string',
          enum: ['catalog_sync', 'auto_accept', 'price_negotiation', 'quality_guarantee', 'instant_ship'],
          description: '过滤 Skill 类型（list 时可选）',
        },
        query: { type: 'string', description: '关键词搜索（list 时可选）' },
        // publish 参数
        name: { type: 'string', description: 'Skill 名称（publish 时必填）' },
        description: { type: 'string', description: 'Skill 详细描述（publish 时必填）' },
        category: { type: 'string', description: '分类（publish 时可选）' },
        config: {
          type: 'object',
          description: 'Skill 配置（publish 时可选，如 auto_accept 需填 max_daily_orders）',
        },
        // subscribe 参数
        skill_id: { type: 'string', description: 'Skill ID（subscribe/unsubscribe 时必填）' },
      },
      required: ['action'],
    },
  },
]

// ─── 工具处理函数 ─────────────────────────────────────────────

function handleInfo() {
  return {
    protocol: 'DCP — Decentralized Commerce Protocol',
    version: '0.1.0',
    description:
      'DCP 是一个去中心化商业协议。每笔交易通过状态机流转，每个状态转移都需要对应责任方的操作证明。任何超时未操作，协议自动判定该方违约并执行处置。',
    roles: {
      buyer: '下单、付款、确认收货或发起争议',
      seller: '上架商品、接单、按时发货',
      logistics: '揽收包裹、更新运输状态、确认投递',
      reviewer: '对商品进行结构化测评（可选）',
      arbitrator: '处理争议，多签裁定',
    },
    transaction_flow: [
      '买家下单 → 资金自动托管',
      '卖家 24h 内接单（超时自动退款）',
      '卖家按承诺时间发货（需提交物流单号）',
      '物流 48h 内揽收（超时判物流违约）',
      '物流在承诺时间内投递（需提交投递证明）',
      '买家 72h 内确认收货（超时自动确认）',
      '协议自动按比例分配资金给各方',
    ],
    available_tools: TOOLS.map((t) => ({ name: t.name, description: t.description.split('\n')[0] })),
    quick_start: {
      seller: '1. dcp_register(role=seller) → 2. dcp_list_product() → 3. dcp_update_order(action=accept/ship)',
      buyer: '1. dcp_register(role=buyer) → 2. dcp_search() → 3. dcp_place_order() → 4. dcp_update_order(action=confirm)',
      logistics: '1. dcp_register(role=logistics) → 2. dcp_update_order(action=pickup/transit/deliver)',
    },
  }
}

function handleRegister(args: Record<string, unknown>) {
  const name = args.name as string
  const role = args.role as string
  const initialBalance = (args.initial_balance as number) ?? 1000

  const validRoles = ['buyer', 'seller', 'logistics', 'reviewer', 'arbitrator']
  if (!validRoles.includes(role)) {
    return { error: `无效角色：${role}。可选：${validRoles.join(', ')}` }
  }

  const id = generateId('usr')
  const apiKey = generateId('key')

  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?, ?, ?, ?)').run(
    id, name, role, apiKey
  )
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, ?)').run(id, initialBalance)

  return {
    success: true,
    message: `注册成功！请妥善保管你的 api_key，这是你在协议中的唯一身份凭证。`,
    user_id: id,
    name,
    role,
    api_key: apiKey,
    initial_balance: initialBalance,
    next_step:
      role === 'seller'
        ? '现在可以用 dcp_list_product 上架你的第一件商品'
        : role === 'buyer'
        ? '现在可以用 dcp_search 搜索商品'
        : '等待订单分配给你',
  }
}

function handleSearch(args: Record<string, unknown>) {
  const query = (args.query as string) ?? ''
  const category = args.category as string | undefined
  const maxPrice = args.max_price as number | undefined
  const limit = (args.limit as number) ?? 10

  let sql = `
    SELECT p.*, u.name as seller_name
    FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.status = 'active' AND p.stock > 0
  `
  const params: unknown[] = []

  if (query) {
    sql += ` AND (p.title LIKE ? OR p.description LIKE ?)`
    params.push(`%${query}%`, `%${query}%`)
  }
  if (category) {
    sql += ` AND p.category = ?`
    params.push(category)
  }
  if (maxPrice !== undefined) {
    sql += ` AND p.price <= ?`
    params.push(maxPrice)
  }
  sql += ` ORDER BY p.created_at DESC LIMIT ?`
  params.push(limit)

  const products = db.prepare(sql).all(...params) as Record<string, unknown>[]

  if (products.length === 0) {
    return { found: 0, message: '没有找到匹配的商品', products: [] }
  }

  return {
    found: products.length,
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      price: `${p.price} DCP`,
      stock: p.stock,
      category: p.category,
      seller: p.seller_name,
      seller_id: p.seller_id,
    })),
  }
}

function handleListProduct(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  if (user.role !== 'seller') {
    return { error: `只有 seller 角色可以上架商品，你的角色是：${user.role}` }
  }

  const price = args.price as number
  const stakeAmount = Math.round(price * 0.15 * 100) / 100

  // 检查卖家是否有足够余额质押
  const wallet = db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(user.id) as Record<string, number>

  if (wallet.balance < stakeAmount) {
    return {
      error: `余额不足：上架此商品需要质押 ${stakeAmount} DCP，你的余额为 ${wallet.balance} DCP`,
    }
  }

  const id = generateId('prd')
  db.prepare(`
    INSERT INTO products (id, seller_id, title, description, price, stock, category, stake_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.id,
    args.title as string,
    args.description as string,
    price,
    (args.stock as number) ?? 1,
    (args.category as string) ?? null,
    stakeAmount
  )

  // 扣除质押金额
  db.prepare(`
    UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?
  `).run(stakeAmount, stakeAmount, user.id)

  return {
    success: true,
    product_id: id,
    title: args.title,
    price: `${price} DCP`,
    stake_locked: `${stakeAmount} DCP（质押保证金，交易完成后返还）`,
    status: 'active（买家现在可以搜索到这件商品）',
  }
}

function handlePlaceOrder(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  if (user.role !== 'buyer') {
    return { error: `只有 buyer 角色可以下单，你的角色是：${user.role}` }
  }

  const product = db
    .prepare("SELECT p.*, u.name as seller_name, u.id as seller_uid FROM products p JOIN users u ON p.seller_id = u.id WHERE p.id = ? AND p.status = 'active'")
    .get(args.product_id as string) as Record<string, unknown> | undefined

  if (!product) {
    return { error: `商品不存在或已下架：${args.product_id}` }
  }

  const quantity = (args.quantity as number) ?? 1
  if ((product.stock as number) < quantity) {
    return { error: `库存不足：当前库存 ${product.stock}，你要购买 ${quantity}` }
  }

  const totalAmount = (product.price as number) * quantity
  const wallet = db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(user.id) as Record<string, number>

  if (wallet.balance < totalAmount) {
    return {
      error: `余额不足：订单金额 ${totalAmount} DCP，你的余额 ${wallet.balance} DCP`,
    }
  }

  const now = new Date()
  const orderId = generateId('ord')

  // 找推荐人
  let promoterId: string | null = null
  if (args.promoter_api_key) {
    const promoter = db
      .prepare('SELECT id FROM users WHERE api_key = ?')
      .get(args.promoter_api_key as string) as { id: string } | undefined
    if (promoter) promoterId = promoter.id
  }

  db.prepare(`
    INSERT INTO orders (
      id, product_id, buyer_id, seller_id, promoter_id,
      quantity, unit_price, total_amount, escrow_amount,
      status, shipping_address, notes,
      pay_deadline, accept_deadline, ship_deadline,
      pickup_deadline, delivery_deadline, confirm_deadline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    product.id,
    user.id,
    product.seller_uid,
    promoterId,
    quantity,
    product.price,
    totalAmount,
    totalAmount,
    args.shipping_address as string,
    (args.notes as string) ?? null,
    addHours(now, 24),   // 买家 24h 内必须付款
    addHours(now, 48),   // 卖家 24h 内接单
    addHours(now, 120),  // 卖家 72h 内发货
    addHours(now, 168),  // 物流 48h 内揽收
    addHours(now, 336),  // 物流 7 天内投递
    addHours(now, 408),  // 买家 72h 内确认
  )

  // 扣除库存
  db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product.id)

  // 模拟"付款"：锁定买家余额
  db.prepare(`
    UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?
  `).run(totalAmount, totalAmount, user.id)

  // 直接进入 paid 状态（Phase 0 模拟支付）
  transition(db, orderId, 'paid', user.id, [], '模拟支付完成，资金已托管')
  notifyTransition(db, orderId, 'created', 'paid')

  // 检查卖家是否开启了 auto_accept Skill，若是则自动接单
  let autoAccepted = false
  if (shouldAutoAccept(db, orderId)) {
    const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
    const acceptResult = transition(db, orderId, 'accepted', sysUser.id, [], '⚡ auto_accept Skill 自动接单')
    if (acceptResult.success) {
      notifyTransition(db, orderId, 'paid', 'accepted')
      autoAccepted = true
    }
  }

  return {
    success: true,
    order_id: orderId,
    product: product.title,
    seller: product.seller_name,
    quantity,
    total_amount: `${totalAmount} DCP（已托管，等待交易完成后自动结算）`,
    status: autoAccepted ? 'accepted' : 'paid',
    auto_accepted: autoAccepted || undefined,
    next: autoAccepted
      ? '⚡ 卖家已开启自动接单，订单已立即接受！等待卖家发货。'
      : '等待卖家 24 小时内接单。卖家超时不接单将自动退款。',
    track: `用 dcp_get_status 查看订单进展`,
  }
}

function handleUpdateOrder(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  const orderId = args.order_id as string
  const action = args.action as string
  const notes = (args.notes as string) ?? ''
  const evidenceDesc = (args.evidence_description as string) ?? ''

  // 验证订单存在且该用户是参与方
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ?')
    .get(orderId) as Record<string, unknown> | undefined

  if (!order) return { error: `订单不存在：${orderId}` }

  const isParticipant =
    order.buyer_id === user.id ||
    order.seller_id === user.id ||
    order.logistics_id === user.id

  if (!isParticipant && user.role !== 'arbitrator') {
    return { error: '你不是这笔订单的参与方，无法操作' }
  }

  // 如果是物流首次操作，绑定物流方
  if (
    (action === 'pickup' || action === 'transit') &&
    order.logistics_id === null &&
    user.role === 'logistics'
  ) {
    db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(user.id, orderId)
  }

  // action → 状态映射
  const actionMap: Record<string, string> = {
    accept:  'accepted',
    ship:    'shipped',
    pickup:  'picked_up',
    transit: 'in_transit',
    deliver: 'delivered',
    confirm: 'confirmed',
    dispute: 'disputed',
  }

  const toStatus = actionMap[action]
  if (!toStatus) return { error: `未知操作：${action}` }

  // 如果有证据描述，先创建证据记录
  const evidenceIds: string[] = []
  if (evidenceDesc) {
    const evidenceId = generateId('evt')
    db.prepare(`
      INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
      VALUES (?, ?, ?, 'description', ?, ?)
    `).run(evidenceId, orderId, user.id, evidenceDesc, `hash_${Date.now()}`)
    evidenceIds.push(evidenceId)
  }

  const result = transition(
    db,
    orderId,
    toStatus as Parameters<typeof transition>[2],
    user.id,
    evidenceIds,
    notes
  )

  if (!result.success) {
    return { error: result.error }
  }

  // 通知相关参与方（L2-6）
  notifyTransition(db, orderId, order.status as string, toStatus)

  // 如果是 dispute，写入 disputes 表（L3-1）
  if (toStatus === 'disputed') {
    const disputeResult = createDispute(db, orderId, user.id, notes || evidenceDesc || '买家发起争议', evidenceIds)
    if (disputeResult.success) {
      return {
        success: true,
        new_status: 'disputed',
        dispute_id: disputeResult.disputeId,
        message: disputeResult.message,
        respond_deadline: disputeResult.respondDeadline,
        next: `用 dcp_dispute action=view dispute_id=${disputeResult.disputeId} 查看争议详情`,
      }
    }
    // 争议记录写入失败不影响状态，仍返回成功
    return { success: true, new_status: 'disputed', message: '争议已发起，资金已冻结', warning: disputeResult.error }
  }

  // 如果是 confirmed，自动触发结算
  if (toStatus === 'confirmed') {
    const sysUser = db
      .prepare("SELECT id FROM users WHERE id = 'sys_protocol'")
      .get() as { id: string }
    transition(db, orderId, 'completed', sysUser.id, [], '系统自动结算')
    settleOrder(db, orderId)
    return {
      success: true,
      new_status: 'completed',
      message: '确认收货成功！资金已自动分配给各参与方。',
      detail: `用 dcp_wallet 查看你的收益`,
    }
  }

  const statusMessages: Record<string, string> = {
    accepted:   '接单成功！请在承诺时间内发货，超时将自动判违约。',
    shipped:    '发货成功！物流方 48 小时内需要完成揽收。',
    picked_up:  '揽收确认！请尽快安排运输。',
    in_transit: '运输状态已更新。',
    delivered:  '投递确认！买家 72 小时内确认收货，超时自动确认。',
    disputed:   '争议已发起，资金冻结，等待仲裁员介入。',
  }

  return {
    success: true,
    new_status: result.newStatus,
    message: statusMessages[toStatus] ?? '状态已更新',
    history_record: result.historyId,
  }
}

function handleGetStatus(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth

  const statusInfo = getOrderStatus(db, args.order_id as string)
  if (!statusInfo) return { error: `订单不存在：${args.order_id}` }

  const { order, history, currentResponsible, activeDeadline, isOverdue } = statusInfo

  return {
    order_id: order.id,
    current_status: order.status,
    current_responsible: currentResponsible
      ? `${currentResponsible}（当前应由此角色操作）`
      : '无（等待系统处理）',
    deadline: activeDeadline
      ? {
          field: activeDeadline.field,
          time: activeDeadline.deadline,
          overdue: isOverdue ? '⚠️ 已超时！协议将自动判责' : '未超时',
        }
      : null,
    history: (history as Record<string, unknown>[]).map((h) => ({
      from: h.from_status,
      to: h.to_status,
      by: `${h.actor_name}（${h.actor_role_name}）`,
      at: h.created_at,
      evidence_count: JSON.parse((h.evidence_ids as string) || '[]').length,
      notes: h.notes,
    })),
  }
}

function handleWallet(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  const wallet = db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(user.id) as Record<string, number> | undefined

  if (!wallet) return { error: '钱包不存在' }

  const payouts = db
    .prepare('SELECT SUM(amount) as total FROM payouts WHERE recipient_id = ?')
    .get(user.id) as { total: number | null }

  return {
    user: user.name,
    role: user.role,
    balance: `${wallet.balance} DCP（可用）`,
    staked: `${wallet.staked} DCP（质押中，不可用）`,
    escrowed: `${wallet.escrowed} DCP（托管中，交易完成后结算）`,
    total_earned: `${payouts.total ?? 0} DCP（历史累计收益）`,
  }
}

// ─── 通知处理 ─────────────────────────────────────────────────

function handleNotifications(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  const onlyUnread = args.unread === true
  const notifs = getNotifications(db, user.id, onlyUnread, 30)
  const unread = getUnreadCount(db, user.id)

  if (args.mark_read) {
    markRead(db, user.id)
  }

  return {
    unread_count: unread,
    notifications: notifs.map(n => ({
      id: n.id,
      title: n.title,
      body: n.body,
      order_id: n.order_id,
      read: n.read === 1,
      time: n.created_at,
    })),
  }
}

// ─── 争议处理 ─────────────────────────────────────────────────

function handleDispute(args: Record<string, unknown>) {
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  const action = args.action as string

  // ── 查看争议详情 ────────────────────────────────────────────
  if (action === 'view') {
    let dispute = args.dispute_id
      ? getDisputeDetails(db, args.dispute_id as string)
      : args.order_id
        ? getOrderDispute(db, args.order_id as string)
        : null

    if (!dispute) return { error: '找不到争议记录，请提供 dispute_id 或 order_id' }

    const evidenceList = (orderId: string, uploaderRole: string) =>
      db.prepare(`
        SELECT e.description, e.type, e.file_hash, e.created_at, u.name as uploader
        FROM evidence e JOIN users u ON e.uploader_id = u.id
        WHERE e.order_id = ? AND u.role = ?
        ORDER BY e.created_at ASC
      `).all(orderId, uploaderRole) as Record<string, unknown>[]

    return {
      dispute_id: dispute.id,
      order_id: dispute.order_id,
      status: dispute.status,
      initiator: `${dispute.initiator_name}（${dispute.initiator_role}）`,
      defendant: `${dispute.defendant_name}（${dispute.defendant_role}）`,
      reason: dispute.reason,
      respond_deadline: dispute.respond_deadline,
      arbitrate_deadline: dispute.arbitrate_deadline,
      plaintiff_evidence: evidenceList(dispute.order_id, dispute.initiator_role as string),
      defendant_notes: dispute.defendant_notes ?? '（被诉方尚未提交回应）',
      defendant_evidence: JSON.parse((dispute.defendant_evidence_ids as string) || '[]'),
      ruling: dispute.ruling_type
        ? { type: dispute.ruling_type, refund_amount: dispute.refund_amount, reason: dispute.verdict_reason }
        : null,
      resolved_at: dispute.resolved_at,
    }
  }

  // ── 仲裁员查看所有待处理争议 ───────────────────────────────
  if (action === 'list_open') {
    if (user.role !== 'arbitrator') {
      return { error: '只有仲裁员可以查看所有待处理争议' }
    }
    const disputes = getOpenDisputes(db)
    return {
      open_count: disputes.length,
      disputes: disputes.map(d => ({
        dispute_id: d.id,
        order_id: d.order_id,
        status: d.status,
        initiator: `${d.initiator_name}（${d.initiator_role}）`,
        defendant: `${d.defendant_name}（${d.defendant_role}）`,
        reason: d.reason,
        amount: `${d.total_amount} DCP`,
        respond_deadline: d.respond_deadline,
        arbitrate_deadline: d.arbitrate_deadline,
        created_at: d.created_at,
      }))
    }
  }

  // ── 被诉方提交反驳 ──────────────────────────────────────────
  if (action === 'respond') {
    if (!args.dispute_id) return { error: '请提供 dispute_id' }

    // 如有证据描述，先创建证据记录
    const evidenceIds: string[] = []
    if (args.evidence_description) {
      const dispute = getDisputeDetails(db, args.dispute_id as string)
      if (dispute) {
        const eid = generateId('evt')
        db.prepare(`
          INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
          VALUES (?, ?, ?, 'description', ?, ?)
        `).run(eid, dispute.order_id, user.id, args.evidence_description as string, `hash_${Date.now()}`)
        evidenceIds.push(eid)
      }
    }

    return respondToDispute(
      db,
      args.dispute_id as string,
      user.id,
      (args.notes as string) ?? '',
      evidenceIds
    )
  }

  // ── 仲裁员裁定 ─────────────────────────────────────────────
  if (action === 'arbitrate') {
    if (!args.dispute_id) return { error: '请提供 dispute_id' }
    if (!args.ruling) return { error: '请提供 ruling（refund_buyer / release_seller / partial_refund）' }
    if (!args.ruling_reason) return { error: '请提供 ruling_reason（裁定理由将永久记录）' }
    if (args.ruling === 'partial_refund' && !args.refund_amount) {
      return { error: 'partial_refund 需要提供 refund_amount' }
    }

    return arbitrateDispute(
      db,
      args.dispute_id as string,
      user.id,
      args.ruling as 'refund_buyer' | 'release_seller' | 'partial_refund',
      args.ruling_reason as string,
      args.refund_amount as number | undefined
    )
  }

  return { error: `未知 action：${action}` }
}

// ─── Skill 市场处理 ────────────────────────────────────────────

function handleSkill(args: Record<string, unknown>) {
  const action = args.action as string

  // ── 浏览 Skill 市场 ────────────────────────────────────────
  if (action === 'list') {
    let userId: string | undefined
    if (args.api_key) {
      const a = requireAuth(db, args.api_key as string)
      if (!('error' in a)) userId = a.user.id
    }
    const skills = listSkills(db, {
      skillType: args.skill_type as SkillType | undefined,
      query: args.query as string | undefined,
      subscriberId: userId,
      limit: 20,
    })
    return {
      total: skills.length,
      skill_types: Object.entries(SKILL_TYPE_META).map(([k, v]) => ({ type: k, label: v.label, icon: v.icon, description: v.description })),
      skills: skills.map(formatSkillForAgent),
    }
  }

  // 以下操作需要身份验证
  const auth = requireAuth(db, args.api_key as string)
  if ('error' in auth) return auth
  const { user } = auth

  // ── 发布 Skill ────────────────────────────────────────────
  if (action === 'publish') {
    if (!args.name)        return { error: '请填写 Skill 名称（name）' }
    if (!args.description) return { error: '请填写 Skill 描述（description）' }
    if (!args.skill_type)  return { error: '请选择 Skill 类型（skill_type）' }

    const skill = publishSkill(db, {
      sellerId:     user.id,
      name:         args.name as string,
      description:  args.description as string,
      category:     args.category as string | undefined,
      skillType:    args.skill_type as SkillType,
      config:       args.config as Record<string, unknown> | undefined,
    })
    const meta = SKILL_TYPE_META[skill.skill_type as SkillType]
    return {
      success: true,
      skill_id: skill.id,
      message: `✅ Skill 「${skill.name}」已发布到 DCP Skill 市场！买家 Agent 现在可以订阅它。`,
      type: `${meta.icon} ${meta.label}`,
      tip: 'auto_accept Skill 发布后，买家新订单将自动被接受（无需手动操作）',
    }
  }

  // ── 订阅 Skill ────────────────────────────────────────────
  if (action === 'subscribe') {
    if (!args.skill_id) return { error: '请提供 skill_id' }
    const result = subscribeSkill(db, user.id, args.skill_id as string, args.config as Record<string, unknown> | undefined)
    return { ...result, skill_id: args.skill_id }
  }

  // ── 取消订阅 ──────────────────────────────────────────────
  if (action === 'unsubscribe') {
    if (!args.skill_id) return { error: '请提供 skill_id' }
    unsubscribeSkill(db, user.id, args.skill_id as string)
    return { success: true, message: '已取消订阅' }
  }

  // ── 我发布的 Skill ────────────────────────────────────────
  if (action === 'my_skills') {
    const skills = getMySkills(db, user.id)
    return {
      total: skills.length,
      skills: skills.map(formatSkillForAgent),
      tip: skills.length === 0 ? '还没有发布任何 Skill。用 dcp_skill action=publish 发布你的第一个 Skill。' : undefined,
    }
  }

  // ── 我订阅的 Skill ────────────────────────────────────────
  if (action === 'my_subs') {
    const skills = getMySubscriptions(db, user.id)
    return {
      total: skills.length,
      subscriptions: skills.map(formatSkillForAgent),
      tip: skills.length === 0 ? '还没有订阅任何 Skill。用 dcp_skill action=list 浏览市场。' : undefined,
    }
  }

  return { error: `未知 action：${action}。可选：list, publish, subscribe, unsubscribe, my_skills, my_subs` }
}

// ─── 结算逻辑（买家确认后自动执行）──────────────────────────────

function settleOrder(db: Database.Database, orderId: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>

  const totalAmount = order.total_amount as number
  const sellerId = order.seller_id as string
  const buyerId = order.buyer_id as string
  const logisticsId = order.logistics_id as string | null
  const promoterId = order.promoter_id as string | null

  // 分成比例（协议参数，未来可治理调整）
  const protocolFee  = Math.round(totalAmount * 0.02 * 100) / 100  // 2% 协议费
  const logisticsFee = Math.round(totalAmount * 0.05 * 100) / 100  // 5% 物流
  const promoterFee  = promoterId ? Math.round(totalAmount * 0.03 * 100) / 100 : 0  // 3% 推荐
  const sellerAmount = totalAmount - protocolFee - logisticsFee - promoterFee

  const payout = (recipientId: string, role: string, amount: number, reason: string) => {
    if (amount <= 0) return
    db.prepare(`INSERT INTO payouts (id, order_id, recipient_id, role, amount, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(generateId('pay'), orderId, recipientId, role, amount, reason)
    db.prepare(`UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?`)
      .run(amount, amount, recipientId)
  }

  // 释放买家托管资金（从 escrowed 减掉）
  db.prepare(`UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?`).run(totalAmount, buyerId)

  // 按比例分发
  payout(sellerId, 'seller', sellerAmount, 'seller_share')
  if (logisticsId) payout(logisticsId, 'logistics', logisticsFee, 'logistics_fee')
  if (promoterId)  payout(promoterId,  'promoter',  promoterFee,  'promoter_fee')

  // 归还卖家质押
  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?').get(order.product_id as string) as { stake_amount: number }
  db.prepare(`UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?`)
    .run(product.stake_amount, product.stake_amount, sellerId)
}

// ─── MCP Server 主体 ──────────────────────────────────────────

export async function startMCPServer() {
  const server = new Server(
    { name: 'dcp-protocol', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    let result: unknown

    try {
      switch (name) {
        case 'dcp_info':          result = handleInfo(); break
        case 'dcp_register':      result = handleRegister(args); break
        case 'dcp_search':        result = handleSearch(args); break
        case 'dcp_list_product':  result = handleListProduct(args); break
        case 'dcp_place_order':   result = handlePlaceOrder(args); break
        case 'dcp_update_order':  result = handleUpdateOrder(args); break
        case 'dcp_get_status':    result = handleGetStatus(args); break
        case 'dcp_wallet':        result = handleWallet(args); break
        case 'dcp_dispute':        result = handleDispute(args); break
        case 'dcp_notifications':  result = handleNotifications(args); break
        case 'dcp_skill':          result = handleSkill(args); break
        default: result = { error: `未知工具：${name}` }
      }
    } catch (err) {
      result = { error: `执行出错：${(err as Error).message}` }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('✅ DCP MCP Server 已启动，等待 Agent 连接...')
}

// ─── 工具函数 ─────────────────────────────────────────────────

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}
