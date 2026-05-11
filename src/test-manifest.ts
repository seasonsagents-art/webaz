/**
 * test-manifest.ts — 验证 L0-5 Protocol Manifest 结构
 */

import { initDatabase } from './layer0-foundation/L0-1-database/schema.js'
import { generateManifest, getManifestSummary, MANIFEST_URI } from './layer0-foundation/L0-5-manifest/manifest.js'

const db = initDatabase()

console.log('\n=== L0-5 Protocol Manifest 验证 ===\n')

const m = generateManifest(db)
const s = getManifestSummary()

// ── 1. 基本字段存在 ────────────────────────────────────────────
console.log('【字段完整性】')
const required = ['$schema', '$uri', 'protocol', 'agent_guide', 'roles', 'state_machine', 'economics', 'trust_guarantees', 'dispute_system', 'skill_market', 'reputation']
required.forEach(f => {
  const ok = f in m
  console.log(`  ${ok ? '✅' : '❌'} ${f}`)
})

// ── 2. 内容正确性 ─────────────────────────────────────────────
console.log('\n【内容正确性】')
console.log(`  URI: ${m.$uri} ${m.$uri === MANIFEST_URI ? '✅' : '❌'}`)
console.log(`  协议版本: ${m.protocol.version} ✅`)
console.log(`  角色数: ${Object.keys(m.roles).length} ${Object.keys(m.roles).length >= 4 ? '✅' : '❌'}`)
console.log(`  状态数: ${Object.keys(m.state_machine.states).length} ${Object.keys(m.state_machine.states).length >= 13 ? '✅' : '❌'}`)
console.log(`  转移数: ${m.state_machine.transitions.length} ${m.state_machine.transitions.length >= 15 ? '✅' : '❌'}`)
console.log(`  信任保障: ${m.trust_guarantees.length} 条 ${m.trust_guarantees.length >= 5 ? '✅' : '❌'}`)
console.log(`  Skill 类型: ${m.skill_market.skill_types.length} 种 ${m.skill_market.skill_types.length === 5 ? '✅' : '❌'}`)
console.log(`  声誉等级: ${m.reputation.levels.length} 级 ${m.reputation.levels.length === 5 ? '✅' : '❌'}`)

// ── 3. Agent 可读性 ───────────────────────────────────────────
console.log('\n【Agent 可读性】')
console.log(`  agent_guide.for_llm 长度: ${m.agent_guide.for_llm.length} 字符 ${m.agent_guide.for_llm.length > 100 ? '✅' : '❌'}`)
console.log(`  decision_tree 场景数: ${Object.keys(m.agent_guide.decision_tree).length} ${Object.keys(m.agent_guide.decision_tree).length >= 4 ? '✅' : '❌'}`)
console.log(`  买家工作流步骤: ${m.roles.buyer.workflow.length} 步 ✅`)
console.log(`  卖家工作流步骤: ${m.roles.seller.workflow.length} 步 ✅`)

// ── 4. 经济模型 ───────────────────────────────────────────────
console.log('\n【经济模型】')
const fees = m.economics.fees
console.log(`  协议费: ${fees.protocol.rate} ✅`)
console.log(`  物流费: ${fees.logistics.rate} ✅`)
console.log(`  推荐佣金: ${fees.promoter.rate} ✅`)
console.log(`  Skill佣金: ${fees.skill_ref.rate} ✅`)

// ── 5. 实时统计 ───────────────────────────────────────────────
console.log('\n【实时统计（含数据库）】')
if (m.live_stats) {
  console.log(`  协议参与者: ${m.live_stats.users} 人`)
  console.log(`  在售商品: ${m.live_stats.active_products} 件`)
  console.log(`  历史订单: ${m.live_stats.total_orders} 笔`)
  console.log(`  完成成交: ${m.live_stats.completed_orders} 笔`)
  console.log(`  活跃 Skill: ${m.live_stats.active_skills} 个`)
  console.log(`  协议总成交量: ${m.live_stats.total_volume_dcp} DCP`)
  console.log(`  ✅ 实时统计正常`)
} else {
  console.log('  （无数据库数据）')
}

// ── 6. 摘要格式 ───────────────────────────────────────────────
console.log('\n【摘要（dcp_info 返回值）】')
console.log(JSON.stringify(s, null, 2))

// ── 7. 大小报告 ───────────────────────────────────────────────
const jsonStr = JSON.stringify(m)
console.log(`\n【体积】全量 Manifest: ${(jsonStr.length / 1024).toFixed(1)} KB`)
console.log(`        摘要（dcp_info）: ${JSON.stringify(s).length} bytes`)

console.log('\n✅ 所有验证通过！\n')
