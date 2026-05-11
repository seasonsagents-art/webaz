/**
 * DCP 启动入口 & 模块测试
 */

import { initDatabase, generateId } from './layer0-foundation/L0-1-database/schema.js'
import { transition, checkTimeouts, getOrderStatus, initSystemUser } from './layer0-foundation/L0-2-state-machine/engine.js'

console.log('🦞 DCP — Decentralized Commerce Protocol')
console.log('─'.repeat(50))

const db = initDatabase()
const sysUser = initSystemUser(db)   // 确保系统用户存在

// ─── 测试 L0-2：完整交易状态机流转 ───────────────────────────

console.log('\n📋 测试 L0-2 状态机引擎\n')

// 1. 创建测试角色
const buyer    = createUser(db, '张三', 'buyer',    500)
const seller   = createUser(db, '李四店铺', 'seller', 200)
const logistic = createUser(db, '顺丰速运', 'logistics', 300)

// 2. 上架商品
const productId = generateId('prd')
db.prepare(`
  INSERT INTO products (id, seller_id, title, description, price, stake_amount)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(productId, seller.id, '手工皮质钱包', '意大利头层牛皮，手工缝制', 288, 50)

// 3. 创建订单
const orderId = generateId('ord')
const now = new Date()
db.prepare(`
  INSERT INTO orders (
    id, product_id, buyer_id, seller_id,
    quantity, unit_price, total_amount, escrow_amount,
    status,
    pay_deadline, accept_deadline, ship_deadline,
    pickup_deadline, delivery_deadline, confirm_deadline
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?)
`).run(
  orderId, productId, buyer.id, seller.id,
  1, 288, 288, 288,
  'created',
  addHours(now, 24),   // 24h 内付款
  addHours(now, 48),   // 付款后 24h 内接单
  addHours(now, 120),  // 接单后 72h 内发货
  addHours(now, 168),  // 发货后 48h 内揽收
  addHours(now, 336),  // 揽收后 7天内投递
  addHours(now, 408),  // 投递后 72h 内确认
)

console.log(`✅ 订单创建：${orderId}`)
console.log(`   商品：手工皮质钱包 ¥288`)
console.log(`   买家：${buyer.name}  →  卖家：${seller.name}\n`)

// ─── 跑一遍完整的正常流程 ──────────────────────────────────────

const steps = [
  {
    desc: '💳 买家付款',
    fn: () => transition(db, orderId, 'paid', buyer.id, [], '微信支付 ¥288')
  },
  {
    desc: '✅ 卖家接单',
    fn: () => transition(db, orderId, 'accepted', seller.id, [], '确认接单，3天内发货')
  },
  {
    desc: '📦 卖家发货（需要证据）',
    fn: () => {
      // 先创建一条证据记录
      const evidenceId = generateId('evt')
      db.prepare(`
        INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(evidenceId, orderId, seller.id, 'photo', '包裹外观照片+快递单', 'sha256_mock_abc123')
      return transition(db, orderId, 'shipped', seller.id, [evidenceId], '顺丰 SF1234567890')
    }
  },
  {
    desc: '🚚 物流揽收（需要证据）',
    fn: () => {
      const evidenceId = generateId('evt')
      db.prepare(`
        INSERT INTO evidence (id, order_id, uploader_id, type, description, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(evidenceId, orderId, logistic.id, 'gps', '揽收GPS坐标', '{"lat":31.23,"lng":121.47}')
      return transition(db, orderId, 'picked_up', logistic.id, [evidenceId], '已揽收，包裹完好')
    }
  },
  {
    desc: '🚛 开始运输',
    fn: () => transition(db, orderId, 'in_transit', logistic.id, [], '已发往上海转运中心')
  },
  {
    desc: '📬 物流投递（需要证据）',
    fn: () => {
      const evidenceId = generateId('evt')
      db.prepare(`
        INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(evidenceId, orderId, logistic.id, 'photo', '投递照片（含门牌号）', 'sha256_delivery_xyz789')
      return transition(db, orderId, 'delivered', logistic.id, [evidenceId], '已放前台，收件人已签收')
    }
  },
  {
    desc: '✅ 买家确认收货',
    fn: () => transition(db, orderId, 'confirmed', buyer.id, [], '商品完好，非常满意')
  },
  {
    desc: '💰 系统自动结算',
    fn: () => transition(db, orderId, 'completed', sysUser.id, [], '交易完成，资金自动分配')
  },
]

let allPassed = true
for (const step of steps) {
  const result = step.fn()
  if (result.success) {
    console.log(`  ${step.desc}`)
    console.log(`     状态 → ${result.newStatus}  [hist: ${result.historyId}]`)
  } else {
    console.log(`  ❌ ${step.desc} 失败：${result.error}`)
    allPassed = false
  }
}

// ─── 测试「拒绝非法操作」──────────────────────────────────────

console.log('\n🚫 测试非法操作（应该全部被拒绝）\n')

const illegalTests = [
  {
    desc: '物流方尝试取消买家的订单',
    fn: () => transition(db, orderId, 'cancelled', logistic.id)
  },
  {
    desc: '买家尝试直接跳到 completed',
    fn: () => transition(db, orderId, 'completed', buyer.id)
  },
  {
    desc: '卖家尝试把 completed 改回 paid',
    fn: () => transition(db, orderId, 'paid', seller.id)
  },
]

for (const test of illegalTests) {
  const result = test.fn()
  if (!result.success) {
    console.log(`  ✅ 正确拒绝：${test.desc}`)
    console.log(`     原因：${result.error}`)
  } else {
    console.log(`  ❌ 漏洞！非法操作被允许了：${test.desc}`)
    allPassed = false
  }
}

// ─── 查看完整状态历史 ─────────────────────────────────────────

console.log('\n📜 订单完整状态历史\n')
const status = getOrderStatus(db, orderId)!
for (const h of status.history as any[]) {
  console.log(`  ${h.from_status.padEnd(12)} → ${h.to_status.padEnd(12)} | ${h.actor_name}（${h.actor_role_name}）`)
}

// ─── 测试超时判责 ─────────────────────────────────────────────

console.log('\n⏰ 测试超时自动判责\n')

const orderId2 = generateId('ord')
db.prepare(`
  INSERT INTO orders (
    id, product_id, buyer_id, seller_id,
    quantity, unit_price, total_amount, escrow_amount, status,
    pay_deadline, accept_deadline, ship_deadline, pickup_deadline, delivery_deadline, confirm_deadline
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  orderId2, productId, buyer.id, seller.id,
  1, 288, 288, 288, 'paid',
  addHours(now, -48),  // 所有截止时间都已过
  addHours(now, -24),  // 卖家接单截止时间已过！
  addHours(now, -1),
  addHours(now, -1),
  addHours(now, -1),
  addHours(now, -1),
)

console.log(`  模拟场景：卖家超时未接单（截止时间已过 24 小时）`)
const timeoutResult = checkTimeouts(db)
console.log(`  处理了 ${timeoutResult.processed} 个超时订单`)
for (const d of timeoutResult.details) {
  console.log(`  ✅ ${d.orderId}：${d.action}`)
}

// ─── 最终结论 ─────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50))
if (allPassed) {
  console.log('✅ L0-1 数据库：正常')
  console.log('✅ L0-2 状态机：正常（完整流程 + 非法拦截 + 超时判责）')
} else {
  console.log('❌ 部分测试未通过，请检查上方输出')
}
console.log('─'.repeat(50))

// ─── 工具函数 ─────────────────────────────────────────────────

function createUser(db: Database.Database, name: string, role: string, balance: number) {
  const id = generateId('usr')
  const apiKey = generateId('key')
  db.prepare(`INSERT INTO users (id, name, role, api_key) VALUES (?, ?, ?, ?)`).run(id, name, role, apiKey)
  db.prepare(`INSERT INTO wallets (user_id, balance) VALUES (?, ?)`).run(id, balance)
  return { id, name, role, apiKey }
}

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}
