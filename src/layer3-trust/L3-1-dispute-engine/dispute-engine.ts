/**
 * L3-1 · 争议引擎
 *
 * 核心设计原则：无歧义自动判责
 * - 发起争议 → 被诉方 48h 内必须提交反驳证据
 * - 被诉方超时不回应 → 协议自动判发起方胜诉
 * - 仲裁员收到争议后 120h 内必须裁定
 * - 仲裁员超时 → 协议默认退款给买家（买家保护原则）
 *
 * 覆盖模块：L3-1 争议触发、L3-2 证据收集、L3-3 超时自动判责、L3-5 处置执行
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { transition } from '../../layer0-foundation/L0-2-state-machine/engine.js'

// ─── 类型定义 ─────────────────────────────────────────────────

export interface DisputeRecord {
  id: string
  order_id: string
  initiator_id: string
  initiator_name?: string
  initiator_role?: string
  defendant_id: string | null
  defendant_name?: string
  defendant_role?: string
  reason: string
  status: 'open' | 'in_review' | 'resolved' | 'dismissed'
  defendant_notes: string | null
  defendant_evidence_ids: string   // JSON 数组
  respond_deadline: string | null  // 被告方回应截止
  arbitrate_deadline: string | null // 仲裁截止
  assigned_arbitrators: string     // JSON 数组
  verdict: string | null
  verdict_reason: string | null
  ruling_type: string | null       // refund_buyer / release_seller / partial_refund
  refund_amount: number | null
  created_at: string
  resolved_at: string | null
}

// ─── Schema 初始化（幂等，安全重复调用）────────────────────────

/**
 * 为 disputes 表添加 L3 需要的新列
 * 使用 try/catch 避免列已存在时报错
 */
export function initDisputeSchema(db: Database.Database): void {
  const newColumns = [
    `ALTER TABLE disputes ADD COLUMN defendant_id TEXT`,
    `ALTER TABLE disputes ADD COLUMN defendant_notes TEXT`,
    `ALTER TABLE disputes ADD COLUMN defendant_evidence_ids TEXT DEFAULT '[]'`,
    `ALTER TABLE disputes ADD COLUMN respond_deadline TEXT`,
    `ALTER TABLE disputes ADD COLUMN arbitrate_deadline TEXT`,
    `ALTER TABLE disputes ADD COLUMN ruling_type TEXT`,
    `ALTER TABLE disputes ADD COLUMN refund_amount REAL`,
  ]
  for (const stmt of newColumns) {
    try { db.exec(stmt) } catch { /* 列已存在，跳过 */ }
  }
}

// ─── L3-1 争议触发 ────────────────────────────────────────────

/**
 * 创建争议记录
 * 在 dcp_update_order action=dispute 之后调用，写入 disputes 表
 */
export function createDispute(
  db: Database.Database,
  orderId: string,
  initiatorId: string,
  reason: string,
  evidenceIds: string[]
): { success: boolean; disputeId?: string; error?: string; message?: string; respondDeadline?: string } {

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: `订单不存在：${orderId}` }
  if (order.status !== 'disputed') return { success: false, error: '订单尚未进入争议状态，请先调用 dcp_update_order action=dispute' }

  // 检查是否已有进行中的争议
  const existing = db.prepare(
    `SELECT id FROM disputes WHERE order_id = ? AND status NOT IN ('resolved', 'dismissed')`
  ).get(orderId) as { id: string } | undefined
  if (existing) return { success: false, error: `该订单已有进行中的争议：${existing.id}` }

  // 确定被诉方：买家发起 → 被诉卖家，卖家/物流发起 → 被诉买家
  const initiator = db.prepare('SELECT role FROM users WHERE id = ?').get(initiatorId) as { role: string } | undefined
  if (!initiator) return { success: false, error: '发起方用户不存在' }

  let defendantId: string
  if (initiator.role === 'buyer') {
    defendantId = order.seller_id as string
  } else if (initiator.role === 'seller') {
    defendantId = order.buyer_id as string
  } else if (initiator.role === 'logistics') {
    defendantId = order.seller_id as string  // 物流纠纷默认与卖家
  } else {
    return { success: false, error: '此角色不能发起争议' }
  }

  const now = new Date()
  const disputeId = generateId('dsp')
  const respondDeadline = addHours(now, 48)
  const arbitrateDeadline = addHours(now, 120)

  db.prepare(`
    INSERT INTO disputes (
      id, order_id, initiator_id, defendant_id, reason, status,
      defendant_evidence_ids, respond_deadline, arbitrate_deadline, assigned_arbitrators
    ) VALUES (?, ?, ?, ?, ?, 'open', '[]', ?, ?, '[]')
  `).run(disputeId, orderId, initiatorId, defendantId, reason, respondDeadline, arbitrateDeadline)

  return {
    success: true,
    disputeId,
    respondDeadline,
    message: `争议已记录（${disputeId}）。被诉方有 48 小时提交反驳证据，超时协议自动判你胜诉。`,
  }
}

// ─── L3-2 证据收集 ────────────────────────────────────────────

/**
 * 被诉方提交反驳证据
 * @param db
 * @param disputeId 争议ID
 * @param responderId 被诉方用户ID
 * @param notes 反驳说明
 * @param evidenceIds 证据ID列表
 */
export function respondToDispute(
  db: Database.Database,
  disputeId: string,
  responderId: string,
  notes: string,
  evidenceIds: string[]
): { success: boolean; error?: string; message?: string } {

  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: `争议不存在：${disputeId}` }
  if (dispute.status !== 'open') {
    return { success: false, error: `争议已不在等待回应状态（当前：${dispute.status}）` }
  }
  if (dispute.defendant_id !== responderId) {
    return { success: false, error: '你不是本争议的被诉方，无法提交回应' }
  }

  // 检查截止时间
  if (dispute.respond_deadline && new Date() > new Date(dispute.respond_deadline)) {
    return { success: false, error: '回应截止时间已过，协议将自动裁定' }
  }

  db.prepare(`
    UPDATE disputes SET
      defendant_notes = ?,
      defendant_evidence_ids = ?,
      status = 'in_review'
    WHERE id = ?
  `).run(notes, JSON.stringify(evidenceIds), disputeId)

  return {
    success: true,
    message: '反驳证据已提交，争议进入仲裁阶段。仲裁员将在 72 小时内做出裁定。',
  }
}

// ─── L3-4 仲裁裁定 + L3-5 处置执行 ──────────────────────────

/**
 * 仲裁员做出裁定，并自动执行资金处置
 */
export function arbitrateDispute(
  db: Database.Database,
  disputeId: string,
  arbitratorId: string,
  ruling: 'refund_buyer' | 'release_seller' | 'partial_refund',
  reason: string,
  refundAmount?: number
): { success: boolean; error?: string; message?: string; settlement?: Record<string, unknown> } {

  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: `争议不存在：${disputeId}` }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已处理完毕' }
  }

  const arbitrator = db.prepare('SELECT role FROM users WHERE id = ?').get(arbitratorId) as { role: string } | undefined
  if (!arbitrator) return { success: false, error: '仲裁员不存在' }
  if (arbitrator.role !== 'arbitrator' && arbitrator.role !== 'system') {
    return { success: false, error: `只有仲裁员才能做出裁定，你的角色是：${arbitrator.role}` }
  }

  // 执行资金处置
  const settlement = executeSettlement(db, dispute.order_id, ruling, refundAmount)
  if (!settlement.success) return { success: false, error: settlement.error }

  // 更新争议记录
  db.prepare(`
    UPDATE disputes SET
      status = 'resolved',
      verdict = ?,
      verdict_reason = ?,
      ruling_type = ?,
      refund_amount = ?,
      resolved_at = datetime('now')
    WHERE id = ?
  `).run(ruling, reason, ruling, refundAmount ?? null, disputeId)

  return {
    success: true,
    message: `裁定已执行：${getRulingDescription(ruling, refundAmount)}`,
    settlement: settlement.detail,
  }
}

// ─── L3-5 资金处置执行 ────────────────────────────────────────

function executeSettlement(
  db: Database.Database,
  orderId: string,
  ruling: string,
  refundAmount?: number
): { success: boolean; error?: string; detail?: Record<string, unknown> } {

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: '订单不存在' }

  const totalAmount = order.total_amount as number
  const buyerId   = order.buyer_id as string
  const sellerId  = order.seller_id as string

  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?')
    .get(order.product_id as string) as { stake_amount: number } | undefined
  const stakeAmount = product?.stake_amount ?? 0

  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  if (ruling === 'refund_buyer') {
    // ── 买家胜诉：退全款 + 卖家损失一半质押（惩罚）──────────────
    const penalty = Math.round(stakeAmount * 0.5 * 100) / 100
    const stakeReturn = stakeAmount - penalty

    db.transaction(() => {
      // 退还买家托管资金
      db.prepare('UPDATE wallets SET escrowed = escrowed - ?, balance = balance + ? WHERE user_id = ?')
        .run(totalAmount, totalAmount, buyerId)
      // 卖家扣押质押 → 一半补偿给买家，一半归协议
      if (stakeAmount > 0) {
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(stakeAmount, sellerId)
        if (penalty > 0) {
          db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(penalty, buyerId)
        }
      }
      transition(db, orderId, 'cancelled', sysUser.id, [], `争议裁定：退款买家，质押惩罚 ${penalty} DCP`)
    })()

    return {
      success: true,
      detail: {
        ruling: 'refund_buyer',
        buyer_refund: totalAmount,
        buyer_compensation: penalty,
        seller_stake_forfeited: stakeAmount,
        seller_stake_returned: stakeReturn,
      }
    }

  } else if (ruling === 'release_seller') {
    // ── 卖家胜诉：资金释放给卖家（正常结算逻辑）──────────────────
    const protocolFee  = Math.round(totalAmount * 0.02 * 100) / 100
    const logisticsFee = order.logistics_id ? Math.round(totalAmount * 0.05 * 100) / 100 : 0
    const sellerAmount = totalAmount - protocolFee - logisticsFee

    db.transaction(() => {
      db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(totalAmount, buyerId)
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(sellerAmount, sellerId)
      if (order.logistics_id && logisticsFee > 0) {
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(logisticsFee, order.logistics_id as string)
      }
      // 返还卖家质押
      if (stakeAmount > 0) {
        db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?')
          .run(stakeAmount, stakeAmount, sellerId)
      }
      transition(db, orderId, 'completed', sysUser.id, [], '争议裁定：卖家胜诉，资金释放完成')
    })()

    return {
      success: true,
      detail: {
        ruling: 'release_seller',
        seller_received: sellerAmount,
        logistics_fee: logisticsFee,
        protocol_fee: protocolFee,
        seller_stake_returned: stakeAmount,
      }
    }

  } else if (ruling === 'partial_refund') {
    // ── 折中处理：部分退款 ────────────────────────────────────────
    const refund = refundAmount ?? Math.round(totalAmount * 0.5 * 100) / 100
    if (refund > totalAmount) return { success: false, error: `退款金额 ${refund} 超出订单总额 ${totalAmount}` }
    const sellerGet = Math.round((totalAmount - refund) * 100) / 100
    const stakeReturn = Math.round(stakeAmount * 0.5 * 100) / 100  // 质押返一半

    db.transaction(() => {
      db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(totalAmount, buyerId)
      if (refund > 0) {
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(refund, buyerId)
      }
      if (sellerGet > 0) {
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(sellerGet, sellerId)
      }
      if (stakeAmount > 0) {
        db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?')
          .run(stakeAmount, stakeReturn, sellerId)
      }
      transition(db, orderId, 'cancelled', sysUser.id, [], `争议裁定：部分退款 ${refund} DCP`)
    })()

    return {
      success: true,
      detail: {
        ruling: 'partial_refund',
        buyer_refund: refund,
        seller_received: sellerGet,
        seller_stake_returned: stakeReturn,
      }
    }
  }

  return { success: false, error: `未知裁定类型：${ruling}` }
}

// ─── L3-3 超时自动判责 ────────────────────────────────────────

/**
 * 扫描争议超时情况，自动裁定
 * 与 checkTimeouts() 配套使用，应定期运行
 */
export function checkDisputeTimeouts(db: Database.Database): {
  processed: number
  details: Array<{ disputeId: string; action: string }>
} {
  const now = new Date().toISOString()
  const details: Array<{ disputeId: string; action: string }> = []

  const openDisputes = db.prepare(
    `SELECT * FROM disputes WHERE status IN ('open', 'in_review')`
  ).all() as DisputeRecord[]

  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  for (const dispute of openDisputes) {
    if (dispute.status === 'open' && dispute.respond_deadline && now > dispute.respond_deadline) {
      // 被告未在截止时间内回应 → 自动判发起方胜诉
      const initiator = db.prepare('SELECT role FROM users WHERE id = ?')
        .get(dispute.initiator_id) as { role: string } | undefined
      const ruling = initiator?.role === 'buyer' ? 'refund_buyer' : 'release_seller'

      const r = arbitrateDispute(db, dispute.id, sysUser.id, ruling, '被诉方超时未提交反驳证据，协议自动裁定')
      if (r.success) {
        details.push({ disputeId: dispute.id, action: `被告超时 → ${ruling}` })
      }

    } else if (dispute.status === 'in_review' && dispute.arbitrate_deadline && now > dispute.arbitrate_deadline) {
      // 仲裁员超时未裁定 → 买家保护原则，默认退款
      const r = arbitrateDispute(db, dispute.id, sysUser.id, 'refund_buyer', '仲裁员超时未裁定，协议默认退款买家（买家保护原则）')
      if (r.success) {
        details.push({ disputeId: dispute.id, action: '仲裁超时 → 默认退款买家' })
      }
    }
  }

  return { processed: details.length, details }
}

// ─── 查询函数 ─────────────────────────────────────────────────

export function getDisputeDetails(
  db: Database.Database,
  disputeId: string
): (DisputeRecord & Record<string, unknown>) | null {
  return db.prepare(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    WHERE d.id = ?
  `).get(disputeId) as (DisputeRecord & Record<string, unknown>) | null
}

export function getOrderDispute(
  db: Database.Database,
  orderId: string
): (DisputeRecord & Record<string, unknown>) | null {
  return db.prepare(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    WHERE d.order_id = ? AND d.status NOT IN ('resolved', 'dismissed')
    ORDER BY d.created_at DESC LIMIT 1
  `).get(orderId) as (DisputeRecord & Record<string, unknown>) | null
}

export function getOpenDisputes(db: Database.Database): (DisputeRecord & Record<string, unknown>)[] {
  return db.prepare(`
    SELECT d.*,
      u1.name as initiator_name, u1.role as initiator_role,
      u2.name as defendant_name, u2.role as defendant_role,
      o.total_amount, o.status as order_status
    FROM disputes d
    LEFT JOIN users u1 ON d.initiator_id = u1.id
    LEFT JOIN users u2 ON d.defendant_id = u2.id
    LEFT JOIN orders o ON d.order_id = o.id
    WHERE d.status IN ('open', 'in_review')
    ORDER BY d.created_at ASC
  `).all() as (DisputeRecord & Record<string, unknown>)[]
}

// ─── 工具函数 ─────────────────────────────────────────────────

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

function getRulingDescription(ruling: string, refundAmount?: number): string {
  switch (ruling) {
    case 'refund_buyer':    return `全额退款 ${refundAmount ?? ''}DCP 给买家，扣押卖家一半保证金`
    case 'release_seller':  return '资金释放给卖家，交易完成'
    case 'partial_refund':  return `部分退款 ${refundAmount} DCP 给买家，余款归卖家`
    default: return ruling
  }
}
