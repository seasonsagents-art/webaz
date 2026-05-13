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
import { createHmac, createHash } from 'node:crypto'

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

// ─── 验证员白名单表 ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_whitelist (
    user_id   TEXT PRIMARY KEY,
    added_at  TEXT DEFAULT (datetime('now')),
    note      TEXT
  )
`)

// ─── 内部审核账号（固定 ID，密钥由 MASTER_SEED 派生，幂等）────────
const INTERNAL_AUDITOR_ID  = 'usr_iaudit_001'
const INTERNAL_AUDITOR_KEY = 'key_iaudit_' + createHmac('sha256', MASTER_SEED).update('internal_auditor_v1').digest('hex').slice(0, 32)
;(() => {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(INTERNAL_AUDITOR_ID)
  if (!existing) {
    const wid = 'wal_iaudit_001'
    db.prepare('INSERT INTO users (id, name, role, roles, api_key) VALUES (?,?,?,?,?)')
      .run(INTERNAL_AUDITOR_ID, '内部审核员', 'buyer', JSON.stringify(['buyer']), INTERNAL_AUDITOR_KEY)
    db.prepare('INSERT OR IGNORE INTO wallets (id, user_id, balance) VALUES (?,?,0)').run(wid, INTERNAL_AUDITOR_ID)
    console.log(`[WebAZ] 内部审核账号已创建，API Key: ${INTERNAL_AUDITOR_KEY}`)
  }
  db.prepare('INSERT OR IGNORE INTO verifier_whitelist (user_id, note) VALUES (?,?)').run(INTERNAL_AUDITOR_ID, '内部审核员')
})()

// ─── Schema 迁移（幂等）──────────────────────────────────────────
try { db.exec('ALTER TABLE wallets ADD COLUMN deposit_address TEXT') } catch {}

const NEW_PRODUCT_COLS = [
  'ALTER TABLE products ADD COLUMN specs TEXT',
  'ALTER TABLE products ADD COLUMN brand TEXT',
  'ALTER TABLE products ADD COLUMN model TEXT',
  'ALTER TABLE products ADD COLUMN source_url TEXT',
  'ALTER TABLE products ADD COLUMN source_price REAL',
  'ALTER TABLE products ADD COLUMN source_price_at TEXT',
  'ALTER TABLE products ADD COLUMN weight_kg REAL',
  'ALTER TABLE products ADD COLUMN ship_regions TEXT DEFAULT "全国"',
  'ALTER TABLE products ADD COLUMN excluded_regions TEXT',
  'ALTER TABLE products ADD COLUMN handling_hours INTEGER DEFAULT 24',
  'ALTER TABLE products ADD COLUMN estimated_days TEXT',
  'ALTER TABLE products ADD COLUMN fragile INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN return_days INTEGER DEFAULT 7',
  'ALTER TABLE products ADD COLUMN return_condition TEXT',
  'ALTER TABLE products ADD COLUMN warranty_days INTEGER DEFAULT 0',
  'ALTER TABLE products ADD COLUMN commitment_hash TEXT',
  'ALTER TABLE products ADD COLUMN description_hash TEXT',
  'ALTER TABLE products ADD COLUMN price_hash TEXT',
  'ALTER TABLE products ADD COLUMN hashed_at TEXT',
  'ALTER TABLE products ADD COLUMN updated_at TEXT',
]
for (const sql of NEW_PRODUCT_COLS) { try { db.exec(sql) } catch {} }

// ─── 商品信息 hash（防篡改）──────────────────────────────────────
function md5(data: string) { return createHash('md5').update(data).digest('hex') }

function makeCommitmentHash(p: Record<string, unknown>) {
  return md5(JSON.stringify({
    ship_regions:    p.ship_regions    ?? '全国',
    handling_hours:  p.handling_hours  ?? 24,
    estimated_days:  p.estimated_days  ?? null,
    return_days:     p.return_days     ?? 7,
    return_condition:p.return_condition ?? '',
    warranty_days:   p.warranty_days   ?? 0,
  }))
}
function makeDescriptionHash(p: Record<string, unknown>) {
  return md5(JSON.stringify({ title: p.title, description: p.description, specs: p.specs ?? null }))
}
function makePriceHash(price: number, ts: string) {
  return md5(JSON.stringify({ price, created_at: ts }))
}
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
db.exec(`
  CREATE TABLE IF NOT EXISTS price_sessions (
    token      TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    price      REAL NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS product_external_links (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    source      TEXT DEFAULT 'manual',
    verified    INTEGER DEFAULT 0,
    verify_note TEXT,
    added_at    TEXT DEFAULT (datetime('now')),
    verified_at TEXT,
    UNIQUE(product_id, url)
  )
`)
try { db.exec('ALTER TABLE product_external_links ADD COLUMN revoked INTEGER DEFAULT 0') } catch {}
// link_challenges 保留用于向后兼容，新流程用 verify_tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS link_challenges (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    code        TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    verified_at TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS verify_tasks (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL DEFAULT 'code_check',
    product_id          TEXT NOT NULL,
    url                 TEXT NOT NULL,
    code                TEXT,
    verifiers_needed    INTEGER NOT NULL DEFAULT 3,
    reward_per_verifier REAL NOT NULL DEFAULT 0.1,
    fee_locked          REAL NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'open',
    result              TEXT,
    created_at          TEXT DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    settled_at          TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS verify_submissions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    verifier_id  TEXT NOT NULL,
    submission   TEXT,
    verdict      TEXT,
    claimed_at   TEXT DEFAULT (datetime('now')),
    submitted_at TEXT,
    UNIQUE(task_id, verifier_id)
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS verifier_stats (
    user_id       TEXT PRIMARY KEY,
    verify_rights INTEGER NOT NULL DEFAULT 3,
    tasks_done    INTEGER NOT NULL DEFAULT 0,
    tasks_correct INTEGER NOT NULL DEFAULT 0,
    tasks_wrong   INTEGER NOT NULL DEFAULT 0,
    suspended_until TEXT
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
// 构建 agent_summary：一句话决策摘要
function buildAgentSummary(p: Record<string, unknown>): string {
  const parts: string[] = []
  if (p.brand)         parts.push(String(p.brand))
  if (p.model)         parts.push(String(p.model))
  const returnDays = p.return_days != null ? Number(p.return_days) : null
  if (returnDays != null && returnDays > 0) parts.push(`${returnDays}天退货`)
  else if (returnDays === 0)               parts.push('不支持退货')
  const warranty = p.warranty_days != null ? Number(p.warranty_days) : null
  if (warranty && warranty > 0)            parts.push(`${warranty}天质保`)
  const handling = p.handling_hours != null ? Number(p.handling_hours) : null
  if (handling != null)                    parts.push(`${handling}h发货`)
  const est = p.estimated_days
  if (est) {
    const estParsed = typeof est === 'string' ? (() => { try { return JSON.parse(est) } catch { return est } })() : est
    if (typeof estParsed === 'object' && estParsed !== null) {
      const vals = Object.values(estParsed as Record<string, unknown>).map(Number).filter(n => !isNaN(n))
      if (vals.length) parts.push(`全国${Math.min(...vals)}-${Math.max(...vals)}天`)
    } else if (typeof estParsed === 'number') {
      parts.push(`全国约${estParsed}天`)
    } else {
      parts.push(`时效:${String(estParsed)}`)
    }
  }
  if (p.ship_regions && p.ship_regions !== '全国') parts.push(`发货:${p.ship_regions}`)
  if (p.fragile) parts.push('易碎品')
  return parts.join('，') || '暂无物流信息'
}

// 格式化商品行为 agent 友好结构
function formatProductForAgent(p: Record<string, unknown>): Record<string, unknown> {
  const specsRaw = p.specs
  let specs: Record<string, string> | null = null
  if (specsRaw) {
    try { specs = JSON.parse(specsRaw as string) } catch { specs = null }
  }
  const estRaw = p.estimated_days
  let estimated_days: Record<string, number> | number | null = null
  if (estRaw) {
    try { estimated_days = JSON.parse(estRaw as string) } catch { estimated_days = null }
  }
  return {
    ...p,
    specs,
    estimated_days,
    agent_summary: buildAgentSummary(p),
  }
}

app.get('/api/products', (req, res) => {
  const { q = '', category, max_price, min_return_days, max_handling_hours } = req.query
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
  if (min_return_days) { sql += ` AND p.return_days >= ?`; params.push(Number(min_return_days)) }
  if (max_handling_hours) { sql += ` AND p.handling_hours <= ?`; params.push(Number(max_handling_hours)) }
  sql += ` ORDER BY rep_points DESC, p.created_at DESC LIMIT 30`
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  res.json(rows.map(formatProductForAgent))
})

// 单品详情（agent verify price 时使用）
app.get('/api/products/:id', (req, res) => {
  // 卖家可查看自己的非上架商品（编辑页用），其他人只能看 active
  const token = ((req.headers.authorization as string) || '').replace('Bearer ', '')
  const selfUser = token ? db.prepare('SELECT id FROM users WHERE api_key = ?').get(token) as { id: string } | undefined : undefined
  const row = db.prepare(`
    SELECT p.*, u.name as seller_name,
      COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
    FROM products p
    JOIN users u ON p.seller_id = u.id
    LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
    WHERE p.id = ? AND (p.status = 'active' OR p.seller_id = ?)
  `).get(req.params.id, selfUser?.id ?? '') as Record<string, unknown> | undefined
  if (!row) return void res.status(404).json({ error: 'not_found' })
  res.json(formatProductForAgent(row))
})

// 卖家：我的商品
app.get('/api/my-products', (req, res) => {
  const user = auth(req, res); if (!user) return
  const products = db.prepare(`
    SELECT p.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM verify_tasks WHERE product_id=p.id AND status IN ('code_issued','open')
      ) THEN 1 ELSE 0 END as has_pending_task,
      CASE WHEN EXISTS (SELECT 1 FROM product_external_links WHERE product_id=p.id AND revoked=1)
        AND NOT EXISTS (SELECT 1 FROM product_external_links WHERE product_id=p.id AND verified=1 AND (revoked IS NULL OR revoked=0))
      THEN 1 ELSE 0 END as all_links_revoked
    FROM products p WHERE p.seller_id = ? ORDER BY p.created_at DESC
  `).all(user.id)
  res.json(products)
})

// 卖家：上架商品
app.post('/api/products', (req, res) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'seller') return void res.json({ error: '仅卖家可上架商品' })

  const {
    title, description, price, stock = 1, category = '',
    specs, brand, model, source_url, source_price,
    weight_kg, ship_regions = '全国', handling_hours = 24,
    estimated_days, fragile = 0,
    return_days = 7, return_condition = '', warranty_days = 0,
  } = req.body
  if (!title || !description || !price) return void res.json({ error: '请填写商品名、描述、价格' })

  // ── 上架前检查：同一卖家不能重复关联相同外部链接 ──────────────
  if (source_url) {
    const sameSellerDupe = db.prepare(`
      SELECT COUNT(*) as n FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND p.seller_id = ?
    `).get(source_url, user.id) as { n: number }
    if (sameSellerDupe.n > 0) {
      return void res.json({ error: '您已上架过来自此链接的商品，不能重复关联相同外部链接' })
    }
  }

  const priceNum = Number(price)
  const stakeDiscount = getStakeDiscount(db, user.id as string)
  const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)
  const stakeAmount = Math.round(priceNum * stakeRate * 100) / 100
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  if (wallet.balance < stakeAmount) {
    return void res.json({ error: `余额不足：上架需质押 ${stakeAmount} WAZ，当前余额 ${wallet.balance} WAZ` })
  }

  const now = new Date().toISOString()
  const id = generateId('prd')
  const specsJson = specs ? (typeof specs === 'string' ? specs : JSON.stringify(specs)) : null
  const estJson   = estimated_days ? (typeof estimated_days === 'string' ? estimated_days : JSON.stringify(estimated_days)) : null
  const pFields   = { ship_regions, handling_hours, estimated_days: estJson, return_days, return_condition, warranty_days }

  db.prepare(`INSERT INTO products (
    id, seller_id, title, description, price, stock, category, stake_amount,
    specs, brand, model, source_url, source_price, source_price_at,
    weight_kg, ship_regions, handling_hours, estimated_days, fragile,
    return_days, return_condition, warranty_days,
    commitment_hash, description_hash, price_hash, hashed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, user.id, title, description, priceNum, Number(stock), category, stakeAmount,
    specsJson, brand ?? null, model ?? null,
    source_url ?? null, source_price ? Number(source_price) : null, source_price ? now : null,
    weight_kg ? Number(weight_kg) : null, ship_regions, Number(handling_hours), estJson, fragile ? 1 : 0,
    Number(return_days), return_condition, Number(warranty_days),
    makeCommitmentHash(pFields), makeDescriptionHash({ title, description, specs: specsJson }),
    makePriceHash(priceNum, now), now
  )
  db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`)
    .run(stakeAmount, stakeAmount, user.id)

  // ── 来源链接：冲突检测 ────────────────────────────────────────
  let linkConflict: { task_id?: string; code?: string; expires_at?: string; message: string } | null = null
  if (source_url) {
    // 另一家卖家已认领此链接（verified=1）
    const otherClaim = db.prepare(`
      SELECT pel.product_id FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
    `).get(source_url, user.id) as { product_id: string } | undefined

    if (otherClaim) {
      // 插入为未验证状态
      db.prepare(`INSERT OR IGNORE INTO product_external_links (id, product_id, url, source, verified, verify_note)
        VALUES (?, ?, ?, 'import', 0, '链接冲突：等待众包验证确认归属')`).run(generateId('lnk'), id, source_url)

      // 创建认领验证任务（扣锁定费）
      const VERIFIERS_NEEDED = 1
      const REWARD_EACH      = 0.1
      const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
      // 重新读钱包（已扣质押）
      const walletNow = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
      const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      const code    = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
      const taskId  = generateId('vtk')
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()
      const baseMsg = `此商品来源链接已被其他商家认领。请将验证码 [${code}] 放入该平台商品标题或描述，等待人工审核确认后归属自动转移。`

      if (walletNow.balance >= feeLocked) {
        try {
          db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
            VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`).run(taskId, 'code_check', id, source_url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)
          db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ?`).run(feeLocked, user.id)
          linkConflict = { task_id: taskId, code: `[${code}]`, expires_at: expiresAt, message: baseMsg }
        } catch {
          linkConflict = { message: `${baseMsg}（余额不足以锁定验证费 ${feeLocked} WAZ，请前往商品外部链接手动发起验证）` }
        }
      } else {
        linkConflict = { message: `${baseMsg}（当前余额不足以锁定验证费 ${feeLocked} WAZ，请充值后前往商品编辑页手动发起验证）` }
      }
      // 有冲突：商品进入仓库，等待验证结果后再上架
      db.prepare(`UPDATE products SET status='warehouse', updated_at=datetime('now') WHERE id=?`).run(id)
    } else {
      // 无冲突 — 直接标记 verified=1
      db.prepare(`INSERT OR IGNORE INTO product_external_links (id, product_id, url, source, verified, verified_at)
        VALUES (?, ?, ?, 'import', 1, datetime('now'))`).run(generateId('lnk'), id, source_url)
    }
  }

  // 额外链接：同步冲突检查，无冲突直接关联 verified=1，已被他人认领则跳过并返回 blocked_links
  const additionalLinks = req.body.additional_links
  const blockedLinks: { url: string; message: string }[] = []
  if (Array.isArray(additionalLinks) && additionalLinks.length > 0) {
    for (const extraUrl of additionalLinks.slice(0, 5)) {
      if (typeof extraUrl !== 'string' || !extraUrl.startsWith('http')) continue
      const alreadyLinked = db.prepare('SELECT id FROM product_external_links WHERE product_id = ? AND url = ?').get(id, extraUrl)
      if (alreadyLinked) continue
      // 同卖家已在其他商品关联过此链接
      const selfConflict = db.prepare(`
        SELECT p.title FROM product_external_links pel
        JOIN products p ON pel.product_id = p.id
        WHERE pel.url = ? AND p.seller_id = ? AND p.id != ?
      `).get(extraUrl, user.id, id) as { title: string } | undefined
      if (selfConflict) {
        blockedLinks.push({ url: extraUrl, message: `您已在商品「${selfConflict.title}」中关联了此链接` })
        continue
      }
      // 他人已认领（verified=1）
      const otherConflict = db.prepare(`
        SELECT p.title FROM product_external_links pel
        JOIN products p ON pel.product_id = p.id
        WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
      `).get(extraUrl, user.id) as { title: string } | undefined
      if (otherConflict) {
        blockedLinks.push({ url: extraUrl, message: `此链接已被其他商家认领，上架后可在商品编辑页发起验证任务` })
        continue
      }
      // 无冲突 — 直接关联 verified=1
      try {
        db.prepare(`INSERT OR IGNORE INTO product_external_links (id, product_id, url, source, verified, verified_at)
          VALUES (?, ?, ?, 'import_extra', 1, datetime('now'))`).run(generateId('lnk'), id, extraUrl)
      } catch {}
    }
  }

  res.json({
    success: true,
    product_id: id,
    stake_locked: stakeAmount,
    ...(linkConflict ? { link_conflict: linkConflict } : {}),
    ...(blockedLinks.length > 0 ? { blocked_links: blockedLinks } : {}),
  })
})

// 链接认领状态查询（上架前检查，无需商品 ID）
app.get('/api/check-url', (req, res) => {
  const user = auth(req, res); if (!user) return
  const url = req.query.url as string
  if (!url) return void res.json({ error: '请提供 url 参数' })

  // 同卖家已有此链接
  const selfClaim = db.prepare(`
    SELECT p.id as product_id, p.title FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND p.seller_id = ?
  `).get(url, user.id) as { product_id: string; title: string } | undefined
  if (selfClaim) {
    return void res.json({ claimed: true, self: true, product_title: selfClaim.title, message: `您已在商品「${selfClaim.title}」中关联了此链接` })
  }

  // 他人已认领（verified=1）
  const otherClaim = db.prepare(`
    SELECT p.title as product_title FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
  `).get(url, user.id) as { product_title: string } | undefined
  if (otherClaim) {
    return void res.json({ claimed: true, self: false, message: `此链接已被其他商家认领，不能直接添加，上架后请在商品编辑页发起认领验证任务` })
  }

  res.json({ claimed: false })
})

// 商品外部链接：查询
app.get('/api/products/:id/links', (req, res) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(req.params.id) as { seller_id: string } | undefined
  if (!product) return void res.status(404).json({ error: '商品不存在' })
  if (product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
  const links = db.prepare(`SELECT id, url, source, verified, revoked, verify_note, added_at FROM product_external_links WHERE product_id = ? ORDER BY added_at ASC`).all(req.params.id)
  res.json(links)
})

// 商品外部链接：手动添加
// 规则：新链接（无人认领）直接关联 verified=1；已被他人认领则发起众包验证任务
app.post('/api/products/:id/links', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(req.params.id, user.id) as Record<string, unknown> | undefined
  if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })

  const { url } = req.body
  if (!url || !url.startsWith('http')) return void res.json({ error: '请提供有效链接' })

  // 已关联此商品
  const existing = db.prepare('SELECT id, verified, revoked FROM product_external_links WHERE product_id = ? AND url = ?')
    .get(req.params.id as string, url) as { id: string; verified: number; revoked: number } | undefined
  if (existing) {
    // 主权失效的旧记录：删除后允许重新发起认领申诉
    if (existing.revoked) {
      db.prepare('DELETE FROM product_external_links WHERE id = ?').run(existing.id)
    } else {
      return void res.json({ error: '该链接已关联到此商品' })
    }
  }

  // 同卖家的其他商品已关联此链接
  const sameSellerOther = db.prepare(`
    SELECT p.title FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND p.seller_id = ? AND pel.product_id != ?
  `).get(url, user.id, req.params.id as string) as { title: string } | undefined
  if (sameSellerOther) {
    return void res.json({ error: `此链接已在您的商品「${sameSellerOther.title}」中关联，一个链接不能关联多个商品` })
  }

  // 检查是否已被其他卖家认领（verified=1）
  const otherClaim = db.prepare(`
    SELECT p.title as product_title FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
  `).get(url, user.id) as { product_title: string } | undefined

  if (!otherClaim) {
    // ── 新链接，无冲突：直接关联 verified=1 ──────────────────────
    const linkId = generateId('lnk')
    db.prepare(`INSERT INTO product_external_links (id, product_id, url, source, verified, verified_at)
      VALUES (?, ?, ?, 'manual', 1, datetime('now'))`).run(linkId, req.params.id, url)
    return void res.json({ link_id: linkId, verified: 1, message: '链接已关联' })
  }

  // ── 已被他人认领：发起众包验证任务 ───────────────────────────
  // 已有进行中的验证任务（本商品+此链接）则直接返回
  const existingTask = db.prepare(`SELECT id, code, status, expires_at FROM verify_tasks WHERE product_id = ? AND url = ? AND status IN ('code_issued','open')`)
    .get(req.params.id as string, url) as { id: string; code: string; status: string; expires_at: string } | undefined
  if (existingTask) {
    const isPending = existingTask.status === 'code_issued'
    return void res.json({
      task_id: existingTask.id,
      code: `[${existingTask.code}]`,
      status: existingTask.status,
      expires_at: existingTask.expires_at,
      already_pending: true,
      conflict: true,
      instructions: isPending
        ? `此链接已有认领任务，请将验证码 [${existingTask.code}] 放入原平台商品标题或描述，完成后回来点击「确认已添加」提交任务。`
        : `此链接已有进行中的认领任务，等待验证者确认。`,
    })
  }

  const VERIFIERS_NEEDED = 1
  const REWARD_EACH      = 0.1
  const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  if (wallet.balance < feeLocked) {
    return void res.json({ error: `余额不足：认领验证需锁定 ${feeLocked} WAZ，当前余额 ${wallet.balance} WAZ` })
  }

  const chars     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const code      = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  const linkId    = generateId('lnk')
  const taskId    = generateId('vtk')
  const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()

  db.prepare(`INSERT INTO product_external_links (id, product_id, url, source, verified, verify_note)
    VALUES (?, ?, ?, 'manual', 0, '认领验证进行中')`).run(linkId, req.params.id, url)

  db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
    VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`).run(taskId, 'claim', req.params.id, url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)

  db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ?`).run(feeLocked, user.id)

  res.json({
    link_id:  linkId,
    task_id:  taskId,
    verified: 0,
    conflict: true,
    code:     `[${code}]`,
    instructions: `此链接已被其他商家的商品「${otherClaim.product_title}」认领。请将验证码 [${code}] 放入该平台商品标题或描述，完成后在商品编辑页点击「确认已添加」提交验证任务，经审核确认后，链接归属将转移到您的商品。`,
    expires_at: expiresAt,
  })
})

// 商品外部链接：删除
app.delete('/api/products/:id/links/:linkId', (req, res) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(req.params.id) as { seller_id: string } | undefined
  if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
  db.prepare('DELETE FROM product_external_links WHERE id = ? AND product_id = ?').run(req.params.linkId, req.params.id)
  res.json({ success: true })
})

// ─── 众包验证任务引擎 ─────────────────────────────────────────

function getVerifierStats(userId: string) {
  let stats = db.prepare('SELECT * FROM verifier_stats WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined
  if (!stats) {
    db.prepare('INSERT OR IGNORE INTO verifier_stats (user_id) VALUES (?)').run(userId)
    stats = db.prepare('SELECT * FROM verifier_stats WHERE user_id = ?').get(userId) as Record<string, unknown>
  }
  return stats
}

function isEligibleVerifier(userId: string, taskId: string): { ok: boolean; reason?: string } {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!task) return { ok: false, reason: '任务不存在' }

  // 必须在白名单
  const onWhitelist = db.prepare('SELECT user_id FROM verifier_whitelist WHERE user_id = ?').get(userId)
  if (!onWhitelist) return { ok: false, reason: '不在验证员白名单' }

  // 不能是任务发布者（商品卖家）
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(task.product_id as string) as { seller_id: string } | undefined
  if (product?.seller_id === userId) return { ok: false, reason: '不能验证自己的商品链接' }

  // 未已领取
  const existing = db.prepare('SELECT id FROM verify_submissions WHERE task_id = ? AND verifier_id = ?').get(taskId, userId)
  if (existing) return { ok: false, reason: '已领取此任务' }

  return { ok: true }
}

function assignVerifiers(taskId: string) {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined
  if (!task || task.status !== 'open') return

  const needed = (task.verifiers_needed as number)
  const alreadyAssigned = (db.prepare('SELECT COUNT(*) as n FROM verify_submissions WHERE task_id = ?').get(taskId) as { n: number }).n
  const toAssign = needed - alreadyAssigned
  if (toAssign <= 0) return

  // 仅从白名单用户中分配（排除商品卖家）
  const pool = db.prepare(`
    SELECT vw.user_id FROM verifier_whitelist vw
    WHERE vw.user_id != (SELECT seller_id FROM products WHERE id = ?)
    ORDER BY RANDOM()
  `).all(task.product_id as string) as { user_id: string }[]

  let assigned = 0
  for (const { user_id: uid } of pool) {
    if (assigned >= toAssign) break
    const check = isEligibleVerifier(uid, taskId)
    if (!check.ok) continue
    db.prepare(`INSERT OR IGNORE INTO verify_submissions (id, task_id, verifier_id) VALUES (?,?,?)`)
      .run(generateId('vsb'), taskId, uid)
    assigned++
  }
}

function settleTask(taskId: string) {
  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ?').get(taskId) as Record<string, unknown>
  const subs = db.prepare(`SELECT * FROM verify_submissions WHERE task_id = ? AND submitted_at IS NOT NULL`).all(taskId) as Record<string, unknown>[]
  if (subs.length < (task.verifiers_needed as number)) return  // 未满足

  // 统计提交内容（忽略空白/null）
  const freq: Record<string, number> = {}
  for (const s of subs) {
    const v = ((s.submission as string) ?? '').trim().toUpperCase()
    if (v) freq[v] = (freq[v] ?? 0) + 1
  }

  // 找多数票（超过半数）
  const majority = Object.entries(freq).find(([, n]) => n > subs.length / 2)
  const expectedCode = (task.code as string).toUpperCase()
  const passed = majority && majority[0] === expectedCode

  const result = passed ? 'verified' : 'failed'
  db.prepare(`UPDATE verify_tasks SET status='settled', result=?, settled_at=datetime('now') WHERE id=?`).run(result, taskId)

  // 分发奖励 / 扣验证权
  const rewardEach = task.reward_per_verifier as number
  const feeLocked  = task.fee_locked as number

  if (passed) {
    // 通过：全额发给多数验证者，少数验证权-2
    for (const s of subs) {
      const vid = s.verifier_id as string
      const sub = ((s.submission as string) ?? '').trim().toUpperCase()
      const isCorrect = sub === expectedCode
      if (isCorrect) {
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(rewardEach, vid)
        db.prepare(`UPDATE verify_submissions SET verdict='correct' WHERE id=?`).run(s.id)
        db.prepare(`UPDATE verifier_stats SET verify_rights = verify_rights + 1, tasks_done = tasks_done + 1, tasks_correct = tasks_correct + 1 WHERE user_id = ?`).run(vid)
      } else {
        db.prepare(`UPDATE verify_submissions SET verdict='wrong' WHERE id=?`).run(s.id)
        db.prepare(`UPDATE verifier_stats SET verify_rights = verify_rights - 2, tasks_done = tasks_done + 1, tasks_wrong = tasks_wrong + 1 WHERE user_id = ?`).run(vid)
        // 验证权低于 -3 则暂停7天
        const stats = getVerifierStats(vid)
        if ((stats.verify_rights as number) < -3) {
          const until = new Date(Date.now() + 7 * 86400_000).toISOString()
          db.prepare(`UPDATE verifier_stats SET suspended_until = ? WHERE user_id = ?`).run(until, vid)
        }
      }
    }
    // 更新挑战者链接为已验证，商品自动上架
    db.prepare(`UPDATE product_external_links SET verified=1, revoked=0, verify_note='众包验证通过', verified_at=datetime('now') WHERE product_id=? AND url=?`)
      .run(task.product_id, task.url)
    db.prepare(`UPDATE products SET status='active', updated_at=datetime('now') WHERE id=? AND status='warehouse'`)
      .run(task.product_id)

    // 原持有者链接标记为「主权失效」，并检查是否需要强制下架
    const originalOwners = db.prepare(`
      SELECT p.id as product_id, p.seller_id FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url=? AND pel.product_id != ? AND pel.verified=1
    `).all(task.url, task.product_id) as { product_id: string; seller_id: string }[]

    db.prepare(`
      UPDATE product_external_links SET revoked=1, verified=0, verify_note='主权失效'
      WHERE url=? AND product_id != ? AND verified=1
    `).run(task.url, task.product_id)

    for (const orig of originalOwners) {
      const hasValidLink = db.prepare(`
        SELECT id FROM product_external_links WHERE product_id=? AND verified=1 AND (revoked IS NULL OR revoked=0)
      `).get(orig.product_id)
      if (!hasValidLink) {
        db.prepare(`UPDATE products SET status='warehouse', updated_at=datetime('now') WHERE id=? AND status='active'`)
          .run(orig.product_id)
        // 写入系统通知（降级处理，失败不影响主流程）
        try {
          db.prepare(`INSERT INTO notifications (id, user_id, type, entity_type, entity_id, message, created_at)
            VALUES (?,?,'link_revoked','product',?,?,datetime('now'))`)
            .run(generateId('ntf'), orig.seller_id, orig.product_id,
              `您的商品因链接「${task.url as string}」主权失效已被自动下架至仓库，如需重新上架请更换链接或重新发起认领验证。`)
        } catch {}
      }
    }
  } else {
    // 失败：50% 发给参与验证者（补偿时间），50% 销毁
    const compensateTotal = feeLocked * 0.5
    const compensateEach  = subs.length > 0 ? compensateTotal / subs.length : 0
    for (const s of subs) {
      if (compensateEach > 0) db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(compensateEach, s.verifier_id)
      db.prepare(`UPDATE verify_submissions SET verdict='abstain' WHERE id=?`).run(s.id)
      db.prepare(`UPDATE verifier_stats SET tasks_done = tasks_done + 1 WHERE user_id = ?`).run(s.verifier_id)
    }
    // 验证失败：标记链接为 revoked，保留记录使商品无法直接上架
    db.prepare(`UPDATE product_external_links SET revoked=1, verify_note='验证失败：验证码未在原链接中确认' WHERE product_id=? AND url=? AND verified=0`)
      .run(task.product_id, task.url)
  }
}

// ── 卖家确认：已在原平台添加验证码，任务进入分配池
app.post('/api/verify-tasks/:id/confirm', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const task = db.prepare(`SELECT * FROM verify_tasks WHERE id = ? AND status IN ('code_issued','open')`).get(req.params.id) as Record<string, unknown> | undefined
  if (!task) return void res.json({ error: '任务不存在或已结束' })
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(task.product_id as string) as { seller_id: string } | undefined
  if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
  if (task.status === 'open') {
    return void res.json({ success: true, already_open: true, message: '任务已在验证中，无需重复确认' })
  }
  db.prepare(`UPDATE verify_tasks SET status='open' WHERE id=?`).run(req.params.id)
  try { assignVerifiers(req.params.id as string) } catch {}
  res.json({ success: true, message: '任务已提交到验证池，等待审核员确认' })
})

// ── 验证者：查看分配给我的任务
// 卖家：查询某商品的进行中验证任务（供编辑页展示验证码）
app.get('/api/verify-tasks/by-product/:productId', (req, res) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(req.params.productId) as { seller_id: string } | undefined
  if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
  const tasks = db.prepare(`
    SELECT id, type, url, code, status, expires_at, created_at,
      (SELECT COUNT(*) FROM verify_submissions WHERE task_id = verify_tasks.id AND submitted_at IS NOT NULL) as submissions_done
    FROM verify_tasks WHERE product_id = ? AND status IN ('code_issued','open') ORDER BY created_at DESC
  `).all(req.params.productId)
  res.json(tasks)
})

// 卖家：查询我发起的所有认领任务（用于"查看任务进度"页）
app.get('/api/verify-tasks/my-claims', (req, res) => {
  const user = auth(req, res); if (!user) return
  const tasks = db.prepare(`
    SELECT vt.id, vt.type, vt.url, vt.code, vt.status, vt.result,
           vt.verifiers_needed, vt.expires_at, vt.created_at, vt.settled_at,
           p.title as product_title, p.id as product_id,
           (SELECT COUNT(*) FROM verify_submissions WHERE task_id=vt.id AND submitted_at IS NOT NULL) as submissions_done
    FROM verify_tasks vt
    JOIN products p ON vt.product_id = p.id
    WHERE p.seller_id = ?
    ORDER BY vt.created_at DESC
    LIMIT 30
  `).all(user.id)
  res.json(tasks)
})

app.get('/api/verify-tasks/mine', (req, res) => {
  const user = auth(req, res); if (!user) return
  const tasks = db.prepare(`
    SELECT vt.id, vt.type, vt.url, vt.verifiers_needed, vt.reward_per_verifier, vt.expires_at,
      vs.id as sub_id, vs.submitted_at, vs.verdict,
      (SELECT COUNT(*) FROM verify_submissions WHERE task_id = vt.id AND submitted_at IS NOT NULL) as submissions_done
    FROM verify_tasks vt
    JOIN verify_submissions vs ON vs.task_id = vt.id AND vs.verifier_id = ?
    WHERE vt.status = 'open'
    ORDER BY vt.created_at DESC
  `).all(user.id)
  const stats = getVerifierStats(user.id as string)
  res.json({ tasks, stats })
})

// ── 验证者：提交验证结果（填入式）
app.post('/api/verify-tasks/:id/submit', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const { submission } = req.body  // 验证者填入的字符串（看到什么填什么）

  const sub = db.prepare(`SELECT * FROM verify_submissions WHERE task_id = ? AND verifier_id = ?`)
    .get(req.params.id, user.id) as Record<string, unknown> | undefined
  if (!sub) return void res.json({ error: '未分配到此任务' })
  if (sub.submitted_at) return void res.json({ error: '已提交过' })

  const task = db.prepare('SELECT * FROM verify_tasks WHERE id = ? AND status = ?').get(req.params.id, 'open') as Record<string, unknown> | undefined
  if (!task) return void res.json({ error: '任务已结束或不存在' })
  if (new Date(task.expires_at as string) < new Date()) return void res.json({ error: '任务已过期' })

  // 保存提交（提交前不能看到 code，只存原始填入内容）
  db.prepare(`UPDATE verify_submissions SET submission=?, submitted_at=datetime('now') WHERE task_id=? AND verifier_id=?`)
    .run((submission ?? '').trim(), req.params.id, user.id)

  // 检查是否已达到所需提交数 → 结算
  const doneCount = (db.prepare(`SELECT COUNT(*) as n FROM verify_submissions WHERE task_id = ? AND submitted_at IS NOT NULL`).get(req.params.id) as { n: number }).n
  if (doneCount >= (task.verifiers_needed as number)) settleTask(req.params.id as string)

  res.json({ success: true, message: '提交成功，等待其他验证者完成后自动结算' })
})

// ── 验证者：我的验证统计
app.get('/api/verify-stats', (req, res) => {
  const user = auth(req, res); if (!user) return
  res.json(getVerifierStats(user.id as string))
})

// ─── 管理端点（验证员白名单 & 内部审核账号）─────────────────────

// 获取内部审核账号信息
app.get('/api/admin/auditor', (req, res) => {
  const user = auth(req, res); if (!user) return
  const auditor = db.prepare('SELECT id, name, api_key, created_at FROM users WHERE id = ?')
    .get(INTERNAL_AUDITOR_ID) as Record<string, unknown> | undefined
  if (!auditor) return void res.json({ error: '内部审核账号未初始化' })
  res.json({ id: auditor.id, name: auditor.name, api_key: auditor.api_key })
})

// 白名单列表
app.get('/api/admin/verifier-whitelist', (req, res) => {
  const user = auth(req, res); if (!user) return
  const list = db.prepare(`
    SELECT vw.user_id, vw.added_at, vw.note, u.name, u.role
    FROM verifier_whitelist vw
    JOIN users u ON u.id = vw.user_id
    ORDER BY vw.added_at ASC
  `).all()
  res.json(list)
})

// 添加到白名单（按 user_id 或 name 查找）
app.post('/api/admin/verifier-whitelist', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const { user_id, name, note } = req.body as { user_id?: string; name?: string; note?: string }
  let targetId = user_id
  if (!targetId && name) {
    const found = db.prepare('SELECT id FROM users WHERE name = ?').get(name) as { id: string } | undefined
    if (!found) return void res.json({ error: `用户「${name}」不存在` })
    targetId = found.id
  }
  if (!targetId) return void res.json({ error: '请提供 user_id 或 name' })
  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetId) as { id: string; name: string } | undefined
  if (!target) return void res.json({ error: '用户不存在' })
  db.prepare('INSERT OR IGNORE INTO verifier_whitelist (user_id, note) VALUES (?, ?)').run(targetId, note ?? null)
  res.json({ success: true, user_id: targetId, name: target.name })
})

// 从白名单移除
app.delete('/api/admin/verifier-whitelist/:userId', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  if (req.params.userId === INTERNAL_AUDITOR_ID) return void res.json({ error: '内部审核员不可移除' })
  db.prepare('DELETE FROM verifier_whitelist WHERE user_id = ?').run(req.params.userId)
  res.json({ success: true })
})

// ── 公开：验证任务大厅（对合格用户展示未满的任务，隐藏卖家信息）
app.get('/api/verify-tasks/open', (req, res) => {
  const user = auth(req, res); if (!user) return
  // 只看分配给我但未提交的
  const tasks = db.prepare(`
    SELECT vt.id, vt.type, vt.url, vt.reward_per_verifier, vt.expires_at,
      (SELECT COUNT(*) FROM verify_submissions WHERE task_id=vt.id AND submitted_at IS NOT NULL) as done,
      vt.verifiers_needed
    FROM verify_tasks vt
    JOIN verify_submissions vs ON vs.task_id = vt.id AND vs.verifier_id = ? AND vs.submitted_at IS NULL
    WHERE vt.status = 'open'
    ORDER BY vt.created_at ASC
    LIMIT 10
  `).all(user.id)
  res.json(tasks)
})

// 链接冲突验证 — 检查页面是否包含验证码
app.post('/api/link-challenges/:id/verify', async (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const challenge = db.prepare(`SELECT * FROM link_challenges WHERE id = ? AND status = 'pending'`)
    .get(req.params.id) as Record<string, unknown> | undefined
  if (!challenge) return void res.json({ error: '验证码不存在或已失效' })
  if (challenge.product_id !== undefined) {
    const prod = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(challenge.product_id) as { seller_id: string } | undefined
    if (!prod || prod.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
  }
  if (new Date(challenge.expires_at as string) < new Date()) {
    db.prepare(`UPDATE link_challenges SET status='expired' WHERE id = ?`).run(req.params.id)
    return void res.json({ error: '验证码已过期（48小时有效），请重新添加链接' })
  }

  const fullCode = `WebAZ-${challenge.code}`
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 10000)
    const resp = await fetch(challenge.url as string, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh' } })
    const html = await resp.text()
    if (!html.includes(fullCode)) {
      return void res.json({ error: `页面中未找到验证码 "${fullCode}"，请确认已保存到商品标题或描述中` })
    }
  } catch (e: unknown) {
    return void res.json({ error: `无法访问页面：${(e as Error).message}` })
  }

  // 验证通过：将旧链接转移到新商品
  db.prepare(`UPDATE product_external_links SET product_id = ?, verify_note = '通过挑战验证，从原商品转移', verified_at = datetime('now') WHERE url = ?`)
    .run(challenge.product_id, challenge.url)
  db.prepare(`UPDATE link_challenges SET status='verified', verified_at=datetime('now') WHERE id=?`).run(req.params.id)

  res.json({ success: true, message: `验证成功！链接已转移到此商品。` })
})

// 编辑商品
app.put('/api/products/:id', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(req.params.id, user.id) as Record<string, unknown> | undefined
  if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })

  const {
    title, description, price, stock,
    specs, brand, model, handling_hours, ship_regions,
    estimated_days, fragile, return_days, return_condition, warranty_days,
  } = req.body

  const now = new Date().toISOString()
  const specsJson = specs != null ? (typeof specs === 'object' ? JSON.stringify(specs) : specs) : product.specs
  const estJson   = estimated_days != null ? (typeof estimated_days === 'object' ? JSON.stringify(estimated_days) : String(estimated_days)) : product.estimated_days

  const newTitle       = title       ?? product.title
  const newDesc        = description ?? product.description
  const newPrice       = price       != null ? Number(price) : product.price as number
  const newHandling    = handling_hours != null ? Number(handling_hours) : product.handling_hours
  const newShipRegions = ship_regions ?? product.ship_regions
  const newEstDays     = estJson
  const newReturnDays  = return_days != null ? Number(return_days) : product.return_days
  const newReturnCond  = return_condition ?? product.return_condition
  const newWarranty    = warranty_days != null ? Number(warranty_days) : product.warranty_days
  const newFragile     = fragile != null ? (fragile ? 1 : 0) : product.fragile

  const pFields = { ship_regions: newShipRegions, handling_hours: newHandling, estimated_days: newEstDays, return_days: newReturnDays, return_condition: newReturnCond, warranty_days: newWarranty }

  db.prepare(`UPDATE products SET
    title=?, description=?, price=?, stock=?,
    specs=?, brand=?, model=?, handling_hours=?, ship_regions=?,
    estimated_days=?, fragile=?, return_days=?, return_condition=?, warranty_days=?,
    commitment_hash=?, description_hash=?, price_hash=?, hashed_at=?,
    updated_at=datetime('now')
    WHERE id=?`).run(
    newTitle, newDesc, newPrice, stock != null ? Number(stock) : product.stock,
    specsJson, brand ?? product.brand, model ?? product.model,
    newHandling, newShipRegions, newEstDays, newFragile,
    newReturnDays, newReturnCond, newWarranty,
    makeCommitmentHash(pFields),
    makeDescriptionHash({ title: newTitle, description: newDesc, specs: specsJson }),
    makePriceHash(newPrice, now), now,
    req.params.id
  )
  res.json({ success: true })
})

// 卖家：修改商品状态（上架 / 下架到仓库 / 移入回收箱）
app.patch('/api/products/:id/status', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const { status } = req.body as { status: string }
  if (!['active', 'warehouse', 'deleted'].includes(status)) return void res.json({ error: '无效状态值' })
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND seller_id = ?').get(req.params.id, user.id)
  if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })
  if (status === 'active') {
    const pendingTask = db.prepare(`SELECT id FROM verify_tasks WHERE product_id=? AND status IN ('code_issued','open')`).get(req.params.id)
    if (pendingTask) return void res.json({ error: '链接核验进行中，请等待验证结果后再上架' })
    const hasRevoked = db.prepare(`SELECT id FROM product_external_links WHERE product_id=? AND revoked=1`).get(req.params.id)
    const hasValid   = db.prepare(`SELECT id FROM product_external_links WHERE product_id=? AND verified=1 AND (revoked IS NULL OR revoked=0)`).get(req.params.id)
    if (hasRevoked && !hasValid) return void res.json({ error: '所有外部链接已失效（主权失效），请先添加新链接后再上架' })
  }
  db.prepare(`UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id)
  res.json({ success: true })
})

// 卖家：彻底删除商品（仅限回收箱状态）
app.delete('/api/products/:id', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(req.params.id, user.id) as Record<string, unknown> | undefined
  if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })
  if (product.status !== 'deleted') return void res.json({ error: '请先将商品移入回收箱' })
  const activeOrders = db.prepare(`
    SELECT COUNT(*) as n FROM orders WHERE product_id = ? AND status NOT IN ('completed','cancelled','refunded','expired')
  `).get(req.params.id) as { n: number }
  if (activeOrders.n > 0) return void res.json({ error: '该商品有进行中的订单，暂无法删除' })
  db.prepare('DELETE FROM product_external_links WHERE product_id = ?').run(req.params.id)
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id)
  res.json({ success: true })
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

  // ── 链接认领检查（解析前，不浪费 AI 配额）─────────────────────
  // 同一卖家已上架此链接 → 直接拒绝
  const selfClaim = db.prepare(`
    SELECT p.id as product_id, p.title FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND p.seller_id = ?
  `).get(url, user.id) as { product_id: string; title: string } | undefined
  if (selfClaim) {
    return void res.json({ error: `您已上架过来自此链接的商品「${selfClaim.title}」，不能重复关联相同外部链接` })
  }

  // 其他卖家已认领（verified=1）→ 返回冲突，前端跳转认领流程
  const otherClaim = db.prepare(`
    SELECT p.id as product_id FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
  `).get(url, user.id) as { product_id: string } | undefined
  if (otherClaim) {
    return void res.json({
      conflict: true,
      url,
      message: '此链接已被其他商家认领上架。如需认领归属，请发起链接认领验证任务。',
    })
  }

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
        content: `你是一个电商商品信息提取助手，服务于 AI Agent 商业协议平台。从以下网页 HTML 中提取商品信息，返回精简结构化 JSON。

网页来源 URL：${url}

WebAZ 平台各类目价格参考（WAZ ≈ CNY）：
${priceContext || '暂无参考数据'}

只返回 JSON，不要其他文字：
{
  "title": "商品标题（简洁，50字以内）",
  "description": "面向 AI Agent 的商品描述：核心参数+适用场景，100字以内，无营销话术",
  "specs": {"规格名":"规格值"},
  "brand": "品牌（找不到填null）",
  "model": "型号或规格编号（找不到填null）",
  "original_price": 原平台价格数字（CNY，找不到填null）,
  "suggested_price": 建议WAZ定价（参考原价和平台均价，有竞争力）,
  "price_reasoning": "定价理由（1句）",
  "category": "茶具/家居/食品/服装/手工/电子（其他填空）",
  "stock": 建议库存（默认1）,
  "weight_kg": 重量数字（找不到填null）,
  "handling_hours": 备货时间小时数（默认24）,
  "ship_regions": "全国",
  "estimated_days": {"华东":2,"全国":5},
  "return_days": 退货天数（默认7）,
  "return_condition": "退货条件（如未拆封/任意原因）",
  "warranty_days": 质保天数（默认0）,
  "fragile": false,
  "tags": ["标签1","标签2"]
}

HTML（前30000字符）：
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
    source_price: extracted.original_price ?? null,
    used_own_key: usingOwnKey,
    quota: usingOwnKey ? null : { used: usedToday, limit: FREE_IMPORT_LIMIT, remaining: FREE_IMPORT_LIMIT - usedToday },
    ...extracted,
  })
})

// 链接认领验证 — 卖家对已被他人认领的外部链接发起所有权验证
app.post('/api/claim-url', (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'seller') return void res.json({ error: '仅卖家可发起认领' })

  const {
    url, title, description, price, stock = 1, category = '',
    specs, handling_hours = 24, return_days = 7, warranty_days = 0,
  } = req.body
  if (!url || !title || !description || !price) {
    return void res.json({ error: '请填写链接、商品名、描述和价格' })
  }

  // 再次确认链接确实被他人认领（防止并发）
  const otherClaim = db.prepare(`
    SELECT p.id FROM product_external_links pel
    JOIN products p ON pel.product_id = p.id
    WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
  `).get(url, user.id) as { id: string } | undefined
  if (!otherClaim) {
    return void res.json({ error: '该链接当前没有其他商家认领，请直接使用导入上架功能' })
  }

  // 同卖家已有认领任务 → 不重复创建
  const existingClaim = db.prepare(`
    SELECT vt.id FROM verify_tasks vt
    JOIN products p ON vt.product_id = p.id
    WHERE vt.url = ? AND p.seller_id = ? AND vt.status IN ('code_issued','open')
  `).get(url, user.id) as { id: string } | undefined
  if (existingClaim) {
    return void res.json({ error: '您已有针对此链接的进行中认领任务，请在商品编辑页查看并确认', task_id: existingClaim.id })
  }

  // 检查钱包余额
  const VERIFIERS_NEEDED = 1
  const REWARD_EACH      = 0.1
  const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }
  const priceNum = Number(price)
  const stakeDiscount = getStakeDiscount(db, user.id as string)
  const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)
  const stakeAmount = Math.round(priceNum * stakeRate * 100) / 100
  if (wallet.balance < stakeAmount + feeLocked) {
    return void res.json({ error: `余额不足：需要 ${stakeAmount} WAZ 质押 + ${feeLocked} WAZ 验证费，当前余额 ${wallet.balance} WAZ` })
  }

  // 创建商品
  const now = new Date().toISOString()
  const productId = generateId('prd')
  const specsJson = specs ? (typeof specs === 'string' ? specs : JSON.stringify(specs)) : null
  const pFields   = { ship_regions: '全国', handling_hours, estimated_days: null, return_days, return_condition: '', warranty_days }
  db.prepare(`INSERT INTO products (
    id, seller_id, title, description, price, stock, category, stake_amount,
    specs, source_url, handling_hours, return_days, warranty_days,
    commitment_hash, description_hash, price_hash, hashed_at, status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'warehouse')`).run(
    productId, user.id, title, description, priceNum, Number(stock), category, stakeAmount,
    specsJson, url, Number(handling_hours), Number(return_days), Number(warranty_days),
    makeCommitmentHash(pFields), makeDescriptionHash({ title, description, specs: specsJson }),
    makePriceHash(priceNum, now), now
  )
  db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?`)
    .run(stakeAmount, stakeAmount, user.id)

  // 插入未验证链接
  const linkId  = generateId('lnk')
  db.prepare(`INSERT INTO product_external_links (id, product_id, url, source, verified, verify_note)
    VALUES (?,?,?,'claim',0,'认领验证进行中')`).run(linkId, productId, url)

  // 生成验证码 + 创建众包验证任务
  const chars     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const code      = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  const taskId    = generateId('vtk')
  const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()
  db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
    VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`).run(taskId, 'code_check', productId, url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)
  db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ?`).run(feeLocked, user.id)

  res.json({
    success: true,
    product_id: productId,
    task_id: taskId,
    code: `[${code}]`,
    expires_at: expiresAt,
    message: `商品已建立，认领任务已创建。请在原平台商品标题或描述中加入验证码 [${code}]，完成后在商品编辑页点击「确认已添加」提交任务，审核通过后链接归属自动转移。`,
  })
})

// 智能下单 — agent 代用户比价后下单
app.post('/api/agent-buy', async (req: Request, res: Response) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'buyer') return void res.json({ error: '仅买家可使用智能下单' })

  const { source_url, shipping_address, auto_buy = false, user_api_key } = req.body
  if (!source_url) return void res.json({ error: '请提供商品链接' })
  if (auto_buy && !shipping_address) return void res.json({ error: '自动下单需提供收货地址' })

  // ① 抓取原商品页面
  let html = ''
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    const resp = await fetch(source_url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebAZ/1.0; +https://webaz.xyz)',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    clearTimeout(timer)
    html = (await resp.text()).slice(0, 20000)
  } catch (e: unknown) {
    return void res.json({ error: `无法访问该链接：${(e as Error).message}` })
  }

  const client = (typeof user_api_key === 'string' && user_api_key.trim().startsWith('sk-ant-'))
    ? new Anthropic({ apiKey: user_api_key.trim() })
    : anthropic

  // ② Claude 提取原商品关键信息（搜索词拆成独立短词数组）
  let source: Record<string, unknown>
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content:
        `从以下网页提取商品关键信息，仅返回JSON：
{
  "title": "商品全名",
  "price_cny": 数字或null,
  "category": "分类",
  "search_terms": ["独立短词1","独立短词2","独立短词3"]
}
search_terms 是3-5个独立的中文短词（每个2-4个汉字），用于在数据库里搜索同类商品。
例：九阳炒菜机器人 → ["炒菜机","九阳","炒菜机器人","自动炒菜"]
HTML：${html}` }],
    })
    const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no json')
    source = JSON.parse(m[0])
  } catch {
    return void res.json({ error: '无法从链接提取商品信息，请尝试其他链接' })
  }

  if (!source.title) return void res.json({ error: '链接无法提取商品信息（可能需要登录或动态渲染）' })

  // ③ 搜索 WebAZ 同类商品
  // 优先：精确 URL 匹配（卖家已绑定该外部链接的商品，命中率 100%）
  const urlMatchIds = (db.prepare(`
    SELECT DISTINCT product_id FROM product_external_links WHERE url = ? AND verified = 1
  `).all(source_url) as { product_id: string }[]).map(r => r.product_id)

  const urlMatchProducts: Record<string, unknown>[] = urlMatchIds.length > 0
    ? db.prepare(`
        SELECT p.*, u.name as seller_name,
          COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
        FROM products p
        JOIN users u ON p.seller_id = u.id
        LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
        WHERE p.id IN (${urlMatchIds.map(() => '?').join(',')}) AND p.status = 'active' AND p.stock > 0
      `).all(...urlMatchIds) as Record<string, unknown>[]
    : []

  // 兜底：关键词搜索（每个词独立 LIKE OR 连接）
  let keywordProducts: Record<string, unknown>[] = []
  if (urlMatchProducts.length < 3) {
    const rawTerms = Array.isArray(source.search_terms) ? source.search_terms as string[] : []
    if (rawTerms.length === 0) {
      const t = source.title as string
      for (let i = 0; i + 2 <= t.length && rawTerms.length < 4; i += 2) rawTerms.push(t.slice(i, i + 4))
    }
    const terms = rawTerms.filter((t: string) => t && t.length >= 2).slice(0, 6)
    if (terms.length > 0) {
      const termClauses = terms.map(() => `p.title LIKE ? OR p.description LIKE ?`).join(' OR ')
      const termParams  = terms.flatMap((t: string) => [`%${t}%`, `%${t}%`])
      const catClause   = source.category ? ` OR p.category = ?` : ''
      const catParam    = source.category ? [source.category] : []
      const alreadyIds  = urlMatchProducts.map(p => p.id as string)
      const excludeClause = alreadyIds.length > 0 ? ` AND p.id NOT IN (${alreadyIds.map(() => '?').join(',')})` : ''
      keywordProducts = db.prepare(`
        SELECT p.*, u.name as seller_name,
          COALESCE(rs.total_points, 0) as rep_points, COALESCE(rs.level, 'new') as rep_level
        FROM products p
        JOIN users u ON p.seller_id = u.id
        LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
        WHERE p.status = 'active' AND p.stock > 0
          AND (${termClauses}${catClause})${excludeClause}
        ORDER BY rep_points DESC, p.price ASC LIMIT ${5 - urlMatchProducts.length}
      `).all(...termParams, ...catParam, ...alreadyIds) as Record<string, unknown>[]
    }
  }

  // URL 精确匹配排前，关键词结果补后
  const webazProducts = [...urlMatchProducts, ...keywordProducts]
  const webazFormatted: Record<string, unknown>[] = webazProducts.map(p => ({
    ...formatProductForAgent(p),
    url_match: urlMatchIds.includes(p.id as string),  // 标记是否为精确匹配
  }))

  // ④ Claude 比价决策
  let decision: { recommendation: string; best_product_id?: string; reason: string; savings_note?: string }
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content:
        `你是一个购物助手。用户想买以下商品，我们找到了 WebAZ 平台上的替代选项，请做出购买建议。

原商品：
- 标题：${source.title}
- 原平台价格：${source.price_cny ? `¥${source.price_cny} CNY` : '未知'}
- 链接：${source_url}

WebAZ 平台替代方案（WAZ ≈ CNY）：
${webazFormatted.length > 0 ? JSON.stringify(webazFormatted.map(p => ({
  id: p.id,
  title: p.title,
  price: p.price,
  agent_summary: p.agent_summary,
  seller: p.seller_name,
  rep: p.rep_level,
})), null, 2) : '暂无匹配商品'}

仅返回JSON（不要其他文字）：
{
  "recommendation": "buy_webaz" | "buy_source" | "no_match",
  "best_product_id": "WebAZ商品ID（recommendation=buy_webaz时填写，否则null）",
  "reason": "一句话购买建议，说明为什么选这个方案（包含价格对比、售后优势等）",
  "savings_note": "省了多少或更优在哪（简短，可null）"
}` }],
    })
    const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('no json')
    decision = JSON.parse(m[0])
  } catch {
    decision = { recommendation: 'no_match', reason: '无法完成比价分析，请手动选购' }
  }

  // ⑤ 自动下单（auto_buy=true 且推荐 WebAZ）
  let orderId: string | null = null
  let sessionToken: string | null = null
  let verifiedPrice: number | null = null

  if (auto_buy && decision.recommendation === 'buy_webaz' && decision.best_product_id) {
    const product = db.prepare(`SELECT * FROM products WHERE id = ? AND status = 'active'`)
      .get(decision.best_product_id) as Record<string, unknown> | undefined

    if (product && (product.stock as number) > 0) {
      const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(user.id) as { balance: number }

      if (wallet.balance >= (product.price as number)) {
        // verify price
        const now = new Date()
        const expiresAt = new Date(now.getTime() + 10 * 60_000)
        sessionToken = generateId('pst')
        db.prepare(`INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at) VALUES (?,?,?,?,1,?,?)`)
          .run(sessionToken, product.id, user.id, product.price, now.toISOString(), expiresAt.toISOString())
        verifiedPrice = product.price as number

        // place order
        const oId = generateId('ord')
        const totalAmount = product.price as number
        const seller = db.prepare('SELECT id FROM users WHERE id = ?').get(product.seller_id as string) as { id: string }
        db.prepare(`INSERT INTO orders (
          id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
          status, shipping_address, notes, pay_deadline, accept_deadline, ship_deadline,
          pickup_deadline, delivery_deadline, confirm_deadline
        ) VALUES (?,?,?,?,1,?,?,?,'created',?,?,?,?,?,?,?,?)`).run(
          oId, product.id, user.id, seller.id, totalAmount, totalAmount, totalAmount,
          shipping_address, `[智能下单] ${decision.reason}`,
          addHours(now, 24), addHours(now, 48), addHours(now, 120),
          addHours(now, 168), addHours(now, 336), addHours(now, 408)
        )
        db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?')
          .run(totalAmount, totalAmount, user.id)
        db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(product.id)
        db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ?`).run(sessionToken)
        transition(db, oId, 'paid', user.id as string, [], '智能下单：模拟支付完成')
        notifyTransition(db, oId, 'created', 'paid')
        if (shouldAutoAccept(db, oId)) {
          const sys = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string } | undefined
          if (sys) {
            const ar = transition(db, oId, 'accepted', sys.id, [], '⚡ auto_accept Skill 自动接单')
            if (ar.success) notifyTransition(db, oId, 'paid', 'accepted')
          }
        }
        orderId = oId
      }
    }
  }

  // 找到最佳 WebAZ 商品详情（用于展示）
  const bestProduct = decision.best_product_id
    ? webazFormatted.find(p => p.id === decision.best_product_id) ?? null
    : null

  res.json({
    source: {
      title: source.title,
      price_cny: source.price_cny ?? null,
      url: source_url,
    },
    webaz_products: webazFormatted.slice(0, 3),
    recommendation: decision.recommendation,
    best_product: bestProduct,
    reason: decision.reason,
    savings_note: decision.savings_note ?? null,
    auto_bought: !!orderId,
    order_id: orderId,
    verified_price: verifiedPrice,
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
// 价格验证 — agent 下单前锁定价格，返回 session_token（10分钟有效）
app.post('/api/verify-price', (req, res) => {
  const user = auth(req, res); if (!user) return

  const { product_id, quantity = 1 } = req.body
  if (!product_id) return void res.json({ error: '请提供 product_id' })

  const product = db.prepare(`
    SELECT p.*, u.name as seller_name,
      COALESCE(rs.level, 'new') as rep_level
    FROM products p
    JOIN users u ON p.seller_id = u.id
    LEFT JOIN reputation_scores rs ON rs.user_id = p.seller_id
    WHERE p.id = ? AND p.status = 'active'
  `).get(product_id) as Record<string, unknown> | undefined
  if (!product) return void res.json({ error: '商品不存在或已下架' })

  const qty = Number(quantity)
  if ((product.stock as number) < qty) {
    return void res.json({ error: `库存不足：当前库存 ${product.stock}，请求数量 ${qty}` })
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 10 * 60_000) // 10分钟
  const token = generateId('pst')  // price session token

  db.prepare(`
    INSERT INTO price_sessions (token, product_id, user_id, price, quantity, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, product_id, user.id, product.price, qty, now.toISOString(), expiresAt.toISOString())

  res.json({
    session_token: token,
    verified_price: product.price,
    quantity: qty,
    total: (product.price as number) * qty,
    product: formatProductForAgent(product),
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: 600,
    note: '此价格在10分钟内有效。下单时传入 session_token 可保证此价格不变。',
  })
})

app.post('/api/orders', (req, res) => {
  const user = auth(req, res); if (!user) return
  if (user.role !== 'buyer') return void res.json({ error: '仅买家可下单' })

  const { product_id, shipping_address, notes, session_token } = req.body
  if (!product_id || !shipping_address) return void res.json({ error: '请提供商品ID和收货地址' })

  const product = db.prepare(`SELECT p.*, u.id as seller_uid FROM products p
    JOIN users u ON p.seller_id = u.id WHERE p.id = ? AND p.status = 'active'`
  ).get(product_id) as Record<string, unknown> | undefined
  if (!product) return void res.json({ error: '商品不存在或已下架' })
  if ((product.stock as number) < 1) return void res.json({ error: '库存不足' })

  // 验证 session_token（如果提供）
  if (session_token) {
    const session = db.prepare(`
      SELECT * FROM price_sessions WHERE token = ? AND product_id = ? AND user_id = ?
    `).get(session_token, product_id, user.id) as Record<string, unknown> | undefined
    if (!session) return void res.json({ error: 'session_token 无效，请重新调用 verify-price' })
    if (session.used_at) return void res.json({ error: 'session_token 已使用，请重新调用 verify-price' })
    if (new Date(session.expires_at as string) < new Date()) {
      return void res.json({ error: 'session_token 已过期（10分钟有效），请重新调用 verify-price' })
    }
    // 价格变动检测
    if ((session.price as number) !== (product.price as number)) {
      return void res.json({
        error: 'price_changed',
        message: `商品价格已变动：验证时 ${session.price} WAZ，当前 ${product.price} WAZ`,
        new_price: product.price,
        hint: '请重新调用 verify-price 获取新价格',
      })
    }
    db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ?`).run(session_token)
  }

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
