/**
 * DCP 入口文件
 * 现阶段用于测试各模块是否正常初始化
 */

import { initDatabase, generateId } from './layer0-foundation/L0-1-database/schema.js'

console.log('🦞 DCP — Decentralized Commerce Protocol')
console.log('启动中...\n')

// 测试 L0-1：数据库初始化
const db = initDatabase()

// 插入一个测试用户，验证数据库写入正常
const testUserId = generateId('usr')
const testApiKey = generateId('key')

db.prepare(`
  INSERT OR IGNORE INTO users (id, name, role, api_key)
  VALUES (?, ?, ?, ?)
`).run(testUserId, '测试卖家', 'seller', testApiKey)

// 同时创建钱包
db.prepare(`
  INSERT OR IGNORE INTO wallets (user_id, balance)
  VALUES (?, ?)
`).run(testUserId, 1000)

// 读回来验证
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId) as any
const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(testUserId) as any

console.log('\n✅ 数据库读写测试通过：')
console.log(`   用户ID:   ${user.id}`)
console.log(`   角色:     ${user.role}`)
console.log(`   API Key:  ${user.api_key}`)
console.log(`   余额:     ${wallet.balance} DCP`)

// 清理测试数据
db.prepare('DELETE FROM wallets WHERE user_id = ?').run(testUserId)
db.prepare('DELETE FROM users WHERE id = ?').run(testUserId)
console.log('\n🧹 测试数据已清理')
console.log('\n✅ L0-1 数据库模块：正常\n')
