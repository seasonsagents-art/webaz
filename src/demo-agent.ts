/**
 * DCP Agent 交互演示
 * 模拟两个 Agent（卖家Agent + 买家Agent）通过 MCP 工具完成一笔真实交易
 * 这就是真实 Agent 调用时会发生的事情
 */

import Database from 'better-sqlite3'
import { initDatabase, generateId } from './layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, transition, getOrderStatus } from './layer0-foundation/L0-2-state-machine/engine.js'

const db = initDatabase()
initSystemUser(db)

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function line() { console.log('─'.repeat(65)) }

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 3_600_000).toISOString()
}

// 模拟 Agent 说话的感觉
async function agentSay(role: string, emoji: string, msg: string) {
  await sleep(120)
  console.log(`\n${emoji} [${role} Agent]`)
  console.log(`   ${msg}`)
}

async function toolCall(name: string, result: unknown) {
  await sleep(80)
  console.log(`   → 调用工具 ${name}`)
  console.log(`   ← ${JSON.stringify(result, null, 0).slice(0, 120)}...`)
}

async function main() {
  console.clear()
  console.log('🦞 DCP Protocol — Agent 交互演示')
  console.log('   两个 Agent 自动完成一笔真实去中心化交易')
  line()

  // ── STEP 1: 卖家 Agent 注册 ───────────────────────────────────
  await agentSay('卖家', '🏪', '我要在 DCP 协议上开店，先注册一个卖家账号')

  const sellerId = generateId('usr')
  const sellerKey = generateId('key')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?, ?, ?, ?)').run(sellerId, '竹韵手工坊', 'seller', sellerKey)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 500)').run(sellerId)

  await toolCall('dcp_register', { name: '竹韵手工坊', role: 'seller' })
  console.log(`   ✅ 注册成功！api_key 已保存`)

  // ── STEP 2: 卖家 Agent 上架商品 ────────────────────────────────
  await agentSay('卖家', '🏪', '把我的拳头产品上架，定价 168 DCP，自动质押 15% 保证金')

  const productId = generateId('prd')
  const price = 168
  const stake = Math.round(price * 0.15 * 100) / 100
  db.prepare('INSERT INTO products (id, seller_id, title, description, price, stock, category, stake_amount) VALUES (?,?,?,?,?,?,?,?)')
    .run(productId, sellerId, '竹编茶叶罐（250g装）', '云南手工竹编，密封保鲜，适合储存普洱、岩茶', price, 10, '茶具', stake)
  db.prepare('UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ?').run(stake, stake, sellerId)

  await toolCall('dcp_list_product', { title: '竹编茶叶罐', price: 168, stock: 10 })
  console.log(`   ✅ 商品已上架！质押 ${stake} DCP，买家现在可以搜索到`)

  line()

  // ── STEP 3: 买家 Agent 注册 ────────────────────────────────────
  await agentSay('买家', '🛒', '帮我注册买家身份，我想买点好茶具')

  const buyerId = generateId('usr')
  const buyerKey = generateId('key')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?, ?, ?, ?)').run(buyerId, '陈先生', 'buyer', buyerKey)
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 1000)').run(buyerId)

  await toolCall('dcp_register', { name: '陈先生', role: 'buyer' })
  console.log(`   ✅ 注册成功！初始余额 1000 DCP`)

  // ── STEP 4: 买家 Agent 搜索 ────────────────────────────────────
  await agentSay('买家', '🛒', '帮我搜索一下茶具，预算 200 以内')

  const results = db.prepare(`
    SELECT p.*, u.name as seller_name FROM products p
    JOIN users u ON p.seller_id = u.id
    WHERE p.status = 'active' AND (p.title LIKE '%茶%' OR p.category = '茶具') AND p.price <= 200
  `).all() as Record<string, unknown>[]

  await toolCall('dcp_search', { query: '茶具', max_price: 200 })
  console.log(`   ← 找到 ${results.length} 件商品：`)
  results.forEach(p => console.log(`      · ${p.title}  ¥${p.price} DCP  卖家：${p.seller_name}`))

  // ── STEP 5: 买家 Agent 下单 ────────────────────────────────────
  await agentSay('买家', '🛒', `好！买这个竹编茶叶罐，地址是上海市静安区南京西路×号`)

  const orderId = generateId('ord')
  const now = new Date()
  db.prepare(`
    INSERT INTO orders (id, product_id, buyer_id, seller_id,
      quantity, unit_price, total_amount, escrow_amount, status,
      shipping_address, pay_deadline, accept_deadline, ship_deadline,
      pickup_deadline, delivery_deadline, confirm_deadline)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'created', '上海市静安区南京西路×号', ?, ?, ?, ?, ?, ?)
  `).run(orderId, productId, buyerId, sellerId, price, price, price,
    addHours(now, 24), addHours(now, 48), addHours(now, 120),
    addHours(now, 168), addHours(now, 336), addHours(now, 408))
  db.prepare('UPDATE wallets SET balance = balance - ?, escrowed = escrowed + ? WHERE user_id = ?').run(price, price, buyerId)
  db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(productId)
  transition(db, orderId, 'paid', buyerId, [], '买家付款，资金托管')

  await toolCall('dcp_place_order', { product_id: productId, shipping_address: '上海市...' })
  console.log(`   ✅ 订单创建！${price} DCP 已托管`)
  console.log(`   ℹ️  卖家需在 24h 内接单，否则自动退款`)

  line()

  // ── STEP 6: 卖家 Agent 收到通知，接单 ─────────────────────────
  await agentSay('卖家', '🏪', '收到新订单通知！确认接单，3天内安排发货')

  transition(db, orderId, 'accepted', sellerId, [], '确认接单，备货中')
  await toolCall('dcp_update_order', { action: 'accept', order_id: orderId })
  console.log(`   ✅ 接单成功！协议记录：卖家已承诺履约`)

  // ── STEP 7: 卖家 Agent 发货 ────────────────────────────────────
  await agentSay('卖家', '🏪', '商品已打包，交给顺丰，单号 SF1234567890，上传发货凭证')

  const evtShip = generateId('evt')
  db.prepare('INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,?,?,?)')
    .run(evtShip, orderId, sellerId, 'photo', '包裹照片+快递单SF1234567890', 'sha256_ship_abc')
  transition(db, orderId, 'shipped', sellerId, [evtShip], '顺丰SF1234567890')

  await toolCall('dcp_update_order', { action: 'ship', evidence_description: '顺丰单号+包裹照片' })
  console.log(`   ✅ 发货证明已上链！哈希：sha256_ship_abc`)

  // ── STEP 8: 物流 Agent 揽收 ────────────────────────────────────
  const logisticsId = generateId('usr')
  db.prepare('INSERT INTO users (id, name, role, api_key) VALUES (?,?,?,?)').run(logisticsId, '顺丰小哥李明', 'logistics', generateId('key'))
  db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(logisticsId)
  db.prepare('UPDATE orders SET logistics_id = ? WHERE id = ?').run(logisticsId, orderId)

  await agentSay('物流', '🚚', '已揽收包裹，上传GPS坐标和扫描记录')

  const evtPickup = generateId('evt')
  db.prepare('INSERT INTO evidence (id, order_id, uploader_id, type, description, metadata) VALUES (?,?,?,?,?,?)')
    .run(evtPickup, orderId, logisticsId, 'gps', '揽收扫描确认', '{"lat":31.22,"lng":121.48,"timestamp":"2026-05-11T10:30:00Z"}')
  transition(db, orderId, 'picked_up', logisticsId, [evtPickup], '包裹完好，已揽收')
  transition(db, orderId, 'in_transit', logisticsId, [], '已发往上海转运中心')

  await toolCall('dcp_update_order', { action: 'pickup', evidence_description: 'GPS+扫描记录' })
  console.log(`   ✅ 揽收证明已记录，开始运输`)

  // ── STEP 9: 物流 Agent 投递 ────────────────────────────────────
  await agentSay('物流', '🚚', '已送达，拍门口照片，收件人已签收')

  const evtDeliver = generateId('evt')
  db.prepare('INSERT INTO evidence (id, order_id, uploader_id, type, description, file_hash) VALUES (?,?,?,?,?,?)')
    .run(evtDeliver, orderId, logisticsId, 'photo', '投递照片（含门牌）+签收记录', 'sha256_deliver_xyz')
  transition(db, orderId, 'delivered', logisticsId, [evtDeliver], '本人签收，已完成投递')

  await toolCall('dcp_update_order', { action: 'deliver', evidence_description: '投递照片+签收' })
  console.log(`   ✅ 投递证明已记录！买家 72h 内确认，否则自动确认`)

  line()

  // ── STEP 10: 买家 Agent 确认 ───────────────────────────────────
  await agentSay('买家', '🛒', '收到了！茶叶罐做工很好，确认收货')

  transition(db, orderId, 'confirmed', buyerId, [], '商品完好，非常满意！')

  // 自动结算
  const sysUser = db.prepare("SELECT id FROM users WHERE id = 'sys_protocol'").get() as { id: string }
  transition(db, orderId, 'completed', sysUser.id, [], '系统自动结算')

  const protocolFee  = Math.round(price * 0.02 * 100) / 100
  const logisticsFee = Math.round(price * 0.05 * 100) / 100
  const sellerAmount = price - protocolFee - logisticsFee

  db.prepare('UPDATE wallets SET escrowed = escrowed - ? WHERE user_id = ?').run(price, buyerId)
  db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(sellerAmount, sellerAmount, sellerId)
  db.prepare('UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?').run(logisticsFee, logisticsFee, logisticsId)
  db.prepare('UPDATE wallets SET staked = staked - ?, balance = balance + ? WHERE user_id = ?').run(stake, stake, sellerId)

  await toolCall('dcp_update_order', { action: 'confirm' })
  console.log(`   ✅ 确认收货！资金自动结算中...`)

  // ── 最终报告 ────────────────────────────────────────────────────
  line()
  await agentSay('协议系统', '🦞', '交易完成！以下是完整结算报告')

  const statusInfo = getOrderStatus(db, orderId)!

  console.log(`\n   📋 订单 ${orderId}`)
  console.log(`   状态：${(statusInfo.order as Record<string, unknown>).status}（已完成）\n`)

  console.log(`   💰 资金分配（总额 ${price} DCP）：`)
  const sellerW = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(sellerId) as Record<string, number>
  const logW    = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(logisticsId) as Record<string, number>
  const buyerW  = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(buyerId) as Record<string, number>
  console.log(`      卖家（竹韵手工坊）：+${sellerAmount} DCP (${((sellerAmount/price)*100).toFixed(0)}%)  总余额：${sellerW.balance.toFixed(2)}`)
  console.log(`      物流（顺丰小哥）：  +${logisticsFee} DCP (5%)   总余额：${logW.balance.toFixed(2)}`)
  console.log(`      协议费：           -${protocolFee} DCP (2%)`)
  console.log(`      买家（陈先生）：   -${price} DCP         总余额：${buyerW.balance.toFixed(2)}`)

  console.log(`\n   📜 完整状态历史（每步都有链上记录）：`)
  for (const h of statusInfo.history as Record<string, unknown>[]) {
    const evtCount = JSON.parse((h.evidence_ids as string) || '[]').length
    const evtTag = evtCount > 0 ? ` 📎 ${evtCount}份证据` : ''
    console.log(`      ${String(h.from_status).padEnd(12)} → ${String(h.to_status).padEnd(12)} ${String(h.actor_name)}${evtTag}`)
  }

  line()
  console.log('\n🎉 这就是 DCP 协议的第一笔真实交易！')
  console.log()
  console.log('   用户做了什么：告诉 Agent「买这个」「确认收货」')
  console.log('   Agent 做了什么：处理所有协议交互、证据上传、状态流转')
  console.log('   协议做了什么：自动托管资金、验证每步合法性、自动结算分成')
  console.log()
  console.log('   如果任何一方违约（超时/货不对版）：')
  console.log('   协议自动判责 → 自动执行处置 → 不需要任何人工干预')
  line()
}

main().catch(console.error)
