/**
 * PWA HTTP Server
 * 把 DCP 协议暴露给手机浏览器
 * 端口：3000
 */

import express, { Request, Response, NextFunction } from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { initDatabase, generateId } from '../layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, transition, getOrderStatus } from '../layer0-foundation/L0-2-state-machine/engine.js'
import { initDisputeSchema, createDispute, respondToDispute, arbitrateDispute, getOrderDispute } from '../layer3-trust/L3-1-dispute-engine/dispute-engine.js'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = initDatabase()
initSystemUser(db)
initDisputeSchema(db)
initNotificationSchema(db)
initSkillSchema(db)

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
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(id, name.trim(), role, apiKey)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,1000)').run(id)

  res.json({ success: true, api_key: apiKey, user_id: id, name: name.trim(), role })
})

// 当前用户信息
app.get('/api/me', (req, res) => {
  const user = auth(req, res); if (!user) return
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id) as Record<string, number>
  res.json({ ...user, api_key: undefined, wallet })
})

// 搜索商品
app.get('/api/products', (req, res) => {
  const { q = '', category, max_price } = req.query
  let sql = `SELECT p.*, u.name as seller_name FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.status = 'active' AND p.stock > 0`
  const params: unknown[] = []
  if (q) { sql += ` AND (p.title LIKE ? OR p.description LIKE ?)`; params.push(`%${q}%`, `%${q}%`) }
  if (category) { sql += ` AND p.category = ?`; params.push(category) }
  if (max_price) { sql += ` AND p.price <= ?`; params.push(Number(max_price)) }
  sql += ` ORDER BY p.created_at DESC LIMIT 30`
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
  const stakeAmount = Math.round(priceNum * 0.15 * 100) / 100
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }

  if (wallet.balance < stakeAmount) {
    return void res.json({ error: `余额不足：上架需质押 ${stakeAmount} DCP，当前余额 ${wallet.balance} DCP` })
  }

  const id = generateId('prd')
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, category, stake_amount)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, user.id, title, description, priceNum, stock, category, stakeAmount)
  db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`)
    .run(stakeAmount, stakeAmount, user.id)

  res.json({ success: true, product_id: id, stake_locked: stakeAmount })
})

// 我的订单（买家或卖家视角）
app.get('/api/orders', (req, res) => {
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
  if (order.buyer_id !== user.id && order.seller_id !== user.id && order.logistics_id !== user.id && user.role !== 'arbitrator') {
    return void res.status(403).json({ error: '无权查看此订单' })
  }

  const product = db.prepare('SELECT title, price, images FROM products WHERE id = ?').get(order.product_id as string)
  const dispute = getOrderDispute(db, req.params.id)

  res.json({ ...statusInfo, product, dispute })
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
  if (wallet.balance < totalAmount) return void res.json({ error: `余额不足：需 ${totalAmount} DCP，当前 ${wallet.balance} DCP` })

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

// 更新订单状态（接单/发货/揽收/投递/确认/争议）
app.post('/api/orders/:id/action', (req, res) => {
  const user = auth(req, res); if (!user) return
  const { action, notes = '', evidence_description = '' } = req.body

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!order) return void res.status(404).json({ error: '订单不存在' })

  // 物流首次操作绑定 logistics_id
  if (['pickup', 'transit'].includes(action) && !order.logistics_id && user.role === 'logistics') {
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
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id)
  res.json(wallet)
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

// ─── 静态文件 + SPA 回退（必须在所有 API 路由之后）────────────
app.use(express.static(path.join(__dirname, 'public')))

app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ─── 启动 ─────────────────────────────────────────────────────

const PORT = 3000
app.listen(PORT, () => {
  console.log(`✅ DCP PWA 已启动：http://localhost:${PORT}`)
  console.log(`   手机访问：http://<本机IP>:${PORT}`)
})
