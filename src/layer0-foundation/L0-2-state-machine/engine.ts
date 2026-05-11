/**
 * L0-2 · 状态机引擎
 *
 * 三个核心职责：
 * 1. transition()     — 执行状态转移（验证权限 + 记录历史）
 * 2. checkTimeouts()  — 扫描超时订单，自动判责
 * 3. getStatus()      — 查询订单当前状态和责任方
 */

import Database from 'better-sqlite3'
import { generateId } from '../L0-1-database/schema.js'
import {
  VALID_TRANSITIONS,
  CURRENT_RESPONSIBLE,
  type OrderStatus,
  type UserRole
} from './transitions.js'

// ─── 类型定义 ───────────────────────────────────────────────

interface Order {
  id: string
  status: OrderStatus
  buyer_id: string
  seller_id: string
  logistics_id: string | null
  pay_deadline: string | null
  accept_deadline: string | null
  ship_deadline: string | null
  pickup_deadline: string | null
  delivery_deadline: string | null
  confirm_deadline: string | null
  [key: string]: unknown
}

interface User {
  id: string
  role: UserRole
}

export interface TransitionResult {
  success: boolean
  newStatus?: OrderStatus
  error?: string
  historyId?: string
}

// ─── 核心函数 ────────────────────────────────────────────────

/**
 * 执行状态转移
 * @param db        数据库连接
 * @param orderId   订单ID
 * @param toStatus  目标状态
 * @param actorId   操作者用户ID
 * @param evidenceIds 附上的证据ID列表
 * @param notes     备注说明
 */
export function transition(
  db: Database.Database,
  orderId: string,
  toStatus: OrderStatus,
  actorId: string,
  evidenceIds: string[] = [],
  notes: string = ''
): TransitionResult {

  // 1. 读取订单和操作者
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Order | undefined
  if (!order) return { success: false, error: `订单不存在：${orderId}` }

  const actor = db.prepare('SELECT * FROM users WHERE id = ?').get(actorId) as User | undefined
  if (!actor) return { success: false, error: `用户不存在：${actorId}` }

  const fromStatus = order.status

  // 2. 查找合法转移规则
  const transitionKey = `${fromStatus}→${toStatus}`
  const rule = VALID_TRANSITIONS[transitionKey]

  if (!rule) {
    return {
      success: false,
      error: `非法状态转移：${fromStatus} → ${toStatus}（协议不允许此操作）`
    }
  }

  // 3. 验证角色权限
  if (!rule.allowedRoles.includes(actor.role)) {
    return {
      success: false,
      error: `权限不足：${actor.role} 无法执行 ${fromStatus} → ${toStatus}。` +
             `允许的角色：${rule.allowedRoles.join(', ')}`
    }
  }

  // 4. 验证证据要求
  if (rule.requiresEvidence && evidenceIds.length === 0) {
    return {
      success: false,
      error: `此操作需要上传证据。提示：${rule.evidenceHint ?? '请上传相关证明文件'}`
    }
  }

  // 5. 执行转移（数据库事务，保证原子性）
  const historyId = generateId('hist')

  const execute = db.transaction(() => {
    // 更新订单状态
    db.prepare(`
      UPDATE orders
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(toStatus, orderId)

    // 记录状态历史（自举证的核心）
    db.prepare(`
      INSERT INTO order_state_history
        (id, order_id, from_status, to_status, actor_id, actor_role, evidence_ids, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      historyId,
      orderId,
      fromStatus,
      toStatus,
      actorId,
      actor.role,
      JSON.stringify(evidenceIds),
      notes
    )
  })

  execute()

  return { success: true, newStatus: toStatus, historyId }
}

/**
 * 扫描所有超时订单，自动判责
 * 这个函数应该定期运行（如每分钟），是「协议自动执法」的实现
 */
export function checkTimeouts(db: Database.Database): {
  processed: number
  details: Array<{ orderId: string; action: string }>
} {
  const now = new Date().toISOString()
  const details: Array<{ orderId: string; action: string }> = []

  // 找出所有进行中的订单
  const activeOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status NOT IN ('completed', 'cancelled', 'fault_buyer', 'fault_seller', 'fault_logistics')
  `).all() as Order[]

  for (const order of activeOrders) {
    const transitionKey = findActiveDeadlineTransition(order, now)
    if (!transitionKey) continue

    const [, autoFaultState] = transitionKey
    const systemUser = getSystemUser(db)

    // 系统自动触发判责状态
    const result = transition(
      db,
      order.id,
      autoFaultState,
      systemUser.id,
      [],
      `系统自动判责：超过截止时间 ${new Date(now).toLocaleString()}`
    )

    if (result.success) {
      details.push({
        orderId: order.id,
        action: `${order.status} → ${autoFaultState}（超时自动判责）`
      })

      // 如果判责状态可以自动完成，继续执行
      const completionKey = `${autoFaultState}→completed`
      if (VALID_TRANSITIONS[completionKey]) {
        transition(db, order.id, 'completed', systemUser.id, [], '系统自动执行处置')
      }
    }
  }

  return { processed: details.length, details }
}

/**
 * 查询订单的完整状态（含当前责任方、距截止时间）
 */
export function getOrderStatus(db: Database.Database, orderId: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Order | undefined
  if (!order) return null

  const history = db.prepare(`
    SELECT h.*, u.name as actor_name, u.role as actor_role_name
    FROM order_state_history h
    JOIN users u ON h.actor_id = u.id
    WHERE h.order_id = ?
    ORDER BY h.created_at ASC
  `).all(orderId)

  const currentResponsible = CURRENT_RESPONSIBLE[order.status] ?? null
  const activeDeadline = getActiveDeadline(order)

  return {
    order,
    history,
    currentResponsible,
    activeDeadline,
    isOverdue: activeDeadline ? new Date() > new Date(activeDeadline.deadline) : false
  }
}

// ─── 内部工具函数 ─────────────────────────────────────────────

/** 找出当前订单超时的转移（如果有） */
function findActiveDeadlineTransition(
  order: Order,
  now: string
): [string, OrderStatus] | null {
  // 按当前状态找对应的截止时间规则
  const relevantRules = Object.entries(VALID_TRANSITIONS).filter(
    ([key, rule]) =>
      key.startsWith(`${order.status}→`) &&
      rule.deadlineField &&
      rule.autoFaultState
  )

  for (const [, rule] of relevantRules) {
    const deadlineField = rule.deadlineField!
    const deadline = order[deadlineField] as string | null
    if (deadline && now > deadline && rule.autoFaultState) {
      return [deadlineField, rule.autoFaultState]
    }
  }

  return null
}

/** 获取当前有效的截止时间 */
function getActiveDeadline(order: Order) {
  const deadlineMap: Record<string, string> = {
    created:   'pay_deadline',
    paid:      'accept_deadline',
    accepted:  'ship_deadline',
    shipped:   'pickup_deadline',
    in_transit: 'delivery_deadline',
    delivered: 'confirm_deadline',
  }

  const field = deadlineMap[order.status]
  if (!field) return null

  const deadline = order[field] as string | null
  if (!deadline) return null

  return { field, deadline }
}

/** 获取或创建系统用户（用于自动触发），启动时调用一次 */
export function initSystemUser(db: Database.Database): User {
  return getSystemUser(db)
}

function getSystemUser(db: Database.Database): User {
  let sys = db.prepare("SELECT * FROM users WHERE id = 'sys_protocol'").get() as User | undefined
  if (!sys) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, name, role, api_key)
      VALUES ('sys_protocol', '协议系统', 'system', 'sys_internal_key')
    `).run()
    db.prepare(`
      INSERT OR IGNORE INTO wallets (user_id, balance)
      VALUES ('sys_protocol', 0)
    `).run()
    sys = db.prepare("SELECT * FROM users WHERE id = 'sys_protocol'").get() as User
  }
  return sys
}
