/**
 * DCP 协议自动执法进程
 *
 * 每 5 分钟扫描一次：
 * 1. 订单超时判责（checkTimeouts）
 * 2. 争议超时自动裁定（checkDisputeTimeouts）
 *
 * 运行方式：npm run enforcement
 * 生产环境建议用 pm2 或 systemd 守护进程保活
 */

import { initDatabase } from './layer0-foundation/L0-1-database/schema.js'
import { initSystemUser, checkTimeouts } from './layer0-foundation/L0-2-state-machine/engine.js'
import { initDisputeSchema, checkDisputeTimeouts } from './layer3-trust/L3-1-dispute-engine/dispute-engine.js'
import { initReputationSchema, recordViolationReputation, recordDisputeReputation } from './layer4-economics/L4-3-reputation/reputation-engine.js'

const INTERVAL_MS = 5 * 60 * 1000   // 5 分钟
const db = initDatabase()
initSystemUser(db)
initDisputeSchema(db)
initReputationSchema(db)

function timestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function line() { console.log('─'.repeat(55)) }

async function enforce() {
  const start = Date.now()

  // ── 1. 订单超时判责 ───────────────────────────────────────
  const orderResult = checkTimeouts(db)

  // ── 2. 争议超时自动裁定 ───────────────────────────────────
  const disputeResult = checkDisputeTimeouts(db)

  const elapsed = Date.now() - start
  const totalActions = orderResult.processed + disputeResult.processed

  if (totalActions > 0) {
    line()
    console.log(`⚡ [${timestamp()}] 执法扫描 完成 (${elapsed}ms)`)

    if (orderResult.processed > 0) {
      console.log(`\n   📦 订单超时判责 × ${orderResult.processed}`)
      orderResult.details.forEach(d => {
        console.log(`      ${d.orderId}  ${d.action}`)
        // 判责的终态：fault_seller / fault_logistics / fault_buyer
        const faultMatch = d.action.match(/→ (fault_\w+)/)
        if (faultMatch) recordViolationReputation(db, d.orderId, faultMatch[1])
      })
    }

    if (disputeResult.processed > 0) {
      console.log(`\n   ⚖️  争议自动裁定 × ${disputeResult.processed}`)
      disputeResult.details.forEach(d => {
        console.log(`      ${d.disputeId}  ${d.action}`)
        if (d.winnerId && d.loserId && d.orderId) {
          recordDisputeReputation(db, d.orderId, d.winnerId, d.loserId)
        }
      })
    }
    line()
  } else {
    // 无动作时只打印一行心跳，保持日志整洁
    process.stdout.write(`\r⏱  [${timestamp()}] 扫描完成，无超时事件`)
  }
}

// ── 主循环 ────────────────────────────────────────────────────

console.log('\n🦞 DCP Protocol — 自动执法进程启动')
console.log(`   扫描间隔：${INTERVAL_MS / 1000}s`)
console.log(`   职责：订单超时判责 + 争议超时自动裁定`)
line()

// 启动时立即执行一次
enforce().catch(console.error)

// 定期执行
const timer = setInterval(() => {
  enforce().catch(err => {
    console.error(`\n❌ [${timestamp()}] 执法扫描出错：`, err.message)
  })
}, INTERVAL_MS)

// 优雅退出
process.on('SIGINT', () => {
  clearInterval(timer)
  console.log(`\n\n⏹  执法进程已停止`)
  process.exit(0)
})

process.on('SIGTERM', () => {
  clearInterval(timer)
  process.exit(0)
})
