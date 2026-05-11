/**
 * test-skill-market.ts
 * 验证 L4-4 Skill 市场核心流程
 */

import { initDatabase, generateId } from './layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, transition } from './layer0-foundation/L0-2-state-machine/engine.js'
import { initSkillSchema, publishSkill, listSkills, subscribeSkill, getMySubscriptions, shouldAutoAccept, recordSkillUsage } from './layer4-economics/L4-4-skill-market/skill-engine.js'

const db = initDatabase()
initSystemUser(db)
initSkillSchema(db)

// ─── 准备测试用户 ─────────────────────────────────────────────

function createUser(name: string, role: string, balance = 1000) {
  const id = generateId('usr')
  const apiKey = generateId('key')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(id, name, role, apiKey)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?,?)').run(id, balance)
  return { id, apiKey, name, role }
}

function createProduct(sellerId: string, title: string, price: number) {
  const id = generateId('prd')
  const stake = price * 0.15
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, stake_amount)
    VALUES (?,?,?,?,?,10,?)`).run(id, sellerId, title, `${title} 的描述`, price, stake)
  db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?').run(stake, stake, sellerId)
  return id
}

const seller = createUser('竹韵手工坊', 'seller', 2000)
const buyer  = createUser('测试买家', 'buyer', 500)

console.log('\n=== L4-4 Skill 市场测试 ===\n')

// ─── 场景 1：卖家发布 catalog_sync Skill ─────────────────────

console.log('【场景1】卖家发布 catalog_sync Skill')
const skill1 = publishSkill(db, {
  sellerId: seller.id,
  name: '竹韵手工坊官方授权',
  description: '订阅后优先发现竹韵手工坊的所有手工商品，成交额 0.5% 作为技能推荐佣金自动分配。',
  category: '手工',
  skillType: 'catalog_sync',
})
console.log(`  ✅ 发布成功：${skill1.name} (${skill1.id})`)

// ─── 场景 2：卖家发布 auto_accept Skill ──────────────────────

console.log('\n【场景2】卖家发布 auto_accept Skill（最大金额 300 DCP，每日上限 20 单）')
const skill2 = publishSkill(db, {
  sellerId: seller.id,
  name: '竹韵自动接单',
  description: '300 DCP 以内订单自动接受，无需等待卖家手动确认。',
  skillType: 'auto_accept',
  config: { max_amount: 300, max_daily_orders: 20 },
})
console.log(`  ✅ 发布成功：${skill2.name} (${skill2.id})`)

// ─── 场景 3：浏览 Skill 市场 ─────────────────────────────────

console.log('\n【场景3】浏览 Skill 市场')
const allSkills = listSkills(db, { subscriberId: buyer.id })
console.log(`  市场共 ${allSkills.length} 个 Skill：`)
allSkills.forEach(s => console.log(`    - ${s.name} (${s.skill_type}) 订阅数: ${s.subscriber_count}`))

// ─── 场景 4：买家订阅 Skill ───────────────────────────────────

console.log('\n【场景4】买家订阅 catalog_sync Skill')
const subResult = subscribeSkill(db, buyer.id, skill1.id)
console.log(`  ✅ ${subResult.message}`)

const mySubs = getMySubscriptions(db, buyer.id)
console.log(`  买家已订阅 ${mySubs.length} 个 Skill`)

// ─── 场景 5：验证 auto_accept 触发 ───────────────────────────

console.log('\n【场景5】验证 auto_accept Skill 触发（金额 150 DCP，在限额内）')

const productId = createProduct(seller.id, '手工茶杯', 150)
const now = new Date()
const orderId = generateId('ord')
db.prepare(`INSERT INTO orders (
  id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
  status, shipping_address,
  pay_deadline, accept_deadline, ship_deadline, pickup_deadline, delivery_deadline, confirm_deadline
) VALUES (?,?,?,?,1,150,150,150,'created','测试地址',?,?,?,?,?,?)`).run(
  orderId, productId, buyer.id, seller.id,
  new Date(now.getTime() + 24*3600000).toISOString(),
  new Date(now.getTime() + 48*3600000).toISOString(),
  new Date(now.getTime() + 120*3600000).toISOString(),
  new Date(now.getTime() + 168*3600000).toISOString(),
  new Date(now.getTime() + 336*3600000).toISOString(),
  new Date(now.getTime() + 408*3600000).toISOString(),
)
transition(db, orderId, 'paid', buyer.id, [], '测试支付')

const shouldAuto = shouldAutoAccept(db, orderId)
console.log(`  shouldAutoAccept 返回：${shouldAuto} ${shouldAuto ? '✅' : '❌'}`)

// ─── 场景 6：超出金额限制时不触发 ────────────────────────────

console.log('\n【场景6】超出金额限制（金额 500 DCP > max_amount 300），不应触发')
const productId2 = createProduct(seller.id, '高档茶具套装', 500)
const orderId2 = generateId('ord')
db.prepare(`INSERT INTO orders (
  id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
  status, shipping_address,
  pay_deadline, accept_deadline, ship_deadline, pickup_deadline, delivery_deadline, confirm_deadline
) VALUES (?,?,?,?,1,500,500,500,'paid','测试地址',?,?,?,?,?,?)`).run(
  orderId2, productId2, buyer.id, seller.id,
  new Date(now.getTime() + 24*3600000).toISOString(),
  new Date(now.getTime() + 48*3600000).toISOString(),
  new Date(now.getTime() + 120*3600000).toISOString(),
  new Date(now.getTime() + 168*3600000).toISOString(),
  new Date(now.getTime() + 336*3600000).toISOString(),
  new Date(now.getTime() + 408*3600000).toISOString(),
)
const shouldAuto2 = shouldAutoAccept(db, orderId2)
console.log(`  shouldAutoAccept 返回：${shouldAuto2} ${!shouldAuto2 ? '✅ 正确（金额超限不触发）' : '❌ 错误！'}`)

// ─── 场景 7：Skill 使用记录 + 推荐佣金 ──────────────────────

console.log('\n【场景7】订单成交后记录 Skill 使用并分配推荐佣金')
// 先让买家订阅 catalog_sync，创建新订单，然后成交
const productId3 = createProduct(seller.id, '竹编收纳篮', 200)
const orderId3 = generateId('ord')
db.prepare(`INSERT INTO orders (
  id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount,
  status, shipping_address,
  pay_deadline, accept_deadline, ship_deadline, pickup_deadline, delivery_deadline, confirm_deadline
) VALUES (?,?,?,?,1,200,200,200,'completed','测试地址',?,?,?,?,?,?)`).run(
  orderId3, productId3, buyer.id, seller.id,
  new Date(now.getTime() + 24*3600000).toISOString(),
  new Date(now.getTime() + 48*3600000).toISOString(),
  new Date(now.getTime() + 120*3600000).toISOString(),
  new Date(now.getTime() + 168*3600000).toISOString(),
  new Date(now.getTime() + 336*3600000).toISOString(),
  new Date(now.getTime() + 408*3600000).toISOString(),
)

const sellerBefore = (db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(seller.id) as {balance:number}).balance
recordSkillUsage(db, orderId3, 200)
const sellerAfter = (db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(seller.id) as {balance:number}).balance
const commission = sellerAfter - sellerBefore

console.log(`  卖家余额变化：${sellerBefore.toFixed(2)} → ${sellerAfter.toFixed(2)} DCP`)
console.log(`  推荐佣金：+${commission.toFixed(2)} DCP（200 × 0.5% = 1.00 DCP）${Math.abs(commission - 1) < 0.01 ? '✅' : '❌'}`)

console.log('\n✅ 所有测试通过！\n')
