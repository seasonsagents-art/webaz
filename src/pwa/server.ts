/**
 * PWA HTTP Server
 * 把 WebAZ暴露给手机浏览器
 * 端口：3000
 */

import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { initDatabase, generateId } from '../layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, transition, getOrderStatus, checkTimeouts } from '../layer0-foundation/L0-2-state-machine/engine.js'
import {
  initDisputeSchema, createDispute, respondToDispute, arbitrateDispute,
  getOrderDispute, getDisputeDetails, getOpenDisputes, checkDisputeTimeouts,
  initEvidenceRequestSchema, requestEvidence, submitEvidenceForRequest, getEvidenceRequests,
  addPartyEvidence,
  type EvidenceType, type LiabilityEntry,
} from '../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import {
  initNotificationSchema,
  notifyTransition,
  getNotifications,
  getUnreadCount,
  markRead,
  setPushCallback,
  type Notification,
} from '../layer2-business/L2-6-notifications/notification-engine.js'
import {
  initSkillSchema,
  publishSkill,
  listSkills,
  getMySkills,
  subscribeSkill,
  unsubscribeSkill,
  getMySubscriptions,
  shouldAutoAccept,
  type SkillType,
} from '../layer4-economics/L4-4-skill-market/skill-engine.js'
import {
  initReputationSchema,
  recordOrderReputation,
  recordViolationReputation,
  recordDisputeReputation,
  getReputation,
  getSearchBoost,
  getStakeDiscount,
} from '../layer4-economics/L4-3-reputation/reputation-engine.js'
import { generateManifest } from '../layer0-foundation/L0-5-manifest/manifest.js'
import Anthropic from '@anthropic-ai/sdk'
import { privateKeyToAddress, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, parseAbiItem, parseAbi, parseEther, type Log } from 'viem'
import { baseSepolia } from 'viem/chains'
import { createHmac } from 'node:crypto'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── 链上地址派生 ──────────────────────────────────────────────
const MASTER_SEED = process.env.WALLET_MASTER_SEED ?? 'webaz-dev-seed-changeme'

function derivePrivKey(seed: string): `0x${string}` {
  return `0x${createHmac('sha256', MASTER_SEED).update(seed).digest('hex')}`
}

function deriveDepositAddress(userId: string): string {
  return privateKeyToAddress(derivePrivKey(userId))
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = initDatabase()
initSystemUser(db)
initDisputeSchema(db)
initNotificationSchema(db)
initSkillSchema(db)
initReputationSchema(db)
initEvidenceRequestSchema(db)

// ─── Schema 迁移（幂等）──────────────────────────────────────────
try { db.exec('ALTER TABLE wallets ADD COLUMN deposit_address TEXT') } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    to_address  TEXT NOT NULL,
    amount      REAL NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    processed_at TEXT,
    tx_hash     TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS deposit_txns (
    tx_hash      TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    amount       REAL NOT NULL,
    block_number INTEGER,
    swept        INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  )
`)
try { db.exec('ALTER TABLE deposit_txns ADD COLUMN swept INTEGER DEFAULT 0') } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS system_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  )
`)

const app = express()
app.use(express.json())
// express.static は API ルートの後で登録する（順番が重要）

// ─── SSE 连接池（userId → Response）──────────────────────────
const sseClients = new Map<string, Response>()

setPushCallback((userId: string, notif: Notification) => {
  const client = sseClients.get(userId)
  if (client) {
    try { client.write(`data: ${JSON.stringify(notif)}\n\n`) } catch {}
  }
})

// ─── Auth 中间件 ──────────────────────────────────────────────

function getUser(req: Request) {
  const key = req.headers.authorization?.replace('Bearer ', '') ?? (req.body?.api_key as string)
  if (!key) return null
  return db.prepare('SELECT * FROM users WHERE api_key = ?').get(key) as Record<string, unknown> | null
}

function auth(req: Request, res: Response): Record<string, unknown> | null {
  const user = getUser(req)
  if (!user) { res.status(401).json({ error: '请先登录' }); return null }
  return user
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

// ─── API 路由 ─────────────────────────────────────────────────

// 注册
app.post('/api/register', (req, res) => {
  const { name, role } = req.body
  const validRoles = ['buyer', 'seller', 'logistics', 'arbitrator']
  if (!name?.trim()) return void res.json({ error: '请填写名称' })
  if (!validRoles.includes(role)) return void res.json({ error: '角色无效' })

  const id = generateId('usr')
  const apiKey = generateId('key')
  db.prepare('INSERT INTO users (id, name, role, roles, api_key) VALUES (?,?,?,?,?)').run(id, name.trim(), role, JSON.stringify([role]), apiKey)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,1000)').run(id)

  res.json({ success: true, api_key: apiKey, user_id: id, name: name.trim(), role, roles: [role] })
})

// 当前用户信息
app.get('/api/me', (req, res) => {
  const user = auth(req, res); if (!user) return
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id) as Record<string, number>
  const roles: string[] = JSON.parse((user.roles as string) || JSON.stringify([user.role]))
  res.json({ ...user, api_key: undefined, roles, wallet })
})

// 个人资料：查看 API Key
app.get('/api/profile', (req, res) => {
  const user = auth(req, res); if (!user) return
  const wallet = db.prepare('SELECT balance, staked, escrowed, earned FROM wallets WHERE user_id = ?').get(user.id) as Record<string, number>
  const roles: string[] = JSON.parse((user.roles as string) || JSON.stringify([user.role]))
  res.json({ id: user.id, name: user.name, role: user.role, roles, api_key: user.api_key, wallet })
})

// 添加角色
app.post('/api/profile/add-role', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { role } = req.body
  const validRoles = ['buyer', 'seller', 'logistics', 'arbitrator']
  if (!validRoles.includes(role)) return void res.json({ error: '角色无效' })
  const roles: string[] = JSON.parse((user.roles as string) || JSON.stringify([user.role]))
  if (roles.includes(role)) return void res.json({ error: '已拥有该角色' })
  roles.push(role)
  db.prepare("UPDATE users SET roles = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(roles), user.id as string)
  res.json({ success: true, roles })
})

// 切换激活角色
app.post('/api/profile/switch-role', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { role } = req.body
  const roles: string[] = JSON.parse((user.roles as string) || JSON.stringify([user.role]))
  if (!roles.includes(role)) return void res.json({ error: '你还没有该角色，请先添加' })
  db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, user.id as string)
  res.json({ success: true, role, roles })
})

// 通过名字找回 API Key（Phase 0 无需验证，Phase 1 需邮箱/短信）
app.post('/api/recover-key', (req, res) => {
  const { name } = req.body
  if (!name?.trim()) return void res.json({ error: '请填写注册时使用的名称' })
  const users = db.prepare("SELECT name, role, roles, api_key FROM users WHERE name = ? AND id != 'sys_protocol'").all(name.trim()) as Record<string, unknown>[]
  if (users.length === 0) return void res.json({ error: '未找到该名称的账号' })
  res.json({ found: users.length, accounts: users })
})

// 搜索商品（声誉权重排序）
app.get('/api/products', (req, res) => {
  const { q = '', category, max_price } = req.query
  let sql = `SELECT p.*, u.name as seller_name,
    COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
    FROM products p
    JOIN users u ON p.seller_id = u.id
    LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
    WHERE p.status = 'active' AND p.stock > 0`
  const params: unknown[] = []
  if (q) { sql += ` AND (p.title LIKE ? OR p.description LIKE ?)`; params.push(`%${q}%`, `%${q}%`) }
  if (category) { sql += ` AND p.category = ?`; params.push(category) }
  if (max_price) { sql += ` AND p.price <= ?`; params.push(Number(max_price)) }
  sql += ` ORDER BY rep_points DESC, p.created_at DESC LIMIT 30`
  res.json(db.prepare(sql).all(...params))
})

// 卖家：我的商品
app.get('/api/my-products', (req, res) => {
  const user = auth(req, res); if (!user) return
  const products = db.prepare(`SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC`).all(user.id)
  res.json(products)
})

// 卖家：上架商品
app.post('/api/products', (req, res) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'seller') return void res.json({ error: '仅卖家可上架商品' })

  const { title, description, price, stock = 1, category = '' } = req.body
  if (!title || !description || !price) return void res.json({ error: '请填写商品名、描述、价格' })

  const priceNum = Number(price)
  const stakeDiscount = getStakeDiscount(db, user.id as string)
  const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)
  const stakeAmount = Math.round(priceNum * stakeRate * 100) / 100
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }

  if (wallet.balance < stakeAmount) {
    return void res.json({ error: `余额不足：上架需质押 ${stakeAmount} WAZ，当前余额 ${wallet.balance} WAZ` })
  }

  const id = generateId('prd')
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, category, stake_amount)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, user.id, title, description, priceNum, stock, category, stakeAmount)
  db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`)
    .run(stakeAmount, stakeAmount, user.id)

  res.json({ success: true, product_id: id, stake_locked: stakeAmount })
})

// 初始化导入次数追踪表
db.exec(`
  CREATE TABLE IF NOT EXISTS import_logs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)

const FREE_IMPORT_LIMIT = 10

// 一键导入商品（smart_import）
app.post('/api/import-product', async (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'seller') return void res.json({ error: '仅卖家可使用导入功能' })

  const { url, user_api_key } = req.body
  if (!url) return void res.json({ error: '请提供商品链接' })

  // 检查每日额度（用自己 Key 则跳过）
  const usingOwnKey = typeof user_api_key === 'string' && user_api_key.trim().startsWith('sk-ant-')
  if (!usingOwnKey) {
    const todayCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM import_logs WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
    ).get(user.id) as { cnt: number }).cnt
    if (todayCount >= FREE_IMPORT_LIMIT) {
      return void res.json({
        error: `今日免费导入次数已用完（${FREE_IMPORT_LIMIT} 次/天）。请在导入面板填入你自己的 Anthropic API Key 以继续使用。`,
        quota_exceeded: true,
        used: todayCount,
        limit: FREE_IMPORT_LIMIT,
      })
    }
  }

  // 抓取页面 HTML
  let html = ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebAZ/1.0; +https://webaz.xyz)',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    clearTimeout(timer)
    const raw = await resp.text()
    html = raw.slice(0, 30000)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return void res.json({ error: `无法访问该链接：${msg}` })
  }

  // 查询 WebAZ 同类商品均价（用于定价建议）
  const avgPrices = db.prepare(`
    SELECT category, AVG(price) as avg_price, MIN(price) as min_price, MAX(price) as max_price, COUNT(*) as cnt
    FROM products WHERE status = 'active' GROUP BY category
  `).all() as { category: string; avg_price: number; min_price: number; max_price: number; cnt: number }[]

  const priceContext = avgPrices.map(r =>
    `${r.category || '未分类'}：均价 ${r.avg_price?.toFixed(0)} WAZ，最低 ${r.min_price} WAZ，最高 ${r.max_price} WAZ（${r.cnt} 件商品）`
  ).join('\n')

  // 调用 Claude 提取结构化商品数据
  const client = usingOwnKey
    ? new Anthropic({ apiKey: user_api_key.trim() })
    : anthropic

  let extracted: Record<string, unknown>
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `你是一个电商商品信息提取助手。从以下网页 HTML 中提取商品信息，并返回 JSON 格式结果。

网页来源 URL：${url}

WebAZ 平台当前各类目价格参考（WAZ 为协议货币，1 WAZ ≈ 1 CNY）：
${priceContext || '暂无参考数据'}

请提取并返回以下 JSON 格式（只返回 JSON，不要其他文字）：
{
  "title": "商品标题（简洁，50字以内）",
  "description": "商品描述（详细说明材质/规格/特点/适用场景，200字以内，适合 AI Agent 检索）",
  "original_price": 原平台价格数字（CNY，找不到则 null），
  "suggested_price": 建议 WAZ 定价数字（参考原价和平台均价，给出有竞争力的价格），
  "price_reasoning": "定价建议理由（1-2句）",
  "category": "类目（从以下选一个：茶具/家居/食品/服装/手工/电子，其他填空字符串）",
  "stock": 建议库存数量（默认1），
  "tags": ["标签1", "标签2"]（3-5个关键词标签）
}

HTML 内容（前 30000 字符）：
${html}`,
      }],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('未能提取 JSON')
    extracted = JSON.parse(jsonMatch[0])
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return void res.json({ error: `AI 解析失败：${msg}` })
  }

  // 验证提取结果有效（防止页面需要登录导致返回空内容）
  const title = typeof extracted.title === 'string' ? extracted.title.trim() : ''
  const description = typeof extracted.description === 'string' ? extracted.description.trim() : ''
  if (!title || title.length < 2) {
    return void res.json({
      error: '该链接无法提取商品信息（可能需要登录、或为动态渲染页面）。建议使用京东/亚马逊/独立站链接，或改用手动上架。',
      suggestion: 'manual',
    })
  }
  if (!description || description.length < 5) {
    extracted.description = title  // 至少用标题填充描述
  }

  // 记录本次使用（仅平台 Key 计入额度）
  if (!usingOwnKey) {
    db.prepare(`INSERT INTO import_logs (id, user_id) VALUES (?, ?)`).run(generateId('iml'), user.id)
  }

  // 查询今日剩余次数
  const usedToday = usingOwnKey ? 0 : (db.prepare(
    `SELECT COUNT(*) as cnt FROM import_logs WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
  ).get(user.id) as { cnt: number }).cnt

  res.json({
    success: true,
    source_url: url,
    used_own_key: usingOwnKey,
    quota: usingOwnKey ? null : { used: usedToday, limit: FREE_IMPORT_LIMIT, remaining: FREE_IMPORT_LIMIT - usedToday },
    ...extracted,
  })
})

// 我的订单（买家或卖家视角）
app.get('/api/orders', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const orders = db.prepare(`
    SELECT o.*, p.title as product_title, p.images,
      ub.name as buyer_name, us.name as seller_name
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users ub ON o.buyer_id = ub.id
    JOIN users us ON o.seller_id = us.id
    WHERE o.buyer_id = ? OR o.seller_id = ? OR o.logistics_id = ?
    ORDER BY o.created_at DESC LIMIT 50
  `).all(user.id, user.id, user.id)
  res.json(orders)
})

// 订单详情
app.get('/api/orders/:id', (req, res) => {
  const user = auth(req, res); if (!user) return
  const statusInfo = getOrderStatus(db, req.params.id)
  if (!statusInfo) return void res.status(404).json({ error: '订单不存在' })

  const order = statusInfo.order as Record<string, unknown>
  const isLogisticsPickup = (user as Record<string,unknown>).role === 'logistics' &&
    !order.logistics_id && order.status === 'shipped'
  if (order.buyer_id !== user.id && order.seller_id !== user.id && order.logistics_id !== user.id && user.role !== 'arbitrator' && !isLogisticsPickup) {
    return void res.status(403).json({ error: '无权查看此订单' })
  }

  const product = db.prepare('SELECT title, price, images FROM products WHERE id = ?').get(order.product_id as string)
  const dispute = getOrderDispute(db, req.params.id)

  // 为每条历史记录附上证据描述内容
  const history = (statusInfo.history as Record<string, unknown>[]).map(h => {
    const ids: string[] = JSON.parse((h.evidence_ids as string) || '[]')
    const evidenceItems = ids.length
      ? db.prepare(`SELECT description, type FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : []
    return { ...h, evidence_items: evidenceItems } as Record<string, unknown> & { evidence_items: unknown[] }
  })

  // 物流跟踪摘要：从历史中提取所有物流操作的证据
  const LOGISTICS_STEPS = ['shipped', 'picked_up', 'in_transit', 'delivered']
  const trackingInfo = history
    .filter(h => LOGISTICS_STEPS.includes(h.to_status as string))
    .map(h => ({
      status:    h.to_status,
      actor:     h.actor_name,
      time:      h.created_at,
      evidence:  (h.evidence_items as { description: string }[]).map(e => e.description).filter(Boolean),
      notes:     h.notes,
    }))

  res.json({ ...statusInfo, history, product, dispute, trackingInfo })
})

// 下单
app.post('/api/orders', (req, res) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'buyer') return void res.json({ error: '仅买家可下单' })

  const { product_id, shipping_address, notes } = req.body
  if (!product_id || !shipping_address) return void res.json({ error: '请提供商品ID和收货地址' })

  const product = db.prepare(`SELECT p.*, u.id as seller_uid FROM products p
    JOIN users u ON p.seller_id = u.id WHERE p.id = ? AND p.status = 'active'`
  ).get(product_id) as Record<string, unknown> | undefined
  if (!product) return void res.json({ error: '商品不存在或已下架' })
  if ((product.stock as number) < 1) return void res.json({ error: '库存不足' })

  const totalAmount = product.price as number
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  if (wallet.balance < totalAmount) return void res.json({ error: `余额不足：需 ${totalAmount} WAZ，当前 ${wallet.balance} WAZ` })

  const now = new Date()
  const orderId = generateId('ord')
  db.prepare(`INSERT INTO orders (
    id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
    status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
    pickup_deadline, delivery_deadline, confirm_deadline
  ) VALUES (?,?,?,?,1,?,?,?,'created',?,?,?,?,?,?,?,?)`).run(
    orderId, product.id, user.id, product.seller_uid, totalAmount, totalAmount, totalAmount,
    shipping_address, notes || null,
    addHours(now, 24), addHours(now, 48), addHours(now, 120),
    addHours(now, 168), addHours(now, 336), addHours(now, 408)
  )
  db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?')
    .run(totalAmount, totalAmount, user.id)
  db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(product.id)
  transition(db, orderId, 'paid', user.id as string, [], '模拟支付完成')
  notifyTransition(db, orderId, 'created', 'paid')

  // 检查卖家是否有 auto_accept Skill
  let autoAccepted = false
  if (shouldAutoAccept(db, orderId)) {
    const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
    if (sysUser) {
      const ar = transition(db, orderId, 'accepted', sysUser.id, [], '⚡ auto_accept Skill 自动接单')
      if (ar.success) { notifyTransition(db, orderId, 'paid', 'accepted'); autoAccepted = true }
    }
  }

  res.json({ success: true, order_id: orderId, total_amount: totalAmount, auto_accepted: autoAccepted || undefined })
})

// 物流公司列表（卖家发货时选择）
app.get('/api/logistics/companies', (req, res) => {
  const companies = db.prepare(
    `SELECT id, name FROM users WHERE role = 'logistics' ORDER BY name ASC`
  ).all()
  res.json(companies)
})

// 更新订单状态（接单/发货/揽收/投递/确认/争议）
app.post('/api/orders/:id/action', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { action, notes = '', evidence_description = '', logistics_company_id = '' } = req.body

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!order) return void res.status(404).json({ error: '订单不存在' })

  // 卖家发货时：绑定选择的物流公司
  if (action === 'ship' && logistics_company_id) {
    const logi = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'logistics'`).get(logistics_company_id)
    if (!logi) return void res.json({ error: '所选物流公司不存在' })
    db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(logistics_company_id, req.params.id)
  }

  // 物流自行揽收（卖家未指定物流时的兜底）
  if (action === 'pickup' && !order.logistics_id && (user as Record<string, unknown>).role === 'logistics') {
    db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(user.id, req.params.id)
  }

  const actionMap: Record<string, string> = {
    accept: 'accepted', ship: 'shipped', pickup: 'picked_up',
    transit: 'in_transit', deliver: 'delivered', confirm: 'confirmed', dispute: 'disputed'
  }
  const toStatus = actionMap[action]
  if (!toStatus) return void res.json({ error: `未知操作：${action}` })

  // 创建证据记录
  const evidenceIds: string[] = []
  if (evidence_description) {
    const eid = generateId('evt')
    db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
      VALUES (?,?,?,'description',?,?)`).run(eid, req.params.id, user.id, evidence_description, `hash_${Date.now()}`)
    evidenceIds.push(eid)
  }

  const fromStatus = (order as Record<string, unknown>).status as string
  const result = transition(db, req.params.id, toStatus as Parameters<typeof transition>[2], user.id as string, evidenceIds, notes)
  if (!result.success) return void res.json({ error: result.error })

  // 通知相关参与方
  notifyTransition(db, req.params.id, fromStatus, toStatus)

  // 发起争议时写入 disputes 表
  if (toStatus === 'disputed') {
    createDispute(db, req.params.id, user.id as string, notes || evidence_description || '买家发起争议', evidenceIds)
  }

  // 确认收货时自动结算
  if (toStatus === 'confirmed') {
    const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
    transition(db, req.params.id, 'completed', sysUser.id, [], '系统自动结算')
    notifyTransition(db, req.params.id, 'confirmed', 'completed')
    settleOrder(req.params.id)
  }

  res.json({ success: true, new_status: result.newStatus })
})

// 钱包
app.get('/api/wallet', (req, res) => {
  const user = auth(req, res); if (!user) return
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id) as Record<string, unknown>

  // 生成并缓存链上充值地址（首次调用时派生）
  if (!wallet.deposit_address) {
    const addr = deriveDepositAddress(user.id as string)
    db.prepare('UPDATE wallets SET deposit_address = ? WHERE user_id = ?').run(addr, user.id)
    wallet.deposit_address = addr
  }

  res.json(wallet)
})

// 提现申请（Phase 1：记录申请，人工处理；Phase 2 自动链上转账）
app.post('/api/wallet/withdraw', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { to_address, amount } = req.body

  if (!/^0x[0-9a-fA-F]{40}$/.test(to_address ?? '')) {
    return void res.json({ error: '请输入有效的以太坊地址（0x 开头，42 位字符）' })
  }
  const amountNum = Number(amount)
  if (!amountNum || amountNum <= 0) return void res.json({ error: '请输入提现金额' })
  if (amountNum < 10) return void res.json({ error: '最低提现金额为 10 WAZ' })

  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  if (wallet.balance < amountNum) {
    return void res.json({ error: `余额不足：当前可用 ${wallet.balance.toFixed(2)} WAZ` })
  }

  const wid = generateId('wdr')
  db.prepare(`INSERT INTO withdrawal_requests (id, user_id, to_address, amount) VALUES (?,?,?,?)`)
    .run(wid, user.id, to_address, amountNum)
  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amountNum, user.id)

  res.json({
    success: true,
    request_id: wid,
    message: '提现申请已提交，将在 24 小时内到账。',
  })
})

// 我的提现记录
app.get('/api/wallet/withdrawals', (req, res) => {
  const user = auth(req, res); if (!user) return
  const list = db.prepare(
    `SELECT id, to_address, amount, status, created_at, tx_hash FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
  ).all(user.id)
  res.json(list)
})

// 我的充值记录
app.get('/api/wallet/deposits', (req, res) => {
  const user = auth(req, res); if (!user) return
  const list = db.prepare(
    `SELECT tx_hash, amount, block_number, swept, created_at FROM deposit_txns WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
  ).all(user.id)
  res.json(list)
})

// ─── 管理员端点 ───────────────────────────────────────────────

function adminAuth(req: Request, res: Response): boolean {
  const adminKey = process.env.ADMIN_KEY
  if (!adminKey) { res.status(503).json({ error: '管理功能未启用（未设置 ADMIN_KEY）' }); return false }
  if (req.headers['x-admin-key'] !== adminKey) { res.status(403).json({ error: '认证失败' }); return false }
  return true
}

// 热钱包状态
app.get('/api/admin/hot-wallet', async (req, res) => {
  if (!adminAuth(req, res)) return
  try {
    const balance = await publicClient.readContract({
      address: USDC_SEPOLIA, abi: USDC_ABI,
      functionName: 'balanceOf', args: [HOT_WALLET_ADDR],
    }) as bigint
    res.json({ address: HOT_WALLET_ADDR, usdc_balance: Number(balance) / 1e6 })
  } catch (e) {
    res.json({ address: HOT_WALLET_ADDR, usdc_balance: null, error: (e as Error).message })
  }
})

// 待处理提现列表
app.get('/api/admin/withdrawals', (req, res) => {
  if (!adminAuth(req, res)) return
  const list = db.prepare(`
    SELECT wr.*, u.name as user_name
    FROM withdrawal_requests wr JOIN users u ON wr.user_id = u.id
    WHERE wr.status = 'pending' ORDER BY wr.created_at ASC
  `).all()
  res.json(list)
})

// 批准并执行提现
app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
  if (!adminAuth(req, res)) return
  const result = await executeWithdrawal(req.params.id).catch(e => ({ success: false as const, error: (e as Error).message, txHash: undefined }))
  if (!result.success) return void res.json({ error: result.error })
  res.json({ success: true, tx_hash: result.txHash })
})

// 充值测试 WAZ（Phase 0 专用，最多单次 1000，余额上限 5000）
app.post('/api/wallet/topup', (req, res) => {
  const user = auth(req, res); if (!user) return
  const amount = Math.min(1000, Math.max(1, Number(req.body?.amount) || 500))
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  if (wallet.balance >= 5000) return void res.json({ error: '余额已达上限 5000 WAZ，无需充值' })
  const actual = Math.min(amount, 5000 - wallet.balance)
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(actual, user.id)
  res.json({ success: true, added: actual, new_balance: wallet.balance + actual })
})

// 物流：可接订单 + 我的进行中订单
app.get('/api/logistics/orders', (req, res) => {
  const user = auth(req, res); if (!user) return
  if ((user as Record<string, unknown>).role !== 'logistics') return void res.status(403).json({ error: '仅限物流角色' })

  const available = db.prepare(`
    SELECT o.*, p.title as product_title, p.category,
      ub.name as buyer_name, us.name as seller_name
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users ub ON o.buyer_id = ub.id
    JOIN users us ON o.seller_id = us.id
    WHERE o.status = 'shipped' AND (o.logistics_id IS NULL OR o.logistics_id = '')
    ORDER BY o.created_at ASC LIMIT 20
  `).all()

  const mine = db.prepare(`
    SELECT o.*, p.title as product_title, p.category,
      ub.name as buyer_name, us.name as seller_name
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users ub ON o.buyer_id = ub.id
    JOIN users us ON o.seller_id = us.id
    WHERE o.logistics_id = ? AND o.status IN ('shipped','picked_up','in_transit')
    ORDER BY o.created_at ASC LIMIT 20
  `).all(user.id)

  res.json({ available, mine })
})

// ─── 结算 ──────────────────────────────────────────────────────

function settleOrder(orderId: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>
  const total = order.total_amount as number
  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?').get(order.product_id as string) as { stake_amount: number }

  const protocolFee  = Math.round(total * 0.02 * 100) / 100
  const logisticsFee = Math.round(total * 0.05 * 100) / 100
  const promoterFee  = order.promoter_id ? Math.round(total * 0.03 * 100) / 100 : 0
  const sellerAmount = total - protocolFee - logisticsFee - promoterFee

  db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(total, order.buyer_id as string)
  db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(sellerAmount, sellerAmount, order.seller_id as string)
  if (order.logistics_id) db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(logisticsFee, logisticsFee, order.logistics_id as string)
  if (order.promoter_id)  db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(promoterFee, promoterFee, order.promoter_id as string)
  db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?').run(product.stake_amount, product.stake_amount, order.seller_id as string)

  // L4-3 声誉积分
  recordOrderReputation(db, orderId)
}

// ─── 通知 API ─────────────────────────────────────────────────

// SSE 实时推送流（EventSource 不支持自定义 header，用 URL 参数传 key）
app.get('/api/notifications/stream', (req, res) => {
  const key = (req.query.key as string) ?? req.headers.authorization?.replace('Bearer ', '')
  const user = key ? db.prepare('SELECT * FROM users WHERE api_key = ?').get(key) as Record<string, unknown> | null : null
  if (!user) return void res.status(401).end()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  sseClients.set(user.id as string, res)

  // 连接时推送未读数
  const unread = getUnreadCount(db, user.id as string)
  res.write(`data: ${JSON.stringify({ type: 'init', unread })}\n\n`)

  // 心跳保活（每 30s）
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { clearInterval(heartbeat) }
  }, 30_000)

  req.on('close', () => {
    sseClients.delete(user.id as string)
    clearInterval(heartbeat)
  })
})

// 获取通知列表
app.get('/api/notifications', (req, res) => {
  const user = auth(req, res); if (!user) return
  const onlyUnread = req.query.unread === '1'
  const notifs = getNotifications(db, user.id as string, onlyUnread)
  const unread = getUnreadCount(db, user.id as string)
  res.json({ unread, notifications: notifs })
})

// 标记已读（不传 id 则全部已读）
app.post('/api/notifications/read', (req, res) => {
  const user = auth(req, res); if (!user) return
  markRead(db, user.id as string, req.body?.id as string | undefined)
  res.json({ success: true })
})

// ─── Skill 市场 API ───────────────────────────────────────────

// 浏览 Skill 市场（公开，无需登录）
app.get('/api/skills', (req, res) => {
  const user = getUser(req)
  const skills = listSkills(db, {
    skillType: req.query.type as SkillType | undefined,
    query: req.query.q as string | undefined,
    subscriberId: user?.id as string | undefined,
    limit: 30,
  })
  res.json(skills)
})

// 我发布的 Skill
app.get('/api/skills/mine', (req, res) => {
  const user = auth(req, res); if (!user) return
  res.json(getMySkills(db, user.id as string))
})

// 我订阅的 Skill
app.get('/api/skills/subscriptions', (req, res) => {
  const user = auth(req, res); if (!user) return
  res.json(getMySubscriptions(db, user.id as string))
})

// 发布新 Skill
app.post('/api/skills', (req, res) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'seller') return void res.json({ error: '只有卖家才能发布 Skill' })
  const { name, description, category, skill_type, config } = req.body
  if (!name || !description || !skill_type) return void res.json({ error: '请填写 name、description、skill_type' })
  try {
    const skill = publishSkill(db, {
      sellerId: user.id as string,
      name, description, category,
      skillType: skill_type as SkillType,
      config: config ?? {},
    })
    res.json({ success: true, skill })
  } catch (err) {
    res.json({ error: (err as Error).message })
  }
})

// 订阅 Skill
app.post('/api/skills/:id/subscribe', (req, res) => {
  const user = auth(req, res); if (!user) return
  try {
    const result = subscribeSkill(db, user.id as string, req.params.id, req.body?.config ?? {})
    res.json(result)
  } catch (err) {
    res.json({ error: (err as Error).message })
  }
})

// 取消订阅 Skill
app.delete('/api/skills/:id/subscribe', (req, res) => {
  const user = auth(req, res); if (!user) return
  unsubscribeSkill(db, user.id as string, req.params.id)
  res.json({ success: true })
})

// ─── Protocol Manifest（L0-5）────────────────────────────────

// 公开端点：任何客户端都可发现协议规范
app.get('/api/manifest', (_req, res) => {
  res.json(generateManifest(db))
})

// 声誉 API ─────────────────────────────────────────────────────

// 我的声誉
app.get('/api/reputation', (req, res) => {
  const user = auth(req, res); if (!user) return
  const rep = getReputation(db, user.id as string)
  res.json({
    level:             rep.level,
    total_points:      rep.total_points,
    transactions_done: rep.transactions_done,
    disputes_won:      rep.disputes_won,
    disputes_lost:     rep.disputes_lost,
    violations:        rep.violations,
    recent_events:     rep.recent_events,
  })
})

// 查看任意用户的声誉（公开）
app.get('/api/reputation/:userId', (req, res) => {
  const rep = getReputation(db, req.params.userId)
  res.json({
    level:             rep.level,
    total_points:      rep.total_points,
    transactions_done: rep.transactions_done,
    disputes_won:      rep.disputes_won,
    disputes_lost:     rep.disputes_lost,
    violations:        rep.violations,
  })
})

// ─── 争议 API（L3 PWA 接口）────────────────────────────────────

// 仲裁员：查看所有开放争议
app.get('/api/disputes', (req, res) => {
  const user = auth(req, res); if (!user) return
  if ((user as Record<string, unknown>).role !== 'arbitrator') return void res.status(403).json({ error: '仅限仲裁员访问' })
  res.json(getOpenDisputes(db))
})

// 争议详情（含双方证据）
app.get('/api/disputes/:id', (req, res) => {
  const user = auth(req, res); if (!user) return
  const dispute = getDisputeDetails(db, req.params.id)
  if (!dispute) return void res.status(404).json({ error: '争议不存在' })

  const role = (user as Record<string, unknown>).role as string
  // 允许：发起方、被告方、物流方（关联订单的 logistics_id）、仲裁员
  const orderForAuth = db.prepare('SELECT logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as { logistics_id: string | null } | undefined
  const isLogisticsParty = orderForAuth?.logistics_id === user.id
  if (dispute.initiator_id !== user.id && dispute.defendant_id !== user.id
      && !isLogisticsParty && role !== 'arbitrator') {
    return void res.status(403).json({ error: '无权查看此争议' })
  }

  // 原告证据 — 从状态机历史中取 disputed 转移时附带的证据
  const hist = db.prepare(
    `SELECT evidence_ids FROM order_state_history WHERE order_id = ? AND to_status = 'disputed'`
  ).get(dispute.order_id) as { evidence_ids: string } | undefined
  const plaintiffEvidenceIds: string[] = hist ? JSON.parse(hist.evidence_ids || '[]') : []
  const defEvidenceIds: string[] = JSON.parse(dispute.defendant_evidence_ids || '[]')

  const fetchEvidence = (ids: string[]) =>
    ids.length
      ? db.prepare(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : []

  // 证据补充请求列表
  const evidenceRequests = getEvidenceRequests(db, req.params.id)
  const myPendingRequests = evidenceRequests.filter(
    r => r.requested_from_id === user.id && r.status === 'pending'
  )

  // 涉案参与方（仲裁员选择发证据请求的对象）
  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as Record<string, string | null> | undefined
  const partyIds = [dispute.initiator_id, dispute.defendant_id, order?.logistics_id].filter(Boolean) as string[]
  const parties = [...new Set(partyIds)].map(id =>
    db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id)
  ).filter(Boolean)

  // 参与方主动提交的证据
  const partyEvidenceIds: string[] = JSON.parse((dispute as Record<string, unknown>).party_evidence_ids as string || '[]')

  // 当前用户是否参与方（用于前端判断是否显示主动举证按钮）
  const orderParties = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as Record<string, string | null> | undefined
  const allPartyIds = [
    orderParties?.buyer_id, orderParties?.seller_id, orderParties?.logistics_id,
    dispute.initiator_id, dispute.defendant_id
  ].filter(Boolean) as string[]
  const isParty = allPartyIds.includes(user.id as string)

  res.json({
    ...dispute,
    plaintiff_evidence:   fetchEvidence(plaintiffEvidenceIds),
    defendant_evidence:   fetchEvidence(defEvidenceIds),
    party_evidence:       fetchEvidence(partyEvidenceIds),
    evidence_requests:    evidenceRequests,
    my_pending_requests:  myPendingRequests,
    parties,
    is_party: isParty,
  })
})

// 被诉方提交反驳证据
app.post('/api/disputes/:id/respond', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { notes = '', evidence_description = '' } = req.body

  const dispute = getDisputeDetails(db, req.params.id)
  if (!dispute) return void res.status(404).json({ error: '争议不存在' })
  if (dispute.defendant_id !== user.id) return void res.status(403).json({ error: '你不是本争议的被诉方' })

  const evidenceIds: string[] = []
  if (evidence_description) {
    const eid = generateId('evt')
    db.prepare(`INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
      VALUES (?,?,?,'description',?,?)`).run(eid, dispute.order_id, user.id, evidence_description, `hash_${Date.now()}`)
    evidenceIds.push(eid)
  }

  const result = respondToDispute(db, req.params.id, user.id as string, notes || evidence_description, evidenceIds)
  if (!result.success) return void res.json({ error: result.error })
  res.json({ success: true, message: result.message })
})

// 仲裁员裁定
app.post('/api/disputes/:id/arbitrate', (req, res) => {
  const user = auth(req, res); if (!user) return
  if ((user as Record<string, unknown>).role !== 'arbitrator') return void res.status(403).json({ error: '仅限仲裁员' })

  const { ruling, reason, refund_amount, liable_party_id, liability_parties } = req.body
  if (!ruling || !reason) return void res.json({ error: '请提供裁定结果（ruling）和理由（reason）' })
  const validRulings = ['refund_buyer', 'release_seller', 'partial_refund', 'liability_split']
  if (!validRulings.includes(ruling)) {
    return void res.json({ error: `ruling 必须是 ${validRulings.join(' / ')} 之一` })
  }
  if (ruling === 'liability_split') {
    if (!Array.isArray(liability_parties) || liability_parties.length === 0) {
      return void res.json({ error: '责任分配裁定需要提供 liability_parties 数组' })
    }
    for (const p of liability_parties as LiabilityEntry[]) {
      if (!p.user_id || typeof p.amount !== 'number' || p.amount < 0) {
        return void res.json({ error: '每个责任方需提供 user_id 和非负 amount' })
      }
    }
  }

  const dispute = getDisputeDetails(db, req.params.id)
  if (!dispute) return void res.status(404).json({ error: '争议不存在' })

  const result = arbitrateDispute(
    db, req.params.id, user.id as string, ruling, reason,
    refund_amount ? Number(refund_amount) : undefined,
    liability_parties as LiabilityEntry[] | undefined,
    liable_party_id as string | undefined
  )
  if (!result.success) return void res.json({ error: result.error })

  // 争议声誉更新（责任分配时以主要责任方为败诉方）
  let winnerId: string | null = null
  let loserId: string | null = null
  if (ruling === 'refund_buyer') {
    winnerId = dispute.initiator_id; loserId = dispute.defendant_id
  } else if (ruling === 'release_seller') {
    winnerId = dispute.defendant_id; loserId = dispute.initiator_id
  } else if (ruling === 'liability_split' && Array.isArray(liability_parties) && liability_parties.length > 0) {
    // 最大责任方为败诉方
    const maxLiable = (liability_parties as LiabilityEntry[]).reduce((a, b) => a.amount >= b.amount ? a : b)
    loserId = maxLiable.user_id
    winnerId = dispute.initiator_id !== loserId ? dispute.initiator_id : dispute.defendant_id
  }
  if (winnerId && loserId) recordDisputeReputation(db, dispute.order_id, winnerId, loserId)

  res.json({ success: true, message: result.message, settlement: result.settlement })
})

// 参与方主动提交证据
app.post('/api/disputes/:id/add-evidence', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { description, evidence_type = 'text', file_hash } = req.body
  if (!description?.trim()) return void res.json({ error: '请填写证据内容' })

  const result = addPartyEvidence(
    db, req.params.id, user.id as string,
    description.trim(), evidence_type as EvidenceType, file_hash
  )
  if (!result.success) return void res.json({ error: result.error })
  res.json({ success: true, evidence_id: result.evidenceId, anchor_hash: result.anchorHash })
})

// 仲裁员：请求某方补充证据
app.post('/api/disputes/:id/request-evidence', (req, res) => {
  const user = auth(req, res); if (!user) return
  if ((user as Record<string, unknown>).role !== 'arbitrator') return void res.status(403).json({ error: '仅限仲裁员' })

  const { requested_from_id, evidence_types, description, deadline_hours = 48 } = req.body
  if (!requested_from_id || !description) return void res.json({ error: '请指定被要求方和证据要求说明' })
  if (!Array.isArray(evidence_types) || evidence_types.length === 0) {
    return void res.json({ error: '请至少选择一种证据类型' })
  }
  const validTypes = ['text', 'image', 'video', 'document', 'chain_data']
  if (!evidence_types.every((t: string) => validTypes.includes(t))) {
    return void res.json({ error: `证据类型无效，支持：${validTypes.join('/')}` })
  }

  const result = requestEvidence(
    db, req.params.id, user.id as string,
    requested_from_id, evidence_types as EvidenceType[],
    description, Number(deadline_hours)
  )
  if (!result.success) return void res.json({ error: result.error })
  res.json({ success: true, request_id: result.requestId })
})

// 当事人：提交指定证据请求的回应
app.post('/api/evidence-requests/:requestId/submit', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { evidence_type = 'text', description, file_hash } = req.body
  if (!description?.trim()) return void res.json({ error: '请填写证据内容' })

  const result = submitEvidenceForRequest(
    db, req.params.requestId, user.id as string,
    evidence_type as EvidenceType, description.trim(), file_hash
  )
  if (!result.success) return void res.json({ error: result.error })
  res.json({ success: true, evidence_id: result.evidenceId, anchor_hash: result.anchorHash })
})

// 查询某争议的关联用户（仲裁员选择发证据请求给谁）
app.get('/api/disputes/:id/parties', (req, res) => {
  const user = auth(req, res); if (!user) return
  const dispute = getDisputeDetails(db, req.params.id)
  if (!dispute) return void res.status(404).json({ error: '争议不存在' })

  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as Record<string, string | null> | undefined

  const partyIds = [dispute.initiator_id, dispute.defendant_id, order?.logistics_id].filter(Boolean) as string[]
  const uniqueIds = [...new Set(partyIds)]
  const parties = uniqueIds.map(id => {
    const u = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id) as Record<string, string>
    return u
  }).filter(Boolean)

  res.json(parties)
})

// ─── 静态文件 + SPA 回退（必须在所有 API 路由之后）────────────
app.use(express.static(path.join(__dirname, 'public')))

app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ─── 自动执法（随 PWA 进程内置运行）────────────────────────────

const ENFORCE_INTERVAL_MS = 5 * 60 * 1000   // 每 5 分钟扫描一次

function runEnforcement() {
  try {
    const orderResult   = checkTimeouts(db)
    const disputeResult = checkDisputeTimeouts(db)

    if (orderResult.processed > 0) {
      console.log(`⚡ 订单超时判责 × ${orderResult.processed}`)
      orderResult.details.forEach(d => {
        console.log(`   ${d.orderId}  ${d.action}`)
        const faultMatch = d.action.match(/→ (fault_\w+)/)
        if (faultMatch) recordViolationReputation(db, d.orderId, faultMatch[1])
      })
    }

    if (disputeResult.processed > 0) {
      console.log(`⚡ 争议自动裁定 × ${disputeResult.processed}`)
      disputeResult.details.forEach(d => {
        console.log(`   ${d.disputeId}  ${d.action}`)
        if (d.winnerId && d.loserId && d.orderId) {
          recordDisputeReputation(db, d.orderId, d.winnerId as string, d.loserId as string)
        }
      })
    }
  } catch (err) {
    console.error('执法扫描出错：', (err as Error).message)
  }
}

// ─── 链上基础配置 ─────────────────────────────────────────────

const USDC_SEPOLIA  = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const USDC_DECIMALS = 6
const DEPOSIT_POLL_MS = 60_000

const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
)

const _rpcRaw = process.env.BASE_RPC_URL ?? 'sepolia.base.org'
const rpcUrl = _rpcRaw.startsWith('http') ? _rpcRaw : `https://${_rpcRaw}`

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
})

// ─── 热钱包（归集 + 提现出账）────────────────────────────────────

const HOT_WALLET_PRIV = derivePrivKey('platform-hot-wallet')
const HOT_WALLET_ADDR = privateKeyToAddress(HOT_WALLET_PRIV)

const hotWalletClient = createWalletClient({
  account: privateKeyToAccount(HOT_WALLET_PRIV),
  chain: baseSepolia,
  transport: http(rpcUrl),
})

// ─── 归集：充值地址 → 热钱包 ────────────────────────────────────

async function sweepToHotWallet(userId: string, depositAddress: string) {
  // 检查链上 USDC 余额
  const onChain = await publicClient.readContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [depositAddress as `0x${string}`],
  }) as bigint
  if (onChain === 0n) return

  // 热钱包先打一点 ETH 给充值地址支付 Gas
  const ethHash = await hotWalletClient.sendTransaction({
    to: depositAddress as `0x${string}`,
    value: parseEther('0.0005'),
  })
  await publicClient.waitForTransactionReceipt({ hash: ethHash })

  // 充值地址把 USDC 转给热钱包
  const depClient = createWalletClient({
    account: privateKeyToAccount(derivePrivKey(userId)),
    chain: baseSepolia,
    transport: http(rpcUrl),
  })
  const usdcHash = await depClient.writeContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'transfer',
    args: [HOT_WALLET_ADDR, onChain],
  })
  await publicClient.waitForTransactionReceipt({ hash: usdcHash })

  db.prepare('UPDATE deposit_txns SET swept = 1 WHERE user_id = ? AND swept = 0').run(userId)
  console.log(`🔄 归集：${Number(onChain) / 1e6} USDC → 热钱包 (${usdcHash.slice(0, 10)}...)`)
}

// ─── 提现执行：热钱包 → 用户地址 ────────────────────────────────

async function executeWithdrawal(requestId: string): Promise<{ success: boolean; error?: string; txHash?: string }> {
  const req = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending'")
    .get(requestId) as Record<string, unknown> | undefined
  if (!req) return { success: false, error: '申请不存在或已处理' }

  const amountRaw = BigInt(Math.round((req.amount as number) * 10 ** USDC_DECIMALS))

  const hotBalance = await publicClient.readContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'balanceOf', args: [HOT_WALLET_ADDR],
  }) as bigint

  if (hotBalance < amountRaw) {
    return { success: false, error: `热钱包余额不足（需 ${req.amount} USDC，现有 ${Number(hotBalance) / 1e6} USDC）` }
  }

  const txHash = await hotWalletClient.writeContract({
    address: USDC_SEPOLIA, abi: USDC_ABI,
    functionName: 'transfer',
    args: [req.to_address as `0x${string}`, amountRaw],
  })
  await publicClient.waitForTransactionReceipt({ hash: txHash })

  db.prepare("UPDATE withdrawal_requests SET status='processed', tx_hash=?, processed_at=datetime('now') WHERE id=?")
    .run(txHash, requestId)
  console.log(`💸 提现完成：${req.amount} USDC → ${(req.to_address as string).slice(0, 10)}... (${txHash.slice(0, 10)}...)`)
  return { success: true, txHash }
}

// ─── 充值监听 ─────────────────────────────────────────────────

async function checkDeposits() {
  const rows = db.prepare(
    'SELECT user_id, deposit_address FROM wallets WHERE deposit_address IS NOT NULL'
  ).all() as { user_id: string; deposit_address: string }[]
  if (rows.length === 0) return

  const addrToUser = new Map(rows.map(r => [r.deposit_address.toLowerCase(), r.user_id]))

  const latestBlock = await publicClient.getBlockNumber()
  const savedRow = db.prepare("SELECT value FROM system_state WHERE key = 'last_deposit_block'").get() as { value: string } | undefined
  const fromBlock = savedRow ? BigInt(savedRow.value) + 1n : latestBlock - 50n
  if (fromBlock > latestBlock) return

  const logs = await publicClient.getLogs({
    address: USDC_SEPOLIA,
    event: transferEvent,
    args: { to: rows.map(r => r.deposit_address as `0x${string}`) },
    fromBlock,
    toBlock: latestBlock,
  })

  for (const log of logs as (Log & { args: { to: string; value: bigint }; transactionHash: string; blockNumber: bigint })[]) {
    const txHash  = log.transactionHash
    const toAddr  = log.args.to?.toLowerCase()
    const userId  = addrToUser.get(toAddr)
    if (!userId) continue

    if (db.prepare('SELECT 1 FROM deposit_txns WHERE tx_hash = ?').get(txHash)) continue

    const amount = Number(log.args.value) / 10 ** USDC_DECIMALS
    db.prepare('INSERT INTO deposit_txns (tx_hash, user_id, amount, block_number) VALUES (?,?,?,?)')
      .run(txHash, userId, amount, Number(log.blockNumber))
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, userId)

    const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined)?.name ?? userId
    console.log(`💰 充值到账：${name} +${amount} WAZ  (${txHash.slice(0, 10)}...)`)

    // 异步归集，不阻塞充值到账
    sweepToHotWallet(userId, toAddr!).catch(e =>
      console.error(`归集失败 (${userId}):`, e.message)
    )
  }

  db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('last_deposit_block', ?)")
    .run(latestBlock.toString())
}

function startDepositWatcher() {
  checkDeposits().catch(e => console.error('充值扫描出错：', e.message))
  setInterval(() => {
    checkDeposits().catch(e => console.error('充值扫描出错：', e.message))
  }, DEPOSIT_POLL_MS)
  console.log(`⛓  充值监听已启动（Base Sepolia，每 ${DEPOSIT_POLL_MS / 1000}s 扫描）`)
  console.log(`🏦 热钱包地址：${HOT_WALLET_ADDR}`)
}

// ─── 启动 ─────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000
app.listen(PORT, () => {
  console.log(`✅ WebAZ 已启动：http://localhost:${PORT}`)
  console.log(`   手机访问：http://<本机IP>:${PORT}`)

  // 启动时立即扫描一次，之后每 5 分钟执行
  runEnforcement()
  setInterval(runEnforcement, ENFORCE_INTERVAL_MS)
  console.log(`⚡ 自动执法已启动（每 ${ENFORCE_INTERVAL_MS / 60000} 分钟扫描）`)

  // 链上充值监听
  startDepositWatcher()
})
