/**
 * L2-6 · 通知系统
 *
 * 每次订单状态变更后调用 notifyTransition()，
 * 自动判断通知哪些参与方，写入 notifications 表。
 * PWA 通过 SSE 实时接收；Agent 通过 dcp_notifications 工具轮询。
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'

// ─── Schema 初始化 ────────────────────────────────────────────

export function initNotificationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      order_id   TEXT REFERENCES orders(id),
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      read       INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);
  `)
}

// ─── 类型 ─────────────────────────────────────────────────────

export interface Notification {
  id: string
  user_id: string
  order_id: string | null
  type: string
  title: string
  body: string
  read: number
  created_at: string
}

// 实时推送回调（由 PWA server 注入，解耦依赖）
let pushCallback: ((userId: string, notif: Notification) => void) | null = null

export function setPushCallback(cb: (userId: string, notif: Notification) => void) {
  pushCallback = cb
}

// ─── 核心：状态变更 → 通知规则 ───────────────────────────────

interface NotifRule {
  recipients: Array<'buyer' | 'seller' | 'logistics' | 'arbitrators'>
  title: string
  body: (ctx: OrderCtx) => string
}

interface OrderCtx {
  buyerName: string
  sellerName: string
  productTitle: string
  totalAmount: number
  orderId: string
  logisticsName?: string
}

const RULES: Record<string, NotifRule> = {
  'created→paid': {
    recipients: ['seller'],
    title: '🛍️ 新订单',
    body: ctx => `${ctx.buyerName} 下单了「${ctx.productTitle}」，金额 ${ctx.totalAmount} DCP。请在 24h 内接单，否则自动退款。`,
  },
  'paid→accepted': {
    recipients: ['buyer'],
    title: '✅ 卖家已接单',
    body: ctx => `${ctx.sellerName} 已接受你的订单，预计 5 天内发货。`,
  },
  'paid→cancelled': {
    recipients: ['buyer'],
    title: '❌ 订单已取消',
    body: ctx => `订单「${ctx.productTitle}」已取消，${ctx.totalAmount} DCP 将原路退回。`,
  },
  'accepted→shipped': {
    recipients: ['buyer'],
    title: '📦 商品已发货',
    body: ctx => `${ctx.sellerName} 已发货，物流 48h 内揽收后你可以追踪包裹。`,
  },
  'shipped→picked_up': {
    recipients: ['buyer', 'seller'],
    title: '🚚 物流已揽收',
    body: ctx => `包裹已由${ctx.logisticsName ?? '物流方'}揽收，正在运输中。`,
  },
  'in_transit→delivered': {
    recipients: ['buyer'],
    title: '📬 包裹已投递',
    body: ctx => `你的包裹已送达，请确认收货。72 小时内未确认将自动完成。`,
  },
  'delivered→confirmed': {
    recipients: ['seller'],
    title: '💰 买家确认收货',
    body: ctx => `${ctx.buyerName} 已确认收货，${ctx.totalAmount} DCP 结算中。`,
  },
  'confirmed→completed': {
    recipients: ['seller'],
    title: '✅ 交易完成，资金到账',
    body: ctx => `订单「${ctx.productTitle}」交易完成，收益已入账，查看钱包确认。`,
  },
  'paid→disputed': {
    recipients: ['seller'],
    title: '⚠️ 买家发起争议',
    body: ctx => `${ctx.buyerName} 对订单「${ctx.productTitle}」发起了争议。请在 48 小时内提交反驳证据，否则协议自动裁定退款。`,
  },
  'accepted→disputed': {
    recipients: ['seller'],
    title: '⚠️ 买家发起争议',
    body: ctx => `${ctx.buyerName} 对订单「${ctx.productTitle}」发起了争议，请在 48h 内回应。`,
  },
  'shipped→disputed': {
    recipients: ['seller', 'logistics'],
    title: '⚠️ 发生争议',
    body: ctx => `订单「${ctx.productTitle}」出现争议，请提交相关证据。`,
  },
  'in_transit→disputed': {
    recipients: ['seller', 'logistics'],
    title: '⚠️ 运输中发生争议',
    body: ctx => `订单「${ctx.productTitle}」运输过程中发生争议，请及时回应。`,
  },
  'delivered→disputed': {
    recipients: ['seller'],
    title: '⚠️ 买家对收货发起争议',
    body: ctx => `${ctx.buyerName} 声称货物有问题，已发起争议。请在 48h 内提交证据。`,
  },
  'disputed→completed': {
    recipients: ['buyer', 'seller'],
    title: '⚖️ 争议裁定：卖家胜诉',
    body: ctx => `订单「${ctx.productTitle}」争议已裁定，资金已释放给卖家。`,
  },
  'disputed→cancelled': {
    recipients: ['buyer', 'seller'],
    title: '⚖️ 争议裁定：退款买家',
    body: ctx => `订单「${ctx.productTitle}」争议已裁定，${ctx.totalAmount} DCP 已退回买家。`,
  },
  'paid→fault_seller': {
    recipients: ['buyer', 'seller'],
    title: '⏰ 卖家超时违约',
    body: ctx => `卖家超时未接单，订单已自动取消，${ctx.totalAmount} DCP 退款处理中。`,
  },
  'accepted→fault_seller': {
    recipients: ['buyer', 'seller'],
    title: '⏰ 卖家超时未发货',
    body: ctx => `卖家超时未发货，订单已判违约，资金退回。`,
  },
  'in_transit→fault_logistics': {
    recipients: ['buyer', 'seller'],
    title: '⏰ 物流超时',
    body: ctx => `物流方超时未完成投递，已自动记录违约。`,
  },
}

// ─── 主入口：状态变更后调用 ───────────────────────────────────

export function notifyTransition(
  db: Database.Database,
  orderId: string,
  fromStatus: string,
  toStatus: string,
): void {
  const rule = RULES[`${fromStatus}→${toStatus}`]
  if (!rule) return  // 没有规则的转移不发通知

  // 查询订单上下文
  const ctx = getOrderCtx(db, orderId)
  if (!ctx) return

  const title = rule.title
  const body  = rule.body(ctx)
  const type  = `${fromStatus}→${toStatus}`

  // 确定收件人 ID 列表
  const recipientIds = resolveRecipients(db, rule.recipients, ctx, orderId)

  for (const userId of recipientIds) {
    createNotification(db, userId, orderId, type, title, body)
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────

function getOrderCtx(db: Database.Database, orderId: string): OrderCtx | null {
  const row = db.prepare(`
    SELECT o.buyer_id, o.seller_id, o.logistics_id, o.total_amount,
           ub.name as buyer_name, us.name as seller_name,
           ul.name as logistics_name, p.title as product_title
    FROM orders o
    JOIN users ub ON o.buyer_id = ub.id
    JOIN users us ON o.seller_id = us.id
    LEFT JOIN users ul ON o.logistics_id = ul.id
    LEFT JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `).get(orderId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    orderId,
    buyerName:     row.buyer_name as string,
    sellerName:    row.seller_name as string,
    logisticsName: row.logistics_name as string | undefined,
    productTitle:  row.product_title as string,
    totalAmount:   row.total_amount as number,
  }
}

function resolveRecipients(
  db: Database.Database,
  roles: NotifRule['recipients'],
  ctx: OrderCtx,
  orderId: string
): string[] {
  const ids = new Set<string>()
  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?').get(orderId) as Record<string, string | null>

  for (const role of roles) {
    if (role === 'buyer'      && order.buyer_id)      ids.add(order.buyer_id)
    if (role === 'seller'     && order.seller_id)     ids.add(order.seller_id)
    if (role === 'logistics'  && order.logistics_id)  ids.add(order.logistics_id)
    if (role === 'arbitrators') {
      const arbs = db.prepare("SELECT id FROM users WHERE role = 'arbitrator'").all() as { id: string }[]
      arbs.forEach(a => ids.add(a.id))
    }
  }
  return [...ids]
}

export function createNotification(
  db: Database.Database,
  userId: string,
  orderId: string | null,
  type: string,
  title: string,
  body: string,
): Notification {
  const notif: Notification = {
    id: generateId('ntf'),
    user_id: userId,
    order_id: orderId,
    type,
    title,
    body,
    read: 0,
    created_at: new Date().toISOString(),
  }
  db.prepare(`
    INSERT INTO notifications (id, user_id, order_id, type, title, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(notif.id, userId, orderId, type, title, body)

  // 实时推送（如果 PWA SSE 连接在线）
  pushCallback?.(userId, notif)

  return notif
}

// ─── 查询 ─────────────────────────────────────────────────────

export function getNotifications(
  db: Database.Database,
  userId: string,
  onlyUnread = false,
  limit = 30
): Notification[] {
  const sql = `SELECT * FROM notifications WHERE user_id = ?${onlyUnread ? ' AND read = 0' : ''}
    ORDER BY created_at DESC LIMIT ?`
  return db.prepare(sql).all(userId, limit) as Notification[]
}

export function getUnreadCount(db: Database.Database, userId: string): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read = 0').get(userId) as { n: number }
  return row.n
}

export function markRead(db: Database.Database, userId: string, notifId?: string): void {
  if (notifId) {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notifId, userId)
  } else {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId)
  }
}
