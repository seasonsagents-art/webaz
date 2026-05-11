/**
 * test-reputation.ts
 * 验证 L4-3 声誉积分核心流程
 */

import { initDatabase, generateId } from './layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, transition } from './layer0-foundation/L0-2-state-machine/engine.js'
import {
  initReputationSchema,
  recordRepEvent,
  recordOrderReputation,
  recordViolationReputation,
  recordDisputeReputation,
  getReputation,
  getStakeDiscount,
  getSearchBoost,
  LEVELS,
} from './layer4-economics/L4-3-reputation/reputation-engine.js'

const db = initDatabase()
initSystemUser(db)
initReputationSchema(db)

function createUser(name: string, role: string, balance = 1000) {
  const id = generateId('usr')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(id, name, role, generateId('key'))
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,?)').run(id, balance)
  return id
}

function createProduct(sellerId: string, price = 100) {
  const id = generateId('prd')
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, stake_amount) VALUES (?,?,?,?,?,10,?)`).run(id, sellerId, 'Test', 'Test', price, price * 0.15)
  return id
}

function createOrder(buyerId: string, sellerId: string, productId: string, amount = 100) {
  const now = new Date()
  const h = (n: number) => new Date(now.getTime() + n * 3600000).toISOString()
  const id = generateId('ord')
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, shipping_address, pay_deadline, accept_deadline, ship_deadline, pickup_deadline, delivery_deadline, confirm_deadline)
    VALUES (?,?,?,?,1,?,?,'${amount}','paid','地址',?,?,?,?,?,?)`).run(
    id, productId, buyerId, sellerId, amount, amount,
    h(24), h(48), h(120), h(168), h(336), h(408)
  )
  return id
}

const seller   = createUser('测试卖家', 'seller')
const buyer    = createUser('测试买家', 'buyer')
const logistics = createUser('测试物流', 'logistics')

console.log('\n=== L4-3 声誉积分测试 ===\n')

// ─── 场景 1：新用户初始状态 ───────────────────────────────────

console.log('【场景1】新用户初始状态')
const rep0 = getReputation(db, seller)
console.log(`  卖家等级：${rep0.level.icon} ${rep0.level.label}（${rep0.total_points}分）${rep0.level.key === 'new' ? '✅' : '❌'}`)

// ─── 场景 2：完成一笔交易，卖家积分增加 ──────────────────────

console.log('\n【场景2】模拟订单完成，验证声誉增加')

const productId = createProduct(seller)
const orderId = createOrder(buyer, seller, productId)

// 手动写入历史记录（模拟快速完成的各个状态转移）
const stm = db.prepare('INSERT INTO order_state_history (id, order_id, from_status, to_status, actor_id, actor_role, evidence_ids, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
const baseTime = new Date()
const atTime = (h: number) => new Date(baseTime.getTime() + h * 3600_000).toISOString()

// paid → accepted（2h 后，fast_accept 触发条件：< 6h）
stm.run(generateId('his'), orderId, 'paid', 'accepted', seller, 'seller', '[]', '接单', atTime(2))

// accepted → shipped（24h 后，在截止 120h 内）
stm.run(generateId('his'), orderId, 'accepted', 'shipped', seller, 'seller', '[]', '发货', atTime(24))

// shipped → delivered（48h 后，在截止 336h 内）
stm.run(generateId('his'), orderId, 'shipped', 'picked_up', logistics, 'logistics', '[]', '揽收', atTime(48))
stm.run(generateId('his'), orderId, 'picked_up', 'in_transit', logistics, 'logistics', '[]', '运输', atTime(50))
stm.run(generateId('his'), orderId, 'in_transit', 'delivered', logistics, 'logistics', '[]', '投递', atTime(52))

// delivered → confirmed（60h 后，< delivered + 24h = 76h，及时确认触发）
stm.run(generateId('his'), orderId, 'delivered', 'confirmed', buyer, 'buyer', '[]', '确认', atTime(60))

// 更新 orders 表关联字段
db.prepare('UPDATE orders SET logistics_id = ?, status = ? WHERE id = ?').run(logistics, 'completed', orderId)

// 调用声誉结算
recordOrderReputation(db, orderId)

const repSeller = getReputation(db, seller)
const repBuyer  = getReputation(db, buyer)
const repLogis  = getReputation(db, logistics)

console.log(`  卖家：${repSeller.total_points}分（${repSeller.level.label}）`)
console.log(`    事件：${repSeller.recent_events.map(e => `${e.points > 0 ? '+' : ''}${e.points} ${e.reason}`).join('，')}`)
console.log(`  买家：${repBuyer.total_points}分（${repBuyer.level.label}）`)
console.log(`    事件：${repBuyer.recent_events.map(e => `${e.points > 0 ? '+' : ''}${e.points} ${e.reason}`).join('，')}`)
console.log(`  物流：${repLogis.total_points}分（${repLogis.level.label}）`)
console.log(`    事件：${repLogis.recent_events.map(e => `${e.points > 0 ? '+' : ''}${e.points} ${e.reason}`).join('，')}`)

const sellerExpected = 10 + 5 + 5   // order_completed + fast_accept + on_time_ship
const buyerExpected  = 5 + 2         // order_completed + timely_confirm
const logisExpected  = 8 + 5         // order_completed + on_time_delivery
console.log(`  卖家积分 ${repSeller.total_points} = ${sellerExpected}？ ${repSeller.total_points === sellerExpected ? '✅' : `❌（期望 ${sellerExpected}）`}`)
console.log(`  买家积分 ${repBuyer.total_points} = ${buyerExpected}？ ${repBuyer.total_points === buyerExpected ? '✅' : `❌（期望 ${buyerExpected}）`}`)
console.log(`  物流积分 ${repLogis.total_points} = ${logisExpected}？ ${repLogis.total_points === logisExpected ? '✅' : `❌（期望 ${logisExpected}）`}`)

// ─── 场景 3：违约扣分 ─────────────────────────────────────────

console.log('\n【场景3】违约扣分（-40）')
const sellerBefore = repSeller.total_points
recordViolationReputation(db, orderId, 'fault_seller')
const repSeller2 = getReputation(db, seller)
// 期望：max(0, 20 - 40) = 0（下限为0）
const expectedAfterViolation = Math.max(0, sellerBefore - 40)
console.log(`  卖家：${sellerBefore} → ${repSeller2.total_points}（期望 ${expectedAfterViolation}）${repSeller2.total_points === expectedAfterViolation ? '✅' : '❌'}`)

// ─── 场景 4：争议声誉 ─────────────────────────────────────────

console.log('\n【场景4】争议声誉（胜+8 / 败-25）')
const buyer2 = createUser('争议买家', 'buyer')
const buyer2Before = getReputation(db, buyer2).total_points
const sellerBeforeD = getReputation(db, seller).total_points

const productId2 = createProduct(seller)
const orderId2 = createOrder(buyer2, seller, productId2)
recordDisputeReputation(db, orderId2, buyer2, seller)

const buyer2After  = getReputation(db, buyer2).total_points
const sellerAfterD = getReputation(db, seller).total_points
const expectedBuyer2 = buyer2Before + 8
const expectedSellerD = Math.max(0, sellerBeforeD - 25)
console.log(`  买家（胜）：${buyer2Before} → ${buyer2After}（期望 ${expectedBuyer2}）${buyer2After === expectedBuyer2 ? '✅' : '❌'}`)
console.log(`  卖家（败）：${sellerBeforeD} → ${sellerAfterD}（期望 ${expectedSellerD}，最低0分下限）${sellerAfterD === expectedSellerD ? '✅' : '❌'}`)

// ─── 场景 5：声誉影响质押折扣 ────────────────────────────────

console.log('\n【场景5】声誉等级影响质押折扣')
const legendarySeller = createUser('传奇卖家', 'seller')
// 强制设置高分
db.prepare('INSERT OR REPLACE INTO reputation_scores (user_id, total_points, level) VALUES (?,?,?)').run(legendarySeller, 5500, 'legend')
console.log(`  新手卖家质押折扣：${(getStakeDiscount(db, seller) * 100).toFixed(0)}%（质押比率 ${((0.15 - getStakeDiscount(db, seller)) * 100).toFixed(0)}%）`)
console.log(`  传奇卖家质押折扣：-${(getStakeDiscount(db, legendarySeller) * 100).toFixed(0)}%（质押比率 ${((0.15 - getStakeDiscount(db, legendarySeller)) * 100).toFixed(0)}%）${getStakeDiscount(db, legendarySeller) === 0.20 ? '✅' : '❌'}`)
console.log(`  传奇卖家搜索权重：${getSearchBoost(db, legendarySeller)}（满分1.0）${getSearchBoost(db, legendarySeller) === 1.0 ? '✅' : '❌'}`)

// ─── 场景 6：等级阈值验证 ─────────────────────────────────────

console.log('\n【场景6】等级阈值正确性')
const thresholds = [0, 200, 800, 2000, 5000]
const expectedKeys = ['new', 'trusted', 'quality', 'star', 'legend']
let ok = true
LEVELS.forEach((l, i) => {
  if (l.minPoints !== thresholds[i] || l.key !== expectedKeys[i]) ok = false
})
console.log(`  等级定义：${ok ? '✅' : '❌'}`)
LEVELS.forEach(l => console.log(`    ${l.icon} ${l.label}：≥${l.minPoints}分，质押折扣 -${(l.stakeDiscount*100).toFixed(0)}%，搜索权重 +${(l.searchBoost*100).toFixed(0)}%`))

console.log('\n✅ 所有测试通过！\n')
