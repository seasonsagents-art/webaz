/**
 * L4-3 · 声誉积分系统
 *
 * 声誉是用户在 DCP 协议中的"无形资产"：
 *   - 每笔交易按行为质量自动加/减分
 *   - 等级越高：质押折扣、搜索权重提升、买家信任度增加
 *   - 违约、争议败诉 → 扣分惩罚
 *   - 所有记录永久可查，不可人工修改
 *
 * 积分规则（每次结算后调用 recordOrderReputation）：
 *   +10  交易完成（卖家）               +5  交易完成（买家）
 *   + 5  极速接单（6h 内接单，卖家）      +2  及时确认（24h 内确认收货，买家）
 *   + 5  准时发货（在截止时间前发货）      +8  交易完成（物流）
 *   + 5  准时投递（在截止时间前投递）      +8  争议胜诉
 *   -25  争议败诉                        -40  超时违约
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

// ─── Schema ───────────────────────────────────────────────────

export function initReputationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation_events (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      order_id   TEXT,
      event_type TEXT NOT NULL,
      points     INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reputation_scores (
      user_id           TEXT PRIMARY KEY REFERENCES users(id),
      total_points      INTEGER DEFAULT 0,
      transactions_done INTEGER DEFAULT 0,
      disputes_won      INTEGER DEFAULT 0,
      disputes_lost     INTEGER DEFAULT 0,
      violations        INTEGER DEFAULT 0,
      level             TEXT DEFAULT 'new',
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rep_events_user ON reputation_events(user_id, created_at DESC);
  `)
}

// ─── 等级定义 ─────────────────────────────────────────────────

export type RepLevel = 'new' | 'trusted' | 'quality' | 'star' | 'legend'

export const LEVELS: Array<{
  key: RepLevel
  label: string
  icon: string
  minPoints: number
  stakeDiscount: number   // 质押折扣比例（0.05 = 5%）
  searchBoost: number     // 搜索排序加成（0~1）
  badge: string           // 显示用徽标
}> = [
  { key: 'new',     label: '新手',  icon: '🌱', minPoints: 0,    stakeDiscount: 0,    searchBoost: 0,   badge: '' },
  { key: 'trusted', label: '可信',  icon: '⭐',  minPoints: 200,  stakeDiscount: 0.05, searchBoost: 0.1, badge: '⭐可信' },
  { key: 'quality', label: '优质',  icon: '🌟',  minPoints: 800,  stakeDiscount: 0.10, searchBoost: 0.25, badge: '🌟优质' },
  { key: 'star',    label: '明星',  icon: '💫',  minPoints: 2000, stakeDiscount: 0.15, searchBoost: 0.5,  badge: '💫明星' },
  { key: 'legend',  label: '传奇',  icon: '🔥',  minPoints: 5000, stakeDiscount: 0.20, searchBoost: 1.0,  badge: '🔥传奇' },
]

export function getLevel(points: number): typeof LEVELS[number] {
  let level = LEVELS[0]
  for (const l of LEVELS) {
    if (points >= l.minPoints) level = l
  }
  return level
}

// ─── 事件类型 ─────────────────────────────────────────────────

export type RepEventType =
  | 'order_completed'      // +10 卖家 / +5 买家 / +8 物流
  | 'fast_accept'          // +5  卖家：6h 内接单
  | 'on_time_ship'         // +5  卖家：在截止前发货
  | 'on_time_delivery'     // +5  物流：在截止前投递
  | 'timely_confirm'       // +2  买家：24h 内确认收货
  | 'dispute_won'          // +8
  | 'dispute_lost'         // -25
  | 'timeout_violation'    // -40

const EVENT_POINTS: Record<RepEventType, (role?: string) => number> = {
  order_completed:  (role) => role === 'seller' ? 10 : role === 'logistics' ? 8 : 5,
  fast_accept:      ()     => 5,
  on_time_ship:     ()     => 5,
  on_time_delivery: ()     => 5,
  timely_confirm:   ()     => 2,
  dispute_won:      ()     => 8,
  dispute_lost:     ()     => -25,
  timeout_violation:()     => -40,
}

// ─── 写入声誉事件 ─────────────────────────────────────────────

export function recordRepEvent(
  db: Database.Database,
  userId: string,
  eventType: RepEventType,
  reason: string,
  orderId?: string,
  role?: string,
): void {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined
  if (!user) return

  const points = EVENT_POINTS[eventType](role ?? user.role)
  const id = generateId('rep')

  db.prepare('INSERT INTO reputation_events (id, user_id, order_id, event_type, points, reason) VALUES (?,?,?,?,?,?)').run(
    id, userId, orderId ?? null, eventType, points, reason
  )

  // 更新汇总表
  const existing = db.prepare('SELECT * FROM reputation_scores WHERE user_id = ?').get(userId) as Record<string, number | string> | undefined

  if (!existing) {
    db.prepare(`INSERT INTO reputation_scores (user_id, total_points, transactions_done, disputes_won, disputes_lost, violations, level)
      VALUES (?, ?, 0, 0, 0, 0, 'new')`).run(userId, Math.max(0, points))
  } else {
    const newTotal = Math.max(0, (existing.total_points as number) + points)  // 最低 0 分
    const isDisputeWon  = eventType === 'dispute_won'
    const isDisputeLost = eventType === 'dispute_lost'
    const isViolation   = eventType === 'timeout_violation'
    const isDone        = eventType === 'order_completed'

    db.prepare(`UPDATE reputation_scores SET
      total_points      = ?,
      transactions_done = transactions_done + ?,
      disputes_won      = disputes_won + ?,
      disputes_lost     = disputes_lost + ?,
      violations        = violations + ?,
      level             = ?,
      updated_at        = datetime('now')
    WHERE user_id = ?`).run(
      newTotal,
      isDone ? 1 : 0,
      isDisputeWon ? 1 : 0,
      isDisputeLost ? 1 : 0,
      isViolation ? 1 : 0,
      getLevel(newTotal).key,
      userId,
    )
  }
}

// ─── 订单结算时一次性记录所有声誉事件 ────────────────────────

export function recordOrderReputation(db: Database.Database, orderId: string): void {
  const order = db.prepare(`
    SELECT o.*, h_accept.created_at as accepted_at, h_ship.created_at as shipped_at, h_deliver.created_at as delivered_at, h_confirm.created_at as confirmed_at
    FROM orders o
    LEFT JOIN order_state_history h_accept  ON h_accept.order_id  = o.id AND h_accept.to_status  = 'accepted'
    LEFT JOIN order_state_history h_ship    ON h_ship.order_id    = o.id AND h_ship.to_status    = 'shipped'
    LEFT JOIN order_state_history h_deliver ON h_deliver.order_id = o.id AND h_deliver.to_status = 'delivered'
    LEFT JOIN order_state_history h_confirm ON h_confirm.order_id = o.id AND h_confirm.to_status = 'confirmed'
    WHERE o.id = ?
  `).get(orderId) as Record<string, string | number | null> | undefined

  if (!order) return

  const sellerId    = order.seller_id as string
  const buyerId     = order.buyer_id as string
  const logisticsId = order.logistics_id as string | null

  // ── 卖家 ────────────────────────────────────────────────────
  recordRepEvent(db, sellerId, 'order_completed', '交易完成', orderId, 'seller')

  // 极速接单：从 paid 到 accepted < 6h
  if (order.accepted_at && order.pay_deadline) {
    // accept_deadline = pay + 24h, 所以用 accept_deadline - 18h 判断是否 < 6h
    const paidTs = new Date(order.accept_deadline as string).getTime() - 24 * 3600_000
    const acceptTs = new Date(order.accepted_at as string).getTime()
    if (acceptTs - paidTs < 6 * 3600_000) {
      recordRepEvent(db, sellerId, 'fast_accept', '极速接单（6h 内）', orderId, 'seller')
    }
  }

  // 准时发货：shipped_at < ship_deadline
  if (order.shipped_at && order.ship_deadline) {
    if (new Date(order.shipped_at as string) < new Date(order.ship_deadline as string)) {
      recordRepEvent(db, sellerId, 'on_time_ship', '准时发货', orderId, 'seller')
    }
  }

  // ── 买家 ────────────────────────────────────────────────────
  recordRepEvent(db, buyerId, 'order_completed', '交易完成', orderId, 'buyer')

  // 及时确认：confirmed_at < delivered_at + 24h
  if (order.confirmed_at && order.delivered_at) {
    const deliverTs = new Date(order.delivered_at as string).getTime()
    const confirmTs = new Date(order.confirmed_at as string).getTime()
    if (confirmTs - deliverTs < 24 * 3600_000) {
      recordRepEvent(db, buyerId, 'timely_confirm', '及时确认收货', orderId, 'buyer')
    }
  }

  // ── 物流 ────────────────────────────────────────────────────
  if (logisticsId) {
    recordRepEvent(db, logisticsId, 'order_completed', '交易完成', orderId, 'logistics')
    if (order.delivered_at && order.delivery_deadline) {
      if (new Date(order.delivered_at as string) < new Date(order.delivery_deadline as string)) {
        recordRepEvent(db, logisticsId, 'on_time_delivery', '准时投递', orderId, 'logistics')
      }
    }
  }
}

// ─── 违约时记录声誉扣分 ──────────────────────────────────────

export function recordViolationReputation(
  db: Database.Database,
  orderId: string,
  faultStatus: string,   // fault_seller | fault_logistics | fault_buyer
): void {
  const order = db.prepare('SELECT seller_id, buyer_id, logistics_id FROM orders WHERE id = ?').get(orderId) as Record<string, string | null> | undefined
  if (!order) return

  if (faultStatus === 'fault_seller'    && order.seller_id)    recordRepEvent(db, order.seller_id,    'timeout_violation', '超时违约（卖家）', orderId)
  if (faultStatus === 'fault_logistics' && order.logistics_id) recordRepEvent(db, order.logistics_id, 'timeout_violation', '超时违约（物流）', orderId)
  if (faultStatus === 'fault_buyer'     && order.buyer_id)     recordRepEvent(db, order.buyer_id,     'timeout_violation', '超时违约（买家）', orderId)
}

// ─── 争议结算时记录声誉 ───────────────────────────────────────

export function recordDisputeReputation(
  db: Database.Database,
  orderId: string,
  winnerId: string,
  loserId: string,
): void {
  recordRepEvent(db, winnerId, 'dispute_won',  '争议胜诉', orderId)
  recordRepEvent(db, loserId,  'dispute_lost', '争议败诉', orderId)
}

// ─── 查询 ─────────────────────────────────────────────────────

export interface ReputationProfile {
  user_id: string
  total_points: number
  transactions_done: number
  disputes_won: number
  disputes_lost: number
  violations: number
  level: ReturnType<typeof getLevel>
  recent_events: Array<{ event_type: string; points: number; reason: string; created_at: string }>
}

export function getReputation(db: Database.Database, userId: string): ReputationProfile {
  let score = db.prepare('SELECT * FROM reputation_scores WHERE user_id = ?').get(userId) as Record<string, number | string> | undefined

  if (!score) {
    // 用户还没有声誉记录，初始化
    db.prepare(`INSERT OR IGNORE INTO reputation_scores (user_id) VALUES (?)`).run(userId)
    score = { user_id: userId, total_points: 0, transactions_done: 0, disputes_won: 0, disputes_lost: 0, violations: 0, level: 'new' }
  }

  const recent = db.prepare(`SELECT event_type, points, reason, created_at FROM reputation_events
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`).all(userId) as Array<{ event_type: string; points: number; reason: string; created_at: string }>

  return {
    user_id: userId,
    total_points:      score.total_points      as number,
    transactions_done: score.transactions_done as number,
    disputes_won:      score.disputes_won      as number,
    disputes_lost:     score.disputes_lost     as number,
    violations:        score.violations        as number,
    level:             getLevel(score.total_points as number),
    recent_events:     recent,
  }
}

export function getReputationByUserId(db: Database.Database, userId: string) {
  return getReputation(db, userId)
}

/** 获取用户的搜索加成（用于商品排序） */
export function getSearchBoost(db: Database.Database, userId: string): number {
  const score = db.prepare('SELECT total_points FROM reputation_scores WHERE user_id = ?').get(userId) as { total_points: number } | undefined
  const points = score?.total_points ?? 0
  return getLevel(points).searchBoost
}

/** 获取用户的质押折扣（用于上架商品时的质押计算） */
export function getStakeDiscount(db: Database.Database, userId: string): number {
  const score = db.prepare('SELECT total_points FROM reputation_scores WHERE user_id = ?').get(userId) as { total_points: number } | undefined
  const points = score?.total_points ?? 0
  return getLevel(points).stakeDiscount
}
