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
  respond_deadline: string | null
  arbitrate_deadline: string | null
  assigned_arbitrators: string     // JSON 数组
  verdict: string | null
  verdict_reason: string | null
  ruling_type: string | null
  refund_amount: number | null
  party_evidence_ids: string       // JSON 数组（参与方主动举证）
  liability_parties: string        // JSON 数组（责任分配裁定）
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
    // Phase 1 新增：多方举证 + 责任分配
    `ALTER TABLE disputes ADD COLUMN party_evidence_ids TEXT DEFAULT '[]'`,
    `ALTER TABLE disputes ADD COLUMN liability_parties TEXT DEFAULT '[]'`,
  ]
  for (const stmt of newColumns) {
    try { db.exec(stmt) } catch { /* 列已存在，跳过 */ }
  }
}

/** 任意参与方（非被告）主动提交证据 */
export function addPartyEvidence(
  db: Database.Database,
  disputeId: string,
  submitterId: string,
  description: string,
  evidenceType: EvidenceType = 'text',
  fileHash?: string
): { success: boolean; evidenceId?: string; anchorHash?: string; error?: string } {
  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId) as DisputeRecord | undefined
  if (!dispute) return { success: false, error: '争议不存在' }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已结案' }
  }

  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as Record<string, string | null> | undefined
  const partyIds = [order?.buyer_id, order?.seller_id, order?.logistics_id,
                    dispute.initiator_id, dispute.defendant_id].filter(Boolean) as string[]
  if (!partyIds.includes(submitterId)) {
    return { success: false, error: '你不是此争议的参与方' }
  }

  const anchorHash = fileHash || generateAnchorHash(description)
  const eid = generateId('evt')
  db.prepare(
    `INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,?,?,?)`
  ).run(eid, dispute.order_id, submitterId, evidenceType, description, anchorHash)

  const existing: string[] = JSON.parse(dispute.party_evidence_ids || '[]')
  existing.push(eid)
  db.prepare(`UPDATE disputes SET party_evidence_ids = ? WHERE id = ?`).run(JSON.stringify(existing), disputeId)

  return { success: true, evidenceId: eid, anchorHash }
}

// ─── L3-1 争议触发 ────────────────────────────────────────────

/**
 * 创建争议记录
 * 在 webaz_update_order action=dispute 之后调用，写入 disputes 表
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
  if (order.status !== 'disputed') return { success: false, error: '订单尚未进入争议状态，请先调用 webaz_update_order action=dispute' }

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
export interface LiabilityEntry {
  user_id: string
  role: string
  amount: number          // 该方应承担的赔偿金额
  insurance_cap?: number  // 保险兜底上限（物流方可用），超额由协议垫付
}

export function arbitrateDispute(
  db: Database.Database,
  disputeId: string,
  arbitratorId: string,
  ruling: 'refund_buyer' | 'release_seller' | 'partial_refund' | 'liability_split',
  reason: string,
  refundAmount?: number,
  liabilityParties?: LiabilityEntry[],
  liablePartyId?: string   // 指定责任方 user_id（用于 partial_refund 第三方责任场景）
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
  const settlement = ruling === 'liability_split' && liabilityParties
    ? executeLiabilitySplit(db, dispute.order_id, liabilityParties, refundAmount)
    : executeSettlement(db, dispute.order_id, ruling, refundAmount, liablePartyId)
  if (!settlement.success) return { success: false, error: settlement.error }

  // 收取仲裁费（败诉/责任方付 1%，最低 1 WAZ）
  const order = db.prepare('SELECT total_amount, buyer_id, seller_id FROM orders WHERE id = ?')
    .get(dispute.order_id) as { total_amount: number; buyer_id: string; seller_id: string } | undefined
  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
  const arbFees: Record<string, number> = {}

  if (order) {
    const amt = order.total_amount
    if (ruling === 'refund_buyer') {
      const f = chargeArbitrationFee(db, order.seller_id, amt, arbitratorId, sysUser.id)
      if (f.fee > 0) arbFees[order.seller_id] = f.fee
    } else if (ruling === 'release_seller') {
      const f = chargeArbitrationFee(db, order.buyer_id, amt, arbitratorId, sysUser.id)
      if (f.fee > 0) arbFees[order.buyer_id] = f.fee
    } else if (ruling === 'partial_refund') {
      // 有指定责任方：仲裁费全由责任方承担
      // 无责任方：买卖双方各付 0.5%
      const payerId = liablePartyId ?? null
      if (payerId) {
        const f = chargeArbitrationFee(db, payerId, amt, arbitratorId, sysUser.id)
        if (f.fee > 0) arbFees[payerId] = f.fee
      } else {
        const halfAmt = amt * 0.5
        const fb = chargeArbitrationFee(db, order.buyer_id,  halfAmt, arbitratorId, sysUser.id)
        const fs = chargeArbitrationFee(db, order.seller_id, halfAmt, arbitratorId, sysUser.id)
        if (fb.fee > 0) arbFees[order.buyer_id]  = fb.fee
        if (fs.fee > 0) arbFees[order.seller_id] = fs.fee
      }
    } else if (ruling === 'liability_split' && liabilityParties) {
      const totalLiability = liabilityParties.reduce((s, p) => s + p.amount, 0) || amt
      for (const p of liabilityParties) {
        const share = (p.amount / totalLiability) * amt
        const f = chargeArbitrationFee(db, p.user_id, share, arbitratorId, sysUser.id)
        if (f.fee > 0) arbFees[p.user_id] = (arbFees[p.user_id] ?? 0) + f.fee
      }
    }
  }

  // 更新争议记录
  db.prepare(`
    UPDATE disputes SET
      status = 'resolved',
      verdict = ?,
      verdict_reason = ?,
      ruling_type = ?,
      refund_amount = ?,
      liability_parties = ?,
      resolved_at = datetime('now')
    WHERE id = ?
  `).run(
    ruling, reason, ruling, refundAmount ?? null,
    JSON.stringify(liabilityParties ?? []),
    disputeId
  )

  return {
    success: true,
    message: `裁定已执行：${getRulingDescription(ruling, refundAmount)}`,
    settlement: {
      ...settlement.detail,
      arbitration_fees: arbFees,
    },
  }
}

/**
 * 执行多方责任分配结算
 *
 * 资金流模型：
 *  A) 托管资金（买家原款）：
 *     - 买家获得 actualRefund（从托管中拨还）
 *     - 卖家获得 totalAmount - actualRefund（托管剩余，若无责任则取回全额）
 *
 *  B) 责任罚款（惩戒性）：每个责任方按各自金额被扣款，扣款进入协议金库
 *     - 先扣质押，不足再扣余额
 *     - 物流方可设 insurance_cap：超出上限的部分由协议金库垫付（买家仍足额赔付）
 *
 *  C) 卖家商品质押：
 *     - 若卖家未列入责任方，质押全额返还
 *     - 若卖家列入责任方，按责任金额比例扣罚，剩余返还
 *
 * 这样确保托管资金守恒（无凭空创造/销毁），责任方额外受罚（去向：sys_protocol）。
 */
function executeLiabilitySplit(
  db: Database.Database,
  orderId: string,
  liabilityParties: LiabilityEntry[],
  buyerRefund?: number
): { success: boolean; error?: string; detail?: Record<string, unknown> } {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown> | undefined
  if (!order) return { success: false, error: '订单不存在' }

  const totalAmount = order.total_amount as number
  const buyerId     = order.buyer_id as string
  const sellerId    = order.seller_id as string
  const sysUser     = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }

  const product = db.prepare('SELECT stake_amount FROM products WHERE id = ?')
    .get(order.product_id as string) as { stake_amount: number } | undefined
  const stakeAmount = product?.stake_amount ?? 0

  const actualRefund = Math.min(buyerRefund ?? totalAmount, totalAmount)
  const sellerEscrowShare = Math.round((totalAmount - actualRefund) * 100) / 100

  // 预先计算各责任方实际扣款（资金守恒：责任方扣款 = 协议金库收入）
  const settled: Array<{
    userId: string; role: string; owed: number
    actualPenalty: number; insuranceCovered: number
  }> = []

  for (const entry of liabilityParties) {
    const wallet = db.prepare('SELECT balance, staked FROM wallets WHERE user_id = ?')
      .get(entry.user_id) as { balance: number; staked: number } | undefined
    const available = (wallet?.balance ?? 0) + (wallet?.staked ?? 0)

    let actualPenalty: number
    let insuranceCovered = 0

    if (entry.insurance_cap !== undefined && entry.insurance_cap < entry.amount) {
      // 有保险上限：责任方最多赔 insurance_cap，不足部分由协议垫付
      actualPenalty = Math.min(entry.insurance_cap, available)
      insuranceCovered = entry.amount - entry.insurance_cap  // 协议垫付
    } else {
      // 无保险上限：以实际可用余额为上限
      actualPenalty = Math.min(entry.amount, available)
      insuranceCovered = entry.amount - actualPenalty       // 余额不足部分
    }

    settled.push({ userId: entry.user_id, role: entry.role, owed: entry.amount, actualPenalty, insuranceCovered })
  }

  // 卖家是否在责任方列表中
  const sellerLiability = liabilityParties.find(p => p.user_id === sellerId)

  db.transaction(() => {
    // ── A. 托管拨付 ──────────────────────────────────────────────
    // 释放买家托管，退还 actualRefund 给买家，剩余给卖家
    db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(totalAmount, buyerId)
    if (actualRefund > 0) {
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(actualRefund, buyerId)
    }
    if (sellerEscrowShare > 0) {
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(sellerEscrowShare, sellerId)
    }

    // ── B. 责任罚款 → 协议金库 ────────────────────────────────────
    let totalToTreasury = 0
    for (const s of settled) {
      if (s.actualPenalty > 0) {
        const w = db.prepare('SELECT balance, staked FROM wallets WHERE user_id = ?')
          .get(s.userId) as { balance: number; staked: number }
        if (w.staked >= s.actualPenalty) {
          db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(s.actualPenalty, s.userId)
        } else {
          const fromStake   = w.staked
          const fromBalance = s.actualPenalty - fromStake
          db.prepare('UPDATE wallets SET staked = 0, balance = balance - ? WHERE user_id = ?').run(fromBalance, s.userId)
        }
        totalToTreasury += s.actualPenalty
      }
    }
    if (totalToTreasury > 0) {
      db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(totalToTreasury, sysUser.id)
    }

    // ── C. 卖家商品质押处理 ───────────────────────────────────────
    if (stakeAmount > 0) {
      if (sellerLiability) {
        // 卖家有责：按责任金额比例扣罚质押，剩余返还
        const stakeForfeited = Math.min(stakeAmount, sellerLiability.amount)
        const stakeReturn    = stakeAmount - stakeForfeited
        db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(stakeAmount, sellerId)
        if (stakeReturn > 0) {
          db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(stakeReturn, sellerId)
        }
        if (stakeForfeited > 0) {
          db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(stakeForfeited, sysUser.id)
        }
      } else {
        // 卖家无责：全额返还质押
        db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?')
          .run(stakeAmount, stakeAmount, sellerId)
      }
    }

    transition(db, orderId, 'cancelled', sysUser.id, [], `争议裁定：责任分配，退款买家 ${actualRefund} WAZ`)
  })()

  return {
    success: true,
    detail: {
      ruling: 'liability_split',
      buyer_refund: actualRefund,
      seller_escrow_share: sellerEscrowShare,
      liability_breakdown: settled.map(s => ({
        userId: s.userId, role: s.role,
        owed: s.owed, actualPenalty: s.actualPenalty, insuranceCovered: s.insuranceCovered
      })),
    }
  }
}

// ─── L3-5 资金处置执行 ────────────────────────────────────────

// ─── 仲裁费收取 ───────────────────────────────────────────────

/**
 * 向败诉方收取仲裁费：订单金额的 1%（最低 1 WAZ）
 * - 有人工仲裁员时：50% 给仲裁员作为激励，50% 归协议
 * - 自动裁定时：100% 归协议
 * - 先扣质押，质押不足再扣余额
 */
function chargeArbitrationFee(
  db: Database.Database,
  loserId: string,
  orderAmount: number,
  arbitratorId: string,
  sysUserId: string,
): { fee: number; arbitratorShare: number; protocolShare: number } {
  const fee = Math.max(1, Math.round(orderAmount * 0.01 * 100) / 100)
  const isHumanArbitrator = arbitratorId !== sysUserId

  const wallet = db.prepare('SELECT balance, staked FROM wallets WHERE user_id = ?')
    .get(loserId) as { balance: number; staked: number } | undefined
  const available = (wallet?.balance ?? 0) + (wallet?.staked ?? 0)
  const actualFee = Math.min(fee, available)
  if (actualFee <= 0) return { fee: 0, arbitratorShare: 0, protocolShare: 0 }

  // 扣款：先质押后余额
  const staked = wallet?.staked ?? 0
  if (staked >= actualFee) {
    db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(actualFee, loserId)
  } else {
    const fromBalance = actualFee - staked
    db.prepare('UPDATE wallets SET staked = 0, balance = balance - ? WHERE user_id = ?').run(fromBalance, loserId)
  }

  // 分配：人工仲裁各一半，自动裁定全归协议
  const arbitratorShare = isHumanArbitrator ? Math.round(actualFee * 0.5 * 100) / 100 : 0
  const protocolShare = actualFee - arbitratorShare

  if (protocolShare > 0) {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(protocolShare, sysUserId)
  }
  if (arbitratorShare > 0) {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(arbitratorShare, arbitratorId)
  }

  return { fee: actualFee, arbitratorShare, protocolShare }
}

function executeSettlement(
  db: Database.Database,
  orderId: string,
  ruling: string,
  refundAmount?: number,
  liablePartyId?: string
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
      transition(db, orderId, 'cancelled', sysUser.id, [], `争议裁定：退款买家，质押惩罚 ${penalty} WAZ`)
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
    const refund = refundAmount ?? Math.round(totalAmount * 0.5 * 100) / 100
    if (refund > totalAmount) return { success: false, error: `退款金额 ${refund} 超出订单总额 ${totalAmount}` }

    if (liablePartyId) {
      // ── 第三方责任 partial_refund ────────────────────────────────
      // 卖家全额结算（正常收款），买家赔偿由责任方钱包直接支付
      const protocolFee  = Math.round(totalAmount * 0.02 * 100) / 100
      const logisticsFee = order.logistics_id ? Math.round(totalAmount * 0.05 * 100) / 100 : 0
      const sellerAmount = totalAmount - protocolFee - logisticsFee

      // 检查责任方余额是否足够
      const liableWallet = db.prepare('SELECT balance, staked FROM wallets WHERE user_id = ?')
        .get(liablePartyId) as { balance: number; staked: number } | undefined
      const liableAvailable = (liableWallet?.balance ?? 0) + (liableWallet?.staked ?? 0)
      const actualRefund = Math.min(refund, liableAvailable)

      db.transaction(() => {
        // 1. 释放托管 → 正常结算给卖家
        db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(totalAmount, buyerId)
        db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(sellerAmount, sellerId)
        if (order.logistics_id && logisticsFee > 0) {
          db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(logisticsFee, order.logistics_id as string)
        }
        // 2. 返还卖家质押
        if (stakeAmount > 0) {
          db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?')
            .run(stakeAmount, stakeAmount, sellerId)
        }
        // 3. 从责任方钱包扣除赔偿（先质押后余额）
        if (actualRefund > 0) {
          const liableStaked = liableWallet?.staked ?? 0
          if (liableStaked >= actualRefund) {
            db.prepare('UPDATE wallets SET staked = staked - ? WHERE user_id = ?').run(actualRefund, liablePartyId)
          } else {
            const fromBalance = actualRefund - liableStaked
            db.prepare('UPDATE wallets SET staked = 0, balance = balance - ? WHERE user_id = ?').run(fromBalance, liablePartyId)
          }
          // 4. 赔偿金给买家
          db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(actualRefund, buyerId)
        }
        transition(db, orderId, 'completed', sysUser.id, [], `争议裁定：第三方责任赔偿 ${actualRefund} WAZ，卖家全额结算`)
      })()

      return {
        success: true,
        detail: {
          ruling: 'partial_refund',
          liable_party: liablePartyId,
          buyer_compensation: actualRefund,
          seller_received: sellerAmount,
          logistics_fee: logisticsFee,
          protocol_fee: protocolFee,
          seller_stake_returned: stakeAmount,
        }
      }

    } else {
      // ── 买卖双方协商 partial_refund（原逻辑）───────────────────────
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
        transition(db, orderId, 'cancelled', sysUser.id, [], `争议裁定：部分退款 ${refund} WAZ`)
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
  details: Array<{ disputeId: string; action: string; orderId?: string; winnerId?: string; loserId?: string }>
} {
  const now = new Date().toISOString()
  const details: Array<{ disputeId: string; action: string; orderId?: string; winnerId?: string; loserId?: string }> = []

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
        details.push({
          disputeId: dispute.id,
          action: `被告超时 → ${ruling}`,
          orderId: dispute.order_id,
          winnerId: dispute.initiator_id,
          loserId: dispute.defendant_id ?? undefined,
        })
      }

    } else if (dispute.status === 'in_review' && dispute.arbitrate_deadline && now > dispute.arbitrate_deadline) {
      // 仲裁员超时未裁定 → 买家保护原则，默认退款
      const r = arbitrateDispute(db, dispute.id, sysUser.id, 'refund_buyer', '仲裁员超时未裁定，协议默认退款买家（买家保护原则）')
      if (r.success) {
        // 默认退款买家 → 买家胜，被告（卖家）败
        details.push({
          disputeId: dispute.id,
          action: '仲裁超时 → 默认退款买家',
          orderId: dispute.order_id,
          winnerId: dispute.initiator_id,
          loserId: dispute.defendant_id ?? undefined,
        })
      }
    }
  }

  return { processed: details.length, details }
}

// ─── L3-2 扩展：证据补充请求系统 ────────────────────────────────

export type EvidenceType = 'text' | 'image' | 'video' | 'document' | 'chain_data'

export interface EvidenceRequest {
  id: string
  dispute_id: string
  requested_from_id: string
  requested_from_name?: string
  requested_from_role?: string
  evidence_types: string        // JSON 数组
  description: string
  deadline: string
  status: 'pending' | 'submitted' | 'expired'
  submitted_evidence_ids: string // JSON 数组
  created_at: string
}

export function initEvidenceRequestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispute_evidence_requests (
      id                    TEXT PRIMARY KEY,
      dispute_id            TEXT NOT NULL,
      requested_from_id     TEXT NOT NULL,
      evidence_types        TEXT DEFAULT '["text"]',
      description           TEXT NOT NULL,
      deadline              TEXT NOT NULL,
      status                TEXT DEFAULT 'pending',
      submitted_evidence_ids TEXT DEFAULT '[]',
      created_at            TEXT DEFAULT (datetime('now'))
    )
  `)
}

/**
 * 仲裁员向任意角色发出"补充证据"请求
 */
export function requestEvidence(
  db: Database.Database,
  disputeId: string,
  arbitratorId: string,
  requestedFromId: string,
  evidenceTypes: EvidenceType[],
  description: string,
  deadlineHours = 48
): { success: boolean; requestId?: string; error?: string } {
  const arb = db.prepare('SELECT role FROM users WHERE id = ?').get(arbitratorId) as { role: string } | undefined
  if (!arb || (arb.role !== 'arbitrator' && arb.role !== 'system')) {
    return { success: false, error: '仅仲裁员可发出证据请求' }
  }
  const dispute = db.prepare('SELECT status FROM disputes WHERE id = ?').get(disputeId) as { status: string } | undefined
  if (!dispute) return { success: false, error: '争议不存在' }
  if (dispute.status === 'resolved' || dispute.status === 'dismissed') {
    return { success: false, error: '该争议已结案' }
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(requestedFromId)
  if (!target) return { success: false, error: '指定用户不存在' }

  const requestId = generateId('evr')
  db.prepare(`
    INSERT INTO dispute_evidence_requests
      (id, dispute_id, requested_from_id, evidence_types, description, deadline)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(requestId, disputeId, requestedFromId, JSON.stringify(evidenceTypes), description, addHours(new Date(), deadlineHours))

  // 若争议仍在 open 状态，自动推进到 in_review
  if (dispute.status === 'open') {
    db.prepare(`UPDATE disputes SET status = 'in_review' WHERE id = ?`).run(disputeId)
  }

  return { success: true, requestId }
}

/**
 * 被要求方提交证据（响应某条请求）
 */
export function submitEvidenceForRequest(
  db: Database.Database,
  requestId: string,
  submitterId: string,
  evidenceType: EvidenceType,
  description: string,
  fileHash?: string
): { success: boolean; evidenceId?: string; anchorHash?: string; error?: string } {
  const req = db.prepare('SELECT * FROM dispute_evidence_requests WHERE id = ?').get(requestId) as EvidenceRequest | undefined
  if (!req) return { success: false, error: '证据请求不存在' }
  if (req.requested_from_id !== submitterId) return { success: false, error: '你不是此请求的被要求方' }
  if (req.status !== 'pending') return { success: false, error: '此请求已关闭（已提交或已过期）' }
  if (new Date() > new Date(req.deadline)) return { success: false, error: '提交截止时间已过' }

  const dispute = db.prepare('SELECT order_id FROM disputes WHERE id = ?').get(req.dispute_id) as { order_id: string }
  // 生成锚定哈希（Phase 0 模拟；Phase 2 替换为 IPFS CID 或链上 TX）
  const anchorHash = fileHash || generateAnchorHash(description)
  const eid = generateId('evt')

  db.prepare(`
    INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eid, dispute.order_id, submitterId, evidenceType, description, anchorHash)

  const current: string[] = JSON.parse(req.submitted_evidence_ids || '[]')
  current.push(eid)
  db.prepare(`
    UPDATE dispute_evidence_requests
    SET status = 'submitted', submitted_evidence_ids = ?
    WHERE id = ?
  `).run(JSON.stringify(current), requestId)

  return { success: true, evidenceId: eid, anchorHash }
}

/**
 * 查询争议的所有证据请求（含已提交内容）
 */
export function getEvidenceRequests(
  db: Database.Database,
  disputeId: string
): (EvidenceRequest & Record<string, unknown>)[] {
  const rows = db.prepare(`
    SELECT r.*, u.name as requested_from_name, u.role as requested_from_role
    FROM dispute_evidence_requests r
    LEFT JOIN users u ON r.requested_from_id = u.id
    WHERE r.dispute_id = ?
    ORDER BY r.created_at ASC
  `).all(disputeId) as (EvidenceRequest & Record<string, unknown>)[]

  return rows.map(r => {
    const ids: string[] = JSON.parse(r.submitted_evidence_ids || '[]')
    const items = ids.length
      ? db.prepare(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : []
    return { ...r, submitted_items: items }
  })
}

/** 生成锚定哈希（Phase 0 模拟；Phase 2 用 IPFS/链上替换） */
function generateAnchorHash(content: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  const ts = Date.now().toString(16)
  return `0x${h.toString(16).padStart(8, '0')}${ts}`
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
    case 'refund_buyer':    return `全额退款 ${refundAmount ?? ''}WAZ 给买家，扣押卖家一半保证金`
    case 'release_seller':  return '资金释放给卖家，交易完成'
    case 'partial_refund':  return `部分退款 ${refundAmount} WAZ 给买家，余款归卖家`
    default: return ruling
  }
}
